// AI Maze — single corpus publisher.
//
// Woken by DynamoDB Streams on the snapshot table. It NEVER trusts stream order
// as desired state (README invariant): on any relevant event it strong-reads
// the context POINTER, loads the sealed snapshot for desiredVersion, verifies
// every staged blob's hash + graph completeness, writes the immutable versioned
// corpus object set to the corpus S3 bucket, then promotes the compact KVS
// marker to the ready version and records appliedVersion.
//
// Idempotent: republishing the same version is a no-op-equivalent overwrite of
// identical, content-addressed objects. arm64 / Node.js 22.

// KVS data-plane calls sign with SigV4a (signingRegion '*'). We register the
// AWS-documented CRT SigV4a implementation via a static side-effect import. CDK
// npm-installs @aws-sdk/signature-v4-crt (native, prebuilt aws-crt binaries)
// into the bundle via `bundling.nodeModules` instead of esbuild-inlining it.
// Without a registered signer the client throws "Neither CRT nor JS SigV4a
// implementation is available".
//
// IMPORTANT: the stack also lists @aws-sdk/client-cloudfront-keyvaluestore in
// nodeModules so the client and the signer share ONE bundled
// signature-v4-multi-region instance. If the client stayed external it would
// resolve a different multi-region copy from Lambda's /var/runtime and never see
// the CRT registration — the same "Neither CRT nor JS SigV4a" error.
import '@aws-sdk/signature-v4-crt';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { createHash } from 'node:crypto';

const s3 = new S3Client({});
const ddb = new DynamoDBClient({});
const kvsClient = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

const SNAPSHOT_TABLE = process.env.SNAPSHOT_TABLE;
const STAGING_BUCKET = process.env.STAGING_BUCKET;
const CORPUS_BUCKET = process.env.CORPUS_BUCKET;
const KVS_ARN = process.env.KVS_ARN;
const DECOY_BUCKET_NAME = process.env.DECOY_BUCKET_NAME;
if (!DECOY_BUCKET_NAME) throw new Error('DECOY_BUCKET_NAME must be set — no fallback: a guessable default bucket name could be squatted');
// How long a published decoy is served before the edge asks for a rotation. Past
// this age the decoy keeps serving; a replacement is built in the background.
const ROTATE_TTL_SECONDS = parseInt(process.env.ROTATE_TTL_SECONDS || '86400', 10);

const sha256hex = (d) => createHash('sha256').update(d).digest('hex');

/** @param {import('aws-lambda').DynamoDBStreamEvent} event */
export const handler = async (event) => {
  // Collect the distinct contexts touched by this batch; act on the current
  // desired state for each (not the per-record image).
  const contexts = new Set();
  for (const r of event.Records) {
    const keys = r.dynamodb?.Keys ? unmarshall(r.dynamodb.Keys) : null;
    if (keys?.PK?.startsWith?.('CTX#')) contexts.add(keys.PK.slice(4));
  }
  for (const ctx of contexts) {
    try {
      await publishContext(ctx);
    } catch (err) {
      console.error(`publisher: ctx=${ctx} failed:`, err);
      throw err; // let the stream retry; previous ready version stays active
    }
  }
};

