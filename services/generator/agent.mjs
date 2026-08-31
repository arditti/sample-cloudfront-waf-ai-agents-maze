// AI Maze — generator "agent" pipeline (runs inside the AgentCore Runtime
// container; see server.mjs for the HTTP entrypoint).
//
// For each context-key message it:
//   1. Fetches the URL the edge function logged for the triggering request,
//      exactly as a visitor would — one HTTPS GET with a browser user agent, plus
//      the ingest pass-through header that keeps WAF from steering ingestion into
//      the maze (see fetch.mjs). Nothing about the site or its origins is
//      assumed or configured here; the URL arrives with the message.
//   2. Detects the ARCHETYPE from the RESPONSE CONTENT-TYPE (see detect.mjs) and
//      ingests accordingly:
//        - json : the probed body already is the content -> sketch its schema.
//        - html : invoke the headless renderer Lambda to EXECUTE the page's JS
//                 and capture the hydrated DOM skeleton + any JSON it fetched
//                 (README: "render the entire page/javascript/data ... rather
//                 than an empty html"). EVERY document goes through this.
//   3. Validates the ingested content with a cheap Bedrock call: is this really
//      the page's content (not an error page, wall, interstitial, empty shell, or
//      a decoy that leaked back), does it match the content-type's verdict, and
//      what is its title/topic. A rejection fails the message — a decoy built
//      from a 403 page resembles nothing.
//   4. Calls Amazon Bedrock Opus 5 for archetype-appropriate decoy content.
//   5. Renders decoys that are STRUCTURALLY ISOMORPHIC to the real thing (same
//      DOM skeleton / same JSON schema), injecting per-decoy tracking IDs.
//   6. Stages content-addressed blobs, seals an immutable DynamoDB snapshot, and
//      CAS-promotes desiredVersion (DynamoDB Streams then wakes the publisher).
//
// Every run produces a NEW version, so a rotation gets new fiction and new page
// ids (dpid = hash(ctx:version:slug)). srcHash is recorded for drift visibility,
// not to skip work: a decoy that never changes while the real page moves is its
// own fingerprint.
//
// The maze is only ever SERVED from private S3.
//
// arm64 / Node.js 24. Runs in a container (not Lambda), so the AWS SDK v3 is a
// declared dependency (see package.json) rather than runtime-provided.

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  BedrockRuntimeClient,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  sanitizeSourceHtml,
  jsonSchemaSketch,
  extractCanaries,
  buildBedrockBody,
  buildIngestAnalystBody,
  renderDecoyPage,
  renderStructuralDecoy,
  renderDecoyJson,
  decoyPageId,
  safeSlug,
  sha256hex,
} from './lib.mjs';
import { archetypeForContentType, assertVerdictUsable, assertNotOwnDecoy } from './detect.mjs';
import { suppressedFor, backoffSeconds, describeDelay } from './backoff.mjs';
import { fetchAsUser, ingestHeaders } from './fetch.mjs';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const bedrock = new BedrockRuntimeClient({});
const lambda = new LambdaClient({});

const STAGING_BUCKET = process.env.STAGING_BUCKET;
const SNAPSHOT_TABLE = process.env.SNAPSHOT_TABLE;
const DECOY_BUCKET_NAME = process.env.DECOY_BUCKET_NAME;
if (!DECOY_BUCKET_NAME) throw new Error('DECOY_BUCKET_NAME must be set — no fallback: a guessable default bucket name could be squatted');
const MODEL_ID = process.env.MODEL_ID || 'us.anthropic.claude-opus-5';
// Second model, tried when the primary will not produce output. Measured, not
// guessed: on this project's generation prompt Opus 5 returned
// stop_reason=refusal on every attempt across a long window while Sonnet 5
// answered it cleanly every time. The refusal is model-specific rather than
// prompt-specific, so retrying the same model harder does not help — switching
// does. Decoy quality is comparable; a maze that generates beats a better-worded
// maze that does not.
const FALLBACK_MODEL_ID = process.env.FALLBACK_MODEL_ID || 'us.anthropic.claude-sonnet-5';
const PAGE_COUNT = parseInt(process.env.PAGE_COUNT || '5', 10);
const EFFORT = process.env.GEN_EFFORT || 'low';
const RENDERER_FN = process.env.RENDERER_FN; // headless renderer Lambda name

