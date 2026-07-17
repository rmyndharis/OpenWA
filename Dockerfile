# OpenWA - Dockerfile
# Multi-stage build for production-ready image

# ===== Stage 1: Builder =====
# Pin the builder to the BUILD host's platform (not the target's). It only produces arch-INDEPENDENT
# artifacts (the NestJS dist/ JS and the static dashboard SPA), so it never needs to run emulated for
# the non-native target. On a multi-arch buildx build this avoids QEMU emulating the whole npm ci +
# Vite build for arm64 — which is slow AND is where the arm64 lightningcss (Vite 8's native CSS
# minifier) optional dependency fails to install ("Cannot find module lightningcss.linux-arm64-gnu.node").
# The per-arch runtime deps are installed natively in the target-platform production stage below.
# NOTE: $BUILDPLATFORM requires BuildKit (CI uses buildx; modern `docker build`/compose default to it).
FROM --platform=$BUILDPLATFORM docker.io/node:26-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install all dependencies INCLUDING devDependencies — the build needs them (`nest` from
# @nestjs/cli, plus `vite`/`typescript` for the dashboard). `--include=dev` is REQUIRED, not
# cosmetic: npm omits devDependencies whenever NODE_ENV=production is present in the build env.
# Coolify (and similar PaaS) promote every ${VAR} referenced in the compose file to a build-time
# variable, so docker-compose.yml's `NODE_ENV=${NODE_ENV:-production}` leaks NODE_ENV=production
# into this stage and a bare `npm ci` would skip @nestjs/cli → `sh: 1: nest: not found` (exit 127).
# (docker-compose.dev.yml hardcodes NODE_ENV=development, which is why the dev build never hit this.)
RUN npm ci --include=dev

# Copy source code
COPY . .

# Build the API (dist/) and the dashboard SPA (dashboard/dist/). The root `npm ci` above
# ran before the dashboard source was copied, so its postinstall hook skipped the dashboard
# deps - install them explicitly here (npm ci, reproducible from dashboard/package-lock.json).
# `--include=dev` for the same reason as above: the dashboard build needs vite/typescript
# (devDependencies), which a NODE_ENV=production build env would otherwise omit.
RUN npm run build && npm run dashboard:ci -- --include=dev && npm run dashboard:build

# ===== Stage 2: Production =====
FROM docker.io/node:26-slim AS production

# Chrome for Testing has no linux-arm64 build, and Puppeteer's chromium snapshot
# is x86_64-only on Linux too. So: amd64 uses Chrome for Testing (downloaded below)
# to avoid the Debian chromium package's K8s SIGTRAP under strict non-root/seccomp;
# arm64 installs Debian's chromium instead (it ships a native arm64 build). Both
# resolve to the same /usr/local/bin/puppeteer-chrome symlink below.
ARG TARGETARCH
RUN apt-get update && apt-get install -y \
    $([ "$TARGETARCH" = arm64 ] && echo chromium) \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    dumb-init \
    gosu \
    patch \
    curl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to skip automatic download during npm install (we download it explicitly below)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create app user for security
RUN groupadd -r openwa && useradd -r -g openwa openwa

WORKDIR /app

# Copy package files
COPY package*.json ./

# Backport upstream whatsapp-web.js#201832 (id._serialized -> id.$1 normalization,
# broken by WA Web 2.3000.x ~2026-07-14) into the installed dep at build time.
# The patcher self-disables once whatsapp-web.js ships the fix upstream.
COPY scripts/patch-wwebjs-201832.js scripts/wwebjs-201832.patch ./scripts/

# Install production dependencies only, then apply the backport patcher (needs `patch`).
RUN npm ci --omit=dev && node scripts/patch-wwebjs-201832.js && npm cache clean --force

# amd64: download Chrome for Testing via Puppeteer and symlink it.
# arm64: use Debian's chromium installed above (CfT has no linux-arm64 build).
# test -n guards against a future path mismatch failing loudly instead of shipping a broken image.
RUN if [ "$TARGETARCH" = arm64 ]; then \
        ln -s /usr/bin/chromium /usr/local/bin/puppeteer-chrome; \
    else \
        mkdir -p /opt/puppeteer && \
        PUPPETEER_CACHE_DIR=/opt/puppeteer ./node_modules/.bin/puppeteer browsers install 'chrome@146.0.7680.31' && \
        chown -R openwa:openwa /opt/puppeteer && \
        chrome_path=$(find /opt/puppeteer/chrome/linux*/chrome-linux64/chrome | head -n 1) && \
        test -n "$chrome_path" && \
        ln -s "$chrome_path" /usr/local/bin/puppeteer-chrome; \
    fi
ENV PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/puppeteer-chrome

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy the bundled dashboard SPA; ServeStaticModule serves it from this same process/port
# (app.module.ts resolves dashboard/dist relative to dist/). Single container, single port.
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Create data directories with correct ownership
RUN mkdir -p ./data/sessions ./data/media && \
    chown -R openwa:openwa /app

# The non-root openwa user has no home of its own (`useradd -r`, no -m). Chromium resolves the home
# dir from the passwd entry via glib's getpwuid() — it IGNORES $HOME — so it tries to read/write
# /home/openwa, which does not exist. On hardened/read-only hosts that makes the browser HARD-CRASH
# at launch (SIGTRAP/int3, logged as "chrome_crashpad_handler: --database is required"). The robust
# fix is to point Chromium's config + cache at writable, pre-created dirs via XDG_* (honored directly,
# bypassing the passwd lookup); docker-entrypoint.sh creates them owned by openwa. On a read_only
# rootfs these live on the tmpfs /tmp. HOME is kept for any other HOME-relative tooling. See #254/#242.
ENV HOME=/app/data
ENV XDG_CONFIG_HOME=/tmp/.config
ENV XDG_CACHE_HOME=/tmp/.cache

# Copy entrypoint: runs as root to fix named-volume ownership, then drops to openwa via gosu
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 2785

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:2785/api/health/ready || exit 1

# dumb-init is PID 1 and handles signal forwarding.
# It execs docker-entrypoint.sh (as root), which fixes volume ownership and
# then drops to the openwa user via gosu before starting the node process.
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main"]
