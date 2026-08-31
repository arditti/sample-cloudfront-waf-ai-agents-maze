// AI Maze — headless renderer Lambda (Playwright + Chromium).
//
// The one job of this Lambda is to turn a URL into "what a JS-executing crawler
// actually sees", so the generator can build a decoy that is ISOMORPHIC to the
// real thing (same DOM skeleton / same JSON schema) rather than an empty shell.
//
// Contract (stable — a Bedrock AgentCore Browser or Docker/Playwright variant
// can replace this file without touching the generator):
//   in : { url, headers?, waitUntil?, timeoutMs?, capture? }
//   out: {
//     status, contentType, finalUrl,
//     html,            // fully rendered outerHTML (post-hydration)
//     text,            // visible innerText (bounded)
//     structure,       // compact DOM skeleton: tags/classes/nesting/repeat counts
//     captured: [ { url, status, contentType, json|bodyText } ]  // XHR/fetch seen
//   }
//
// `headers` (supplied by the generator) carries the ingest pass-through header the
// WAF rule Allows, which is what guarantees this fetch is never steered into the
// maze, plus the triggering request's replayed headers so the origin and the
// page's own JS produce the variant the crawler would have received. Headers are
// attached to every SAME-ORIGIN request the page makes, so the app's XHRs are
// covered without leaking the secret to third-party hosts. `user-agent` is applied
// to the browser context so `navigator.userAgent` agrees with the header.
// arm64 Node.js 24 (Lambda container image).

import { chromium } from 'playwright-core';

const DEFAULT_TIMEOUT = 20000;
// Used only when the caller replays no user agent of its own.
const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_TEXT = 20000;
const MAX_CAPTURED = 12;
const MAX_CAPTURED_BYTES = 200000;

let browserPromise = null;

function newContextOn(browser, userAgent) {
  return browser.newContext({
    userAgent,
    viewport: { width: 1280, height: 900 },
    javaScriptEnabled: true,
  });
}

// Reuse the browser across warm invocations (cold start pays the launch once) —
// but NEVER a dead one: Chromium can crash or exit between invokes (OOM, frozen
// container), and calling newContext/newPage on a closed browser throws
// "Target page, context or browser has been closed". Verify liveness and
// relaunch when needed.
async function getBrowser() {
  if (browserPromise) {
    try {
      const b = await browserPromise;
      if (b.isConnected()) return b;
      await b.close().catch(() => {});
    } catch {
      /* previous launch failed — fall through to relaunch */
    }
    browserPromise = null;
  }
  browserPromise = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });
  return browserPromise;
}

export const handler = async (event) => {
  const url = event?.url;
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new Error('renderer: event.url must be an absolute http(s) URL');
  }
  const waitUntil = event?.waitUntil || 'networkidle';
  const timeoutMs = Math.min(event?.timeoutMs || DEFAULT_TIMEOUT, 45000);

  // Caller-supplied headers: the ingest pass-through secret plus the triggering
  // request's replayed headers. The user agent is applied to the browser context
  // instead, so `navigator.userAgent` matches the header and UA-sniffing page JS
  // renders the variant the crawler would have received.
  const extraHeaders = {};
  let userAgent = DEFAULT_UA;
  for (const [k, v] of Object.entries(event?.headers || {})) {
    const key = String(k).toLowerCase();
    if (typeof v !== 'string' || !v) continue;
    if (key === 'user-agent') userAgent = v;
    else extraHeaders[key] = v;
  }

  // Chromium in Lambda can die between invocations (OOM, frozen container), and
  // the corpse only reveals itself when newContext/newPage throws "Target page,
  // context or browser has been closed". getBrowser checks isConnected, but the
  // process can also die DURING setup — so retry once with a guaranteed-fresh
  // browser rather than burning an SQS retry on a known transient.
  let context;
  let page;
  for (let attempt = 0; ; attempt++) {
    try {
      context = await newContextOn(await getBrowser(), userAgent);
      page = await context.newPage(); // the observed crash point
      break;
    } catch (err) {
      if (attempt >= 1 || !/has been closed|Target (page|browser)/i.test(String(err?.message))) throw err;
      console.warn('renderer: browser was dead during setup, relaunching once');
      await context?.close().catch(() => {});
      context = undefined;
      browserPromise = null;
    }
  }


  // Attach the headers to SAME-ORIGIN requests only — the document and the app's
  // own XHRs. Sending a shared secret to every third-party script host the page
  // happens to load would leak it, so this is route-scoped rather than a blanket
  // extraHTTPHeaders on the context.
  if (Object.keys(extraHeaders).length) {
    const targetOrigin = new URL(url).origin;
    await context.route('**/*', async (route) => {
      const req = route.request();
      let sameOrigin = false;
      try { sameOrigin = new URL(req.url()).origin === targetOrigin; } catch { /* data:, blob: */ }
      if (!sameOrigin) return route.continue();
      return route.continue({ headers: { ...req.headers(), ...extraHeaders } });
    });
  }

  const captured = [];
  // Capture JSON-ish responses the page fetched (the SPA's data source). We read
  // bodies lazily and bound both count and size so a chatty page can't blow up.
  context.on('response', async (resp) => {
    try {
      if (captured.length >= MAX_CAPTURED) return;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const rurl = resp.url();
      const looksJson = ct.includes('json') || /\/api\//.test(rurl) || /\.json(\?|$)/.test(rurl);
      if (!looksJson) return;
      const buf = await resp.body().catch(() => null);
      if (!buf || buf.length > MAX_CAPTURED_BYTES) return;
      const bodyText = buf.toString('utf-8');
      let json = null;
      try { json = JSON.parse(bodyText); } catch { /* keep bodyText only */ }
      captured.push({
        url: rurl,
        status: resp.status(),
        contentType: ct,
        ...(json !== null ? { json } : { bodyText: bodyText.slice(0, MAX_CAPTURED_BYTES) }),
      });
    } catch {
      /* ignore individual capture failures */
    }
  });

  let status = 0;
  let contentType = '';
  try {
    const resp = await page.goto(url, { waitUntil, timeout: timeoutMs });
    status = resp ? resp.status() : 0;
    contentType = resp ? (resp.headers()['content-type'] || '') : '';
    // Give late hydration a beat even after networkidle.
    await page.waitForTimeout(500);

    const html = await page.content();
    const text = (await page.evaluate(() => document.body ? document.body.innerText : '')).slice(0, MAX_TEXT);
    const structure = await page.evaluate(domSkeleton);

    return { status, contentType, finalUrl: page.url(), html, text, structure, captured };
  } finally {
    await context.close().catch(() => {});
  }
};