/**
 * Process one context-key message end-to-end. Returns a compact summary the
 * AgentCore Runtime relays back to the invoker (or `{skipped}` when there is no
 * resolvable source). Throws on failure so the invoker can report the SQS record
 * as a batch-item failure and let the message retry.
 *
 * @param {{ ctx: string, url?: string, source?: string }} msg
 */
export async function processContext(msg) {
  const ctx = msg.ctx;
  if (!ctx) throw new Error('message missing ctx');

  // The URL comes from the log event that triggered this generation (the edge
  // function records it for the request the crawler actually made), never from
  // configuration here — so the generator ingests exactly what was asked for and
  // holds no assumption about the site's host or path layout.
  const source = msg.url;
  if (!source) {
    console.error(`generator: no source URL for ctx=${ctx}; skipping (no context => no generation)`);
    return { ctx, skipped: true, reason: 'no-source' }; // README: "No context means no contextual generation."
  }

  // Has this context just failed? Some sources can never produce a decoy, and a
  // crawler will keep asking for them, so spend nothing until the backoff elapses.
  // Returning (rather than throwing) means the message is deleted instead of
  // retried, which is the point: retrying a doomed context is the cost we are
  // avoiding.
  const before = await getPointer(ctx);
  const wait = suppressedFor(before, Math.floor(Date.now() / 1000));
  if (wait > 0) {
    console.log(
      `generator: ctx=${ctx} suppressed for another ${describeDelay(wait)} ` +
        `after ${before.failCount} failure(s); last was: ${before.lastFailReason || 'unknown'}`,
    );
    return { ctx, skipped: true, reason: 'backoff', retryInSeconds: wait };
  }

  try {
    return await generateForContext({ ctx, source, replay: msg.headers, pointer: before });
  } catch (err) {
    // Remember the failure before rethrowing, so the next request for this context
    // is suppressed rather than repeating the same work.
    await recordFailure(ctx, err);
    throw err;
  }
}

async function generateForContext({ ctx, source, replay, pointer }) {
  // The self-ingest guard's context-scoped signal: the canaries of this context's
  // current version, which is the decoy a mis-routed ingest of THIS url would be
  // served. Decoys from other contexts are caught by the guard's beacon-carrier
  // signature instead, which needs no lookup.
  const ownCanaries = await currentCanaries(ctx, pointer);

  // 1. Fetch it as a normal visitor, replaying the triggering request's own
  //    headers so the origin varies its response the same way it did for the
  //    crawler (pass-through header keeps WAF from steering ingestion into the
  //    maze).
  const probe = await fetchAsUser(source, replay);

  // 2. The response — not the path — decides the archetype, then ingest.
  assertNotOwnDecoy(probe.body, `${probe.url} (probe)`, ownCanaries);
  const archetype = archetypeForContentType(probe.contentType);
  const src = await ingest(archetype, probe, replay, ownCanaries);

  const srcHash = sha256hex(
    JSON.stringify({ c: probe.contentType, t: src.title, x: src.text, s: src.structure, k: src.sampleSchema }),
  );

  // 3. Validate + parse what was ingested. Throws unless it is real, agreeing
  //    with the content-type verdict, and confidently judged.
  const verdict = await validateIngest({ archetype, source, contentType: probe.contentType, src });

  // 4. Generate with Opus 5, on the validated title/topic.
  const graph = await generate({ archetype, ...src, title: verdict.title || src.title, topic: verdict.topic });

  // 5. Render + stage each decoy (content-addressed), tagged with media/ext.
  const nextVersion = await computeNextVersion(ctx);
  // The origin the decoy will be served from, so its links are absolute and can
  // bring a future visitor back to us. Taken from the URL that triggered generation.
  const { manifest, media, canaries, beacon } = await renderAndStage({
    ctx, version: nextVersion, archetype, graph, structure: src.structure, origin: probe.url,
  });
  if (!manifest.length) throw new Error(`empty decoy set for ctx=${ctx}`);
  // A decoy nobody can later trace is a decoy that taught us nothing. Fail rather
  // than publish one — the canary set is the only provenance the payload's text
  // has, so an empty set is a hard error rather than a silent gap.
  if (!canaries.length) throw new Error(`no traceable canary in the decoy for ctx=${ctx}`);

  // 6. Seal immutable snapshot + CAS desiredVersion (atomic transaction).
  await sealSnapshot({
    ctx,
    version: nextVersion,
    sourceUrl: probe.url,
    srcHash,
    manifest,
    entry: 'index',
    media,
    archetype,
    // Distinctive invented values, so a phrase found in the wild maps back to this
    // exact version via a snapshot-table lookup in the DynamoDB console.
    canaries,
    // Which URL fields (if any) were pointed at the beacon. `null` for a JSON
    // payload with no URL field: attribution there is canaries + serve log only.
    beacon,
    detect: {
      contentType: probe.contentType,
      confidence: verdict.confidence,
      reason: verdict.reason,
      via: 'content-type+llm',
    },
  });
  console.log(`generator: sealed ctx=${ctx} archetype=${archetype} version=${nextVersion} media=${media} pages=${manifest.length}`);
  return { ctx, archetype, version: nextVersion, media, pages: manifest.length };
}

