// Custom-resource minter for the INGEST SECRET: the shared token that identifies
// the maze's own ingestion traffic (generator agent + headless renderer) to
// WAF, so ingestion is allowlisted instead of being mazed. Without it the
// generator would eventually build decoys out of decoys.
//
// The secret is generated ONCE, on the first `cdk deploy`, and preserved across
// deploys in an SSM Parameter (same "mint once, never rotate" contract as the KVS
// signing secret in kvs-seeder.mjs). Deleting the stack deletes the parameter, so
// a fresh deploy mints a fresh secret.
//
// The value is returned as the `Secret` response attribute; the stack feeds it to
// the WAF Allow rule (byte-match on the user-agent header) and to the generator /
// renderer as an environment variable. NOTE: WAF needs the literal to match
// against, so the value is necessarily present in the WebACL definition — this
// secret keeps the ingest identity unguessable from OUTSIDE, it is not a
// defense against someone who can already read the account's own config.
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import { randomBytes, createHash } from 'node:crypto';

const ssm = new SSMClient({});

// Read the existing secret, or null when the parameter does not exist yet.
async function existingSecret(name) {
  try {
    const res = await ssm.send(new GetParameterCommand({ Name: name }));
    const v = res.Parameter?.Value;
    return typeof v === 'string' && v.length ? v : null;
  } catch (e) {
    if (e?.name === 'ParameterNotFound') return null; // first deploy
    throw e;
  }
}

export const handler = async (event) => {
  const name = event.ResourceProperties?.ParameterName;
  if (!name) throw new Error('ingest-secret: ParameterName is required');
  console.log(`ingest-secret: ${event.RequestType} for ${name}`);

  if (event.RequestType === 'Delete') {
    try {
      await ssm.send(new DeleteParameterCommand({ Name: name }));
    } catch (e) {
      console.log('ingest-secret: delete best-effort ignored: ' + e);
    }
    return { PhysicalResourceId: name };
  }

  const prior = await existingSecret(name);
  // A hex SHA-256 of fresh entropy: opaque, fixed-length, safe in a User-Agent
  // header and well under WAF's 200-byte search-string limit.
  const secret = prior || createHash('sha256').update(randomBytes(32)).digest('hex');
  if (!prior) {
    await ssm.send(
      new PutParameterCommand({ Name: name, Value: secret, Type: 'String', Overwrite: false }),
    );
  }
  console.log(`ingest-secret: ${prior ? 'reused' : 'generated'} secret (value redacted)`);
  return { PhysicalResourceId: name, Data: { Secret: secret } };
};
