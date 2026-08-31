// AI Maze — viewer-request CloudFront Function (JS 2.0). Runs after WAF
// (x-amzn-waf-* readable), before the cache. Serves ready decoys IN PLACE, answers /wm/
// beacons, and resolves followed decoy links (?c=) against the emitting version.
//
// TWO SINKS: console.log = control plane ONLY (`decoy_needed` -> subscription -> SQS).
// cf.logCustomData = this request's ACCESS-LOG record, which is the analytics store;
// 800 bytes, URL-encoded, LAST call wins, hence one accumulating object.
//
// LIMIT: 10 KB incl. comments (asserted at synth).
import cf from 'cloudfront';
import crypto from 'crypto';

var kvs = cf.kvs();

// Reserved KVS keys (compact; never one entry per page).
var KEY_CONFIG = '__config__';
var KEY_CTX_PREFIX = 'ctx#';

var WAF_BOT_CATEGORY = 'x-amzn-waf-bot-category';
var WAF_DECOY_NEEDED = 'x-amzn-waf-decoy-needed';
var WAF_MISS_ACTION = 'x-amzn-waf-decoy-miss-action'; // "block" | "allow"

function headerVal(headers, name) {
  return headers[name] && headers[name].value ? headers[name].value : '';
}

// Context key: sha256("v1:"+path), host/query independent, one per PATH.
function contextKeyForPath(path) {
  var norm = path;
  if (norm.length > 1 && norm.charAt(norm.length - 1) === '/') {
    norm = norm.substring(0, norm.length - 1);
  }
  if (norm === '' ) norm = '/';

  return crypto.createHash('sha256').update('v1:' + norm).digest('hex').substring(0, 20);
}

function b64url(str) {
  return Buffer.from(str, 'utf8').toString('base64url');
}

function mintTrackingId(secret, ctx, version, ttlSeconds) {
  var nowSec = Math.floor(Date.now() / 1000); // frozen to fn start — fine.
  var exp = nowSec + ttlSeconds;
  var nonce = Math.floor(Math.random() * 1e9).toString(36);
  var payload = ctx + '.' + version + '.' + exp + '.' + nonce;
  var sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return b64url(payload) + '.' + sig;
}

async function readConfig() {
  try {
    return await kvs.get(KEY_CONFIG, { format: 'json' });
  } catch (e) {
    return null;
  }
}

async function readContextMarker(ctx) {
  try {
    return await kvs.get(KEY_CTX_PREFIX + ctx, { format: 'json' });
  } catch (e) {
    return null; // no ready version for this context
  }
}

// Replayed on re-fetch. ALLOWLIST: never cookie/authorization.
var REPLAY_HEADERS = [
  'user-agent',
  'accept',
  'accept-language',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
];
var MAX_HEADER_LEN = 256;

function replayHeaders(headers) {
  var out = {};
  for (var i = 0; i < REPLAY_HEADERS.length; i++) {
    var name = REPLAY_HEADERS[i];
    var v = headerVal(headers, name);
    if (v) out[name] = v.length > MAX_HEADER_LEN ? v.substring(0, MAX_HEADER_LEN) : v;
  }
  return out;
}

// Rebuilt so the generator re-fetches the SAME resource.
function queryStringOf(qs) {
  var parts = [];
  for (var key in qs) {
    var entry = qs[key];
    if (entry && entry.multiValue && entry.multiValue.length) {
      for (var i = 0; i < entry.multiValue.length; i++) {
        parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(entry.multiValue[i].value));
      }
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(entry && entry.value ? entry.value : ''));
    }
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// Absolute URL from the EVENT, never the viewer's Host (SSRF).
// Emitting decoy (`?s=`): the crawl graph without needing Referer.
function referrerToken(querystring) {
  var q = querystring && querystring.s;
  return q && q.value ? String(q.value).substring(0, 16) : '';
}

// Context a decoy link came FROM (`?c=`). Without it, following a link mints a context
// whose ingest can only 404, so the maze stays one page deep. Shape-checked: query data.
function linkContext(querystring) {
  var q = querystring && querystring.c;
  var v = q && q.value ? String(q.value) : '';
  return /^[0-9a-f]{20}$/.test(v) ? v : '';
}

// Sibling slug a decoy link points at.
function slugOf(uri) {
  var last = uri.split('?')[0].split('/').pop();
  return /^[a-z0-9-]{1,60}$/.test(last) ? last : '';
}

function sourceUrl(distributionDomainName, uri, querystring) {
  return 'https://' + distributionDomainName + uri + queryStringOf(querystring);
}

function logEvent(obj) {
  console.log('LBY ' + JSON.stringify(obj));
}

// One accumulating payload: only the LAST logCustomData value survives.
var cd = {};
function emitCd() {
  cf.logCustomData(JSON.stringify(cd));
}

function beaconResponse(ext) {
  var type = 'text/plain; charset=utf-8';
  var body = 'This page is available in the site archive.\n';
  if (ext === 'css') {
    type = 'text/css';
    body = '.masthead__mark{letter-spacing:.14em}\n';
  } else if (ext === 'svg') {
    type = 'image/svg+xml';
    body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">' +
      '<rect width="400" height="300" fill="#e9e4d8"/>' +
      '<circle cx="200" cy="150" r="66" fill="#cfd8cd"/></svg>\n';
  }
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type': { value: type },
      'cache-control': { value: 'public, max-age=300' },
      'x-robots-tag': { value: 'noindex, nofollow' }
    },
    body: body
  };
}