// ---------------------------------------------------------------------------
// Ingestion adapters (origin-agnostic)
// ---------------------------------------------------------------------------

async function ingest(archetype, probe, replay, ownCanaries) {
  if (archetype === 'json') {
    // The probe body already IS the content — no second request.
    let sample;
    try {
      sample = JSON.parse(probe.body);
    } catch {
      throw new Error(`json ingest ${probe.url}: body did not parse as JSON`);
    }
    return { title: '', text: '', sampleSchema: jsonSchemaSketch(sample) };
  }

  // html: EXECUTE the document in the headless renderer. Every document takes
  // this path — a server-rendered page and a client-rendered app are both only
  // honestly observable after their JavaScript has run.
  const rendered = await invokeRenderer(probe.url, replay);
  // The renderer follows its own navigations, so re-check what it ended up on.
  assertNotOwnDecoy(rendered.html, `${rendered.finalUrl || probe.url} (rendered)`, ownCanaries);
  const { title, text: sanitized } = sanitizeSourceHtml(rendered.html || '');
  const text = (rendered.text || '').trim() || sanitized;
  if (!text || text.length < 20) throw new Error('rendered html context too small');
  if (!rendered.structure) throw new Error('renderer returned no DOM skeleton');
  const cap = (rendered.captured || []).find((c) => c && c.json != null);
  return {
    title,
    text,
    structure: rendered.structure,
    sampleSchema: cap ? jsonSchemaSketch(cap.json) : null,
  };
}

