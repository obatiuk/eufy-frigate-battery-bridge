FROM docker.io/library/node:22-alpine3.23 AS builder
RUN apk add --no-cache font-inter \
    && cp "$(find /usr/share/fonts -iname '*Inter*Regular*' -o -iname '*InterVariable*' -o -iname '*.ttc' | head -n 1)" /tmp/Inter.ttf
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund ws@8.18.3

FROM docker.io/library/alpine:3.23

ENV NODE_ENV=production \
    FONT_FILE=/usr/share/fonts/Inter.ttf

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

COPY --from=builder /tmp/Inter.ttf /usr/share/fonts/Inter.ttf
COPY --from=builder /app/node_modules /app/node_modules
COPY src/bridge.js /app/bridge.js

WORKDIR /app
USER node

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "bridge.js"]
