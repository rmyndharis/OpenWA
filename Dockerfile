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
# The digest pins the multi-arch node:22-slim index, so every build starts from the same immutable
# base; dependabot's docker ecosystem proposes the new digest when the tag moves. Update tag and
# digest together.
FROM --platform=$BUILDPLATFORM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

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
# Same digest-pinned node:22-slim base as the builder stage.
FROM docker.io/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS production

# Run the app with production defaults from the first boot: an unset NODE_ENV selects the
# development branch of the CORS/Swagger/DTO-error-detail/default-secret hardening (main.ts
# warns about exactly this case). Both compose files and the Helm chart already set it; a plain
# `docker run` of this image did not. The npm installs below pin --omit=dev explicitly, so this
# changes nothing about which dependencies land in the image.
ENV NODE_ENV=production

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
# snapshots (.backup) instead of plain-copying a live database (which can archive a torn file). The
# DATABASE_TYPE=postgres half of the same script needs pg_dump, installed further down.
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

# The PostgreSQL client for the DATABASE_TYPE=postgres half of backup.sh/restore.sh, which the
# runbook drives in-container. Debian bookworm ships client 15 and pg_dump refuses a newer server
# outright ("aborting because of server version mismatch", reproduced against the postgres:16 the
# bundled compose file runs), so the distro package would install a pg_dump that cannot dump our own
# stack, and psql would be missing for restore. PGDG is PostgreSQL's own apt repository and carries
# current majors for both architectures we build; measured cost ~59 MB.
#
# Deliberately NEWER than the postgres:16 the compose file ships. The rule is one-directional (a
# client may be newer than its server, never older), and DATABASE_HOST often points at a managed
# Postgres the compose file does not control, where 17 is the current default. Pinning to 16 would
# have left every such deployment unable to back up. Verified against live 16 and 17 servers.
#
# The signing key is committed rather than fetched at build time. Fetched, it was the one build input
# nothing pinned: `signed-by` attests only that the .debs match whatever that request returned, so a
# compromised host, or a build behind a TLS-intercepting proxy whose root is in the trust store,
# would swap the trust anchor with nothing to notice. Committed, it is reviewed once and diffable
# forever, and it removes one of the two network calls the release build makes uncached
# (release.yml's `no-cache-filters: production` rebuilds this stage every tag, on both platforms).
# Verify with `gpg --show-keys --with-fingerprint scripts/pgdg-ACCC4CF8.asc`:
#   B97B0AFC AA1A47F0 44F244A0 7FCC7D46 ACCC4CF8, uid "PostgreSQL Debian Repository".
#
# 10 packages arrive with it on top of the list above (12 on a bare base; sqlite3 already brings
# libreadline8), including a full perl interpreter: /usr/bin/pg_dump is a symlink to
# postgresql-common's pg_wrapper, which is a perl script. Trivy on the built image, with the release
# job's own settings (CRITICAL,HIGH + ignore-unfixed + .trivyignore): 0 findings, the bar the ffmpeg
# layer above was held to. Counting unfixed ones too, the perl packages carry 8 CRITICAL/HIGH with
# no upstream fix, but every one of them is a CVE the base image ALREADY had through perl-base
# (Debian essential, present before this layer), so the layer adds 0 distinct vulnerabilities.
# libpq5 and the postgresql-client packages themselves are clean. Recheck with:
#   trivy image --vuln-type os,library --severity CRITICAL,HIGH --ignore-unfixed --ignorefile .trivyignore <image>
#
# The armored key must reach the image with LF endings. apt dearmors a `signed-by=` .asc through
# apt-key, whose awk advances on the blank armor separator line, so a CR there yields an empty
# keyring and NO_PUBKEY 7FCC7D46ACCC4CF8. The `.gitattributes` rule keeps fresh clones on LF; the
# strip below repairs the Windows clones already on disk, which that rule cannot reach.
COPY scripts/pgdg-ACCC4CF8.asc /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
RUN sed -i 's/\r$//' /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
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
# scripts/postinstall.js rides along so a bare local `npm ci` keeps working, but the
# --ignore-scripts install below skips the hook here: the explicit fatal run right
# after is the sole (and stricter) applier for the image.
COPY scripts/postinstall.js scripts/patch-wwebjs-201832.js scripts/wwebjs-201832.patch scripts/patch-wwebjs-newsletter-preview.js scripts/patch-wwebjs-status.js scripts/patch-wwebjs-ready-sync.js scripts/patch-wwebjs-participant-arity.js scripts/patch-wwebjs-block.js scripts/patch-baileys-appstate.js scripts/patch-baileys-newsletter-create.js ./scripts/

# Install production dependencies only, then apply the backports. The status patcher runs after
# the two patchers it depends on: its transforms were written against the tree they leave behind.
# scripts/dockerfile-patchers.spec.js derives this list from scripts/patch-*.js and fails if a
# patcher is added without being copied AND run here — a hand-written list loses one silently, and
# the Baileys one shipped in postinstall for a whole release without ever reaching the image.
#
# --ignore-scripts: this stage has no compiler toolchain, and npm still auto-runs
# `node-gyp rebuild` for any package shipping a binding.gyp without its own install
# script (better-sqlite3's major bump ships N-API prebuilds inside the package, so
# its runtime loader picks prebuilds/<platform>-<arch>.node — compiling here would
# fail on the missing python). The other native optionals (cpu-features,
# msgpackr-extract) are optional=true with runtime fallbacks. The patchers that DO
# need to run are the explicit fatal invocations below; baileys' preinstall is only
# a node-version check that the engines field enforces anyway.
RUN npm ci --omit=dev --ignore-scripts \
    && node scripts/patch-wwebjs-201832.js \
    && node scripts/patch-wwebjs-newsletter-preview.js \
    && node scripts/patch-wwebjs-status.js \
    && node scripts/patch-wwebjs-ready-sync.js \
    && node scripts/patch-wwebjs-participant-arity.js \
    && node scripts/patch-wwebjs-block.js \
    && node scripts/patch-baileys-appstate.js \
    && node scripts/patch-baileys-newsletter-create.js \
    && npm cache clean --force

# Replace the npm the base image bundles. npm is not on the request path — the entrypoint runs
# `node dist/main` — but it stays in the image because the operator runbooks drive it
# (`docker exec openwa npm run cli …`, `npm run export`), and its own bundled dependency tree is
# what the release image scan reports. node:22-slim currently ships npm 10.9.8, whose bundle
# carries a critical node-tar advisory plus sigstore/picomatch ones; npm 12 fixes all three.
# Deliberately AFTER `npm ci`, so the application tree is still resolved by the npm the lockfile
# was generated with and only the global CLI is swapped. Pinned to the exact patch release —
# a floating npm@12 would make the image's bundled npm tree depend on when the build happened.
RUN npm install -g npm@12.0.2 && npm cache clean --force

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

# Operator backup/restore scripts. docs/11-operational-runbooks.md drives them in-container
# (`docker exec` against the named-volume mount at /app/data), and the sqlite3 CLI installed above
# is there for backup.sh's online-consistent snapshots — but the scripts themselves were never
# copied into the image. lib-env.sh is sourced by both, never executed. backup.sh/restore.sh carry
# the exec bit in the repo and COPY preserves it, so no chmod is needed.
COPY scripts/backup.sh scripts/restore.sh scripts/lib-env.sh ./scripts/

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
