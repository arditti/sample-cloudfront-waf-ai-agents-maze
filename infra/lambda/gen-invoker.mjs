// AI Maze — generator invoker Lambda.
//
// Bridges the generation SQS FIFO queue to the generator agent running on Amazon
// Bedrock AgentCore Runtime. The heavy pipeline (ingest -> Opus 5 -> render ->
// stage -> seal) lives in the AgentCore container; this Lambda only:
//   1. Receives each SQS record (a context-key message written by the parser).
//   2. Calls InvokeAgentRuntime with the message body as the JSON payload.
//   3. Fails the record (batch-item failure) on any error so SQS retries and,
//      after maxReceiveCount, routes to the DLQ — same delivery semantics the
//      former generator Lambda had.
//
// arm64 / Node.js 22. AWS SDK v3 is provided by the Lambda runtime.

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';

const ac = new BedrockAgentCoreClient({});

const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN;

// InvokeAgentRuntime requires runtimeSessionId length >= 33. One session PER
// MESSAGE (the SQS message id is a 36-char UUID): each generation job is a
// self-contained batch run, and a fresh session guarantees it executes on the
// runtime's CURRENT container version — a per-context sticky session would pin
// retries to whatever (possibly stale) instance served that context last.
function sessionIdFor(messageId, ctx) {
  const base = `lby-${String(messageId || '')}-${String(ctx || '')}`.slice(0, 100);
  if (base.length >= 33) return base;
  return (base + '-'.repeat(33)).slice(0, 33);
}

async function readStream(response) {
  // The agent responds with a single JSON object (not SSE), but InvokeAgentRuntime
  // still delivers it as a byte stream. Concatenate then parse.
  if (!response) return '';
  if (typeof response === 'string') return response;
  if (typeof response[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf-8');
  }
  // Some SDK shapes expose transformToString on the body.
  if (typeof response.transformToString === 'function') {
    return await response.transformToString('utf-8');
  }
  return Buffer.from(response).toString('utf-8');
}

/** @param {import('aws-lambda').SQSEvent} event */
export const handler = async (event) => {
  if (!AGENT_RUNTIME_ARN) throw new Error('AGENT_RUNTIME_ARN not configured');
  const failures = [];

  for (const record of event.Records) {
    let ctx;
    try {
      const msg = JSON.parse(record.body);
      ctx = msg.ctx;
      const out = await ac.send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: AGENT_RUNTIME_ARN,
          qualifier: 'DEFAULT',
          runtimeSessionId: sessionIdFor(record.messageId, ctx),
          contentType: 'application/json',
          accept: 'application/json',
          payload: new TextEncoder().encode(record.body),
        }),
      );

      const text = await readStream(out.response);
      let parsed;
      try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { ok: false, error: `non-JSON agent response: ${text.slice(0, 200)}` }; }
      if (parsed.ok === false) {
        throw new Error(parsed.error || 'agent reported failure');
      }
      console.log(`gen-invoker: ok ctx=${ctx} ->`, JSON.stringify(parsed.result || parsed));
    } catch (err) {
      console.error(`gen-invoker: failed record ${record.messageId} (ctx=${ctx}):`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
