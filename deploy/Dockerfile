FROM docker.io/library/node:22-alpine3.23 AS builder
LABEL org.opencontainers.image.source="https://github.com/obatiuk/eufy-frigate-battery-bridge"
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev --no-package-lock --no-audit --no-fund
COPY src/ /app/src/
COPY test/ /app/test/
COPY deploy/ /app/deploy/
RUN node --test --test-reporter=/app/test/reporter.js /app/test/*.test.js

FROM docker.io/library/alpine:3.23
LABEL org.opencontainers.image.source="https://github.com/obatiuk/eufy-frigate-battery-bridge"

ENV NODE_ENV=production

RUN apk add --no-cache \
      nodejs \
      ffmpeg \
      tzdata \
      tini \
      libdrm \
      mesa-va-gallium \
      mesa-dri-gallium \
    && adduser -D -u 1000 node \
    && mkdir -p /config/cache \
    && chown -R node:node /config

COPY --from=builder /app/node_modules /app/node_modules
COPY package.json /app/package.json
COPY src/ /app/

ARG BUILD_VERSION=latest
ARG GIT_COMMIT=dev
RUN printf '%s (%s)\n' "${BUILD_VERSION}" "${GIT_COMMIT}" > /app/.version
ENV BRIDGE_VERSION=${BUILD_VERSION} \
    BRIDGE_COMMIT=${GIT_COMMIT}

WORKDIR /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${HTTP_PORT:-8080}/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app.js"]