async function invokeRenderer(url, replay) {
  if (!RENDERER_FN) throw new Error('RENDERER_FN not configured');
  const out = await lambda.send(
    new InvokeCommand({
      FunctionName: RENDERER_FN,
      InvocationType: 'RequestResponse',
      // Chromium must carry the same pass-through header as the probe, or the
      // renderer's own fetch could be steered into the maze. The replayed headers
      // ride along too, so JS that sniffs the user agent renders the same variant
      // the crawler would have received.
      Payload: Buffer.from(JSON.stringify({ url, headers: ingestHeaders(replay) })),
    }),
  );
  const txt = out.Payload ? Buffer.from(out.Payload).toString('utf-8') : '';
  let parsed;
  try { parsed = JSON.parse(txt); } catch { throw new Error('renderer returned non-JSON: ' + txt.slice(0, 200)); }
  if (out.FunctionError || parsed?.errorType) {
    throw new Error(`renderer failed: ${parsed?.errorMessage || out.FunctionError}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Validation: content-type gave the archetype, the model confirms the content
// ---------------------------------------------------------------------------

/**
 * Confirm the ingested content is worth building a decoy from, and distill its
 * title/topic. Every negative outcome throws so the SQS record fails and retries:
 * a decoy generated from an error page, a login wall, or a leaked-back decoy is
 * worse than no decoy at all, and silently degrading would hide that.
 */
async function validateIngest({ archetype, source, contentType, src }) {
  const verdict = await invokeModelJson(
    buildIngestAnalystBody({
      archetype,
      source,
      contentType,
      title: src.title,
      text: src.text,
      structure: src.structure,
      sampleSchema: src.sampleSchema,
    }),
  );
  const confidence = assertVerdictUsable(verdict, { archetype, source, contentType });
  console.log(`generator: ingest validated source=${source} archetype=${archetype} confidence=${confidence}`);
  return verdict;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

async function generate({ archetype, title, topic, text, structure, sampleSchema }) {
  return invokeModelJson(
    buildBedrockBody({
      archetype,
      title,
      topic,
      text,
      structure,
      sampleSchema,
      pageCount: PAGE_COUNT,
      effort: EFFORT,
    }),
  );
}

// Bedrock throws InternalServerException / ThrottlingException / ModelTimeout as
// ordinary weather at this scale. Retrying in-process is much cheaper than
// failing the SQS record: a retry costs seconds, an SQS redelivery re-runs the
// whole ingest (fetch + headless render) before it gets back here.
//
// `stop_reason: "refusal"` belongs on that list too. Measured against Opus 5 with
// IDENTICAL prompts minutes apart, it fires non-deterministically and cuts the
// completion mid-JSON — the same prompt that refuses once succeeds on the next
// call. It is not a signal to rewrite the prompt; it is a signal to try again.
const TRANSIENT = /InternalServerException|ThrottlingException|ServiceUnavailable|ModelTimeout|ModelNotReady|TooManyRequests/i;
// Truncated or malformed model JSON, and outright refusals, are also worth one
// more attempt: both are per-completion slips rather than bad requests.
const RETRY_OUTPUT = /did not return JSON|no usable JSON|Unexpected token|Expected ',' or|in JSON at position|stop_reason=refusal/i;

/**
 * Invoke the model and parse its response as a single JSON object, retrying and
 * then falling back to the secondary model. The first half of the attempts go to
 * the primary; the rest go to the fallback, because a refusal is a property of the
 * model rather than of the request and more attempts at the same one just burn
 * time.
 */
async function invokeModelJson(body, attempts = 4) {
  const switchAt = Math.ceil(attempts / 2);
  for (let attempt = 1; ; attempt++) {
    const modelId = attempt <= switchAt ? MODEL_ID : FALLBACK_MODEL_ID;
    try {
      const out = await invokeModelJsonOnce(body, modelId);
      if (modelId !== MODEL_ID) console.log(`generator: produced with fallback model ${modelId}`);
      return out;
    } catch (err) {
      const msg = String(err?.message || '');
      const transient =
        TRANSIENT.test(err?.name || '') || TRANSIENT.test(msg) || RETRY_OUTPUT.test(msg);
      if (!transient || attempt >= attempts) throw err;
      const next = attempt + 1 <= switchAt ? MODEL_ID : FALLBACK_MODEL_ID;
      const backoffMs = 2000 * attempt;
      console.warn(
        `generator: ${modelId} failed (${err?.name || 'Error'}); attempt ${attempt + 1}/${attempts} on ${next} in ${backoffMs}ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

async function invokeModelJsonOnce(body, modelId) {
  const res = await bedrock.send(
    new InvokeModelWithResponseStreamCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );

  let out = '';
  let stopReason = '';
  for await (const evt of res.body) {
    if (!evt.chunk?.bytes) continue;
    const chunk = JSON.parse(Buffer.from(evt.chunk.bytes).toString('utf-8'));
    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
      out += chunk.delta.text;
    } else if (chunk.type === 'message_delta' && chunk.delta?.stop_reason) {
      stopReason = chunk.delta.stop_reason;
    }
  }
  // `max_tokens` here means the budget ran out before (or partway through) the
  // answer — the actionable signal when a completion comes back empty or cut off.
  if (!out.trim() || stopReason === 'max_tokens') {
    throw new Error(
      `model produced no usable JSON (stop_reason=${stopReason || 'unknown'}, ` +
        `${out.length} chars): ${out.slice(0, 200) || '<empty completion>'}`,
    );
  }
  return parseModelJson(out);
}

function parseModelJson(out) {
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    // An EMPTY completion here usually means max_tokens was exhausted before any
    // text was emitted (see modelBody: thinking draws from the same budget).
    throw new Error(
      `model did not return JSON (${out.length} chars): ` + (out.slice(0, 200) || '<empty completion>'),
    );
  }
  return JSON.parse(out.slice(start, end + 1));
}

function normalizeGraph(graph) {
  const rawPages = Array.isArray(graph?.pages) ? graph.pages : [];
  const seen = new Set();
  const pages = [];
  for (const p of rawPages) {
    const slug = safeSlug(p?.slug);
    if (seen.has(slug)) continue;
    seen.add(slug);
    pages.push({ slug, title: p?.title, paragraphs: p?.paragraphs, links: p?.links });
  }
  if (!seen.has('index')) {
    pages.unshift({
      slug: 'index',
      title: 'Overview',
      paragraphs: ['An overview of related material.'],
      links: pages.slice(0, 3).map((p) => p.slug),
    });
  }
  return pages;
}

// ---------------------------------------------------------------------------
// Rendering + staging (archetype-aware; produces media-tagged manifest)
// ---------------------------------------------------------------------------

async function renderAndStage({ ctx, version, archetype, graph, structure, origin }) {
  const manifest = [];
  const stage = async (slug, body, ext, contentType) => {
    const hash = sha256hex(body);
    const blobKey = `staging/${hash}${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: STAGING_BUCKET,
        Key: blobKey,
        Body: body,
        ContentType: contentType,
        Metadata: { ctx, version, slug, dpid: decoyPageId(ctx, version, slug) },
      }),
    );
    manifest.push({ slug, hash, blobKey, ext, contentType, dpid: decoyPageId(ctx, version, slug) });
  };

  if (archetype === 'json') {
    const data = graph && graph.data != null ? graph.data : graph;
    const { body, beacon } = renderDecoyJson({ ctx, version, slug: 'index', data, origin });
    await stage('index', body, '.json', 'application/json; charset=utf-8');
    // `beacon` is null when the schema has no URL-valued field to point at. Recorded
    // either way: a JSON decoy with no beacon is covered by canaries and the serve
    // log ONLY, and that difference should be visible in the snapshot rather than
    // inferred later from a silent absence of hits.
    if (!beacon) {
      console.log(`LBY json decoy has no beacon carrier (no url-ish field) ctx=${ctx} ${version}`);
    }
    return { manifest, media: 'json', canaries: extractCanaries(data), beacon };
  }

  // html: the entry page is always structure-isomorphic to the rendered DOM; the
  // rest are interlinked sibling articles.
  const pages = normalizeGraph(graph);
  const allSlugs = new Set(pages.map((p) => safeSlug(p.slug)));
  for (const page of pages) {
    const slug = safeSlug(page.slug);
    let html;
    if (slug === 'index') {
      html = renderStructuralDecoy({
        ctx, version, slug, structure, origin,
        records: graph.records,
        title: graph.title,
        tagline: graph.tagline,
        nav: graph.nav,
        // Sibling page titles serve as section labels; anything left over fills
        // the leaves that have no obvious role.
        fillers: {
          labels: (graph.pages || []).map((p) => p && p.title).filter(Boolean),
          rest: (graph.nav || []).slice(0, 4),
        },
        links: page.links,
        allSlugs,
      });
    } else {
      // The graph's title doubles as the masthead on sibling pages, so they read
      // as part of the same site rather than orphaned articles.
      html = renderDecoyPage({ ctx, version, page: { ...page, siteName: graph.title }, allSlugs, origin });
    }
    await stage(slug, html, '.html', 'text/html; charset=utf-8');
  }
  // Canaries come from the generated fiction, not the rendered markup: the invented
  // business name, product names and places are what survive being reformatted or
  // paraphrased downstream.
  return {
    manifest,
    media: 'html',
    canaries: extractCanaries({ t: graph.title, g: graph.tagline, r: graph.records, p: graph.pages }),
  };
}

// ---------------------------------------------------------------------------
// DynamoDB snapshot: desired-state, immutable, CAS-promoted
// ---------------------------------------------------------------------------

/**
 * Count a failure on the context pointer. `ADD` so concurrent attempts cannot lose
 * an increment, and the reason is kept because "this context is failing" is only
 * useful with "and here is why".
 */
async function recordFailure(ctx, err) {
  const reason = String(err?.message || err || 'unknown').slice(0, 400);
  try {
    const res = await ddb.send(
      new UpdateItemCommand({
        TableName: SNAPSHOT_TABLE,
        Key: marshall({ PK: `CTX#${ctx}`, SK: 'POINTER' }),
        UpdateExpression:
          'ADD failCount :one SET lastFailAt = :now, lastFailReason = :why, lastFailIso = :iso',
        ExpressionAttributeValues: marshall({
          ':one': 1,
          ':now': Math.floor(Date.now() / 1000),
          ':why': reason,
          ':iso': new Date().toISOString(),
        }),
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const count = Number(unmarshall(res.Attributes || {}).failCount) || 1;
    console.warn(
      `generator: ctx=${ctx} failure #${count}; next attempt suppressed for ` +
        `${describeDelay(backoffSeconds(count))}`,
    );
  } catch (bookkeepingErr) {
    // Never let bookkeeping mask the real failure.
    console.error(`generator: could not record failure for ctx=${ctx}:`, bookkeepingErr);
  }
}

async function computeNextVersion(ctx) {
  const cur = await getPointer(ctx);
  const n = cur?.desiredNum || 0;
  return `v${n + 1}`;
}

/**
 * The recorded canaries of the context's CURRENT version, for the self-ingest
 * guard. Empty on a cold context (nothing sealed yet, so nothing of ours could
 * come back), and empty on any read hiccup: the guard is a backstop, and failing
 * generation because a lookup for the backstop failed would invert its purpose.
 */
async function currentCanaries(ctx, pointer) {
  const version = pointer?.desiredVersion;
  if (!version) return [];
  try {
    const res = await ddb.send(
      new GetItemCommand({
        TableName: SNAPSHOT_TABLE,
        Key: marshall({ PK: `CTX#${ctx}`, SK: `SNAP#${version}` }),
      }),
    );
    const snap = res.Item ? unmarshall(res.Item) : null;
    return Array.isArray(snap?.canaries) ? snap.canaries : [];
  } catch (err) {
    console.warn(`generator: could not read canaries for ctx=${ctx} ${version}:`, err);
    return [];
  }
}

async function getPointer(ctx) {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: SNAPSHOT_TABLE,
      Key: marshall({ PK: `CTX#${ctx}`, SK: 'POINTER' }),
      ConsistentRead: true,
    }),
  );
  return res.Item ? unmarshall(res.Item) : null;
}

