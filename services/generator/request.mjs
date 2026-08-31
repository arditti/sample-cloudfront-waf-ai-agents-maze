// AI Maze — how an ingestion request is shaped.
//
// Pure, dependency-free: the URL and header rules that decide what the generator
// is allowed to fetch and what it may carry when it does. Kept out of fetch.mjs
// (which pulls the AWS SDK) so it can be exercised without any AWS at all.

/** Visitor identity used when the triggering event replayed no headers. */
export const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Baseline headers, before the triggering request's own are layered on top. */
export const VISITOR_DEFAULTS = {
  'user-agent': DEFAULT_UA,
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// Only these may be replayed from the triggering request: what an origin
// legitimately varies its response on. The edge function allowlists them too;
// re-checking here means a malformed or hand-crafted queue message cannot smuggle
// a `cookie`, an `authorization`, or the ingest header itself into ingestion.
const REPLAYABLE = new Set([
  'user-agent',
  'accept',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
]);

const MAX_HEADER_LEN = 256;

/** Filter a replay-header bag down to the allowlist, lowercasing names. */
export function sanitizeReplayHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = String(k).toLowerCase();
    if (REPLAYABLE.has(name) && typeof v === 'string' && v) out[name] = v.slice(0, MAX_HEADER_LEN);
  }
  return out;
}

/**
 * The URL is data that arrived over SQS, so check its shape AND its host before
 * fetching it. Only absolute http(s) URLs are ingestable; anything else (file:,
 * data:, a bare path) is a bug upstream, not something to paper over with a default.
 *
 * The host allowlist is a credential guard, not URL construction. Ingestion sends
 * the WAF pass-through secret on every request, so a URL naming someone else's host
 * would hand them that secret — and with it the ability to bypass the maze.
 * The URL still comes from the triggering event; this only refuses to carry the
 * secret somewhere it does not belong. An off-allowlist URL means a bug or a
 * tampered queue message, so it fails rather than being fetched bare.
 */
export function assertIngestableUrl(url, allowedHosts = []) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error(`not an absolute URL, cannot ingest: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported URL scheme "${parsed.protocol}", cannot ingest`);
  }
  const allow = allowedHosts.filter(Boolean).map((h) => String(h).toLowerCase());
  if (allow.length && !allow.includes(parsed.host.toLowerCase())) {
    throw new Error(
      `refusing to ingest ${parsed.host}: not an allowlisted ingest host ` +
        `(would leak the ingest secret off-site)`,
    );
  }
  return parsed.toString();
}
