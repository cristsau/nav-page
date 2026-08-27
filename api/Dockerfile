FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ARG NAV_RELEASE_SHA=development

LABEL org.opencontainers.image.revision=$NAV_RELEASE_SHA

ENV NODE_ENV=production
ENV NAV_RELEASE_SHA=$NAV_RELEASE_SHA

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# The local embedding runtime ships a glibc-linked native library.  Refuse to
# build if a stale or incorrectly tagged musl/Alpine base image is supplied,
# and prove that the exact production dependency can be loaded before release.
RUN . /etc/os-release \
  && test "$ID" = "debian" \
  && getconf GNU_LIBC_VERSION \
  && node -e "import('onnxruntime-node').then(() => console.log('onnxruntime-node native runtime ready')).catch((error) => { console.error(error); process.exit(1) })"

COPY src ./src
COPY scripts ./scripts

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
