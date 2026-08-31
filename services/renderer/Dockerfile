# AI Maze — headless renderer Lambda (Playwright + Chromium, arm64).
#
# Built and pushed automatically by `cdk deploy` (DockerImageFunction); no manual
# image steps. We use the official Playwright image (ships a matching Chromium +
# every system library it needs) and layer the AWS Lambda Runtime Interface
# Client on top so it runs as a Lambda handler. arm64 throughout.
#
# Pinned to a specific Playwright version so Chromium and the npm package stay in
# lockstep; bump this tag and the package.json version together.
# Digest-pinned in addition to the version tag: this container executes
# untrusted page JS, so the base image must not be silently replaceable.
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e

# Lambda task root convention.
ENV LAMBDA_TASK_ROOT=/var/task
WORKDIR ${LAMBDA_TASK_ROOT}

# Playwright's browsers are preinstalled in the base image; point at them and do
# not let npm try to re-download during install. Lambda's filesystem is read-only
# except /tmp, so Chromium's Fontconfig/XDG caches must live there ("Fontconfig
# error: No writable cache directories" otherwise).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config

# aws-lambda-ric compiles the AWS C runtime client at install time; the
# Playwright image ships no build toolchain, so install what its preinstall
# script needs (see the aws-lambda-ric README).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       g++ make cmake unzip xz-utils autoconf automake libtool libcurl4-openssl-dev \
       python3-setuptools \
    && rm -rf /var/lib/apt/lists/*

# npm ci = exact lockfile versions, so the Chromium/playwright-core pairing and
# the compiled RIC stay reproducible across rebuilds.
COPY package.json package-lock.json ${LAMBDA_TASK_ROOT}/
RUN npm ci --omit=dev

COPY index.mjs ${LAMBDA_TASK_ROOT}/

# The AWS Lambda Runtime Interface Client is the entrypoint; CMD is the handler.
ENTRYPOINT ["npx", "aws-lambda-ric"]
CMD ["index.handler"]
