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
FROM --platform=$BUILDPLATFORM docker.io/node:22-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# The postinstall hook is a real file (scripts/postinstall.js), and `npm ci` fails outright when
# a lifecycle script is missing — copy it BEFORE the install. dashboard/ and the backport patcher
# are deliberately still absent at this point, so the hook cleanly no-ops here (dashboard deps are
# installed explicitly below; the patcher only matters for the production stage).
COPY scripts/postinstall.js ./scripts/

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
# Drop the incremental-build cache afterwards: it is pinned inside dist/ (so nest's deleteOutDir
# wipes it with the output), and the production stage copies dist/ wholesale — it would otherwise
# ship dead compiler metadata in every image.
RUN npm run build && npm run dashboard:ci -- --include=dev && npm run dashboard:build && rm -f dist/*.tsbuildinfo

# ===== Stage 2: Production =====
FROM docker.io/node:22-slim AS production

# Chrome for Testing has no linux-arm64 build, and Puppeteer's chromium snapshot
# is x86_64-only on Linux too. So: amd64 uses Chrome for Testing (downloaded below)
# to avoid the Debian chromium package's K8s SIGTRAP under strict non-root/seccomp;
# arm64 installs Debian's chromium instead (it ships a native arm64 build). Both
# resolve to the same /usr/local/bin/puppeteer-chrome symlink below.
#
# chromium-sandbox is listed EXPLICITLY (not left to Recommends) so --no-install-recommends still
# trims every other Recommends but keeps the setuid sandbox binary available. Our default forces
# --no-sandbox (configuration.ts) so it goes unused, but a user who overrides PUPPETEER_ARGS to drop
# --no-sandbox would otherwise get a chromium that can't launch. Verified on real arm64 hardware:
# with --no-install-recommends the package is dropped, and chromium launches fine under --no-sandbox.
ARG TARGETARCH
# sqlite3 ships the CLI so an in-container scripts/backup.sh run takes online-consistent SQLite
# snapshots (.backup) instead of plain-copying a live database (which can archive a torn file).
#
# ffmpeg backs the opt-in media-conversion endpoints, and also repairs an existing gap: whatsapp-web.js
# requires fluent-ffmpeg at module load and calls it for video-to-webp animated stickers, so
# sendSticker with a video mimetype has been failing in this image for want of the binary. Measured
# cost with --no-install-recommends: ~210 MB, and no new fixable CRITICAL/HIGH findings under the
# release image scan. It is the Debian package rather than a bundled static build precisely so that
# codec CVEs arrive through the same security stream as everything else here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    $([ "$TARGETARCH" = arm64 ] && echo "chromium chromium-sandbox") \
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
    sqlite3 \
    ffmpeg \
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
# scripts/postinstall.js rides along: `npm ci` below runs the hook, which fails
# when the file is missing. With the patcher present the hook applies it in
# --best-effort mode; the explicit fatal run right after is the real gate.
COPY scripts/postinstall.js scripts/patch-wwebjs-201832.js scripts/wwebjs-201832.patch scripts/patch-wwebjs-newsletter-preview.js scripts/patch-wwebjs-status.js scripts/patch-wwebjs-ready-sync.js ./scripts/

# Install production dependencies only, then apply the backports. The status patcher runs after
# the two patchers it depends on: its transforms were written against the tree they leave behind.
RUN npm ci --omit=dev \
    && node scripts/patch-wwebjs-201832.js \
    && node scripts/patch-wwebjs-newsletter-preview.js \
    && node scripts/patch-wwebjs-status.js \
    && node scripts/patch-wwebjs-ready-sync.js \
    && npm cache clean --force

# Replace the npm the base image bundles. npm is not on the request path — the entrypoint runs
# `node dist/main` — but it stays in the image because the operator runbooks drive it
# (`docker exec openwa npm run cli …`, `npm run export`), and its own bundled dependency tree is
# what the release image scan reports. node:22-slim currently ships npm 10.9.8, whose bundle
# carries a critical node-tar advisory plus sigstore/picomatch ones; npm 12 fixes all three.
# Deliberately AFTER `npm ci`, so the application tree is still resolved by the npm the lockfile
# was generated with and only the global CLI is swapped.
RUN npm install -g npm@12 && npm cache clean --force

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

# Create data directories with correct ownership. Only ./data is chowned, NOT all of /app: the app
# tree (node_modules, dist) only needs read access, which root-owned files already grant, and the
# entrypoint re-chowns /app/data at every container start for the mounted-volume case. A full
# /app chown walks every production dependency file (issue #1045: ~35 minutes on a small VPS) and
# duplicates their metadata into a new image layer.
RUN mkdir -p ./data/sessions ./data/media ./data/plugins && \
    chown -R openwa:openwa ./data

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
#
# NOTE — no `USER openwa` directive on purpose (Trivy DS-0002 will flag it, ignore).
# The Node process does NOT run as root: docker-entrypoint.sh:30 is
# `exec gosu openwa "$@"` after the chowns on lines 7 and 25. Adding `USER openwa`
# here would run the entrypoint as openwa and break the chown-before-drop pattern
# that makes named-volume mounts work on first boot (#254, #259).
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/main"]
