// AI Maze — log parser Lambda.
//
// Target of a CloudWatch Logs subscription filter on the CloudFront Function
// log group. CloudWatch delivers subscription payloads gzip-compressed and
// base64-encoded in event.awslogs.data.
//
// It extracts `decoy_needed` signals emitted as `LBY {json}` lines, applies the
// generation admission budget (threat model M2 — see budget.mjs), and enqueues
// one context-key-deduplicated message per admitted context onto the generation
// SQS FIFO queue (README §4.2 steps 3-4).
//
// Budget state lives in the snapshot table under PK prefixes the publisher's
// stream handler ignores (it acts only on CTX#):
//   BUDGET#<windowStart> / WINDOW — atomic admission counter, TTL'd.
//   ADMIT#<ctx>          / ADMIT  — this context spent its admission already,
//                                   so its retries ride free (backoff bounds
//                                   them; billing them would starve fresh
//                                   contexts without bounding anything new).

import { gunzipSync } from 'node:zlib';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import {
  classifyAsk,
  windowStartSec,
  windowExpiresAt,
  DEFAULT_BUDGET_PER_WINDOW,
  DEFAULT_WINDOW_SECONDS,
} from './budget.mjs';

const sqs = new SQSClient({});
const ddb = new DynamoDBClient({});
const QUEUE_URL = process.env.QUEUE_URL;
const SNAPSHOT_TABLE = process.env.SNAPSHOT_TABLE;
// THE cost ceiling (threat model M2): at most this many NEW contexts may enter
// generation per window. Rotations and retries are bounded elsewhere and ride free.
const BUDGET_PER_WINDOW = parseInt(
  process.env.GEN_BUDGET_PER_WINDOW || String(DEFAULT_BUDGET_PER_WINDOW),
  10,
);
const WINDOW_SECONDS = parseInt(
  process.env.GEN_BUDGET_WINDOW_SECONDS || String(DEFAULT_WINDOW_SECONDS),
  10,
);

/** @param {{awslogs:{data:string}}} event */
export const handler = async (event) => {
  if (!QUEUE_URL || !SNAPSHOT_TABLE) throw new Error('QUEUE_URL / SNAPSHOT_TABLE not configured');
  const payload = JSON.parse(gunzipSync(Buffer.from(event.awslogs.data, 'base64')).toString('utf8'));
  // payload.logEvents: [{ id, timestamp, message }]
  const events = payload.logEvents || [];

  // Deduplicate within this batch by context-key so we don't fan out N sends
  // for the same page; SQS FIFO dedup (below) covers cross-batch within 5 min.
  const byContext = new Map();
  for (const le of events) {
    const idx = le.message.indexOf('LBY ');
    if (idx === -1) continue;
    let obj;
    try {
      obj = JSON.parse(le.message.slice(idx + 4).trim());
    } catch {
      continue;
    }
    if (obj.e !== 'decoy_needed') continue;
    if (!obj.ctx) continue;
    // Prefer a record that carries the absolute source URL: the generator ingests
    // exactly that URL, so a record without one cannot start a generation.
    const prev = byContext.get(obj.ctx);
    if (!prev || (!prev.url && obj.url)) {
      byContext.set(obj.ctx, {
        ctx: obj.ctx,
        url: obj.url,
        // Allowlisted request headers (user agent, language, client hints) the
        // generator replays so ingestion sees what the crawler would have seen.
        headers: obj.headers,
        source: obj.source,
        // The edge's actual reason ('no_marker' | 'stale'), which the budget
        // needs to tell a free rotation from a billable new context.
        reason: obj.reason,
        ver: obj.ver,
      });
    }
  }

  // Admission runs sequentially: contexts per batch are few after dedup, and a
  // serial walk keeps the budget writes from racing each other inside one batch.
  const nowSec = Math.floor(Date.now() / 1000);
  const admitted = [];
  let dropped = 0;
  for (const msg of byContext.values()) {
    // A rotation never needs the mark, so skip its read.
    const alreadyAdmitted = msg.reason === 'stale' ? false : await admitMarkExists(msg.ctx);
    const kind = classifyAsk({ reason: msg.reason, alreadyAdmitted });
    if (kind === 'new') {
      const verdict = await admitNewContext(msg.ctx, nowSec);
      if (!verdict.admitted) {
        dropped++;
        console.log(
          'LBY ' +
            JSON.stringify({
              e: 'budget_exhausted',
              ctx: msg.ctx,
              source: msg.source,
              window: verdict.window,
              cap: BUDGET_PER_WINDOW,
            }),
        );
        continue;
      }
    }
    admitted.push(msg);
  }

  const sends = admitted.map((msg) =>
    sqs.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(msg),
        MessageGroupId: msg.ctx, // per-context ordering
        MessageDeduplicationId: msg.ctx, // collapse duplicates within the dedup window
      }),
    ),
  );
  const results = await Promise.allSettled(sends);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    console.error(`parser: ${failed.length}/${sends.length} enqueues failed`);
    for (const f of failed) console.error(String(f.reason));
    throw new Error('partial enqueue failure'); // let CW Logs retry the batch
  }
  console.log(
    `parser: enqueued ${sends.length} context(s)${dropped ? `, dropped ${dropped} over budget` : ''}: ${admitted.map((m) => m.ctx).join(',')}`,
  );
  return { enqueued: sends.length, dropped };
};

