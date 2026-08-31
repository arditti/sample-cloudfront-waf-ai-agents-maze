// Smoke checks for the pure halves of archetype detection and prompt assembly.
// The repo carries no test framework (POC); this runs on plain node:
//
//   node scripts/smoke-detect.mjs
//
// Exits non-zero on the first failure.

import {
  archetypeForContentType,
  assertVerdictUsable,
  assertNotOwnDecoy,
  MIN_CONFIDENCE,
} from '../services/generator/detect.mjs';
import { sanitizeReplayHeaders, assertIngestableUrl } from '../services/generator/request.mjs';
import { backoffSeconds, suppressedFor } from '../services/generator/backoff.mjs';
import { windowStartSec, windowExpiresAt, classifyAsk } from '../services/parser/budget.mjs';
import {
  buildIngestAnalystBody,
  buildBedrockBody,
  renderDecoyPage,
  renderStructuralDecoy,
  renderDecoyJson,
  decoyPageId,
  extractCanaries,
} from '../services/generator/lib.mjs';

// Fresh decoys must carry NO invisible format characters: the old zero-width
// watermark was a one-fetch tell to any normalizer, and this is the regression
// gate that keeps it from coming back in any form.
const ZERO_WIDTH = /[\u200b\u200c\u200d\u2060\ufeff]/;

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what || 'value'}: expected ${expected}, got ${actual}`);
}

function throws(fn, what) {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`${what} should have thrown`);
}

// ---------------------------------------------------------------------------
// content-type -> archetype
// ---------------------------------------------------------------------------

check('json media types map to json', () => {
  eq(archetypeForContentType('application/json'), 'json');
  eq(archetypeForContentType('application/json; charset=utf-8'), 'json', 'with charset');
  eq(archetypeForContentType('APPLICATION/JSON'), 'json', 'uppercase');
  eq(archetypeForContentType('application/ld+json'), 'json', 'structured suffix');
  eq(archetypeForContentType('application/vnd.api+json; charset=utf-8'), 'json', 'vendor suffix');
});

check('document media types map to html', () => {
  eq(archetypeForContentType('text/html'), 'html');
  eq(archetypeForContentType('text/html; charset=UTF-8'), 'html', 'with charset');
  eq(archetypeForContentType('application/xhtml+xml'), 'html', 'xhtml');
  eq(archetypeForContentType('text/plain'), 'html', 'text/plain');
  eq(archetypeForContentType('text/xml'), 'html', 'text/xml');
});

check('undecodable media throws', () => {
  throws(() => archetypeForContentType(''), 'missing content-type');
  throws(() => archetypeForContentType(undefined), 'undefined content-type');
  throws(() => archetypeForContentType('image/png'), 'image');
  throws(() => archetypeForContentType('application/pdf'), 'pdf');
  throws(() => archetypeForContentType('application/octet-stream'), 'octet-stream');
  throws(() => archetypeForContentType('video/mp4'), 'video');
});

// `application/xhtml+xml` must not be swallowed by the +json suffix rule.
check('xhtml is not mistaken for json', () => {
  eq(archetypeForContentType('application/xhtml+xml'), 'html');
});

// ---------------------------------------------------------------------------
// verdict gating
// ---------------------------------------------------------------------------

const ctx = { archetype: 'html', source: '/shop', contentType: 'text/html' };

check('a real, agreeing, confident verdict passes', () => {
  const c = assertVerdictUsable(
    { archetype: 'html', isRealContent: true, confidence: 0.9, title: 'Shop', topic: 'coffee' },
    ctx,
  );
  eq(c, 0.9, 'returned confidence');
});

check('non-real content is rejected', () => {
  throws(
    () => assertVerdictUsable({ archetype: 'html', isRealContent: false, confidence: 0.99 }, ctx),
    'isRealContent false',
  );
});

check('archetype disagreement is rejected', () => {
  throws(
    () => assertVerdictUsable({ archetype: 'json', isRealContent: true, confidence: 0.99 }, ctx),
    'body is json but content-type said html',
  );
});

check('low confidence is rejected', () => {
  throws(
    () => assertVerdictUsable({ archetype: 'html', isRealContent: true, confidence: MIN_CONFIDENCE - 0.01 }, ctx),
    'below threshold',
  );
  throws(
    () => assertVerdictUsable({ archetype: 'html', isRealContent: true }, ctx),
    'missing confidence',
  );
});

check('a malformed verdict is rejected', () => {
  throws(() => assertVerdictUsable(null, ctx), 'null verdict');
  throws(() => assertVerdictUsable({}, ctx), 'empty verdict');
});

// ---------------------------------------------------------------------------
// decoys must never be re-ingested (closes the decoys-from-decoys loop)
// ---------------------------------------------------------------------------

check('a decoy announces nothing, yet is recognisable to us', () => {
  const decoyHtml = renderDecoyPage({
    ctx: 'abc123',
    version: 'v1',
    page: {
      slug: 'index',
      title: 'Overview',
      paragraphs: ['A first sentence of filler. Then a second one to carry the mark.'],
      links: [],
    },
    allSlugs: new Set(['index']),
  });
  // Nothing an attacker can grep for: no meta tag, comment, attribute or brand word.
  if (/x-maze|data-dpid|maze-decoy|dp_/i.test(decoyHtml)) {
    throw new Error('decoy carries a visible marker');
  }
  // And no invisible one either: the zero-width watermark is gone, because a
  // normalizer flagged it in one fetch. Zero format characters, ever.
  if (ZERO_WIDTH.test(decoyHtml)) throw new Error('decoy carries zero-width characters');

  // Both beacon carriers must be keyed by the page's own id (first 8 hex of the
  // dpid). A carrier whose token drifted from the page id would report traffic
  // that cannot be traced to a decoy, which is what makes a hit worth logging.
  const expect = decoyPageId('abc123', 'v1', 'index').replace('dp_', '').slice(0, 8);
  const cssToken = (decoyHtml.match(/<link rel="stylesheet" href="\/wm\/([a-f0-9]+)\.css">/) || [])[1];
  const linkToken = (decoyHtml.match(/<a href="\/wm\/([a-f0-9]+)"/) || [])[1];
  eq(cssToken, expect, 'stylesheet beacon token is the page id');
  eq(linkToken, expect, 'link beacon token is the page id');
  // The styling itself must stay inline: the decoy's rendered CSS has to keep matching
  // the real page's, so the beacon sheet carries one cosmetic rule and nothing more.
  if (!decoyHtml.includes('<style>')) throw new Error('base stylesheet stopped being inline');
  // The self-ingest guard recognises the html decoy from its beacon carrier alone.
  throws(() => assertNotOwnDecoy(decoyHtml, 'html decoy'), 'html decoy re-ingestion');

  const { body: decoyJson } = renderDecoyJson({
    ctx: 'abc123',
    version: 'v1',
    slug: 'index',
    data: { items: [{ note: 'A long enough string value that reads as invented product prose.' }] },
  });
  if (decoyJson.includes('x_maze')) throw new Error('json decoy carries an extra key');
  JSON.parse(decoyJson); // still schema-isomorphic and parseable
  if (ZERO_WIDTH.test(decoyJson)) throw new Error('json decoy carries zero-width characters');

  // A JSON decoy's beacon has to REPLACE an existing URL value, never add a key: the
  // schema isomorphism is the whole reason JSON decoys carry no out-of-band field.
  const withUrls = renderDecoyJson({
    ctx: 'c0',
    version: 'v1',
    slug: 'index',
    data: { logo: 'https://cdn.test/logo.png', items: [{ image: '/img/a.jpg', url: '/p/a' }], notes: 'x'.repeat(60) },
  });
  // The token is derived from THIS payload's own page id, not the one above: a
  // hard-coded expectation here would pass while the beacon pointed anywhere.
  const expectC0 = decoyPageId('c0', 'v1', 'index').replace(/^dp_/, '').slice(0, 8);
  const token = expectC0;
  if (!withUrls.beacon) throw new Error('a payload with url fields produced no beacon');
  eq(withUrls.beacon.token, token, 'json beacon token is the page id');
  const parsed = JSON.parse(withUrls.body);
  // The index only has to make the URLs distinct; which record gets which depends on
  // walk order, so assert the beacon path rather than a particular number.
  if (!parsed.items[0].image.startsWith(`/wm/${token}.svg?i=`)) {
    throw new Error(`image field does not point at the beacon: ${parsed.items[0].image}`);
  }
  if (!parsed.logo.startsWith(`/wm/${token}.svg?i=`)) {
    throw new Error(`logo field does not point at the beacon: ${parsed.logo}`);
  }
  if (parsed.logo === parsed.items[0].image) throw new Error('two records share one image URL');
  // Link fields keep their own plausible path and gain the token: following one is
  // reported as `from` on the next request, and identical URLs across records would
  // be a tell in their own right.
  eq(parsed.items[0].url, `/p/a?s=${token}`, 'link field keeps its path and carries the token');
  eq(Object.keys(parsed).sort().join(','), 'items,logo,notes', 'json beacon added no key');

  // REGRESSION: the first live JSON decoy came back with a bare filename rather than
  // a path, and the beacon was silently skipped. A generated payload is whatever the
  // model wrote, so an image field carrying "tealeaf-1023.jpg" must still be caught.
  const bareFile = renderDecoyJson({
    ctx: 'c0', version: 'v1', slug: 'index',
    data: { products: [{ image: 'tealeaf-1023.jpg', notes: 'q'.repeat(60) }] },
  });
  if (!bareFile.beacon) throw new Error('a bare image filename produced no beacon');
  eq(JSON.parse(bareFile.body).products[0].image, `/wm/${token}.svg?i=1`, 'a bare image filename is beaconized');

  // A payload whose LONGEST string is a URL must still get its beacon.
  const longUrl = renderDecoyJson({
    ctx: 'c0', version: 'v1', slug: 'index',
    data: {
      products: [{ image: 'https://images.example.test/very/long/path/tealeaf-1023-large.jpg', notes: 'r'.repeat(45) }],
    },
  });
  eq(JSON.parse(longUrl.body).products[0].image, `/wm/${token}.svg?i=1`, 'the long url field is the beacon');

  // No URL field anywhere -> no beacon, and it must say so rather than invent one.
  // JSON has no renderer, so there is no cooperation-free carrier to fall back on:
  // such a decoy is traceable by canaries and the serve log only.
  const noUrls = renderDecoyJson({
    ctx: 'c0', version: 'v1', slug: 'index',
    data: { currency: 'USD', items: [{ sku: 'A1', notes: 'y'.repeat(60) }] },
  });
  if (noUrls.beacon !== null) throw new Error('invented a beacon for a payload with no url field');
  eq(Object.keys(JSON.parse(noUrls.body)).sort().join(','), 'currency,items', 'no-beacon payload keeps its schema');

  // Distinct image URLs per record: six products sharing one image URL is a tell.
  const multi = renderDecoyJson({
    ctx: 'c0', version: 'v1', slug: 'index',
    data: { items: [{ image: 'a.jpg' }, { image: 'b.jpg' }, { image: 'c.jpg' }], notes: 's'.repeat(60) },
  });
  const imgs = JSON.parse(multi.body).items.map((i) => i.image);
  eq(new Set(imgs).size, 3, 'each record gets a distinct image URL');
  if (!imgs.every((u) => u.startsWith(`/wm/${token}.svg?`))) {
    throw new Error('distinct image URLs stopped resolving to the beacon path');
  }

  // A url-ish KEY holding prose must be left alone: rewriting it would change the
  // payload's meaning, not just its target.
  const prose = renderDecoyJson({
    ctx: 'c0', version: 'v1', slug: 'index',
    data: { link: 'ask at the shed on Pier Road', notes: 'z'.repeat(60) },
  });
  eq(JSON.parse(prose.body).link, 'ask at the shed on Pier Road', 'a non-url value is not rewritten');
  if (prose.beacon !== null) throw new Error('beaconized a field whose value is not a URL');

  // A JSON decoy with URL fields is recognisable from its svg beacon alone\u2026
  throws(() => assertNotOwnDecoy(withUrls.body, 'json decoy with urls'), 'json-with-urls re-ingestion');
  // \u2026but one with NO URL field carries no in-band signal at all any more, so the
  // guard needs the context's recorded canaries to catch it. That is the re-keyed
  // M4: canaries where the zero-width watermark used to be.
  const jsonCanaries = extractCanaries(JSON.parse(decoyJson));
  if (!jsonCanaries.length) throw new Error('no canary extracted from the beaconless json decoy');
  assertNotOwnDecoy(decoyJson, 'json decoy, no canaries supplied'); // documents the blind spot
  throws(
    () => assertNotOwnDecoy(decoyJson, 'json decoy', jsonCanaries),
    'json decoy re-ingestion with its canaries known',
  );

  // Real content passes untouched, even with a canary set in hand.
  assertNotOwnDecoy('<!doctype html><html><body><h1>Real page</h1></body></html>', 'real html', jsonCanaries);
  assertNotOwnDecoy('{"items":[{"id":1}]}', 'real json', jsonCanaries);
  assertNotOwnDecoy('', 'empty body', jsonCanaries);
  // A `num:` signature is a snapshot-side digest, never matched as a substring.
  assertNotOwnDecoy('num:1,2,3 appears literally here', 'digest lookalike', ['num:1,2,3']);
});

check('an entry page carries its beacons and no zero-width residue', () => {
  const card = { tag: 'article', class: ['batch'], repeat: 2, children: [{ tag: 'h3' }, { tag: 'div', class: ['row', 'garden'], children: [{ tag: 'span', class: ['v'] }] }] };
  const structure = { tag: 'body', children: [{ tag: 'div', class: ['rail'], children: [{ tag: 'b' }] }, { tag: 'div', class: ['wrap'], children: [{ tag: 'h1' }, { tag: 'p', class: ['lede'] }, card] }] };
  const expect = decoyPageId('c', 'v1', 'index').replace('dp_', '').slice(0, 8);

  const entry = renderStructuralDecoy({
    ctx: 'c', version: 'v1', slug: 'index', structure,
    records: [{ name: 'Ember', garden: 'Doars' }, { name: 'Steam', garden: 'Anxi' }],
    title: 'Willowmere Tea Works', tagline: 'Small drums and long rests.',
    nav: ['Shop'], fillers: {}, links: [], allSlugs: new Set(['index']),
  });
  if (ZERO_WIDTH.test(entry)) throw new Error('entry page carries zero-width characters');
  if (!entry.includes(`/wm/${expect}.css`)) throw new Error('entry page is missing its stylesheet beacon');
  if (!entry.includes('Willowmere Tea Works')) throw new Error('entry page lost the canary-bearing title');
  throws(() => assertNotOwnDecoy(entry, 'entry page'), 'entry page re-ingestion');
});

// ---------------------------------------------------------------------------
// replayed request headers
// ---------------------------------------------------------------------------

check('replayed headers are allowlisted, never credentials', () => {
  const out = sanitizeReplayHeaders({
    'User-Agent': 'GPTBot/1.0',
    'Accept-Language': 'de-DE,de;q=0.9',
    'sec-ch-ua-mobile': '?1',
    cookie: 'session=secret',
    authorization: 'Bearer token',
    host: 'evil.example',
    referer: 'https://evil.example/',
    'x-maze-ingest': 'attacker-supplied',
  });
  eq(out['user-agent'], 'GPTBot/1.0', 'user-agent kept and lowercased');
  eq(out['accept-language'], 'de-DE,de;q=0.9', 'accept-language kept');
  eq(out['sec-ch-ua-mobile'], '?1', 'client hint kept');
  eq(out.cookie, undefined, 'cookie dropped');
  eq(out.authorization, undefined, 'authorization dropped');
  eq(out.host, undefined, 'host dropped');
  eq(out.referer, undefined, 'referer dropped');
  eq(out['x-maze-ingest'], undefined, 'ingest header cannot be smuggled in');
  eq(Object.keys(sanitizeReplayHeaders(undefined)).length, 0, 'missing bag is empty');
  eq(Object.keys(sanitizeReplayHeaders({ 'user-agent': 42 })).length, 0, 'non-string dropped');
  eq(sanitizeReplayHeaders({ 'user-agent': 'x'.repeat(500) })['user-agent'].length, 256, 'value capped');
});

check('only absolute http(s) URLs are ingestable', () => {
  eq(assertIngestableUrl('https://d123.cloudfront.net/shop?id=42'),
    'https://d123.cloudfront.net/shop?id=42', 'query string preserved');
  throws(() => assertIngestableUrl('/shop'), 'bare path');
  throws(() => assertIngestableUrl('file:///etc/passwd'), 'file scheme');
  throws(() => assertIngestableUrl(undefined), 'missing url');
});

check('the ingest secret cannot be carried to an unexpected host', () => {
  const allow = ['d123.cloudfront.net'];
  // The normal path: the URL the edge logged, on our own distribution.
  eq(assertIngestableUrl('https://d123.cloudfront.net/', allow), 'https://d123.cloudfront.net/');
  eq(assertIngestableUrl('https://D123.CloudFront.net/', allow), 'https://d123.cloudfront.net/',
    'host comparison is case-insensitive');
  // A tampered queue message naming someone else's host must not be fetched: every
  // ingest request carries the WAF bypass secret, so fetching it would leak it.
  throws(() => assertIngestableUrl('https://evil.example/collect', allow), 'off-allowlist host');
  throws(() => assertIngestableUrl('https://d123.cloudfront.net.evil.example/', allow),
    'suffix-confusion host');
  throws(() => assertIngestableUrl('https://d123.cloudfront.net:8443/', allow),
    'host includes the port, so a different port is a different host');
  // An empty allowlist is permissive on purpose (local runs), so the deployed stack
  // must always set one — INGEST_HOSTS in infra/lib/maze-stack.ts.
  eq(assertIngestableUrl('https://anywhere.example/', []), 'https://anywhere.example/');
});

// ---------------------------------------------------------------------------
// backoff: a context that cannot generate must stop costing anything
// ---------------------------------------------------------------------------

check('failure backoff steps up and stops retrying doomed contexts', () => {
  eq(backoffSeconds(0), 0, 'no failures, no wait');
  eq(backoffSeconds(1), 300, 'first failure waits 5m');
  eq(backoffSeconds(2), 900, 'second waits 15m');
  eq(backoffSeconds(3), 3600, 'third waits 1h');
  eq(backoffSeconds(5), 86400, 'fifth waits a day');
  eq(backoffSeconds(50), 86400, 'and it caps there rather than growing forever');
});

check('a failing context is suppressed until its backoff elapses', () => {
  const now = 1_000_000;
  eq(suppressedFor(null, now), 0, 'no pointer');
  eq(suppressedFor({}, now), 0, 'no failure history');
  eq(suppressedFor({ failCount: 1, lastFailAt: now - 10 }, now), 290, 'still waiting');
  eq(suppressedFor({ failCount: 1, lastFailAt: now - 300 }, now), 0, 'backoff elapsed exactly');
  eq(suppressedFor({ failCount: 1, lastFailAt: now - 999 }, now), 0, 'long past');
  eq(suppressedFor({ failCount: 3, lastFailAt: now - 60 }, now), 3540, 'longer step after more failures');
  // A pointer with a count but no timestamp must not suppress forever.
  eq(suppressedFor({ failCount: 4 }, now), 0, 'count without a timestamp is not suppression');
});

// ---------------------------------------------------------------------------
// budget: new contexts are metered, everything already bounded rides free
// ---------------------------------------------------------------------------

check('budget windows align without coordination', () => {
  eq(windowStartSec(5000, 3600), 3600, 'inside the second hour');
  eq(windowStartSec(7200, 3600), 7200, 'exactly on a boundary');
  eq(windowStartSec(7199, 3600), 3600, 'one second before the boundary');
  eq(windowStartSec(42, 120), 0, 'short test-sized windows too');
});

check('window counter items expire one window after their own', () => {
  eq(windowExpiresAt(7200, 3600), 14400, 'start + 2 windows');
  eq(windowExpiresAt(0, 120), 240, 'test-sized window');
});

check('only a NEW context is billed to the budget', () => {
  eq(classifyAsk({ reason: 'stale' }), 'rotation', 'rotation is bounded per context by ttl');
  eq(classifyAsk({ reason: 'no_marker', alreadyAdmitted: true }), 'retry', 'retries are bounded by backoff');
  eq(classifyAsk({ reason: 'no_marker', alreadyAdmitted: false }), 'new', 'first admission pays');
  // An unknown or missing reason is metered, not waved through: the failure
  // mode of the maze is an unbounded bill, never a missed decoy.
  eq(classifyAsk({}), 'new', 'no reason is billed');
  eq(classifyAsk({ reason: 'something_else' }), 'new', 'unknown reason is billed');
  // A stale ask never consults the admission mark; even a marked context
  // rotates free.
  eq(classifyAsk({ reason: 'stale', alreadyAdmitted: true }), 'rotation', 'rotation of an admitted context');
});

// ---------------------------------------------------------------------------
// canaries: every decoy must be traceable, whatever shape it is
// ---------------------------------------------------------------------------

check('a canary is extracted from every realistic payload shape', () => {
  const shapes = {
    prose: { products: [{ sku: 'HRB-FOG-100', name: 'Willow Bay Harbor Fog', notes: 'Second-flush Assam cut with dried sea buckthorn from the dunes north of the harbour.' }] },
    shortStrings: { products: [{ sku: 'AB-1', name: 'Harbor Fog', garden: 'Doars, West Bengal', price: 18.5 }] },
    idsAndEnums: { items: [{ id: 'a1b2c3d4e5', status: 'active', qty: 4 }], total: 1 },
    numbersOnly: { series: [1, 2, 3], count: 3, price: 17.25 },
  };
  for (const [label, payload] of Object.entries(shapes)) {
    const c = extractCanaries(payload);
    if (!c.length) throw new Error(`${label}: no canary extracted — the decoy would be untraceable`);
  }
  // Numeric-only payloads degrade to a value signature rather than nothing.
  const numeric = extractCanaries(shapes.numbersOnly);
  if (!String(numeric[0]).startsWith('num:')) throw new Error('numeric payload should yield a value signature');
  // Bare enums and booleans are not distinctive enough to be evidence.
  const generic = extractCanaries({ a: 'active', b: 'true', c: 'USD', d: 'green' });
  if (generic.length) throw new Error(`generic enums must not be treated as canaries: ${generic}`);
  // Proper-noun-ish values rank first, since they survive paraphrase best.
  const ranked = extractCanaries(shapes.prose, 3);
  if (!ranked.some((x) => /Willow Bay/.test(x))) throw new Error('invented names should rank as canaries');
});

// ---------------------------------------------------------------------------
// rotation: a new version must mean new fiction AND new ids
// ---------------------------------------------------------------------------

check('every page id is bound to the version, so a rotation renews them all', () => {
  const slugs = ['index', 'our-shed-story', 'house-blend-notes'];
  const v3 = slugs.map((sl) => decoyPageId('abc123', 'v3', sl));
  const v4 = slugs.map((sl) => decoyPageId('abc123', 'v4', sl));
  // Stable within a version: the publisher, the manifest and the markup must agree.
  slugs.forEach((sl, i) => eq(decoyPageId('abc123', 'v3', sl), v3[i], `stable for ${sl}`));
  // And every one of them changes when the version rolls, so a rotated decoy set
  // shares no identifier with the set it replaced.
  v3.forEach((id, i) => {
    if (id === v4[i]) throw new Error(`dpid for ${slugs[i]} survived the rotation`);
  });
  if (new Set([...v3, ...v4]).size !== v3.length + v4.length) {
    throw new Error('page ids collide across versions');
  }
  // Different contexts never share ids either.
  if (decoyPageId('abc123', 'v3', 'index') === decoyPageId('def456', 'v3', 'index')) {
    throw new Error('page ids collide across contexts');
  }
});

// ---------------------------------------------------------------------------
// prompt assembly
// ---------------------------------------------------------------------------

check('the analyst prompt shows the right evidence per archetype', () => {
  const html = JSON.stringify(
    buildIngestAnalystBody({
      archetype: 'html',
      source: '/shop',
      contentType: 'text/html',
      title: 'Shop',
      text: 'Beans and grinders',
      structure: { tag: 'body', children: [] },
    }),
  );
  if (!html.includes('STRUCTURE')) throw new Error('html evidence must carry the DOM skeleton');
  if (html.includes('SCHEMA')) throw new Error('html evidence must not claim a JSON schema');

  const json = JSON.stringify(
    buildIngestAnalystBody({
      archetype: 'json',
      source: '/api/items',
      contentType: 'application/json',
      sampleSchema: { items: [{ id: 'number' }] },
    }),
  );
  if (!json.includes('SCHEMA')) throw new Error('json evidence must carry the schema');
  if (json.includes('STRUCTURE')) throw new Error('json evidence must not claim a DOM skeleton');
});

check('html generation always asks for a structure-isomorphic entry page', () => {
  const body = buildBedrockBody({
    archetype: 'html',
    title: 'Shop',
    topic: 'specialty coffee',
    text: 'Beans and grinders',
    structure: { tag: 'body', children: [{ tag: 'ul', repeat: 6 }] },
    pageCount: 5,
  });
  const text = body.messages[0].content[0].text;
  if (!text.includes('STRUCTURE')) throw new Error('missing DOM skeleton');
  if (!text.includes('"records"')) throw new Error('missing records contract');
  if (!text.includes('specialty coffee')) throw new Error('missing validated topic');
  if (!/not use the slug "index"/i.test(text)) throw new Error('entry page must be reserved');
  // The model must be told to invent rather than restyle the source: passing the
  // real brand name and asking for plausible copy about it reads as impersonation
  // and Opus refuses (stop_reason=refusal, empty completion).
  if (!/DIFFERENT fictional business/i.test(text)) throw new Error('must ask for an invented business');
  if (!/do not reuse any name/i.test(text)) throw new Error('must forbid reusing source names');
});

check('json generation keeps the schema-isomorphic contract', () => {
  const body = buildBedrockBody({
    archetype: 'json',
    title: 'Items',
    sampleSchema: { items: [{ id: 'number' }] },
    pageCount: 5,
  });
  const text = body.messages[0].content[0].text;
  if (!text.includes('SHAPE')) throw new Error('missing schema/shape block');
  if (!/same field names, the same types/i.test(text)) throw new Error('missing isomorphism contract');
  if (!text.includes('{"data":')) throw new Error('missing output shape');
});

// ---------------------------------------------------------------------------
// Every link a decoy emits carries the emitting page's id
// ---------------------------------------------------------------------------

check('decoy links are ABSOLUTE when an origin is known', () => {
  // The whole point of the origin: a decoy scraped into a corpus keeps URLs that a
  // person can still click, which is what makes a later arrival attributable. Relative
  // hrefs lose the host on extraction and the chain breaks at its most valuable link.
  const origin = 'https://example.cloudfront.net';
  const page = renderDecoyPage({
    ctx: 'c1',
    version: 'v1',
    page: { slug: 'entry', title: 'E', paragraphs: ['u'.repeat(60)], links: ['b'] },
    allSlugs: new Set(['entry', 'b']),
    origin: `${origin}/some/path?ignored=1`,
  });
  const token = decoyPageId('c1', 'v1', 'entry').replace(/^dp_/, '').slice(0, 8);
  for (const expected of [
    // `&` renders as `&amp;` inside an attribute; `c=` carries the emitting context.
    `href="${origin}/b?s=${token}&amp;c=c1"`,
    `href="${origin}/wm/${token}.css"`,
    `href="${origin}/wm/${token}"`,
  ]) {
    if (!page.includes(expected)) throw new Error(`missing absolute url: ${expected}`);
  }

  // JSON keeps the path the model invented but points it at OUR origin: a fictional
  // host would send a future visitor nowhere.
  const json = renderDecoyJson({
    ctx: 'c1', version: 'v1', slug: 'index',
    data: { items: [{ image: 'tea.jpg', url: 'https://madeup.example/products/tea-1001' }], notes: 'v'.repeat(60) },
  origin: `${origin}/api/products`,
  });
  const jt = decoyPageId('c1', 'v1', 'index').replace(/^dp_/, '').slice(0, 8);
  const item = JSON.parse(json.body).items[0];
  eq(item.url, `${origin}/products/tea-1001?s=${jt}`, 'a fictional host is repointed at our origin');
  if (!item.image.startsWith(`${origin}/wm/${jt}.svg?i=`)) {
    throw new Error(`json image beacon is not absolute: ${item.image}`);
  }
});

check('every link a decoy emits carries the emitting page id', () => {
  // A decoy's links point at sibling paths that do not exist on the real site, so
  // following one creates a NEW context. Without the token on the link, that request
  // is anonymous: we would see a crawler ask for /some-slug with no way to tell which
  // decoy sent it. Referer would answer it and crawlers routinely omit Referer.
  const page = renderDecoyPage({
    ctx: 'c0',
    version: 'v1',
    page: { slug: 'entry', title: 'E', paragraphs: ['t'.repeat(60)], links: ['b', 'c'] },
    allSlugs: new Set(['entry', 'b', 'c']),
  });
  const token = decoyPageId('c0', 'v1', 'entry').replace(/^dp_/, '').slice(0, 8);
  // Sibling links are root-relative when no origin is known, and every one carries
  // both the emitting page (`?s=`) and the emitting context (`&c=`).
  const hrefs = page.match(/href="[^"]*\?s=[^"]*"/g) || [];
  if (!hrefs.length) throw new Error('the decoy emitted no sibling links to track');
  for (const h of hrefs) {
    if (!h.includes(`?s=${token}`)) throw new Error(`untracked decoy link: ${h}`);
    if (!h.includes('c=c0')) throw new Error(`link does not carry its context: ${h}`);
  }
  // The beacon link is keyed by the same token, so it needs no separate parameter.
  if (!page.includes(`/wm/${token}`)) throw new Error('beacon link missing from the page');
});


console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
