#!/bin/sh
# Smoke test: load both WhatsApp engine libraries inside the built image, the way a session does.
# Usage: OPENWA_SMOKE_IMAGE=<image> [OPENWA_SMOKE_PLATFORM=linux/arm64] ./scripts/smoke-test-engine-libs.sh
# Requires Docker. Needs no network and no WhatsApp account.
#
# Booting the image proves neither engine works. Baileys is ESM and imported lazily on the first
# session start, so a patch the Dockerfile applies to it, or a dependency missing on one
# architecture, only fails once a user starts a session. whatsapp-web.js loads at boot, but the
# browser it drives is launched per session and differs by architecture (Chrome for Testing on
# amd64, Debian's chromium on arm64). Each probe runs through the real entrypoint, so it executes
# as the openwa user with the directories the entrypoint prepares.
set -e

IMAGE="${OPENWA_SMOKE_IMAGE:?set OPENWA_SMOKE_IMAGE to the image under test}"
if [ -n "${OPENWA_SMOKE_PLATFORM:-}" ]; then
  set -- --platform "$OPENWA_SMOKE_PLATFORM"
  LABEL="$OPENWA_SMOKE_PLATFORM"
else
  set --
  LABEL="host platform"
fi

echo "==> [$LABEL] Importing @whiskeysockets/baileys with ENGINE_TYPE=baileys..."
# The names the Baileys adapter reads from the module. A rename upstream, or a patched file that no
# longer parses, fails here instead of on a user's first session.
docker run --rm "$@" -e ENGINE_TYPE=baileys "$IMAGE" node -e "
import('@whiskeysockets/baileys')
  .then(m => {
    const used = ['default', 'initAuthCreds', 'makeCacheableSignalKeyStore', 'fetchLatestBaileysVersion',
      'fetchLatestWaWebVersion', 'normalizeMessageContent', 'getContentType', 'downloadMediaMessage', 'BufferJSON',
      'proto', 'DisconnectReason', 'S_WHATSAPP_NET', 'ALL_WA_PATCH_NAMES', 'CALL_VIDEO_PREFIX', 'CALL_AUDIO_PREFIX'];
    const missing = used.filter(name => m[name] === undefined);
    if (missing.length > 0 || typeof m.default !== 'function') throw new Error('missing exports: ' + missing.join(', '));
    console.log('PASS: Baileys loaded with every export the adapter uses');
  })
  .catch(error => { console.error('FAIL:', error); process.exit(1); });
"

# A platform other than the Docker daemon's own runs under QEMU user emulation (arm64 on the amd64
# release runner), where a full browser launch is slow and unreliable. There the probe executes the
# browser binary instead, which still fails on a missing shared library or a binary built for the
# wrong architecture. The daemon's own platform gets the full launch.
NATIVE="linux/$(docker version --format '{{.Server.Arch}}')"
if [ -n "${OPENWA_SMOKE_PLATFORM:-}" ] && [ "$OPENWA_SMOKE_PLATFORM" != "$NATIVE" ]; then
  echo "==> [$LABEL] Loading whatsapp-web.js and running the image's browser binary (emulated, no launch)..."
  docker run --rm "$@" "$IMAGE" sh -c "node -e \"require('whatsapp-web.js')\" && \"\$PUPPETEER_EXECUTABLE_PATH\" --version"
  echo "PASS: whatsapp-web.js loaded and the browser binary runs"
else
  echo "==> [$LABEL] Loading whatsapp-web.js and launching the image's browser..."
  # The same launch options the engine uses by default (configuration.ts): the image's
  # PUPPETEER_EXECUTABLE_PATH and the default PUPPETEER_ARGS.
  docker run --rm "$@" "$IMAGE" node -e "
  require('whatsapp-web.js');
  require('puppeteer')
    .launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    })
    .then(async browser => {
      console.log('PASS: browser launched: ' + (await browser.version()));
      await browser.close();
    })
    .catch(error => { console.error('FAIL:', error); process.exit(1); });
  "
fi

echo ""
echo "Engine library smoke passed on $LABEL"
