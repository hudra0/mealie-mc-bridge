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
# The headless Chromium of the automatic login, for the target platform (this stage runs on
# it; the builder does not). Only the headless shell: the bridge never opens a window.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --only-shell chromium

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /ms-playwright /ms-playwright
# The Debian libraries Chromium needs (a few hundred MB). Without them or the browser the
# bridge still runs; the settings page then says the browser is not available.
RUN npx playwright install-deps chromium \
  && rm -rf /var/lib/apt/lists/*
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
CMD ["node", "dist/main.js"]
