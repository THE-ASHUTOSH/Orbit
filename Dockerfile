# =============================================================================
# Orbit - one image: Chromium + API + built frontend.
#
# Chromium is a child process of the server, not a separate service, for two
# reasons: the server IS the browser lifecycle manager (launch, health, restart),
# and CDP then only ever needs to listen on 127.0.0.1 inside this container -
# there is no network path to it at all. See docs/security.md.
# =============================================================================

# --- build -------------------------------------------------------------------
FROM node:24-slim AS build
WORKDIR /build

# Manifests first so dependency installation is cached independently of sources.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY bench/package.json bench/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm run build --workspace @orbit/protocol \
 && npm run build --workspace @orbit/server \
 && npm run build --workspace @orbit/web

# --- production dependencies -------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
RUN npm ci --omit=dev --workspace @orbit/server --include-workspace-root \
 && npm cache clean --force

# --- runtime -----------------------------------------------------------------
FROM node:24-slim AS runtime

# chromium plus the fonts a real browsing session needs: without CJK/emoji
# fonts, half the web renders as tofu boxes in the stream.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      xvfb \
      openbox \
      fonts-liberation \
      fonts-noto-core \
      fonts-noto-cjk \
      fonts-noto-color-emoji \
      ca-certificates \
      unzip \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

# Non-root. Chromium's own sandbox needs privileges a container should not have,
# so the container boundary is the sandbox (docs/security.md explains the
# trade-off and how to re-enable Chromium's sandbox with SYS_ADMIN).
RUN groupadd --gid 10001 browser \
 && useradd --uid 10001 --gid browser --create-home --home-dir /home/browser browser \
 && mkdir -p /data/profile /data/downloads /data/uploads /data/extensions \
 && chown -R browser:browser /data /home/browser

WORKDIR /app
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=deps  /app/package.json ./package.json
COPY --from=build /build/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /build/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /build/apps/server/dist ./apps/server/dist
COPY --from=build /build/apps/server/package.json ./apps/server/package.json
COPY --from=build /build/apps/web/dist ./web

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Stamped at build time so `docker inspect` can tell you what you are running.
ARG ORBIT_VERSION=dev
LABEL org.opencontainers.image.title="Orbit" \
      org.opencontainers.image.description="Shared multi-user browser: one real Chromium, streamed per tab, several people working in different tabs at once" \
      org.opencontainers.image.version="${ORBIT_VERSION}" \
      org.opencontainers.image.source="https://github.com/THE-ASHUTOSH/Orbit" \
      org.opencontainers.image.licenses="MIT"
ENV ORBIT_VERSION=${ORBIT_VERSION} \
DISPLAY=:99 \
    NODE_ENV=production \
    APP_PORT=3030 \
    SERVER_HOST=0.0.0.0 \
    DATA_DIR=/data \
    CHROMIUM_PATH=/usr/bin/chromium \
    CHROMIUM_DATA_DIR=/data/profile \
    DOWNLOAD_DIR=/data/downloads \
    UPLOAD_DIR=/data/uploads \
    EXTENSIONS_DIR=/data/extensions \
    DATABASE_URL=file:/data/app.db \
    WEB_ROOT=/app/web \
    HOME=/home/browser

USER browser
EXPOSE 3030
# CDP (9222) is deliberately NOT exposed and is bound to loopback.

HEALTHCHECK --interval=20s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APP_PORT||3030)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]
