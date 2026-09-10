FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ARG NAV_RELEASE_SHA=development

LABEL org.opencontainers.image.revision=$NAV_RELEASE_SHA
LABEL io.domo.embedding-isolation=cpu-no-installer-v1

ENV NODE_ENV=production
ENV NAV_RELEASE_SHA=$NAV_RELEASE_SHA

WORKDIR /app

COPY package*.json ./
COPY scripts/embeddingIsolationContract.js scripts/verifyEmbeddingIsolation.js ./scripts/
# Use bundled CPU binaries; never run optional GPU extraction. Remove the ZIP
# code and installer in the SAME layer, then prove native CPU inference works.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev \
  && ONNXRUNTIME_NODE_INSTALL=skip NAV_BUILD_ISOLATION=1 node scripts/verifyEmbeddingIsolation.js --strip-install-tools \
  && npm cache clean --force

# The local embedding runtime ships a glibc-linked native library.  Refuse to
# build if a stale or incorrectly tagged musl/Alpine base image is supplied,
# and prove that the exact production dependency can be loaded before release.
RUN . /etc/os-release \
  && test "$ID" = "debian" \
  && getconf GNU_LIBC_VERSION \
  && node -e "import('onnxruntime-node').then(() => console.log('onnxruntime-node native runtime ready')).catch((error) => { console.error(error); process.exit(1) })"

COPY src ./src
COPY scripts ./scripts

# Prove the real API can load with production-only dependencies. Retired IMAP
# and attachment extraction libraries must not leak into the active import graph.
RUN DATABASE_URL=postgres://nav:build-only@127.0.0.1:5432/nav \
  NAV_PUBLIC_APP_ORIGIN=https://nav.example.test \
  node --input-type=module -e "const { createApp } = await import('./src/app.js'); const app = createApp(); await app.ready(); await app.close()"

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
