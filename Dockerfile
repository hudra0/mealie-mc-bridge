# syntax=docker/dockerfile:1

# The compiled output is plain JavaScript, so the builder always runs on the build host.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# Only the compiler needs these modules; skip native install scripts, which would fetch
# binaries for the build host that nothing here runs.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies are installed on the target platform, so npm ci picks the
# prebuilt binaries of sharp and better-sqlite3 for linux/amd64 or linux/arm64. The compiler
# toolchain is only a fallback for a native module without a matching prebuild; it stays in
# this stage and never reaches the runtime image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Fail the build here, not at runtime, when a native module does not load.
RUN node -e "const D = require('better-sqlite3'); new D(':memory:').close(); require('sharp');"
# The Chromium of the automatic login, for the target platform (this stage runs on it; the
# builder does not). The full browser, not the smaller headless shell: it runs in Chromium's
# new headless mode, which login pages with bot detection tell apart from a person's
# browser less easily. The shell is left out; the bridge never uses it when this one works.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --no-shell chromium

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# HOST defaults to 0.0.0.0 inside the container; the port mapping decides who reaches it.
ENV BRIDGE_IN_CONTAINER=1
WORKDIR /app
# The Debian libraries Chromium needs (a few hundred MB), first, so a change to the npm
# dependencies does not rebuild this layer. The version matches package-lock.json (a test
# checks it). Without them or the browser the bridge still runs; the settings page then says
# the browser is not available. tini runs as PID 1 and reaps the processes a crashed
# Chromium leaves behind.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && npx --yes playwright@1.63.0 install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /ms-playwright /ms-playwright
COPY --from=builder /app/dist ./dist
# The knowledge base: device limits for the validator (DEVICE_PROGRAMS_PATH) and the
# techniques, timing and unit rules the converter reads and the ingredient catalog
# (KNOWLEDGE_DIR).
COPY knowledge ./knowledge
# The base image ships uid/gid 1000 as "node"; rename it instead of adding a second user.
RUN groupmod --new-name bridge node \
  && usermod --login bridge --home /home/bridge --move-home node \
  && mkdir -p /data \
  && chown bridge:bridge /data \
  && chmod 700 /data
USER bridge
VOLUME /data
EXPOSE 3000
# /health answers 503 when the database or DATA_DIR is unusable; anything but 200 fails.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
# Under "init: true" or "docker run --init" tini is not PID 1; as a subreaper it still reaps.
ENV TINI_SUBREAPER=1
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
