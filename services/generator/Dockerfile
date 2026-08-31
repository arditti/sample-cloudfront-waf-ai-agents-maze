# AI Maze — generator agent container for Amazon Bedrock AgentCore Runtime.
#
# Built and pushed automatically by `cdk deploy` via
# AgentRuntimeArtifact.fromAsset(...) (a CDK DockerImageAsset published to the
# bootstrap ECR repo before the Runtime is created) — no manual image steps.
#
# The AgentCore Runtime requires an ARM64 container that serves the HTTP protocol
# contract on 0.0.0.0:8080 (GET /ping, POST /invocations). server.mjs implements
# both; agent.mjs holds the ingest -> Opus 5 -> render -> stage -> seal pipeline.
#
# ECR Public mirror of the official Node image — anonymous Docker Hub pulls get
# 429-rate-limited from shared CI egress IPs.
# Digest-pinned (multi-arch index) so rebuilds cannot silently pull a different
# Node patch release; bump tag + digest together when upgrading.
FROM --platform=linux/arm64 public.ecr.aws/docker/library/node:24-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

WORKDIR /app

# Install production dependencies first for layer caching (npm ci = exact
# lockfile versions, reproducible builds).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources (server + pipeline + pure helpers). Copy the whole set by glob
# rather than naming each file: an explicit list silently ships an image that
# crashes on startup with ERR_MODULE_NOT_FOUND the moment a new module is added,
# and that only surfaces after a full deploy.
COPY *.mjs ./

ENV PORT=8080
EXPOSE 8080
# server.mjs binds 0.0.0.0:8080 and serves /ping + /invocations.
CMD ["node", "server.mjs"]
