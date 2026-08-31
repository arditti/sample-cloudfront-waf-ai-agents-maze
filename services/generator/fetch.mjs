// AI Maze — origin-agnostic ingestion fetch.
//
// The generator reads the REAL content the same way any visitor would: an HTTPS
// GET with a browser user agent. Nothing about the origin (S3, Function URL,
// third-party) or the site leaks into this module — no base URL, no host, no
// path convention. The URL to ingest arrives in the message, having been logged
// by the edge function for the very request that triggered generation, so what
// gets ingested is exactly what the crawler asked for.
//
// The one non-visitor detail is the INGEST PASS-THROUGH HEADER. Ingestion must
// never be routed into the maze, or the generator would build decoys out of
// decoys. Relying on the user agent not tripping Bot Control is luck, not a
// contract, so a terminating WAF Allow rule (priority 5) short-circuits the whole
// WebACL for requests carrying this header with the right secret — no Bot Control
// label, therefore no decoy directive.
//
// The secret is minted once by a custom resource on the first `cdk deploy`,
// persisted in SSM, and handed over as an environment variable. It rides its OWN
// header rather than being appended to the User-Agent, which is what lets
// ingestion replay the crawler's real user agent unchanged.

import { VISITOR_DEFAULTS, sanitizeReplayHeaders, assertIngestableUrl } from './request.mjs';

/** Header the WAF pass-through rule byte-matches. */
export const INGEST_HEADER = 'x-maze-ingest';

const INGEST_SECRET = process.env.INGEST_SECRET || '';
// Hosts the ingest secret may be sent to (comma-separated). The URL to fetch still
// comes from the triggering event; this only stops the secret travelling to a host
// that arrived in a queue message.
const INGEST_HOSTS = (process.env.INGEST_HOSTS || '')
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);

// Bodies are bounded: the model only ever sees a trimmed slice, and an unbounded
// origin response should not be able to exhaust the container.
const MAX_BODY_CHARS = 256 * 1024;

/**
 * Headers for an ingestion request: sane visitor defaults, overridden by whatever
 * the triggering request actually sent (so the origin varies its response the same
 * way it did for the crawler), with the pass-through secret applied LAST so a
 * replayed header can never displace it.
 *
 * Replaying the crawler's own user agent is safe precisely because the WAF rule is
 * terminating: Bot Control never runs on these requests. Without the secret it
 * would not be — so refuse to fetch rather than ingest a maze page.
 */
export function ingestHeaders(replay) {
  if (!INGEST_SECRET) {
    throw new Error('INGEST_SECRET not configured; refusing to ingest without the WAF allowlist');
  }
  return {
    ...VISITOR_DEFAULTS,
    ...sanitizeReplayHeaders(replay),
    [INGEST_HEADER]: INGEST_SECRET,
  };
}

/**
 * GET the source URL as a normal visitor.
 *
 * For 'json' sources the returned body IS the ingested content, so detection
 * costs nothing extra. For 'html' sources the body is discarded and the headless
 * renderer performs the real, JS-executing fetch — one extra GET, which is the
 * price of not paying for Chromium on every API endpoint.
 *
 * @param {string} sourceUrl absolute URL, taken from the triggering log event
 * @param {object} [replay] allowlisted headers from the triggering request
 * @returns {Promise<{ url: string, status: number, contentType: string, body: string }>}
 */
export async function fetchAsUser(sourceUrl, replay) {
  const url = assertIngestableUrl(sourceUrl, INGEST_HOSTS);
  const res = await fetch(url, { headers: ingestHeaders(replay), redirect: 'follow' });
  if (!res.ok) throw new Error(`ingest ${url} -> HTTP ${res.status}`);
  const body = (await res.text()).slice(0, MAX_BODY_CHARS);
  return { url, status: res.status, contentType: res.headers.get('content-type') || '', body };
}