// Serialized in the page context. Produces a compact, content-free DOM skeleton:
// tag + id + classes + child structure, collapsing runs of structurally-identical
// siblings into a single node with a `repeat` count. This is the "shape" the
// generator asks Opus to preserve, so a decoy matches the real DOM's structure
// (e.g. a product grid of N cards) without copying its text.
function domSkeleton() {
  // A realistic page blows past a few hundred nodes easily: the sample site's
  // rail + hero + five sections + a card grid + a sourcing table truncated at 400,
  // which silently dropped the card grid and the table from the skeleton — so the
  // decoy mirrored only the top of the page.
  var MAX_NODES = 2000;
  var count = 0;

  // Signature used to collapse a run of repeated siblings into one node with a
  // count. It must describe the element AND the shape beneath it: keyed on tag +
  // classes alone, five <section> elements with different children collapse into
  // one and only the first subtree survives — which silently deleted this sample
  // site's card grid and sourcing table from the skeleton, so decoys mirrored just
  // the top of the page. Two levels of child shape is enough to tell a run of
  // identical cards from a sequence of different sections.
  function shallow(el) {
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).sort().join('.');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  }

  function sig(el) {
    var kids = [];
    for (var i = 0; i < el.children.length && i < 12; i++) {
      var c = el.children[i];
      var grandkids = [];
      for (var j = 0; j < c.children.length && j < 6; j++) grandkids.push(shallow(c.children[j]));
      kids.push(shallow(c) + (grandkids.length ? '(' + grandkids.join(',') + ')' : ''));
    }
    return shallow(el) + '[' + kids.join(',') + ']';
  }

  function walk(el, depth) {
    if (count >= MAX_NODES || depth > 12) return null;
    count++;
    var node = { tag: el.tagName.toLowerCase() };
    var id = el.getAttribute('id');
    if (id) node.id = id;
    var cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (cls.length) node.class = cls;
    // Note structurally-meaningful data-* keys (not values).
    var dataKeys = [];
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name.indexOf('data-') === 0) dataKeys.push(a.name);
    }
    if (dataKeys.length) node.dataKeys = dataKeys;

    var kids = [];
    var children = el.children;
    var j = 0;
    while (j < children.length) {
      var child = children[j];
      // Collapse consecutive siblings with the same signature into one w/ repeat.
      var s = sig(child);
      var run = 1;
      while (j + run < children.length && sig(children[j + run]) === s) run++;
      var childNode = walk(child, depth + 1);
      if (childNode) {
        if (run > 1) childNode.repeat = run;
        kids.push(childNode);
      }
      j += run;
    }
    if (kids.length) node.children = kids;
    return node;
  }

  return document.body ? walk(document.body, 0) : null;
}
