// Custom-resource seeder: on stack Create/Update, write the reserved `__config__`
// key into the CloudFront KeyValueStore (data-plane API), keeping the HMAC
// signing secret out of source and the CloudFormation template. The secret is
// generated ONCE and preserved across deploys: on every Create/Update we first
// read the existing `__config__` and reuse its `signingSecret`, minting a fresh
// random secret only when none exists. Non-secret fields (ttl/bucket) can still
// be updated in place without rotating the secret. On Delete it best-effort
// removes the key.
//
// The KVS data-plane API signs with SigV4a (signingRegion '*'). We register the
// AWS-documented CRT SigV4a implementation via a static side-effect import. CDK
// npm-installs @aws-sdk/signature-v4-crt (native, prebuilt aws-crt binaries)
// into the bundle via `bundling.nodeModules` instead of esbuild-inlining it.
// Without a registered signer the client throws "Neither CRT nor JS SigV4a
// implementation is available".
//
// IMPORTANT: the stack also lists @aws-sdk/client-cloudfront-keyvaluestore in
// nodeModules so the client and the signer share ONE bundled
// signature-v4-multi-region instance. If the client stayed external it would
// resolve a different multi-region copy from Lambda's /var/runtime and never see
// the CRT registration — the same "Neither CRT nor JS SigV4a" error.
import '@aws-sdk/signature-v4-crt';
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
  DeleteKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { randomBytes } from 'node:crypto';

const kvs = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });

// Read the existing `__config__` signing secret, or null if absent/unreadable.
async function existingSecret(kvsArn) {
  try {
    const res = await kvs.send(new GetKeyCommand({ KvsARN: kvsArn, Key: '__config__' }));
    const parsed = JSON.parse(res.Value);
    return parsed && typeof parsed.signingSecret === 'string' ? parsed.signingSecret : null;
  } catch (e) {
    return null; // KeyNotFound (first deploy) or malformed value -> mint a new one
  }
}

function requiredProp(props, name) {
  if (!props[name]) throw new Error(`kvs-seeder: resource property ${name} is required`);
  return props[name];
}

export const handler = async (event) => {
  const props = event.ResourceProperties || {};
  const kvsArn = props.KvsArn;
  const requestType = event.RequestType;
  console.log(`kvs-seeder: ${requestType} for ${kvsArn}`);

  if (requestType === 'Delete') {
    try {
      const d = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }));
      await kvs.send(new DeleteKeyCommand({ KvsARN: kvsArn, Key: '__config__', IfMatch: d.ETag }));
    } catch (e) {
      console.log('kvs-seeder: delete best-effort ignored: ' + e);
    }
    return { PhysicalResourceId: `${kvsArn}#__config__` };
  }

  const d = await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: kvsArn }));
  // Reuse the secret across deploys; only generate one the first time.
  const prior = await existingSecret(kvsArn);
  const reused = prior !== null;
  const config = {
    signingSecret: prior || randomBytes(32).toString('base64url'),
    trackingTtlSeconds: Number(props.TrackingTtlSeconds || 3600),
    // Required: never fall back to a guessable bucket name that could be squatted.
    bucket: requiredProp(props, 'DecoyBucketName'),
    // The corpus bucket's regional domain. The edge function points the request
    // origin at it (cf.updateRequestOrigin) to serve a decoy IN PLACE, so it needs
    // the domain at request time and cannot be templated into the function code.
    corpusDomain: props.CorpusDomain || '',
    // Fallback rotation window for the edge when a marker predates the field.
    rotateTtlSeconds: Number(props.RotateTtlSeconds || 86400),
  };
  await kvs.send(
    new PutKeyCommand({ KvsARN: kvsArn, Key: '__config__', Value: JSON.stringify(config), IfMatch: d.ETag }),
  );
  console.log(`kvs-seeder: wrote __config__ (secret ${reused ? 'reused' : 'generated'}, value redacted)`);
  return { PhysicalResourceId: `${kvsArn}#__config__` };
};
