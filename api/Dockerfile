FROM node:24-alpine

ARG NAV_RELEASE_SHA=development

LABEL org.opencontainers.image.revision=$NAV_RELEASE_SHA

ENV NODE_ENV=production
ENV NAV_RELEASE_SHA=$NAV_RELEASE_SHA

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3001/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
