ARG NODE_IMAGE
ARG CADDY_IMAGE
FROM ${NODE_IMAGE} AS frontend
ARG PUBLIC_ORIGIN
WORKDIR /frontend
COPY source/app/package*.json ./
RUN npm ci --no-audit --no-fund
COPY source/app/ ./
RUN VITE_AUTH_MODE=backend VITE_API_BASE_URL=/api VITE_PUBLIC_APP_ORIGIN="$PUBLIC_ORIGIN" npm run build

FROM ${NODE_IMAGE} AS api
ARG SOURCE_REVISION
ENV NODE_ENV=production NAV_RELEASE_SHA=$SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/cristsau/nav-page"
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
WORKDIR /app
COPY source/api/package*.json ./
COPY source/api/scripts/embeddingIsolationContract.js source/api/scripts/verifyEmbeddingIsolation.js ./scripts/
# Preserve the existing reviewed CPU-only isolation, including stripping ZIP tools.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev --no-audit --no-fund \
    && NAV_BUILD_ISOLATION=1 ONNXRUNTIME_NODE_INSTALL=skip node scripts/verifyEmbeddingIsolation.js --strip-install-tools \
    && npm cache clean --force
COPY source/api/src/ ./src/
COPY source/api/scripts/ ./scripts/
COPY --from=frontend /frontend/dist/ /var/www/nav/
COPY runtime.mjs /app/runtime.mjs
CMD ["node", "runtime.mjs"]

FROM ${CADDY_IMAGE} AS web
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/cristsau/nav-page"
LABEL org.opencontainers.image.revision=$SOURCE_REVISION
COPY --from=frontend /frontend/dist/ /srv/
