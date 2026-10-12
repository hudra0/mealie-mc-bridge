# syntax=docker/dockerfile:1

# The compiled output is plain JavaScript, so the builder always runs on the build host.
FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production dependencies are installed on the target platform. When the first native
# dependency arrives, install python3, make and g++ here (and only here) so that a
# missing arm64 prebuild falls back to a source build without bloating the runtime image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
# The base image ships uid/gid 1000 as "node"; rename it instead of adding a second user.
RUN groupmod --new-name bridge node \
  && usermod --login bridge --home /home/bridge --move-home node \
  && mkdir -p /data \
  && chown bridge:bridge /data
USER bridge
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
