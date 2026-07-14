# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG PNPM_VERSION=10.13.1
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV CI=true

WORKDIR /workspace

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build

# pnpm deploy creates a portable production-only server tree, including built
# workspace dependencies. The web build is copied separately and served by
# Fastify through WEB_DIST_DIR.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @poker-with-friends/server deploy --prod --legacy /opt/poker/server \
    && install -d /opt/poker/web \
    && cp -a apps/web/dist /opt/poker/web/dist

FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG APP_BUILD_SHA=unknown
LABEL org.opencontainers.image.title="Poker with Friends" \
      org.opencontainers.image.revision="${APP_BUILD_SHA}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    WEB_DIST_DIR=/opt/poker/web/dist \
    APP_BUILD_SHA=${APP_BUILD_SHA} \
    HOME=/tmp

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/poker/server
COPY --from=build --chown=node:node /opt/poker /opt/poker

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const n=require('node:net');const s=n.connect(Number(process.env.PORT||3000),'127.0.0.1');s.setTimeout(3000);s.on('connect',()=>{s.end();process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