async function publishContext(ctx) {
  const pointer = await getItem(`CTX#${ctx}`, 'POINTER');
  if (!pointer) return;

  // A context can need attention for two unrelated reasons, and a failing context
  // usually has no version at all — so the failure projection runs before the
  // publish check and independently of it.
  //
  // The edge is where suppression pays. Without a marker it logs `decoy_needed` on
  // every single request for a doomed path, and each of those wakes the parser, the
  // queue, the invoker and the agent container before anything discovers there is
  // nothing to build. Publishing the retry time into KVS lets the function decide
  // that for itself, at the cost of the lookup it was already doing.
  await projectFailureState(ctx, pointer);

  if (!pointer.desiredVersion) return;
  if (pointer.appliedVersion === pointer.desiredVersion) return; // already published

  const version = pointer.desiredVersion;

  const snap = await getItem(`CTX#${ctx}`, `SNAP#${version}`);
  if (!snap?.sealed) throw new Error(`snapshot CTX#${ctx}/${version} not sealed`);

  // Verify graph completeness + recompute checksum from the manifest.
  const manifest = snap.manifest || [];
  if (!manifest.length) throw new Error(`empty manifest for ${ctx}/${version}`);
  if (!manifest.some((m) => m.slug === (snap.entry || 'index'))) {
    throw new Error(`entry page missing for ${ctx}/${version}`);
  }
  const checksum = sha256hex(manifest.map((m) => `${m.slug}:${m.hash}`).sort().join('|'));
  if (snap.checksum && snap.checksum !== checksum) {
    throw new Error(`checksum mismatch for ${ctx}/${version}`);
  }

  const bucket = snap.bucket || DECOY_BUCKET_NAME;

  await copyBlobs({ ctx, version, bucket, manifest });
  await promote({ ctx, version, bucket, snap, manifest, checksum });
}

