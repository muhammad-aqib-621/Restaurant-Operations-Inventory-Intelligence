# Build from the repository root: docker build -f apps/api/Dockerfile .
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS base
# Prisma migration engines require OpenSSL; retain normal signed apt verification.
RUN http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" apt-get update \
    && http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/shared/package.json ./packages/shared/package.json
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --ignore-scripts && npm cache clean --force

FROM dependencies AS build
# One source layer also avoids copying a large dependency tree for every file
# when the build host uses Docker's vfs storage driver.
COPY --chown=node:node . .
# Generation needs a syntactically valid datasource, never real build-time credentials.
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    DATABASE_URL=postgresql://build:unused@127.0.0.1:5432/build npm run db:generate \
    && npm run build --workspace @nk/shared \
    && npm run build --workspace @nk/api

# Release jobs use this target; the API runtime has no migration CLI or seed tooling.
FROM build AS migration
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "db:migrate"]

FROM build AS runtime-dependencies
# The generated client lists the build-time CLI/compiler as optional peers.
# Omit peer-only packages so those tools and their transports stay in release jobs.
RUN npm prune --omit=dev --omit=optional --omit=peer --ignore-scripts --no-audit \
    && npm cache clean --force \
    && mkdir -p /runtime/apps/api /runtime/packages/shared /runtime/scripts \
    && mv node_modules /runtime/node_modules \
    && cp package.json /runtime/package.json \
    && cp scripts/bootstrap-owner.mjs /runtime/scripts/bootstrap-owner.mjs \
    && cp -a apps/api/package.json apps/api/dist /runtime/apps/api/ \
    && cp -a packages/shared/package.json packages/shared/dist /runtime/packages/shared/

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
COPY --from=runtime-dependencies --chown=node:node /runtime/ ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:' + (process.env.API_PORT || 4000) + '/api/readiness'); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }"]
CMD ["npm", "run", "start", "--workspace", "@nk/api"]
