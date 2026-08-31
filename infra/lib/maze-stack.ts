import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Runtime as AgentCoreRuntime, AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { SqsEventSource, DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { LambdaDestination } from 'aws-cdk-lib/aws-logs-destinations';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..', '..');
const LOCK = path.join(REPO, 'infra', 'package-lock.json');

// Lambda sources live at the repo root (README §10 layout), outside infra/.
// NodejsFunction requires entries under a projectRoot; anchor it at the repo.
const NODE_ROOT = { projectRoot: REPO, depsLockFilePath: LOCK } as const;

const MODEL_ID = 'us.anthropic.claude-opus-5';
// Secondary model for generation. Opus 5 returns stop_reason=refusal on this
// project's decoy prompt often enough to stall the pipeline; Sonnet 5 answers it
// reliably, so the generator falls back rather than retrying a model that will not
// answer. Both need Bedrock permissions below.
const FALLBACK_MODEL_ID = 'us.anthropic.claude-sonnet-5';
// NOT an S3 bucket: a fixed key path segment inside the corpus bucket
// (corpus/<ctx>/<version>/<segment>/<slug>). Kept the historical name because it
// travels through snapshot records and the KVS config as `bucket`.
const DECOY_BUCKET_NAME = 'decoy';

// Header the generator (and the headless renderer it drives) sends on every
// ingestion request, and that the WAF pass-through rule Allows. Ingestion must
// never be routed into the maze or the generator would build decoys from decoys.
const INGEST_HEADER = 'x-maze-ingest';

/**
 * `nameSuffix` lets a second, isolated copy of the POC stand alongside the main
 * one in the same account (e.g. to verify a change end-to-end without touching a
 * live deployment). Every other physical name is either auto-generated or derived
 * from the stack name; the AgentCore runtime name is the one that must be unique
 * per account, so it takes the suffix too. Empty by default: an unsuffixed deploy
 * is byte-identical to before.
 */
export interface MazeStackProps extends cdk.StackProps {
  readonly nameSuffix?: string;
}

export class MazeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MazeStackProps) {
    super(scope, id, props);

    // Runtime name regex ^[a-zA-Z][a-zA-Z0-9_]{0,47}$ forbids dashes.
    const suffix = (props.nameSuffix || '').replace(/[^A-Za-z0-9_]/g, '');

    const arm = lambda.Architecture.ARM_64;
    const runtime = lambda.Runtime.NODEJS_24_X;

