// AI Maze — generator agent HTTP entrypoint for Amazon Bedrock AgentCore
// Runtime.
//
// The runtime container must implement the AgentCore HTTP protocol contract
// (docs: runtime-http-protocol-contract) on host 0.0.0.0 / port 8080, ARM64:
//   - GET  /ping         -> 200 application/json {"status":"Healthy"}
//   - POST /invocations  -> Content-Type application/json; the raw JSON body is
//                           the InvokeAgentRuntime payload. We respond with a
//                           single JSON object (this pipeline is a batch job, not
//                           a token stream, so SSE would add nothing).
//
// There is no first-party Node server SDK for AgentCore, so we hand-roll the two
// endpoints with node:http. Business logic lives in agent.mjs (processContext),
// unchanged from the former SQS Lambda so the ingest→Opus 5→render→stage→seal
// path and its unit-tested helpers are reused verbatim.
//
// Payload shape (sent by the invoker Lambda, see infra/lambda/gen-invoker.mjs):
//   { ctx: "<context-key>", source: "/path" }
// Response shape:
//   200 { ok: true, result: <processContext summary> }
//   500 { ok: false, error: "<message>" }   (surfaces to the caller as a 424
//                                             RuntimeClientError; the invoker
//                                             then fails the SQS record so it
//                                             retries.)

import http from 'node:http';
import { processContext } from './agent.mjs';

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_BODY_BYTES = 1 << 20; // 1 MiB — payloads are tiny control messages.

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '';

  // Health check — keep it dependency-free and always fast. We never report
  // HealthyBusy: each /invocations call runs synchronously within the request,
  // so there is no out-of-band background work to keep a session alive for.
  if (req.method === 'GET' && (url === '/ping' || url.startsWith('/ping?'))) {
    return sendJson(res, 200, { status: 'Healthy' });
  }

  if (req.method === 'POST' && (url === '/invocations' || url.startsWith('/invocations?'))) {
    let payload;
    try {
      const raw = await readBody(req);
      payload = raw ? JSON.parse(raw) : {};
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: `invalid JSON body: ${err.message}` });
    }
    try {
      const result = await processContext(payload);
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      // Native HTTP error (no protocol envelope). AgentCore surfaces a container
      // 5xx to the caller as 424 RuntimeClientError; the invoker treats that as
      // a batch-item failure so the SQS message retries.
      console.error('generator: invocation failed:', err);
      return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`generator agent listening on 0.0.0.0:${PORT} (/ping, /invocations)`);
});