async function copyBlobs({ ctx, version, bucket, manifest }) {
  // Copy each staged, content-addressed blob to its deterministic corpus key,
  // verifying the hash first. Corpus keys carry the immutable version so only
  // complete versions ever become visible. The extension + content type come
  // from the manifest so JSON decoys are served as application/json and HTML
  // decoys as text/html (README: showcase HTML, SPA, and API/JSON archetypes).
  for (const m of manifest) {
    const body = await getObjectText(STAGING_BUCKET, m.blobKey);
    const actual = sha256hex(body);
    if (actual !== m.hash) throw new Error(`blob hash mismatch ${m.blobKey}: ${actual} != ${m.hash}`);
    const ext = m.ext || '.html';
    const contentType = m.contentType || 'text/html; charset=utf-8';
    const corpusKey = `corpus/${ctx}/${version}/${bucket}/${m.slug}${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: CORPUS_BUCKET,
        Key: corpusKey,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=300',
        Metadata: { ctx, version, dpid: m.dpid || '' },
      }),
    );
  }

}

/**
 * Mirror the generator's failure bookkeeping into the KVS marker as `retryAt`, so
 * the edge can stop asking for a decoy it cannot get. Backoff steps match
 * generator/backoff.mjs deliberately: the edge suppresses for the same window the
 * generator would have refused anyway, just far more cheaply.
 *
 * When a context has a ready version we leave its marker alone apart from
 * `retryAt` — a decoy that is already serving keeps serving while regeneration is
 * failing, which is exactly the behaviour we want.
 */
const BACKOFF_STEPS_SECONDS = [300, 900, 3600, 21600, 86400];

async function projectFailureState(ctx, pointer) {
  const failCount = Number(pointer.failCount) || 0;
  const lastFailAt = Number(pointer.lastFailAt) || 0;
  const marker = await readMarker(ctx);

  if (!failCount || !lastFailAt) {
    // Healthy again: drop any retryAt so the edge resumes asking normally. Nothing
    // to do when there is no marker to clean up.
    if (marker && marker.retryAt) {
      const { retryAt, failCount: _c, ...rest } = marker;
      await putMarker(ctx, rest);
      console.log(`publisher: ctx=${ctx} recovered, cleared retryAt`);
    }
    return;
  }

  const wait = BACKOFF_STEPS_SECONDS[Math.min(failCount, BACKOFF_STEPS_SECONDS.length) - 1];
  const retryAt = lastFailAt + wait;
  if (marker && marker.retryAt === retryAt) return; // already projected

  await putMarker(ctx, { ...(marker || {}), retryAt, failCount });
  console.log(
    `publisher: ctx=${ctx} failing (${failCount}x); edge suppressed until ${new Date(retryAt * 1000).toISOString()}`,
  );
}

/**
 * Sibling slugs for the marker: everything in the manifest except the entry page.
 *
 * Bounded on purpose. The marker is read on every flagged request, so it stays small:
 * at most 12 slugs, each already `safeSlug`-shaped, and anything longer is dropped
 * rather than truncated (a truncated slug would point at an object that is not there).
 */
function slugList(manifest, entry) {
  return (manifest || [])
    .map((m) => m.slug)
    .filter((slug) => slug && slug !== entry && slug.length <= 60)
    .slice(0, 12);
}

async function promote({ ctx, version, bucket, snap, manifest, checksum }) {
  const nowIso = new Date().toISOString();

  // Promote the compact KVS marker only after every object is verified+written.
  // `media` tells the edge which extension to serve (html vs json) so the rewrite
  // targets the right corpus key. `builtAt`/`ttl` are what let the edge serve this
  // decoy while asking for a rotation once it ages out.
  const existing = await readMarker(ctx);
  await promoteKvs(ctx, {
    // Keep any active retryAt: publishing a version does not prove the NEXT
    // generation will succeed, and the generator clears the failure history itself
    // when it seals one.
    ...(existing && existing.retryAt ? { retryAt: existing.retryAt } : {}),
    version,
    bucket,
    entry: snap.entry || 'index',
    media: snap.media || 'html',
    source: snap.sourceUrl,
    ttl: ROTATE_TTL_SECONDS,
    builtAt: Math.floor(Date.now() / 1000),
    // SIBLING SLUGS, so the maze can actually be more than one page deep.
    //
    // The generator writes a graph of interlinked pages into the corpus, but the edge
    // could only ever serve `entry`: a crawler following a decoy's link asked for a path
    // that does not exist on the real site, which became a NEW context whose ingest then
    // failed forever. The pages existed and were unreachable.
    //
    // Listing them here lets the edge serve the sibling the link points at, from the
    // version the link came from. Compact by construction — a handful of short slugs, not
    // one KVS entry per page — and capped so a large graph cannot bloat the marker.
    slugs: slugList(manifest, snap.entry || 'index'),
  });

  // Record appliedVersion + published checksum (drift detection input).
  await ddb.send(
    new UpdateItemCommand({
      TableName: SNAPSHOT_TABLE,
      Key: marshall({ PK: `CTX#${ctx}`, SK: 'POINTER' }),
      UpdateExpression: 'SET appliedVersion = :v, appliedChecksum = :c, appliedAtIso = :t',
      ExpressionAttributeValues: marshall({ ':v': version, ':c': checksum, ':t': nowIso }),
    }),
  );
  console.log(`publisher: promoted ctx=${ctx} version=${version} pages=${manifest.length}`);
}

async function getItem(pk, sk) {
  const res = await ddb.send(
    new GetItemCommand({ TableName: SNAPSHOT_TABLE, Key: marshall({ PK: pk, SK: sk }), ConsistentRead: true }),
  );
  return res.Item ? unmarshall(res.Item) : null;
}

async function getObjectText(bucket, key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await res.Body.transformToString('utf-8');
}

// The KVS data-plane API requires the current ETag (IfMatch) for writes.
async function promoteKvs(ctx, marker) {
  await putMarker(ctx, marker);
}

/** The context marker as the edge sees it, or null when there is none. */
async function readMarker(ctx) {
  try {
    const res = await kvsClient.send(new GetKeyCommand({ KvsARN: KVS_ARN, Key: `ctx#${ctx}` }));
    return JSON.parse(res.Value);
  } catch {
    return null; // absent, or unreadable — treat as no marker
  }
}

async function putMarker(ctx, marker) {
  // KVS writes are conditional on the store ETag, so read it immediately before.
  const desc = await kvsClient.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
  await kvsClient.send(
    new PutKeyCommand({
      KvsARN: KVS_ARN,
      Key: `ctx#${ctx}`,
      Value: JSON.stringify(marker),
      IfMatch: desc.ETag,
    }),
  );
}