async function admitMarkExists(ctx) {
  const res = await ddb.send(
    new GetItemCommand({
      TableName: SNAPSHOT_TABLE,
      Key: marshall({ PK: `ADMIT#${ctx}`, SK: 'ADMIT' }),
    }),
  );
  return !!res.Item;
}

/**
 * Try to spend one admission for a brand-new context. Every step is written so
 * a race or a crash errs toward availability, never toward an unbounded bill:
 * losing the mark race means someone else admitted it (enqueue free — SQS FIFO
 * dedup collapses the double send); a crash between mark and counter leaves a
 * mark that admits the context free on the next ask.
 */
async function admitNewContext(ctx, nowSec) {
  const win = windowStartSec(nowSec, WINDOW_SECONDS);
  const budgetKey = { PK: `BUDGET#${win}`, SK: 'WINDOW' };

  // Short-circuit once the window is spent: an exhausted window costs each
  // further ask one eventually-consistent read, not a write pair. Also the only
  // gate that handles cap = 0 (generation disabled entirely).
  const current = await ddb.send(
    new GetItemCommand({ TableName: SNAPSHOT_TABLE, Key: marshall(budgetKey) }),
  );
  const count = current.Item ? Number(unmarshall(current.Item).admitted) || 0 : 0;
  if (count >= BUDGET_PER_WINDOW) return { admitted: false, window: win };

  // First-ever ask for this context wins the mark; a raced loser treats the
  // context as already admitted.
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: SNAPSHOT_TABLE,
        Item: marshall({ PK: `ADMIT#${ctx}`, SK: 'ADMIT', admittedAt: nowSec, window: win }),
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return { admitted: true, window: win };
    throw err;
  }

  try {
    await ddb.send(
      new UpdateItemCommand({
        TableName: SNAPSHOT_TABLE,
        Key: marshall(budgetKey),
        UpdateExpression: 'ADD admitted :one SET expiresAt = if_not_exists(expiresAt, :exp)',
        ConditionExpression: 'attribute_not_exists(PK) OR admitted < :cap',
        ExpressionAttributeValues: marshall({
          ':one': 1,
          ':exp': windowExpiresAt(win, WINDOW_SECONDS),
          ':cap': BUDGET_PER_WINDOW,
        }),
      }),
    );
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // The window filled while we were admitting: release the mark so a later
      // window can admit this context, and drop the ask.
      await ddb.send(
        new DeleteItemCommand({
          TableName: SNAPSHOT_TABLE,
          Key: marshall({ PK: `ADMIT#${ctx}`, SK: 'ADMIT' }),
        }),
      );
      return { admitted: false, window: win };
    }
    throw err;
  }
  return { admitted: true, window: win };
}