    // Explicit, self-cleaning log group per function (avoids the deprecated
    // logRetention custom resource; lets us attach subscription filters).
    const mkLogGroup = (name: string, retention = logs.RetentionDays.TWO_WEEKS) =>
      new logs.LogGroup(this, `${name}Logs`, {
        retention,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    // ---------------------------------------------------------------------
    // 0. Ingest secret: minted on the FIRST `cdk deploy` (custom resource,
    //    persisted in SSM, reused on later deploys) and consumed by exactly two
    //    sides of the POC:
    //      - the WAF Allow rule below (byte-match on the x-maze-ingest
    //        header), and
    //      - the generator agent, which sends that header on every ingestion
    //        request and passes it to the headless renderer it drives.
    //    It rides a dedicated header rather than the User-Agent so that ingestion
    //    can replay the crawler's real UA unchanged.
    //    Created first because the generator and the WebACL both take it as a
    //    construction-time value.
    // ---------------------------------------------------------------------
    const ingestSecretFn = new NodejsFunction(this, 'IngestSecretMinter', {
      runtime,
      architecture: arm,
      ...NODE_ROOT,
      entry: path.join(REPO, 'infra', 'lambda', 'ingest-secret.mjs'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(1),
      logGroup: mkLogGroup('IngestSecretMinter', logs.RetentionDays.ONE_WEEK),
    });
    const ingestSecretParam = `/ai-maze/${this.stackName}/ingest-secret`;
    ingestSecretFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter${ingestSecretParam}`,
        ],
      }),
    );
    const ingestSecretCr = new cdk.CustomResource(this, 'IngestSecret', {
      serviceToken: new cr.Provider(this, 'IngestSecretProvider', {
        onEventHandler: ingestSecretFn,
      }).serviceToken,
      properties: { ParameterName: ingestSecretParam },
    });
    const INGEST_SECRET = ingestSecretCr.getAttString('Secret');

    // ---------------------------------------------------------------------
    // 1. Storage: private source, private corpus, private staging (all S3).
    // ---------------------------------------------------------------------
    const commonBucketProps: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    };

    const sourceBucket = new s3.Bucket(this, 'SourceBucket', commonBucketProps);
    const corpusBucket = new s3.Bucket(this, 'CorpusBucket', commonBucketProps);
    const stagingBucket = new s3.Bucket(this, 'StagingBucket', {
      ...commonBucketProps,
      lifecycleRules: [{ expiration: cdk.Duration.days(14) }], // bounded retention
    });

    // Seed sample source content at deploy time (single cdk deploy does all).
    new s3deploy.BucketDeployment(this, 'SeedSource', {
      sources: [s3deploy.Source.asset(path.join(REPO, 'seed', 'source'))],
      destinationBucket: sourceBucket,
    });

    // SPA showcase origin (private S3, OAC): a client-rendered app served under
    // /app/*. Its real content is fetched by JS from the JSON API below, so a
    // decoy must be built from the RENDERED DOM, not this empty shell.
    const spaBucket = new s3.Bucket(this, 'SpaBucket', commonBucketProps);
    new s3deploy.BucketDeployment(this, 'SeedSpa', {
      sources: [s3deploy.Source.asset(path.join(REPO, 'seed', 'spa'))],
      destinationBucket: spaBucket,
      destinationKeyPrefix: 'app', // served at /app/index.html, /app/app.js, ...
    });

    // ---------------------------------------------------------------------
    // 2. DynamoDB: desired-state snapshot table (source of truth) + streams.
    // ---------------------------------------------------------------------
    const snapshotTable = new dynamodb.Table(this, 'SnapshotTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
      // Expires the parser's per-window BUDGET# counter items (threat model M2).
      // CTX#/ADMIT# items never carry the attribute, so they are untouched.
      timeToLiveAttribute: 'expiresAt',
    });

    // ---------------------------------------------------------------------
    // 3. CloudFront KeyValueStore (compact readiness/config index).
    // ---------------------------------------------------------------------
    const kvStore = new cloudfront.KeyValueStore(this, 'MazeKvs', {
      keyValueStoreName: `${cdk.Stack.of(this).stackName}-kvs`.toLowerCase(),
    });

    // ---------------------------------------------------------------------
    // 4. Generation SQS FIFO queue (context-key dedup) + DLQ.
    // ---------------------------------------------------------------------
    const genDlq = new sqs.Queue(this, 'GenDlq', {
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: cdk.Duration.days(14),
    });
    const genQueue = new sqs.Queue(this, 'GenQueue', {
      fifo: true,
      contentBasedDeduplication: false,
      deduplicationScope: sqs.DeduplicationScope.MESSAGE_GROUP,
      fifoThroughputLimit: sqs.FifoThroughputLimit.PER_MESSAGE_GROUP_ID,
      visibilityTimeout: cdk.Duration.minutes(6),
      deadLetterQueue: { queue: genDlq, maxReceiveCount: 5 },
    });

    // JSON API origin (a genuinely NON-S3 origin): the SPA's data source and a
    // showcase of "the real origin can be anything". Served under /api/*.
    const apiHandler = new NodejsFunction(this, 'ApiHandler', {
      runtime,
      architecture: arm,
      ...NODE_ROOT,
      entry: path.join(REPO, 'services', 'api', 'index.mjs'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      logGroup: mkLogGroup('ApiHandler'),
    });
    const apiUrl = apiHandler.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM, // signed by CloudFront OAC
    });

    // Headless renderer (Playwright + Chromium) packaged as an arm64 Docker
    // image. `cdk deploy` builds and pushes the image automatically (single
    // deploy). It executes a page's JS so the generator can build decoys that
    // mimic the RENDERED DOM/data rather than an empty SPA shell.
    const renderer = new lambda.DockerImageFunction(this, 'Renderer', {
      code: lambda.DockerImageCode.fromImageAsset(path.join(REPO, 'services', 'renderer')),
      architecture: arm,
      timeout: cdk.Duration.minutes(2),
      // Headless Chromium is memory-hungry and a content-rich page pushed 2048 MB
      // into "Runtime exited without providing a reason" (an OOM kill with no
      // Node stack trace). More memory also means more vCPU, so renders finish
      // sooner and the browser is alive for less time per invoke.
      memorySize: 3008,
      logGroup: mkLogGroup('Renderer'),
      // No INGEST_SECRET here: the generator passes the ingest header, together
      // with the triggering request's replayed headers, in the invoke payload —
      // one source of truth, and the renderer stays a pure URL -> DOM function.
    });

    // ---------------------------------------------------------------------
    // 5. Pipeline Lambdas: parser, generator (agent), publisher.
    // ---------------------------------------------------------------------
    // THE spend ceiling (threat model M2): at most this many NEW contexts enter
    // generation per window; the rest are dropped at the parser. Overridable at
    // synth for a test-sized deploy, like the stack suffix.
    const GEN_BUDGET_PER_WINDOW = process.env.GEN_BUDGET_PER_WINDOW || '20';
    const GEN_BUDGET_WINDOW_SECONDS = process.env.GEN_BUDGET_WINDOW_SECONDS || '3600';

    const parserLogGroup = mkLogGroup('Parser');
    const parser = new NodejsFunction(this, 'Parser', {
      runtime,
      architecture: arm,
      ...NODE_ROOT,
      entry: path.join(REPO, 'services', 'parser', 'index.mjs'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: parserLogGroup,
      environment: {
        QUEUE_URL: genQueue.queueUrl,
        SNAPSHOT_TABLE: snapshotTable.tableName,
        GEN_BUDGET_PER_WINDOW,
        GEN_BUDGET_WINDOW_SECONDS,
      },
    });
    genQueue.grantSendMessages(parser);
    snapshotTable.grantReadWriteData(parser); // BUDGET#/ADMIT# admission state

    // NOTE: the generator "agent" is no longer a Lambda. It now runs on Amazon
    // Bedrock AgentCore Runtime (a containerized agent), defined in section 7b
    // after the distribution. It takes no site URL: the absolute URL to ingest
    // travels with each SQS message, logged by the edge function for the request
    // that triggered generation. A thin `genInvoker` Lambda bridges the SQS FIFO
    // queue to InvokeAgentRuntime.

    const publisher = new NodejsFunction(this, 'Publisher', {
      runtime,
      architecture: arm,
      ...NODE_ROOT,
      entry: path.join(REPO, 'services', 'publisher', 'index.mjs'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      logGroup: mkLogGroup('Publisher'),
      environment: {
        SNAPSHOT_TABLE: snapshotTable.tableName,
        STAGING_BUCKET: stagingBucket.bucketName,
        CORPUS_BUCKET: corpusBucket.bucketName,
        KVS_ARN: kvStore.keyValueStoreArn,
        DECOY_BUCKET_NAME,
        // How long a decoy serves before the edge asks for a rotation. Each
        // rotation is a fresh Opus 5 generation, so this is the cost knob.
        ROTATE_TTL_SECONDS: '86400',
      },
      // KVS data-plane writes sign with SigV4a; the AWS-documented signer is the
      // native CRT implementation. `nodeModules` keeps esbuild from inlining the
      // native module — CDK `npm install`s it into the bundle instead. aws-crt
      // ships prebuilt binaries for every platform (the bundle carries
      // linux-arm64-glibc + -musl), so the arm64 Lambda loads the right one at
      // runtime whether bundled locally or in Docker. Resolving the version
      // requires a package.json above the entry (repo-root package.json).
      //
      // CRITICAL: the KVS client MUST be in nodeModules alongside the CRT signer.
      // The signer registers its SigV4a implementation on the copy of
      // @aws-sdk/signature-v4-multi-region that npm installs into the bundle. If
      // the KVS client were left external (esbuild default for @aws-sdk/*), it
      // would resolve a *different* signature-v4-multi-region from Lambda's
      // /var/runtime and never see the registration — the exact "Neither CRT nor
      // JS SigV4a implementation is available" failure. Co-installing both makes
      // npm dedup them to one shared instance.
      bundling: { nodeModules: ['@aws-sdk/signature-v4-crt', '@aws-sdk/client-cloudfront-keyvaluestore'] },
    });
    publisher.addEventSource(
      new DynamoEventSource(snapshotTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 3,
        bisectBatchOnError: true,
      }),
    );
    stagingBucket.grantRead(publisher);
    corpusBucket.grantReadWrite(publisher);
    snapshotTable.grantReadWriteData(publisher);
    // KVS data-plane write (publisher promotes the ready marker).
    publisher.addToRolePolicy(
      new iam.PolicyStatement({
        // GetKey too: the publisher reads the current marker before writing, so it
        // can preserve fields it is not changing (a live version's routing data when
        // projecting a retry time, and vice versa).
        actions: [
          'cloudfront-keyvaluestore:DescribeKeyValueStore',
          'cloudfront-keyvaluestore:GetKey',
          'cloudfront-keyvaluestore:PutKey',
        ],
        resources: [kvStore.keyValueStoreArn],
      }),
    );

    // ---------------------------------------------------------------------
    // 6. CloudFront Function (viewer-request router) + KVS association.
    // ---------------------------------------------------------------------
    // CloudFront caps function code at 10 KB — COMMENTS INCLUDED — and the service
    // rejects an oversized function with a bare `413` from a downstream service,
    // half an hour into a deploy, after the distribution is already building. Fail
    // at synth instead, with a message that says what to do.
    const viewerFnPath = path.join(REPO, 'services', 'edge', 'maze-viewer.js');
    const viewerFnBytes = require('node:fs').statSync(viewerFnPath).size;
    const VIEWER_FN_LIMIT = 10240;
    if (viewerFnBytes > VIEWER_FN_LIMIT) {
      throw new Error(
        `services/edge/maze-viewer.js is ${viewerFnBytes} bytes; CloudFront Functions ` +
          `allow ${VIEWER_FN_LIMIT}. Move rationale into README.md rather than ` +
          `trimming the logic — comments count toward the limit.`,
      );
    }

    const viewerFn = new cloudfront.Function(this, 'MazeViewerFn', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      keyValueStore: kvStore,
      code: cloudfront.FunctionCode.fromFile({ filePath: viewerFnPath }),
    });

    // ---------------------------------------------------------------------
    // 7. Origins: source and corpus (S3/OAC), plus API (Function URL/OAC).
    // ---------------------------------------------------------------------
    const sourceOrigin = origins.S3BucketOrigin.withOriginAccessControl(sourceBucket);
    const spaOrigin = origins.S3BucketOrigin.withOriginAccessControl(spaBucket);
    // API is a NON-S3 origin: a Lambda Function URL, OAC/IAM-signed by CloudFront.
    const apiOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(apiUrl);

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'AI Maze POC',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: sourceOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: viewerFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // SPA showcase (client-rendered, static S3). Same viewer fn: a flagged
        // bot on /app is redirected into the maze; a real visitor gets the shell
        // + JS, which the generator's headless renderer also executes to build
        // an isomorphic decoy.
        '/app/*': {
          origin: spaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: [
            { function: viewerFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        // JSON API showcase (NON-S3 origin: Lambda Function URL). Flagged bots
        // are mazed to a schema-isomorphic JSON decoy; real traffic reaches the
        // Lambda. (CACHING_OPTIMIZED omits the query string from the cache key,
        // which suits this fixed catalogue endpoint.)
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          functionAssociations: [
            { function: viewerFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
        // No behavior points at the corpus bucket. The edge function selects it at
        // request time with cf.updateRequestOrigin(), and the bucket policy below is
        // what authorizes that. There is deliberately no '/corpus/*' behavior: the
        // function refuses that prefix, because the cache is keyed on the URI it
        // rewrites to.
      },
    });

    // The corpus bucket is reached only via cf.updateRequestOrigin() from the edge
    // function, so no CDK origin construct exists to generate its policy. Grant the
    // distribution read access directly — this is the same statement an OAC-backed
    // S3 origin would have produced, and cf.updateRequestOrigin signs with the
    // distribution's identity, which is what AWS:SourceArn checks.
    corpusBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject'],
        resources: [corpusBucket.arnForObjects('*')],
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
          },
        },
      }),
    );

    // CloudFront's invoke permission for the API Function URL is auto-created by
    // FunctionUrlOrigin.withOriginAccessControl above.

    // ---------------------------------------------------------------------
    // 7b. Generator agent on Amazon Bedrock AgentCore Runtime + SQS invoker.
    //     The agent needs no knowledge of the distribution: it ingests the
    //     absolute URL the edge function logged for the triggering request, which
    //     arrives with each SQS message. Nothing here bakes in a site base URL.
    //
    //     `AgentRuntimeArtifact.fromAsset` builds services/generator/'s Dockerfile as a
    //     CDK DockerImageAsset (arm64, published to the bootstrap ECR repo in
    //     the asset phase of `cdk deploy`, before the Runtime referencing it is
    //     created) — the whole deploy stays a single `cdk deploy`. Defaults:
    //     public network egress, HTTP protocol contract, IAM (SigV4) auth.
    // ---------------------------------------------------------------------
    const generatorAgent = new AgentCoreRuntime(this, 'GeneratorAgent', {
      runtimeName: suffix ? `Maze_Generator_${suffix}` : 'Maze_Generator',
      description:
        'AI Maze decoy generator agent: fetches real content as a visitor, ' +
        'detects its archetype from the content-type, validates it with the model, ' +
        'calls Opus 5, renders structure-isomorphic decoys, seals DynamoDB snapshots.',
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(REPO, 'services', 'generator'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: {
        STAGING_BUCKET: stagingBucket.bucketName,
        SNAPSHOT_TABLE: snapshotTable.tableName,
        DECOY_BUCKET_NAME,
        MODEL_ID,
        FALLBACK_MODEL_ID,
        PAGE_COUNT: '5',
        GEN_EFFORT: 'low',
        RENDERER_FN: renderer.functionName,
        // Allowlisted ingest identity (see section 0 + the WAF Allow rule). No
        // SITE_BASE: the absolute URL to ingest travels with each SQS message.
        INGEST_SECRET,
        // Hosts the ingest secret may be sent to. Ingestion takes its URL from the
        // triggering log event, so this is a credential guard: without it a URL in
        // a tampered queue message would carry the WAF bypass secret off-site.
        INGEST_HOSTS: distribution.distributionDomainName,
      },
    });
    // The generator no longer reads the source bucket: ingestion is purely over
    // HTTP, as a visitor. The bucket stays as the real origin behind CloudFront.
    stagingBucket.grantReadWrite(generatorAgent);
    snapshotTable.grantReadWriteData(generatorAgent);
    renderer.grantInvoke(generatorAgent);
    // Opus 5 is inference-profile-only: allow invoking the profile AND the
    // underlying regional foundation model in every profile region.
    generatorAgent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*:${this.account}:inference-profile/${MODEL_ID}`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/${FALLBACK_MODEL_ID}`,
          // Exact ids, no wildcard: both profiles resolve to bare model ids
          // (verified via bedrock:GetInferenceProfile — no version suffix).
          `arn:aws:bedrock:*::foundation-model/${MODEL_ID.replace(/^us\./, '')}`,
          `arn:aws:bedrock:*::foundation-model/${FALLBACK_MODEL_ID.replace(/^us\./, '')}`,
        ],
      }),
    );
    // The DEFAULT endpoint InvokeAgentRuntime targets via qualifier: 'DEFAULT'.
    generatorAgent.addEndpoint('Default');

    // Thin bridge: SQS FIFO record -> InvokeAgentRuntime (synchronous). A failed
    // invoke fails the record (batch-item failure) so SQS retries and eventually
    // DLQs — the same delivery semantics the former generator Lambda had. The
    // heavy pipeline runs in the AgentCore container, so this stays tiny.
    const genInvoker = new NodejsFunction(this, 'GenInvoker', {
      runtime,
      architecture: arm,
      ...NODE_ROOT,
      entry: path.join(REPO, 'infra', 'lambda', 'gen-invoker.mjs'),
      handler: 'handler',
      // Must outlive one full generation (ingest + Opus 5 + stage + seal).
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: mkLogGroup('GenInvoker'),
      environment: { AGENT_RUNTIME_ARN: generatorAgent.agentRuntimeArn },
    });
    genInvoker.addEventSource(
      new SqsEventSource(genQueue, { batchSize: 1, reportBatchItemFailures: true }),
    );
    genInvoker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        // The runtime AND its endpoints (qualifier: 'DEFAULT' resolves under /*).
        resources: [generatorAgent.agentRuntimeArn, `${generatorAgent.agentRuntimeArn}/*`],
      }),
    );

    // ---------------------------------------------------------------------
    // 8. WAF WebACL (CLOUDFRONT scope) — real Bot Control detection + directive
    //     injection. Four rules (plus the TagBot analytics rules):
    //       0. AllowMazeIngest — a terminating Allow for the maze's own
    //          ingestion traffic, matched on the deploy-generated ingest secret
    //          (section 0) carried in its OWN header, not appended to the
    //          User-Agent: ingestion replays the crawler's real user agent so the
    //          origin and the page's JS answer as they did for the crawler, which a
    //          secret-bearing UA would defeat. It runs BEFORE Bot Control, so the
    //          generator/renderer are never labeled and never mazed: they always
    //          see the REAL origin content. Otherwise the generator would end up
    //          building decoys from decoys.
    //       1. BotControl — the AWS Bot Control managed rule group (COMMON
    //          inspection level) run purely as a LABELER: every one of its rules
    //          is overridden to Count so the group never terminates a request; it
    //          only attaches its bot labels (e.g. the AI-crawler label). This
    //          leaves every routing/decoy decision to our own rule + the CFF.
    //       2. UnverifiedGoodBotDecoyDirective — matches a good-bot identity
    //          claim (the User-Agent tokens the real crawlers send, or a
    //          good-bot category label) WITHOUT Bot Control's bot:verified
    //          label, and Counts while injecting the same decoy directive:
    //          anything that claims a good-bot identity but fails host
    //          validation is an impostor and gets the maze. Genuinely verified
    //          good bots are untouched.
    //       3. AiDecoyDirective — matches the Bot Control AI-crawler label and
    //          Counts (non-terminating) while injecting the decoy directive
    //          headers the CFF reads. Genuine AI crawlers that self-identify
    //          (e.g. GPTBot) get labeled category:ai at COMMON level and are
    //          steered into the maze.
    //     NOTE: Bot Control is a paid managed rule group (additional WAF cost
    //     beyond base WCU).
    // ---------------------------------------------------------------------

    // Run the Bot Control group as a labeler only: override EVERY COMMON-level
    // rule to Count so none of them Block/Challenge/CAPTCHA — the labels still
    // attach and our AiDecoyDirective rule acts on the AI label below.
    const botControlCommonRules = [
      'CategoryAdvertising',
      'CategoryArchiver',
      'CategoryContentFetcher',
      'CategoryEmailClient',
      'CategoryHttpLibrary',
      'CategoryLinkChecker',
      'CategoryMiscellaneous',
      'CategoryMonitoring',
      'CategoryScrapingFramework',
      'CategorySearchEngine',
      'CategorySecurity',
      'CategorySeo',
      'CategorySocialMedia',
      'CategoryAI',
      'SignalAutomatedBrowser',
      'SignalKnownBotDataCenter',
      'SignalNonBrowserUserAgent',
    ];

    // Fully-qualified AI-crawler label emitted by the Bot Control CategoryAI rule.
    const AI_BOT_LABEL = 'awswaf:managed:aws:bot-control:bot:category:ai';

    // Bot Control does real bot confirmation (reverse DNS / host validation) and
    // marks the ones that pass with this label — for a verified bot it also
    // deliberately withholds the signal labels so nothing downstream blocks it.
    // An impostor presenting Googlebot's UA gets category:search_engine WITHOUT
    // bot:verified; that asymmetry is the discriminator the impostor rule below
    // is built on.
    const VERIFIED_BOT_LABEL = 'awswaf:managed:aws:bot-control:bot:verified';

    // Good-bot categories whose real members Bot Control VERIFIES. For these, a
    // category claim without bot:verified is evidence of impersonation — every
    // genuine search engine or social-media crawler passes host validation, so
    // the only thing left in (category AND NOT verified) is a scraper wearing
    // their clothes. Deliberately NOT the whole BOT_CATEGORIES list: Bot Control
    // verifies (almost) nobody in monitoring/seo/advertising, so requiring
    // verification there would maze every legitimate member of those categories —
    // the exact good-bot harm (threat model H3) this rule must not reintroduce.
    const IMPERSONATED_GOOD_BOT_CATEGORIES = ['search_engine', 'social_media'];

    // The category labels alone do NOT catch the impostor, measured live on this
    // WebACL (2026-08-23): a spoofed Googlebot UA from an unverified IP matches
    // ONLY SignalNonBrowserUserAgent at COMMON level — Bot Control withholds the
    // name/category labels from a verified-list bot that fails host validation
    // (CategorySearchEngine has never matched in this ACL's lifetime). The claim
    // the impostor actually makes is the User-Agent string, so the rule matches
    // that claim directly, byte-for-byte. Exact casing on purpose: these tokens
    // are the verbatim strings the real crawlers send, and an impostor's whole
    // aim is to copy them verbatim — a miscased "gOOglebot" fools no allowlist
    // and earns no pass anywhere else either. The category-label arm stays as a
    // second net in case Bot Control ever starts labeling failed claimants.
    const GOOD_BOT_UA_CLAIMS = [
      // Search engines on Bot Control's verified list.
      'Googlebot',
      'AdsBot-Google',
      'bingbot',
      'DuckDuckBot',
      'Baiduspider',
      'YandexBot',
      // Social-media fetchers, same property: the real ones verify.
      'facebookexternalhit',
      'Twitterbot',
      'LinkedInBot',
      'Slackbot',
    ];

    // Bot Control's verdict is the one dimension neither the edge nor the access log can
    // derive for itself, and it is what makes cohort analysis meaningful: "scraping
    // framework" and "verified search engine" are very different visitors.
    //
    // Labels never leave the WebACL, and inserted header VALUES are static strings — no
    // interpolation, so there is no way to write "the label that matched" into a header.
    // The way through is to enumerate: one Count rule per label we care about, each
    // inserting its own literal. Count so evaluation continues and the decoy directive
    // still applies. Priorities sit above BotControl (10) because a label does not exist
    // until the rule that writes it has run.
    const BOT_CATEGORIES = [
      'search_engine',
      'content_fetcher',
      'scraping_framework',
      'monitoring',
      'seo',
      'advertising',
    ];
    const categoryRules: wafv2.CfnWebACL.RuleProperty[] = BOT_CATEGORIES.map((cat, i) => ({
      name: `TagBot${cat.replace(/(^|_)(\w)/g, (_m, _p, c) => c.toUpperCase())}`,
      priority: 11 + i,
      action: {
        count: {
          customRequestHandling: {
            insertHeaders: [{ name: 'bot-category', value: cat }],
          },
        },
      },
      statement: {
        labelMatchStatement: {
          scope: 'LABEL',
          key: `awswaf:managed:aws:bot-control:bot:category:${cat}`,
        },
      },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `TagBot_${cat}`,
        sampledRequestsEnabled: false,
      },
    }));

    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'MazeWebAcl',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AllowMazeIngest',
          priority: 5,
          // Terminating Allow: short-circuits the whole WebACL for our own
          // ingestion requests, so no Bot Control label (and therefore no decoy
          // directive) can ever attach to them.
          action: { allow: {} },
          statement: {
            byteMatchStatement: {
              // `singleHeader` is an untyped (any) passthrough in the L1 resource,
              // so it takes the CloudFormation-cased key `Name` verbatim. A
              // DEDICATED header, not the User-Agent: ingestion replays the
              // crawler's own UA, so the secret must not live there.
              fieldToMatch: { singleHeader: { Name: INGEST_HEADER } },
              // EXACTLY: the header carries nothing but the secret.
              // CloudFormation base64-encodes searchString for us.
              searchString: INGEST_SECRET,
              positionalConstraint: 'EXACTLY',
              textTransformations: [{ priority: 0, type: 'NONE' }],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AllowMazeIngest',
            // Sampling off: sampled requests would echo the secret header.
            sampledRequestsEnabled: false,
          },
        },
        {
          name: 'BotControl',
          priority: 10,
          // Do not override the group's per-rule actions wholesale; keep them as
          // configured below (each explicitly Count via ruleActionOverrides).
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesBotControlRuleSet',
              managedRuleGroupConfigs: [
                { awsManagedRulesBotControlRuleSet: { inspectionLevel: 'COMMON' } },
              ],
              ruleActionOverrides: botControlCommonRules.map((name) => ({
                name,
                actionToUse: { count: {} },
              })),
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'BotControl',
            sampledRequestsEnabled: true,
          },
        },
        ...categoryRules,
        {
          // A good-bot category claim that Bot Control could not verify is an
          // impostor — e.g. a scraper presenting Googlebot's User-Agent from an
          // unverified IP (which, before this rule, was simply served the real
          // page). Genuinely verified good bots carry bot:verified and fall
          // through to the site untouched, so this closes the impersonation gap
          // without mazing real search engines.
          //
          // DO NOT invert this into the canonical AWS example (a TERMINATING
          // Allow on bot:verified): if AI crawlers ever pass Bot Control's
          // verification, a blanket allow-verified rule would short-circuit the
          // WebACL for exactly the crawlers the maze targets and walk them
          // out of the maze. The maze stays opt-in on category:ai (below) plus
          // this rule's proven-impostor match.
          //
          // Priority sits after BotControl (10) because the labels do not exist
          // until it has run, and after the TagBot rules so the claimed category
          // (e.g. bot-category: search_engine) still rides the request into the
          // access log — an impostor cohort is visible there as a "good" category
          // that got decoys. This rule is identified by its own metric.
          name: 'UnverifiedGoodBotDecoyDirective',
          priority: 17,
          action: {
            // Count (non-terminating) + the same decoy directive AiDecoyDirective
            // inserts; the CFF (not WAF) decides block/allow on a decoy miss.
            count: {
              customRequestHandling: {
                insertHeaders: [
                  { name: 'decoy-needed', value: '1' },
                  { name: 'decoy-miss-action', value: 'block' },
                ],
              },
            },
          },
          statement: {
            andStatement: {
              statements: [
                {
                  orStatement: {
                    statements: [
                      ...IMPERSONATED_GOOD_BOT_CATEGORIES.map((cat) => ({
                        labelMatchStatement: {
                          scope: 'LABEL',
                          key: `awswaf:managed:aws:bot-control:bot:category:${cat}`,
                        },
                      })),
                      ...GOOD_BOT_UA_CLAIMS.map((token) => ({
                        byteMatchStatement: {
                          // `singleHeader` takes the CloudFormation-cased key
                          // `Name` verbatim (untyped passthrough, as above).
                          fieldToMatch: { singleHeader: { Name: 'user-agent' } },
                          searchString: token,
                          positionalConstraint: 'CONTAINS',
                          textTransformations: [{ priority: 0, type: 'NONE' }],
                        },
                      })),
                    ],
                  },
                },
                {
                  notStatement: {
                    statement: {
                      labelMatchStatement: { scope: 'LABEL', key: VERIFIED_BOT_LABEL },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'UnverifiedGoodBotDecoyDirective',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AiDecoyDirective',
          priority: 20,
          action: {
            // Count (non-terminating) + inject decoy directive headers the CFF
            // reads. The CFF (not WAF) decides block/allow on a decoy miss.
            count: {
              customRequestHandling: {
                insertHeaders: [
                  { name: 'decoy-needed', value: '1' },
                  { name: 'decoy-miss-action', value: 'block' },
                  // This rule already inserts headers, so `ai` rides along here rather
                  // than costing another rule of its own.
                  { name: 'bot-category', value: 'ai' },
                ],
              },
            },
          },
          statement: {
            labelMatchStatement: { scope: 'LABEL', key: AI_BOT_LABEL },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AiDecoyDirective',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate the WebACL with the distribution (CfnDistribution.WebACLId).
    const cfnDist = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDist.addPropertyOverride('DistributionConfig.WebACLId', webAcl.attrArn);

    // ---------------------------------------------------------------------
    // 9. CFF log group + subscription -> parser. CloudFront Functions log to
    //    /aws/cloudfront/function/<fn-name> in us-east-1. Pre-create it so the
    //    subscription is deterministic.
    // ---------------------------------------------------------------------
    const cffLogGroup = new logs.LogGroup(this, 'CffLogGroup', {
      logGroupName: `/aws/cloudfront/function/${viewerFn.functionName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    new logs.SubscriptionFilter(this, 'CffToParser', {
      logGroup: cffLogGroup,
      destination: new LambdaDestination(parser),
      filterPattern: logs.FilterPattern.literal('LBY'),
    });
    // ---------------------------------------------------------------------
    // 9a. CloudFront access logs -> CloudWatch Logs (standard logging v2).
    //
    //     For the signal that matters most, this is the right log rather than the edge
    //     function's. A decoy's links are absolute and carry `?s=<page id>`, so when a
    //     FUTURE VISITOR arrives on one — a person who got the URL from a model that
    //     had been trained on our fiction — that request is not flagged by WAF, the
    //     viewer-request function returns early, and the edge log says nothing.
    //
    //     Access logs record every request's full query string, user agent, referer and
    //     status regardless of any of that, and cost the edge function nothing: it has
    //     ~250 bytes of headroom against the 10 KB limit, which is not the place to put
    //     an event CloudFront already writes for free.
    //
    //     Field list is deliberate and excludes `c-ip`: attribution here is about which
    //     DECOY travelled, not who read it, and an address is the one field that turns
    //     this into personal data. The fields that remain are not automatically safe:
    //     user agents and referrer URLs can still constitute personal data under GDPR
    //     when combined with other request attributes, so anyone taking this to
    //     production over EU traffic owns that assessment (see the retention note on
    //     the lake bucket below).
    // ---------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'AccessLogGroup', {
      logGroupName: `/aws/cloudfront/access/${this.stackName}`,
      // A HOT WINDOW only. The durable copy is Parquet in S3 (below), so this exists to
      // make the dashboard live rather than to retain anything. Access logs cover every
      // request from traffic this system deliberately attracts, and CloudWatch Logs
      // ingestion is ~20x S3 per GB — the shorter this is, the better.
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const deliverySource = new logs.CfnDeliverySource(this, 'AccessLogSource', {
      name: `${this.stackName}-cf-access`,
      logType: 'ACCESS_LOGS',
      resourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    });

    const deliveryDestination = new logs.CfnDeliveryDestination(this, 'AccessLogDestination', {
      name: `${this.stackName}-cf-access-cwl`,
      outputFormat: 'json',
      destinationResourceArn: accessLogGroup.logGroupArn,
    });

    const accessRecordFields = [
        'timestamp',
        'cs-method',
        'cs-uri-stem',
        'cs-uri-query',
        'sc-status',
        'cs(Referer)',
        'cs(User-Agent)',
        'x-edge-result-type',
        'x-host-header',
        // Written by cf.logCustomData() in the viewer-request function: the maze state
        // only the edge knows (context, version, page id, media, referring decoy),
        // landing on the SAME record as the request that caused it. Without this field
        // in the delivery config the data is emitted and silently discarded.
        'viewer-request-log-data',
    ];

    const accessLogDelivery = new logs.CfnDelivery(this, 'AccessLogDelivery', {
      deliverySourceName: deliverySource.name,
      deliveryDestinationArn: deliveryDestination.attrArn,
      recordFields: accessRecordFields,
    });
    accessLogDelivery.addDependency(deliverySource);
    accessLogDelivery.addDependency(deliveryDestination);

    // ---------------------------------------------------------------------
    // 9a-2. The analytics store: the same access logs, delivered to S3 as Parquet.
    //
    //     CloudWatch Logs is the wrong home for the question this system exists to
    //     answer. The chain runs serve -> scraped -> trained -> a model surfaces the URL
    //     -> a person clicks, and that takes MONTHS. A 14-day log group deletes the serve
    //     record long before the arrival happens, so the join is impossible regardless of
    //     how good the query engine is. That is data loss, not a query limitation.
    //
    //     So S3 holds the durable copy, in Parquet, Hive-partitioned by hour: columnar
    //     scans, years of retention, and Athena for the joins Insights cannot express.
    //     CloudWatch Logs keeps a short hot window for the live dashboard. Same delivery
    //     source, second destination — no Firehose, no Lambda, no transform code.
    //
    //     Cost points the same way: CloudWatch Logs ingestion is ~20x S3 per GB, and the
    //     traffic this system attracts is exactly the high-volume kind.
    // ---------------------------------------------------------------------
    const lakeBucket = new s3.Bucket(this, 'LakeBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        // Long enough to see a decoy served today produce an arrival next spring.
        // Retention trade-off, not a default to inherit blindly: the lake keeps user
        // agents and referrer URLs for 400 days, and those can be personal data under
        // GDPR and similar regimes even with `c-ip` excluded. Deploying this beyond a
        // sample means picking a retention period against your own compliance
        // obligations, not shipping this one.
        { id: 'expire-raw', expiration: cdk.Duration.days(400) },
      ],
    });

    const lakeDestination = new logs.CfnDeliveryDestination(this, 'LakeDestination', {
      name: `${this.stackName}-cf-access-s3`,
      outputFormat: 'parquet',
      destinationResourceArn: lakeBucket.bucketArn,
    });

    const lakeDelivery = new logs.CfnDelivery(this, 'LakeDelivery', {
      deliverySourceName: deliverySource.name,
      deliveryDestinationArn: lakeDestination.attrArn,
      // Hive-style partitions so Athena can prune by hour without a crawler.
      s3EnableHiveCompatiblePath: true,
      s3SuffixPath: 'access/{yyyy}/{MM}/{dd}/{HH}',
      recordFields: accessRecordFields,
    });
    lakeDelivery.addDependency(deliverySource);
    lakeDelivery.addDependency(lakeDestination);

    const glueDb = new glue.CfnDatabase(this, 'LakeDatabase', {
      catalogId: this.account,
      databaseInput: { name: `${this.stackName.toLowerCase()}_lake` },
    });

    // Athena results have to live somewhere; keep them out of the raw data prefix and
    // expire them quickly — they are derived and cheap to recompute.
    const athenaResults = new s3.Bucket(this, 'AthenaResults', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ id: 'expire-results', expiration: cdk.Duration.days(7) }],
    });

    const workGroup = new athena.CfnWorkGroup(this, 'LakeWorkGroup', {
      name: `${this.stackName}-lake`,
      state: 'ENABLED',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        resultConfiguration: { outputLocation: `s3://${athenaResults.bucketName}/results/` },
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: true,
        // A runaway scan on a year of logs is the one way this gets expensive.
        bytesScannedCutoffPerQuery: 10 * 1024 * 1024 * 1024,
      },
    });

    // Table over the Parquet, with PARTITION PROJECTION rather than a crawler: the layout
    // is known and regular, so paying a crawler to rediscover it hourly buys nothing.
    // Column names come from the delivered files, where CloudFront normalises `cs(Referer)`
    // and `viewer-request-log-data` to underscores — read from an actual object rather
    // than assumed, because a mismatch here reads as an empty table, not an error.
    const lakePrefix =
      `s3://${lakeBucket.bucketName}/AWSLogs/aws-account-id=${this.account}/CloudFront/access`;
    const lakeTableName = 'cf_access';
    const lakeTable = new glue.CfnTable(this, 'LakeTable', {
      catalogId: this.account,
      databaseName: `${this.stackName.toLowerCase()}_lake`,
      tableInput: {
        name: lakeTableName,
        tableType: 'EXTERNAL_TABLE',
        parameters: {
          classification: 'parquet',
          'projection.enabled': 'true',
          'projection.year.type': 'integer',
          'projection.year.range': '2026,2027',
          'projection.year.digits': '4',
          'projection.month.type': 'integer',
          'projection.month.range': '1,12',
          'projection.month.digits': '2',
          'projection.day.type': 'integer',
          'projection.day.range': '1,31',
          'projection.day.digits': '2',
          'storage.location.template':
            `${lakePrefix}/year=\${year}/month=\${month}/day=\${day}`,
        },
        // DAILY partitions, not hourly, even though the files land in hour=NN folders —
        // Athena reads a partition prefix recursively, so the hour survives as layout
        // without becoming a partition key. Hourly meant ~21,600 candidate prefixes
        // across the projected range and 45s to answer a 7-row question; daily is 1/24
        // of that. Hour is still available from the `timestamp` column when needed.
        partitionKeys: [
          { name: 'year', type: 'string' },
          { name: 'month', type: 'string' },
          { name: 'day', type: 'string' },
        ],
        storageDescriptor: {
          location: lakePrefix,
          inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
          serdeInfo: {
            serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
          },
          columns: [
            { name: 'timestamp', type: 'string' },
            { name: 'cs_method', type: 'string' },
            { name: 'cs_uri_stem', type: 'string' },
            { name: 'cs_uri_query', type: 'string' },
            { name: 'sc_status', type: 'string' },
            { name: 'cs_referer', type: 'string' },
            { name: 'cs_user_agent', type: 'string' },
            { name: 'x_edge_result_type', type: 'string' },
            { name: 'x_host_header', type: 'string' },
            { name: 'viewer_request_log_data', type: 'string' },
          ],
        },
      },
    });
    lakeTable.addDependency(glueDb);

    // Every query starts from the same shape, so it lives in one place. The custom field
    // is URL-encoded JSON, which Athena reads properly with url_decode +
    // json_extract_scalar — no regex against %22, unlike Logs Insights.
    //
    // EVERY query must filter on the partition columns. With projection, a query that
    // does not is asked to enumerate every hour in the projected range — years × 12 × 31
    // × 24 — and a 7-row table takes minutes while Athena lists S3 prefixes that will
    // never exist. The lookback is the cost dial: `days` prunes to days × 24 partitions.
    const lakeBase = (days: number) => `
WITH r AS (
  SELECT
    from_unixtime(CAST("timestamp" AS bigint))            AS at,
    cs_uri_stem                                            AS path,
    cs_uri_query                                           AS query,
    sc_status                                              AS status,
    url_decode(cs_user_agent)                              AS agent,
    url_decode(cs_referer)                                 AS referer,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.e')     AS event,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.bot')   AS bot_category,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.ctx')   AS ctx,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.ver')   AS version,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.dpid')  AS dpid,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.media') AS media,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.kind')  AS carrier,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.wm')    AS wm,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.tid')   AS tid,
    json_extract_scalar(url_decode(viewer_request_log_data), '$.from')  AS came_from,
    regexp_extract(cs_uri_query, 's=([a-f0-9]+)', 1)        AS arrival_token
  FROM ${lakeTableName}
  WHERE concat(year, month, day) >= date_format(current_date - interval '${days}' day, '%Y%m%d')
)`;

    const namedQuery = (id: string, name: string, description: string, sql: string) => {
      const nq = new athena.CfnNamedQuery(this, id, {
        database: `${this.stackName.toLowerCase()}_lake`,
        workGroup: workGroup.name,
        name: `${this.stackName} — ${name}`,
        description,
        queryString: sql,
      });
      // `workGroup.name` is a literal string, so CloudFormation sees no edge
      // between the two resources — on a FRESH stack the query races the
      // workgroup and fails create with "WorkGroup is not found".
      nq.addDependency(workGroup);
      return nq;
    };

    namedQuery(
      'NqDecoys',
      '01 one row per decoy',
      'Served, read and how, per decoy — with the real path and the WAF verdict.',
      `${lakeBase(30)}
SELECT
  coalesce(wm, substr(dpid, 4, 8))                       AS watermark,
  max_by(path, at) FILTER (WHERE event = 'serve')        AS real_path,
  max_by(version, at) FILTER (WHERE event = 'serve')     AS version,
  max_by(bot_category, at) FILTER (WHERE event = 'serve') AS bot_category,
  count_if(event = 'serve')                              AS times_served,
  count_if(event = 'read')                               AS times_read,
  count_if(carrier = 'css')                              AS rendered,
  count_if(carrier = 'svg')                              AS displayed,
  count_if(carrier = 'link')                             AS link_followed,
  count(DISTINCT agent)                                  AS distinct_agents,
  min(at)                                                AS first_seen,
  max(at)                                                AS last_seen
FROM r
WHERE dpid IS NOT NULL OR wm IS NOT NULL
GROUP BY 1
ORDER BY times_read DESC, times_served DESC
LIMIT 100`,
    );

    namedQuery(
      'NqLatency',
      '02 attribution latency — serve to arrival',
      'Days between serving a decoy and someone arriving on its link. The question the lake exists for.',
      `${lakeBase(400)},
served AS (
  SELECT substr(dpid, 4, 8) AS watermark, min(at) AS served_at, min_by(path, at) AS real_path
  FROM r WHERE event = 'serve' GROUP BY 1
),
arrived AS (
  SELECT arrival_token AS watermark, min(at) AS first_arrival, count(*) AS arrivals,
         max_by(referer, at) AS latest_referer, max_by(agent, at) AS latest_agent
  FROM r WHERE arrival_token <> '' GROUP BY 1
)
SELECT a.watermark, s.real_path, s.served_at, a.first_arrival,
       date_diff('day', s.served_at, a.first_arrival) AS days_to_first_arrival,
       a.arrivals, a.latest_referer, a.latest_agent
FROM arrived a LEFT JOIN served s ON s.watermark = a.watermark
ORDER BY a.first_arrival DESC
LIMIT 100`,
    );

    namedQuery(
      'NqCohorts',
      '03 cohorts by WAF verdict',
      'What each Bot Control category actually does: fetch, render, follow links.',
      `${lakeBase(30)}
SELECT
  coalesce(nullif(bot_category, ''), 'unclassified') AS bot_category,
  agent,
  count_if(event = 'serve')      AS decoys_served,
  count_if(carrier = 'css')      AS pages_rendered,
  count_if(carrier = 'svg')      AS data_displayed,
  count_if(carrier = 'link')     AS links_followed,
  count_if(came_from <> '')      AS arrived_from_a_decoy,
  count(DISTINCT ctx)            AS distinct_contexts
FROM r
GROUP BY 1, 2
ORDER BY decoys_served DESC
LIMIT 100`,
    );

    namedQuery(
      'NqOffsite',
      '04 arrivals from off-site',
      'Someone arrived on a decoy URL referred from somewhere that is not us — the content travelled.',
      `${lakeBase(30)}
SELECT arrival_token AS watermark, referer, path, agent, status, count(*) AS arrivals,
       min(at) AS first_seen, max(at) AS last_seen
FROM r
WHERE arrival_token <> ''
  AND referer <> '-'
  AND referer NOT LIKE '%' || '${distribution.distributionDomainName}' || '%'
GROUP BY 1, 2, 3, 4, 5
ORDER BY arrivals DESC
LIMIT 100`,
    );

    namedQuery(
      'NqGraph',
      '05 crawl graph',
      'Which decoy led a crawler onward, from the token its links carry.',
      `${lakeBase(30)}
SELECT came_from AS from_decoy, count(*) AS follows,
       count(DISTINCT path) AS pages_reached, count(DISTINCT agent) AS distinct_agents,
       array_join(array_agg(DISTINCT path ORDER BY path), ', ') AS reached
FROM r
WHERE came_from IS NOT NULL AND came_from <> ''
GROUP BY 1
ORDER BY follows DESC
LIMIT 50`,
    );

    // Named queries cannot take parameters, so the trace query ships with a literal
    // placeholder to edit in the console. It replaces the old trace script for the
    // log side of a lookup; the snapshot side (canary phrase -> context) is a PartiQL
    // scan of the snapshot table in the DynamoDB console.
    namedQuery(
      'NqTrace',
      '06 trace one watermark end to end',
      "Every record touching one watermark — serve, read, and arrival. Replace 'REPLACE_ME' with a watermark, the first 8 hex of a dpid, or an arrival token.",
      `${lakeBase(400)}
SELECT at, event, path, status,
       coalesce(wm, substr(dpid, 4, 8), nullif(arrival_token, '')) AS watermark,
       version, media, carrier, agent, referer, came_from
FROM r
WHERE 'REPLACE_ME' IN (wm, substr(dpid, 4, 8), arrival_token, came_from)
ORDER BY at
LIMIT 200`,
    );

    new cdk.CfnOutput(this, 'LakeBucketName', { value: lakeBucket.bucketName });
    new cdk.CfnOutput(this, 'LakeDatabaseName', { value: `${this.stackName.toLowerCase()}_lake` });
    new cdk.CfnOutput(this, 'LakeWorkGroupName', { value: workGroup.name });

    // ---------------------------------------------------------------------
    // 9b. Reporting: metrics, saved queries and a dashboard.
    //
    //     Everything the maze knows about a crawl is in the edge log as one
    //     `LBY {json}` line per event, because decoys deliberately carry no
    //     identifier of their own. Grepping that by hand does not scale, so the
    //     events become CloudWatch metrics (cheap to chart and alarm on) while the
    //     id-level questions stay as saved Logs Insights queries (too
    //     high-cardinality for metrics: dpid, tracking id, user agent).
    //
    //     The log line is NOT pure JSON — CloudFront prefixes it with a request id —
    //     so the filters match quoted substrings rather than JSON selectors.
    // ---------------------------------------------------------------------
    const METRICS_NS = `AiMaze/${this.stackName}`;
    const countMetric = (
      id: string,
      metricName: string,
      substring: string,
      logGroup: logs.ILogGroup = cffLogGroup,
    ) => {
      new logs.MetricFilter(this, id, {
        logGroup,
        filterPattern: logs.FilterPattern.literal(`"${substring}"`),
        metricNamespace: METRICS_NS,
        metricName,
        metricValue: '1',
        defaultValue: 0,
      });
      return new cloudwatch.Metric({
        namespace: METRICS_NS,
        metricName,
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });
    };

    // One metric per event the edge emits. Together they answer "is the maze
    // working, and what is it costing" without reading a single log line.
    // These come from the ACCESS log now: the edge no longer console.logs serves or
            // beacon hits, because the access-log record already carries them alongside the
            // request itself. The custom field is URL-encoded, hence %22 rather than a quote.
    const mServed = countMetric('MfServed', 'DecoysServed', '%22e%22:%22serve%22', accessLogGroup);
    const mAsked = countMetric('MfAsked', 'DecoysRequested', '\\"e\\":\\"decoy_needed\\"');
    const mRotate = countMetric('MfRotate', 'RotationsRequested', '\\"reason\\":\\"stale\\"');
    // Asks dropped by the generation admission budget (threat model M2). Emitted by
    // the PARSER, not the edge: the budget is enforced where asks become spend. A
    // non-zero value means the spend ceiling is binding — an attack, or a cap set
    // too low for organic crawl demand.
    const mBudget = countMetric(
      'MfBudget',
      'GenBudgetExhausted',
      '\\"e\\":\\"budget_exhausted\\"',
      parserLogGroup,
    );
    const mSuppressed = countMetric('MfSuppressed', 'AsksSuppressed', '%22e%22:%22suppressed%22', accessLogGroup);
    // The ones that say the content was READ, not just handed over.
    const mBeacon = countMetric('MfBeacon', 'WatermarkBeaconHits', '%22e%22:%22read%22', accessLogGroup);
    // Split by carrier, because they mean different things. A `css` hit is the decoy's
    // own stylesheet: the client RENDERED the page, with no cooperation required —
    // this is the signal that survives a harvester that ignores every link. A `link`
    // hit means something chose to follow the text-alternative link.
    const mRender = countMetric('MfRender', 'BeaconRenderHits', '%22kind%22:%22css%22', accessLogGroup);
    // json decoys have no renderer to exploit, so their carrier is an image URL sitting
    // in the payload's own schema: a hit means something DISPLAYED the data.
    const mImage = countMetric('MfImage', 'BeaconImageHits', '%22kind%22:%22svg%22', accessLogGroup);
    const mFollow = countMetric('MfFollow', 'BeaconLinkHits', '%22kind%22:%22link%22', accessLogGroup);

    // THE one worth an alarm: someone arrived on a decoy's link. Decoy links are
    // absolute and carry `?s=<page id>`, so a request landing here came from decoy
    // content that travelled — and if the visitor looks like a browser and the referer
    // is somewhere that is not us, the content reached a PERSON, most plausibly via a
    // model that had read it. Counted from the ACCESS log because such a visitor is not
    // flagged by WAF and the edge function never sees them as a candidate.
    //
    // A quoted substring, anchored to the start of the query-string VALUE: a bare "s="
    // also matches any user agent or referer containing it, which is most of them.
    const mReferral = countMetric(
      'MfReferral',
      'DecoyLinkArrivals',
      '\\"cs-uri-query\\":\\"s=',
      accessLogGroup,
    );

    // Saved Logs Insights queries. These live in the console ready to run, so the
    // id-level questions do not depend on anyone having the repo checked out.
    const savedQuery = (id: string, name: string, query: string) =>
      new logs.CfnQueryDefinition(this, id, {
        name: `AI Maze/${this.stackName}/${name}`,
        logGroupNames: [cffLogGroup.logGroupName],
        queryString: query,
      });
    // Field names in the log are terse to stay inside the 10 KB edge-function limit,
    // so every query relabels them to a full name with the log's own key in
    // parentheses — readable in the console, still greppable against raw log lines.
    const LBY = 'parse @message "LBY *" as body | parse body /"e":"(?<ev>[^"]+)"/';
    const P = {
      wm: 'parse body /"wm":"(?<wm>[^"]+)"/',
      ua: 'parse body /"ua":"(?<ua>[^"]*)"/',
      ref: 'parse body /"ref":"(?<ref>[^"]*)"/',
      dpid: 'parse body /"dpid":"(?<dpid>[^"]+)"/',
      ctx: 'parse body /"ctx":"(?<ctx>[^"]+)"/',
      ver: 'parse body /"ver":"(?<ver>[^"]+)"/',
      tid: 'parse body /"tid":"(?<tid>[^"]+)"/',
      reason: 'parse body /"reason":"(?<reason>[^"]+)"/',
      media: 'parse body /"media":"(?<media>[^"]+)"/',
      kind: 'parse body /"kind":"(?<kind>[^"]+)"/',
      from: 'parse body /"from":"(?<from>[^"]*)"/',
      // The real path the decoy stands in for. `ctx` is sha256 of it, so without this
      // every table reads as opaque hashes.
      path: 'parse body /"source":"(?<path>[^"]*)"/',
    };
    const LABEL = {
      wm: '`Watermark (wm)`',
      ua: '`User agent (ua)`',
      ref: '`Referrer (ref)`',
      dpid: '`Decoy page id (dpid)`',
      ctx: '`Context (ctx)`',
      ver: '`Version (ver)`',
      tid: '`Tracking id (tid)`',
      ev: '`Event (ev)`',
      reason: '`Reason (reason)`',
      media: '`Media type (media)`',
      kind: '`Beacon carrier (kind)`',
      from: '`Referring decoy (from)`',
      path: '`Real path (source)`',
    };

    // Watermark -> the real path it stands in for, with reads and serves side by side.
    // `wm` is the first 8 hex of `dpid`, so one pass over both event types correlates
    // them: substr(dpid, 3, 8) strips the `dp_` prefix. `earliest(path)` lands on a
    // serve row because a decoy is always served before it can be read, and a row with
    // reads but ZERO serves means the content was read somewhere that is not us.
    const Q_DEMAND =
      `${LBY} | ${P.reason} | ${P.ctx} | ${P.path} ` +
      `| filter ev = 'decoy_needed' ` +
      `| fields ev as ${LABEL.ev}, reason as ${LABEL.reason}, ctx as ${LABEL.ctx}, path as ${LABEL.path} ` +
      `| stats count() as \`Asks\` by ${LABEL.reason}, ${LABEL.path}, ${LABEL.ctx} ` +
      '| sort `Asks` desc | limit 25';

    // Every link a decoy emits carries the EMITTING decoy's token as `?s=`, logged as
    // `from`. That reconstructs the crawl graph from the log alone, without depending
    // on Referer — which crawlers routinely omit.
    // The edge log is the CONTROL PLANE now: the only thing worth querying there is why
    // generation was asked for. Everything else moved to the access log (hot) and the
    // S3/Athena lake (durable) — see the named queries above.
    savedQuery('QDemand', '01 Generation demand — which real path asked, and why', Q_DEMAND);

    // Access-log queries: a different log group, so they carry their own SOURCE.
    // CloudFront writes these as JSON, so the fields are parsed already — they just
    // need backticks, because every one of them has a hyphen or parentheses.
    const Q_ARRIVALS =
      "filter `cs-uri-query` like /s=/ " +
      '| parse `cs-uri-query` /s=(?<token>[a-f0-9]+)/ ' +
      '| fields token as `Watermark (wm)`, `cs-uri-stem` as `Landed on`, ' +
      '`cs(Referer)` as `Came from`, `cs(User-Agent)` as `User agent (ua)`, ' +
      '`sc-status` as `Status` ' +
      '| stats count() as `Arrivals`, count_distinct(`Landed on`) as `Distinct pages`, ' +
      'latest(`Came from`) as `Latest referrer` ' +
      'by `Watermark (wm)`, `User agent (ua)` ' +
      '| sort `Arrivals` desc | limit 25';

    const Q_ARRIVALS_OFFSITE =
      "filter `cs-uri-query` like /s=/ " +
      "| filter `cs(Referer)` != '-' and `cs(Referer)` not like /cloudfront.net/ " +
      '| parse `cs-uri-query` /s=(?<token>[a-f0-9]+)/ ' +
      '| fields token as `Watermark (wm)`, `cs(Referer)` as `Came from`, ' +
      '`cs-uri-stem` as `Landed on`, `cs(User-Agent)` as `User agent (ua)` ' +
      '| stats count() as `Arrivals` by `Came from`, `Watermark (wm)`, `Landed on`, `User agent (ua)` ' +
      '| sort `Arrivals` desc | limit 25';

    // ONE row per decoy, from ONE log. cf.logCustomData() puts the maze's derived state
    // on the access-log record for the request that caused it, so served-vs-read no
    // longer needs two log groups and a join Insights cannot do.
    //
    // Two things this query had to learn the hard way:
    //   * CloudFront URL-ENCODES the custom field, so the patterns match `%22` and not
    //     `"`. Matching on quotes silently returns nothing.
    //   * `substr` is 0-indexed: substr(dp, 0, 8) after stripping `dp_`. Off by one and
    //     one decoy splits into two rows that each look real.
    const CD = '`viewer-request-log-data`';
    const Q_UNIFIED =
      `filter ${CD} like /%22e%22/ ` +
      `| parse ${CD} /%22e%22:%22(?<mev>[^%]+)%22/ ` +
      `| parse ${CD} /%22dpid%22:%22dp_(?<dp>[^%]+)%22/ ` +
      `| parse ${CD} /%22wm%22:%22(?<wmv>[^%]+)%22/ ` +
      `| parse ${CD} /%22kind%22:%22(?<kind>[^%]+)%22/ ` +
      `| parse ${CD} /%22ver%22:%22(?<ver>[^%]+)%22/ ` +
      "| fields coalesce(wmv, substr(dp, 0, 8)) as `Watermark (wm)`, " +
      "coalesce(`cs-uri-stem`, '-') as p, coalesce(ver, '-') as v " +
      "| stats sum(mev = 'serve') as `Times served`, sum(mev = 'read') as `Times read`, " +
      "sum(kind = 'css') as `Rendered`, sum(kind = 'svg') as `Displayed`, " +
      "sum(kind = 'link') as `Link followed`, " +
      'count_distinct(`cs(User-Agent)`) as `Distinct agents`, ' +
      'earliest(p) as `Real path`, earliest(v) as `Version` ' +
      'by `Watermark (wm)` ' +
      '| sort `Times served` desc | limit 25';

    // Who read it: on the access log the agent and referer are real columns, so this no
    // longer needs the edge to duplicate them into its own log line.
    const Q_WHO =
      "filter `viewer-request-log-data` like /%22read%22/ " +
      '| parse `viewer-request-log-data` /%22kind%22:%22(?<kind>[^%]+)%22/ ' +
      '| parse `viewer-request-log-data` /%22wm%22:%22(?<wm>[^%]+)%22/ ' +
      '| fields wm as `Watermark (wm)`, kind as `Beacon carrier (kind)`, ' +
      '`cs(User-Agent)` as `User agent (ua)`, `cs(Referer)` as `Came from` ' +
      '| stats count() as `Times read`, latest(`Came from`) as `Latest referrer` ' +
      'by `Watermark (wm)`, `Beacon carrier (kind)`, `User agent (ua)` ' +
      '| sort `Times read` desc | limit 25';

    const savedAccessQuery = (id: string, name: string, query: string) =>
      new logs.CfnQueryDefinition(this, id, {
        name: `AI Maze/${this.stackName}/${name}`,
        logGroupNames: [accessLogGroup.logGroupName],
        queryString: query,
      });

    savedAccessQuery(
      'QUnified',
      '02 One row per decoy — served, read, and how, from the access log alone',
      Q_UNIFIED,
    );
    savedAccessQuery('QWho', '03 Who read it — agent, referrer and carrier per watermark', Q_WHO);
    savedAccessQuery('QArrivals', '04 Decoy link arrivals — someone came to us on a decoy URL', Q_ARRIVALS);
    savedAccessQuery(
      'QArrivalsOff',
      '05 Decoy link arrivals from OFF-SITE referrers — content that travelled',
      Q_ARRIVALS_OFFSITE,
    );

    const dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${this.stackName}-maze`,
      defaultInterval: cdk.Duration.days(1),
    });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        width: 24,
        height: 11,
        markdown: [
          `# AI Maze — ${this.stackName}`,
          '',
          'Decoys carry **no identifier of their own**, so everything here is built from the',
          'edge log. **Decoys served** is what we handed to crawlers; **watermark beacon hits**',
          'is the one that proves content was actually *read* — each decoy links once to',
          '`/wm/<its own watermark>`, so a hit names the decoy that was followed. An agent with',
          'beacons followed but **zero decoys served** read our text somewhere that is not us.',
          '',
          'Field names are terse in the log (10 KB edge-function limit) and expanded here:',
          '',
          '| Column | Log key | What it is |',
          '|---|---|---|',
          '| Watermark | `wm` | First 32 bits of the decoy page id, hidden in the prose as zero-width characters |',
          '| Decoy page id | `dpid` | `sha256(context:version:slug)[0..16]` — one exact generated page |',
          '| Real path | `source` | The actual path requested — what `ctx` is a hash of |',
          '| Context | `ctx` | `sha256("v1:" + path)[0..20]` — one real URL the maze stands in for |',
          '| Version | `ver` | The sealed snapshot generation; every rotation mints a new one |',
          '| Tracking id | `tid` | Signed per-serve id, never in a URL — groups one crawl together |',
          '| User agent | `ua` | What the client claimed to be |',
          '| Referrer | `ref` | Where a beacon follower came from |',
          '| Event | `ev` | `maze_serve`, `decoy_needed`, `decoy_suppressed`, `canary_hit` |',
          '| Beacon carrier | `kind` | `css` an html decoy was rendered, `svg` a json decoy was displayed, `link` a link was followed |',
          '| Referring decoy | `from` | The decoy whose link the crawler followed to get here — every decoy link carries its own token, so this works without `Referer` |',
          '',
          '**Arrivals on a decoy link** come from the CloudFront ACCESS log, not the edge log:',
          'decoy links are absolute and carry `?s=<page id>`, and a visitor arriving on one is',
          'not flagged by WAF, so the edge function never sees them. An arrival with a',
          'browser-like agent and an off-site referrer means the URL reached a person.',
          '',
          'Reverse lookup, from something found in the wild back to one decoy: canary phrases',
          'and page ids are recorded on every sealed snapshot, so a PartiQL scan of the snapshot',
          'table in the DynamoDB console resolves a phrase or id to one context and version, and',
          'saved Athena query `06 trace one watermark end to end` pulls every record for it.',
          '',
          '**This dashboard is the hot view only.** The chain that matters — served, scraped,',
          'trained, a model surfaces the URL, someone clicks — takes MONTHS, and these log',
          'groups keep days. Historical and joined analysis lives in Athena over the S3 lake:',
          'the saved queries in workgroup `' + `${this.stackName}-lake` + '`.',
        ].join('\n'),
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.SingleValueWidget({
        title: 'Read: pages rendered, data displayed, links followed',
        metrics: [mRender, mImage, mFollow],
        width: 6,
        height: 5,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Arrivals on a decoy link',
        metrics: [mReferral],
        width: 6,
        height: 5,
      }),
      new cloudwatch.SingleValueWidget({
        title: 'Decoys requested vs suppressed vs over budget',
        metrics: [mAsked, mSuppressed, mBudget],
        width: 6,
        height: 5,
      }),
      new cloudwatch.SingleValueWidget({ title: 'Rotations requested (stale fiction)', metrics: [mRotate], width: 6, height: 5 }),
    );
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Maze activity over time (5-minute buckets)',
        left: [mServed, mAsked],
        right: [mBeacon, mRender, mImage, mFollow, mSuppressed, mRotate, mBudget],
        width: 24,
        height: 7,
      }),
    );
    // The dashboard is the HOT view: the last hours or days, from the access log, plus
    // the one edge-log question that is still control plane. Anything historical or
    // joined belongs in Athena over the S3 lake — the console cannot answer "served in
    // August, arrived in November" at all, because the log group does not keep August.
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Who read it — agent, referrer and carrier per watermark',
        logGroupNames: [accessLogGroup.logGroupName],
        queryString: Q_WHO,
        width: 12,
        height: 7,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Generation demand — which real path asked for a decoy, and why',
        logGroupNames: [cffLogGroup.logGroupName],
        queryString: Q_DEMAND,
        width: 12,
        height: 7,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'One row per decoy — served, read, and how (access log alone)',
        logGroupNames: [accessLogGroup.logGroupName],
        queryString: Q_UNIFIED,
        width: 24,
        height: 7,
      }),
    );
    dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        title: 'Arrivals on a decoy link — who came back on a URL we invented',
        logGroupNames: [accessLogGroup.logGroupName],
        queryString: Q_ARRIVALS,
        width: 12,
        height: 7,
      }),
      new cloudwatch.LogQueryWidget({
        title: 'Arrivals referred from OFF-SITE — the content reached someone elsewhere',
        logGroupNames: [accessLogGroup.logGroupName],
        queryString: Q_ARRIVALS_OFFSITE,
        width: 12,
        height: 7,
      }),
    );

    // ---------------------------------------------------------------------
    // 10. Seed the KVS __config__ key (signing secret) via custom resource.
    // ---------------------------------------------------------------------
    const kvsSeeder = new NodejsFunction(this, 'KvsSeeder', {
      runtime,
      architecture: arm,
      ...NODE_ROOT,
      entry: path.join(REPO, 'infra', 'lambda', 'kvs-seeder.mjs'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(1),
      logGroup: mkLogGroup('KvsSeeder', logs.RetentionDays.ONE_WEEK),
      // Same CRT SigV4a signer as the publisher (see note above); the seeder
      // reads + writes the __config__ key on the KVS data-plane. findUp resolves
      // the version from infra/package.json (this entry lives under infra/lambda).
      // The KVS client is co-installed with the signer so both share one
      // signature-v4-multi-region instance (see the publisher note for why).
      bundling: { nodeModules: ['@aws-sdk/signature-v4-crt', '@aws-sdk/client-cloudfront-keyvaluestore'] },
    });
    kvsSeeder.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cloudfront-keyvaluestore:DescribeKeyValueStore',
          // GetKey lets the seeder reuse an existing signing secret across
          // deploys (idempotent: mint once, never rotate on subsequent deploys).
          'cloudfront-keyvaluestore:GetKey',
          'cloudfront-keyvaluestore:PutKey',
          'cloudfront-keyvaluestore:DeleteKey',
        ],
        resources: [kvStore.keyValueStoreArn],
      }),
    );
    const kvsProvider = new cr.Provider(this, 'KvsSeederProvider', { onEventHandler: kvsSeeder });
    new cdk.CustomResource(this, 'KvsConfig', {
      serviceToken: kvsProvider.serviceToken,
      properties: {
        KvsArn: kvStore.keyValueStoreArn,
        TrackingTtlSeconds: '3600',
        DecoyBucketName: DECOY_BUCKET_NAME,
        // The edge function serves decoys in place by repointing the request
        // origin at this bucket, so the domain travels in the KVS config.
        CorpusDomain: corpusBucket.bucketRegionalDomainName,
        RotateTtlSeconds: '86400',
        // Bump to re-invoke the seeder (exercises the CRT SigV4a GetKey/PutKey
        // path and the idempotent secret-reuse logic).
        Version: '4',
      },
    });

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'DistributionDomainName', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new cdk.CfnOutput(this, 'HtmlShowcaseUrl', { value: `https://${distribution.distributionDomainName}/` });
    // SPA entry is referenced as an explicit document (defaultRootObject only
    // applies to the distribution root "/", not to the /app/ sub-path).
    new cdk.CfnOutput(this, 'SpaShowcaseUrl', { value: `https://${distribution.distributionDomainName}/app/index.html` });
    new cdk.CfnOutput(this, 'ApiShowcaseUrl', { value: `https://${distribution.distributionDomainName}/api/products` });
    new cdk.CfnOutput(this, 'SourceBucketName', { value: sourceBucket.bucketName });
    new cdk.CfnOutput(this, 'CorpusBucketName', { value: corpusBucket.bucketName });
    new cdk.CfnOutput(this, 'SnapshotTableName', { value: snapshotTable.tableName });
    new cdk.CfnOutput(this, 'KvsArn', { value: kvStore.keyValueStoreArn });
    new cdk.CfnOutput(this, 'GenQueueUrl', { value: genQueue.queueUrl });
    new cdk.CfnOutput(this, 'CffLogGroupName', { value: cffLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'AccessLogGroupName', { value: accessLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'ParserLogGroupName', { value: parserLogGroup.logGroupName });
    // The budget scenario in e2e-test.sh reads these to decide whether the stack
    // is deployed with a test-sized budget it can exhaust within one run.
    new cdk.CfnOutput(this, 'GenBudgetPerWindow', { value: GEN_BUDGET_PER_WINDOW });
    new cdk.CfnOutput(this, 'GenBudgetWindowSeconds', { value: GEN_BUDGET_WINDOW_SECONDS });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${this.region}.console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboard.dashboardName}`,
    });
  }
}