function blockResponse() {
  return {
    statusCode: 403,
    statusDescription: 'Forbidden',
    headers: {
      'content-type': { value: 'text/plain' },
      'cache-control': { value: 'no-store' },
      'x-maze': { value: 'block' }
    },
    body: 'Forbidden'
  };
}

async function handler(event) {
  var request = event.request;
  var headers = request.headers;
  var uri = request.uri;
  var distDomain = (event.context && event.context.distributionDomainName) || '';

  // Never serve /corpus/: decoys cache under it, and this runs before the cache.
  if (uri.indexOf('/corpus/') === 0) { return blockResponse(); }

  // BEACON. kind: css=rendered, svg=displayed, link=followed.
  if (uri.indexOf('/wm/') === 0) {
    var seg = uri.substring(4).split('/')[0];
    var dot = seg.lastIndexOf('.');
    cd.e = 'read';
    cd.kind = dot > 0 ? seg.substring(dot + 1) : 'link';
    cd.wm = (dot > 0 ? seg.substring(0, dot) : seg).substring(0, 16);
    emitCd();
    return beaconResponse(dot > 0 ? seg.substring(dot + 1) : '');
  }

  cd.bot = headerVal(headers, WAF_BOT_CATEGORY);
  cd.from = referrerToken(request.querystring);

  // Act only when WAF flagged this request as a candidate.
  var needed = headerVal(headers, WAF_DECOY_NEEDED);
  if (needed !== '1') {
    // Record a classified bot or an arrival on a decoy link: visitors the maze
    // never sees as candidates.
    if (cd.bot || cd.from) { emitCd(); }
    return request;
  }

  var cfg = await readConfig();
  if (!cfg) { return request; } // fail open if not configured yet

  // A followed link resolves against the EMITTING context, not this path's.
  var linkCtx = linkContext(request.querystring);
  var ctx = linkCtx || contextKeyForPath(uri);
  var mark = await readContextMarker(ctx);
  // Serve the slug the link asked for, but only if the version has it; else the entry
  // page, since rewriting to a missing object serves nothing.
  var want = linkCtx ? slugOf(uri) : '';
  var sib = want && mark && mark.slugs && mark.slugs.indexOf(want) >= 0 ? want : '';
  var nowSec = Math.floor(Date.now() / 1000);

  // retryAt = keeps failing. Ask for nothing: it wakes the whole pipeline.
  var suppressed = mark && mark.retryAt && nowSec < mark.retryAt;

  // No bucket in the marker or KVS config is a configuration error: never fall
  // back to a guessable name — fall through to the miss/block path instead.
  var bucket = mark ? (mark.bucket || cfg.bucket) : null;

  if (mark && mark.version && bucket) {
    // IN PLACE: 200 at the requested URL. The rewrite SEPARATES THE CACHE.
    var entry = sib || mark.entry || 'index';
    var ext = mark.media === 'json' ? '.json' : '.html';
    // dpid = sha256("<ctx>:<ver>:<slug>")[0..16], as decoyPageId() does.
    var dpid = 'dp_' + crypto.createHash('sha256')
      .update(ctx + ':' + mark.version + ':' + entry)
      .digest('hex').substring(0, 16);
    cd.e = 'serve';
    cd.ctx = ctx;
    cd.ver = mark.version;
    cd.dpid = dpid;
    cd.media = mark.media || 'html';
    cd.tid = mintTrackingId(cfg.signingSecret, ctx, mark.version, cfg.trackingTtlSeconds || 3600);
    emitCd();

    // STALE-WHILE-ROTATE: serves on while a replacement is built.
    var age = nowSec - (mark.builtAt || 0);
    if (!suppressed && age > (mark.ttl || cfg.rotateTtlSeconds)) {
      logEvent({
        e: 'decoy_needed',
        reason: 'stale',
        ctx: ctx,
        age: age,
        ver: mark.version,
        source: uri,
        url: sourceUrl(distDomain, uri, request.querystring),
        headers: replayHeaders(headers),
      });
    }

    request.uri = '/corpus/' + ctx + '/' + mark.version + '/' + bucket + '/' + entry + ext;
    // Repoint at the private corpus bucket, OAC-signed (viewer-request only).
    cf.updateRequestOrigin({
      domainName: cfg.corpusDomain,
      originAccessControlConfig: {
        enabled: true,
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
        originType: 's3'
      }
    });
    return request;
  }

  // Not ready. Ask for a decoy unless this context is in backoff.
  if (suppressed) {
    cd.e = 'suppressed';
    cd.ctx = ctx;
    cd.fails = mark.failCount;
    emitCd();
  } else if (linkCtx) {
    // Link's version is gone or lacks the slug. Do NOT ask: the path exists only in
    // the fiction, so generation would fetch the real URL and fail forever.
    cd.e = 'link_miss';
    cd.ctx = ctx;
    emitCd();
  } else {
    cd.e = 'need';
    cd.ctx = ctx;
    emitCd();
    logEvent({
      e: 'decoy_needed',
      reason: 'no_marker',
      ctx: ctx,
      from: cd.from,
      source: uri,
      url: sourceUrl(distDomain, uri, request.querystring),
      headers: replayHeaders(headers),
    });
  }
  var miss = headerVal(headers, WAF_MISS_ACTION);
  if (miss === 'allow') {
    return request; // degrade open
  }
  return blockResponse(); // default / "block"
}
