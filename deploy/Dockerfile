FROM docker.io/library/node:22-alpine3.23 AS builder
LABEL org.opencontainers.image.source="https://github.com/obatiuk/eufy-frigate-battery-bridge"
WORKDIR /app
COPY package.json package-lock.json /app/
RUN apk add --no-cache binutils \
    && strip --strip-unneeded /usr/local/bin/node \
    && npm ci --omit=dev --no-audit --no-fund \
    && rm -rf /app/node_modules/.bin /app/node_modules/.package-lock.json \
    && find /app/node_modules -type f -name '*.md' -delete \
    && find /app/node_modules -type d -empty -delete
COPY src/ /app/src/
COPY test/ /app/test/
COPY deploy/ /app/deploy/
RUN mkdir -p /app/.tmp/cache \
    && TMPDIR=/app/.tmp BRIDGE_CACHE_DIR=/app/.tmp/cache \
       node --test --test-reporter=/app/test/reporter.js /app/test/*.test.js \
    && rm -rf /app/.tmp

FROM docker.io/library/alpine:3.23
LABEL org.opencontainers.image.source="https://github.com/obatiuk/eufy-frigate-battery-bridge"

ENV NODE_ENV=production \
    MESA_SHADER_CACHE_DISABLE=true

RUN addgroup -g 1000 node \
    && adduser -u 1000 -G node -s /bin/sh -D node \
    && apk add --no-cache \
      ffmpeg \
      libstdc++ \
      mesa-va-gallium \
      tini \
      tzdata \
    && rm -rf /var/cache/apk/* \
    && mkdir -p /config/cache \
    && chown -R node:node /config

COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /app/node_modules /app/node_modules
COPY package.json /app/package.json
COPY src/ /app/

ARG BUILD_VERSION=latest
ARG GIT_COMMIT=dev
ENV BRIDGE_VERSION=${BUILD_VERSION} \
    BRIDGE_COMMIT=${GIT_COMMIT}

WORKDIR /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD if [ "${BRIDGE_HTTP_PORT:-8080}" = "0" ]; then exit 0; fi; wget -qO- "http://127.0.0.1:${BRIDGE_HTTP_PORT:-8080}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "app.js"]