async function sealSnapshot({ ctx, version, sourceUrl, srcHash, manifest, entry, media, archetype, canaries, detect, beacon }) {
  const num = parseInt(version.slice(1), 10);
  const checksum = sha256hex(manifest.map((m) => `${m.slug}:${m.hash}`).sort().join('|'));
  const cur = await getPointer(ctx);
  const curNum = cur?.desiredNum || 0;

  const snapItem = marshall(
    {
      PK: `CTX#${ctx}`,
      SK: `SNAP#${version}`,
      sealed: true,
      ctx,
      version,
      versionNum: num,
      sourceUrl,
      srcHash,
      entry,
      media,
      archetype,
      canaries,
      beacon: beacon || null,
      // Why this archetype was chosen — content-type verdict + model judgement.
      detect,
      bucket: DECOY_BUCKET_NAME,
      pageCount: manifest.length,
      checksum,
      manifest,
      createdAtIso: new Date().toISOString(),
    },
    { removeUndefinedValues: true },
  );

  const pointerUpdate = {
    Update: {
      TableName: SNAPSHOT_TABLE,
      Key: marshall({ PK: `CTX#${ctx}`, SK: 'POINTER' }),
      // Sealing a version proves the context is healthy, so the failure history goes
      // with it — otherwise a context that failed once would stay under backoff long
      // after it started working.
      UpdateExpression:
        'SET desiredVersion = :v, desiredNum = :n, updatedAtIso = :t ' +
        'REMOVE failCount, lastFailAt, lastFailReason, lastFailIso',
      ConditionExpression: 'attribute_not_exists(desiredNum) OR desiredNum = :cur',
      ExpressionAttributeValues: marshall({ ':v': version, ':n': num, ':cur': curNum, ':t': new Date().toISOString() }),
    },
  };

  await ddb.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        { Put: { TableName: SNAPSHOT_TABLE, Item: snapItem, ConditionExpression: 'attribute_not_exists(SK)' } },
        pointerUpdate,
      ],
    }),
  );
}
