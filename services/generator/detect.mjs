// AI Maze — archetype detection.
//
// The archetype is NOT a function of the request path (a POC-only shortcut that
// broke on any real site). It is a function of what the origin actually served:
// the response `content-type`, confirmed afterwards by the LLM validation pass in
// agent.mjs. Two archetypes exist, and they map 1:1 to an ingestion strategy:
//
//   'json' : the body is data          -> parse it, sketch its schema
//   'html' : the body is a document    -> EXECUTE it in the headless renderer
//
// There is deliberately no static-vs-client-rendered distinction. Both are "a
// document a browser renders", and the only honest way to see either is to run
// its JavaScript — so every 'html' source goes through the renderer.

// `application/json` plus the structured suffix family (`application/ld+json`,
// `application/vnd.api+json`, ...).
const JSON_MIME = /^application\/(?:json|[a-z0-9.+-]*\+json)$/;

// Documents. `text/*` is included wholesale: text/plain, text/xml and friends are
// still documents a browser will render, and the validation pass rejects the ones
// that carry no usable context.
const DOC_MIME = new Set(['application/xhtml+xml', 'application/xml']);

/**
 * Map a response content-type to an archetype.
 *
 * @param {string} contentType raw header value (parameters allowed)
 * @returns {'json'|'html'}
 * @throws when the header is absent or names media we cannot build a decoy from
 *   (images, video, PDFs, octet-stream): there is no structure to be isomorphic
 *   to, so failing is better than serving an HTML page in its place.
 */
export function archetypeForContentType(contentType) {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!mime) throw new Error('cannot detect archetype: response had no content-type');
  if (JSON_MIME.test(mime)) return 'json';
  if (mime.indexOf('text/') === 0 || DOC_MIME.has(mime)) return 'html';
  throw new Error(`unsupported content-type "${mime}": no decoy archetype`);
}

/** Below this, the validation pass is not confident enough to build on. */
export const MIN_CONFIDENCE = 0.6;



// The structural signature every decoy carries anyway, for the reader's benefit:
// an HTML decoy always links its per-page beacon stylesheet (injectedHead), and a
// JSON decoy with any image-ish field carries the repointed `.svg?i=` beacon
// value. These are already visible to anyone who fetches the page, so keying the
// self-ingest guard on them adds nothing an adversary did not have.
const HTML_BEACON = /<link rel="stylesheet" href="[^"]*\/wm\/[a-f0-9]{8}\.css">/;
const JSON_BEACON = /\/wm\/[a-f0-9]{8}\.svg\?i=\d/;

/**
 * Refuse to ingest our own output. Formerly keyed on an invisible zero-width
 * watermark; that mark was removed (it was a one-fetch decoy tell to any
 * normalizer — see lib.mjs), so the guard is re-keyed on the two signals that
 * survive: the beacon carriers every decoy embeds, which catch a decoy from ANY
 * context, and the caller-supplied canary set, which catches this context's own
 * current fiction even if the carriers were stripped in transit. The WAF
 * pass-through rule should already keep ingestion out of the maze, but "should"
 * is not a guarantee: a rule that fails to match, or a redirect followed into
 * `/lb/...`, would otherwise have the generator building decoys from decoys and
 * drifting further from the real content on every version. This is a
 * deterministic backstop under the model's judgement, not a replacement for it.
 *
 * @param {string} body raw response body (HTML or JSON text)
 * @param {string} where label for the error message
 * @param {string[]} [canaries] the ingesting context's current recorded canaries
 */
export function assertNotOwnDecoy(body, where, canaries = []) {
  const text = String(body || '');
  if (HTML_BEACON.test(text) || JSON_BEACON.test(text)) {
    throw new Error(`refusing to ingest ${where}: it is maze decoy content (beacon carrier present)`);
  }
  // `num:` signatures are a snapshot-side digest, never a substring of the body.
  const hit = (canaries || []).find(
    (c) => typeof c === 'string' && c.length >= 8 && !c.startsWith('num:') && text.includes(c),
  );
  if (hit) {
    throw new Error(`refusing to ingest ${where}: it is maze decoy content (canary "${hit.slice(0, 60)}")`);
  }
}

/**
 * Second half of detection: the model's verdict on what was actually ingested.
 * Throws on every unusable outcome — the caller lets the SQS record fail and
 * retry. A decoy generated from an error page, a login wall, or a decoy that
 * leaked back is worse than no decoy, and degrading silently would hide it.
 *
 * @param {object} verdict parsed model response
 * @param {{archetype: string, source: string, contentType: string}} ctx
 */
export function assertVerdictUsable(verdict, { archetype, source, contentType }) {
  const confidence = typeof verdict?.confidence === 'number' ? verdict.confidence : 0;
  if (verdict?.isRealContent !== true) {
    throw new Error(
      `ingest rejected for ${source}: not real content (${verdict?.reason || 'no reason given'})`,
    );
  }
  if (verdict.archetype !== archetype) {
    throw new Error(
      `ingest rejected for ${source}: content-type "${contentType}" implied ${archetype} ` +
        `but the body is ${verdict.archetype} (${verdict.reason || 'no reason given'})`,
    );
  }
  if (confidence < MIN_CONFIDENCE) {
    throw new Error(`ingest rejected for ${source}: confidence ${confidence} < ${MIN_CONFIDENCE}`);
  }
  return confidence;
}
