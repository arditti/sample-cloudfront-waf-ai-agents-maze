#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MazeStack } from '../lib/maze-stack';

const app = new cdk.App();

// WAF for CloudFront (CLOUDFRONT scope), CloudFront KeyValueStore, and the
// CloudFront Function log group all require us-east-1. The whole POC is
// single-region for simplicity.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

// Optional suffix so an isolated copy of the POC can stand alongside the main one
// in the same account (MAZE_STACK_SUFFIX=Foo -> AiMazePocFoo). Unset by
// default, in which case this is exactly the single stack it has always been.
const suffix = (process.env.MAZE_STACK_SUFFIX || '').replace(/[^A-Za-z0-9_]/g, '');

const stack = new MazeStack(app, `AiMazePoc${suffix}`, {
  env,
  nameSuffix: suffix,
  description: 'AI Maze on AWS — e2e POC (WAF detection + CloudFront Functions + S3 serving + async Bedrock Opus 5 generation)',
});

// Tags required by project policy so automated cleanups (SpringClean) skip these
// resources.
//
// Applied to the stack's CHILDREN, not to the app or the stack. Tagging the app
// or the stack also sets CloudFormation STACK-LEVEL tags, which CloudFormation
// propagates to every resource it creates — and creating a CloudFront Function
// with any tag attached fails the deploy outright:
//
//   Unable to create function with tags at this time. Please retry without tags
//   (including stack-level tags if using CloudFormation) ... (Status Code: 409)
//
// `excludeResourceTypes` does NOT help there, because it only suppresses the
// resource's own Tags property, not the stack-level propagation. Tagging children
// keeps every taggable resource tagged (buckets, table, queues, Lambdas, WebACL,
// distribution, secret) while leaving the stack itself untagged, so nothing
// propagates onto the CloudFront Function.
const tagProps = { excludeResourceTypes: ['AWS::CloudFront::Function'] };
for (const child of stack.node.children) {
  cdk.Tags.of(child).add('auto-delete', 'no', tagProps);
  cdk.Tags.of(child).add('project', 'ai-maze-poc', tagProps);
}
