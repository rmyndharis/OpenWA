#!/bin/sh
# Smoke test: verify the built image runs its process as the openwa user (not root).
# Usage: ./scripts/smoke-test-non-root.sh
# Requires Docker to be running locally.
set -e

# The Dockerfile pins the builder to $BUILDPLATFORM (BuildKit-injected) for multi-arch correctness,
# so the build requires BuildKit. It's the modern default, but force it on in case the host disabled it.
export DOCKER_BUILDKIT=1

# CI already builds the image; set OPENWA_SMOKE_IMAGE to reuse that tag instead of paying for a
# second build. Unset (the local default) keeps the original behaviour: build here, remove after.
IMAGE_TAG="${OPENWA_SMOKE_IMAGE:-openwa-test-non-root:smoke}"
BUILT_HERE=0

if [ -z "${OPENWA_SMOKE_IMAGE:-}" ]; then
  BUILT_HERE=1
  echo "==> Building test image..."
  docker build -t "$IMAGE_TAG" .
else
  echo "==> Using pre-built image: $IMAGE_TAG"
fi

VOL=""
SIGNAL_CONTAINER=""
BOOT_CONTAINER=""

# Only remove an image this script created — never one the caller handed us.
cleanup() {
  if [ -n "$SIGNAL_CONTAINER" ]; then
    docker rm -f "$SIGNAL_CONTAINER" > /dev/null 2>&1 || true
  fi
  if [ -n "$BOOT_CONTAINER" ]; then
    docker rm -f "$BOOT_CONTAINER" > /dev/null 2>&1 || true
  fi
  if [ -n "$VOL" ]; then
    docker volume rm -f "$VOL" > /dev/null 2>&1 || true
  fi
  if [ "$BUILT_HERE" -eq 1 ]; then
    docker rmi "$IMAGE_TAG" > /dev/null 2>&1 || true
  fi
}
# Every exit, set -e aborts included, so a failed step never leaves the volume or image behind.
trap cleanup EXIT

echo ""
echo "==> Checking process user inside container..."
# Override CMD with 'id' so docker-entrypoint.sh runs: exec gosu openwa id
USER_OUTPUT=$(docker run --rm "$IMAGE_TAG" id)
echo "    $USER_OUTPUT"

if echo "$USER_OUTPUT" | grep -q "uid=0(root)"; then
  echo "FAIL: process is running as root!" >&2
  exit 1
fi

if echo "$USER_OUTPUT" | grep -q "openwa"; then
  echo "PASS: process runs as openwa (non-root)"
else
  echo "FAIL: process is not running as the openwa user" >&2
  exit 1
fi

echo ""
echo "==> Verifying dumb-init is PID 1..."
PID1=$(docker run --rm "$IMAGE_TAG" sh -c 'cat /proc/1/comm 2>/dev/null || ps -p 1 -o comm= 2>/dev/null || echo unknown')
echo "    PID 1: $PID1"
if echo "$PID1" | grep -q "dumb-init"; then
  echo "PASS: dumb-init is PID 1"
else
  # Without it as PID 1 nothing reaps Chromium's exited children or forwards signals past Node.
  echo "FAIL: PID 1 is '$PID1' (expected dumb-init), check the ENTRYPOINT chain" >&2
  exit 1
fi

echo ""
echo "==> Checking signal forwarding with Compose capabilities..."
CAPS=$(docker run --rm -i --entrypoint node "$IMAGE_TAG" -e \
  'const fs=require("fs"),yaml=require("js-yaml");console.log(yaml.load(fs.readFileSync(0,"utf8")).services["openwa-api"].cap_add.join(" "))' < docker-compose.yml)
set --
for cap in $CAPS; do
  set -- "$@" --cap-add "$cap"
done
SIGNAL_CONTAINER=$(docker run -d --read-only --tmpfs /tmp --cap-drop ALL "$@" \
  --security-opt no-new-privileges "$IMAGE_TAG" node -e \
  'const fs=require("fs");if(process.getuid()!==997||!/^CapEff:\s+0+$/m.test(fs.readFileSync("/proc/self/status","utf8")))process.exit(1);process.on("SIGTERM",()=>process.exit(0));console.log("signal-ready");setInterval(()=>{},1000)')
# A container that exited will never print the line, so report that at once with its exit code and logs
# instead of waiting out the deadline.
for attempt in $(seq 1 60); do
  if docker logs "$SIGNAL_CONTAINER" | grep -q '^signal-ready$'; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$SIGNAL_CONTAINER")" != true ]; then
    echo "FAIL: the non-root signal test exited with $(docker inspect --format '{{.State.ExitCode}}' "$SIGNAL_CONTAINER") before it was ready:" >&2
    docker logs "$SIGNAL_CONTAINER" >&2 || true
    exit 1
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "FAIL: the non-root signal test was not ready after 30 s" >&2
    docker logs "$SIGNAL_CONTAINER" >&2 || true
    exit 1
  fi
  sleep 0.5
done
docker stop --time 5 "$SIGNAL_CONTAINER" > /dev/null
SIGNAL_EXIT=$(docker inspect --format '{{.State.ExitCode}}' "$SIGNAL_CONTAINER")
if [ "$SIGNAL_EXIT" != 0 ]; then
  echo "FAIL: the unprivileged process did not receive SIGTERM (exit $SIGNAL_EXIT)" >&2
  exit 1
fi
echo "PASS: init forwards SIGTERM and the non-root process has no effective capabilities"
docker rm "$SIGNAL_CONTAINER" > /dev/null
SIGNAL_CONTAINER=""

echo ""
echo "==> Checking /app/data ownership on start..."
VOL="openwa-smoke-data-$$"
docker volume create "$VOL" > /dev/null
# Seed as root, bypassing the entrypoint: a file restored as root, and a link to a root-owned file.
docker run --rm --entrypoint sh -v "$VOL":/app/data "$IMAGE_TAG" -c \
  'mkdir -p /app/data/sessions/s1 && touch /app/data/sessions/s1/restored && ln -s /etc/passwd /app/data/link'
OWNERS=$(docker run --rm -v "$VOL":/app/data "$IMAGE_TAG" stat -c '%U:%G' /app/data/sessions/s1/restored /etc/passwd | tr '\n' ' ')
echo "    restored file, link target: $OWNERS"
if [ "$OWNERS" = "openwa:openwa root:root " ]; then
  echo "PASS: a root-owned file is re-owned and a symlink target is left alone"
else
  echo "FAIL: expected 'openwa:openwa root:root', got '$OWNERS'" >&2
  exit 1
fi
# A chown is a metadata write even when the owner is unchanged, so it moves ctime. A start that
# re-owns an already-owned file pays that write per file, which is minutes on a large volume.
CTIME_BEFORE=$(docker run --rm --entrypoint stat -v "$VOL":/app/data "$IMAGE_TAG" -c %z /app/data/sessions/s1/restored)
docker run --rm -v "$VOL":/app/data "$IMAGE_TAG" true
CTIME_AFTER=$(docker run --rm --entrypoint stat -v "$VOL":/app/data "$IMAGE_TAG" -c %z /app/data/sessions/s1/restored)
if [ "$CTIME_BEFORE" = "$CTIME_AFTER" ]; then
  echo "PASS: a start leaves already-owned files untouched"
else
  echo "FAIL: a start re-owned an already-owned file (ctime $CTIME_BEFORE -> $CTIME_AFTER)" >&2
  exit 1
fi

echo ""
echo "==> Checking a start as the openwa uid itself..."
# runAsUser/fsGroup and --user name a number, so the image must guarantee it.
PINNED=$(docker run --rm --entrypoint id "$IMAGE_TAG" openwa)
echo "    $PINNED"
case "$PINNED" in
  "uid=997(openwa) gid=997(openwa)"*) echo "PASS: openwa is uid/gid 997" ;;
  *) echo "FAIL: expected openwa to be uid=997 gid=997, got '$PINNED'" >&2; exit 1 ;;
esac
# The Pod Security "restricted" shape: no capabilities at all, read-only rootfs, and the volume a
# root start has already re-owned. The entrypoint must skip its chown and gosu drop, not fail on them.
if ! NONROOT=$(docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user 997:997 -v "$VOL":/app/data "$IMAGE_TAG" id -u 2>&1); then
  echo "FAIL: a start as 997:997 with no capabilities exited non-zero: $NONROOT" >&2
  exit 1
fi
if [ "$NONROOT" = "997" ]; then
  echo "PASS: a start as 997:997 with no capabilities runs the command as 997"
else
  echo "FAIL: a start as 997:997 printed '$NONROOT'" >&2
  exit 1
fi
# Any other uid cannot write the image's /app/data; it must stop with the cause, not a chown error.
if OTHER=$(docker run --rm --user 12345:12345 "$IMAGE_TAG" id -u 2>&1); then
  echo "FAIL: a start as 12345 with an unwritable /app/data succeeded: $OTHER" >&2
  exit 1
fi
if echo "$OTHER" | grep -q "FATAL: /app/data is not writable by uid 12345"; then
  echo "PASS: a start as an unrelated uid stops and names the unwritable volume"
else
  echo "FAIL: a start as 12345 failed without the expected message: $OTHER" >&2
  exit 1
fi

echo ""
echo "==> Booting the gateway with the openwa-api hardening from docker-compose.yml..."
# Everything above runs a probe, never node dist/main, so a change that writes outside /app/data and /tmp
# or needs a dropped capability would pass here and fail on `docker compose up`. These are the compose
# flags, limits at their defaults; scripts/smoke-test-non-root.spec.js fails when the two drift apart.
API_HARDENING="--read-only --tmpfs /tmp --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add KILL --cap-add SETGID --cap-add SETUID --security-opt no-new-privileges:true --pids-limit 2048 --memory 2g"
# shellcheck disable=SC2086 # one flag per word
BOOT_CONTAINER=$(docker run -d $API_HARDENING -v "$VOL":/app/data "$IMAGE_TAG")
for attempt in $(seq 1 120); do
  READY=$(docker exec "$BOOT_CONTAINER" curl -s -o /dev/null -w '%{http_code}' \
    http://localhost:2785/api/health/ready 2> /dev/null || true)
  if [ "$READY" = 200 ]; then
    break
  fi
  if [ "$(docker inspect --format '{{.State.Running}}' "$BOOT_CONTAINER")" != true ]; then
    echo "FAIL: the hardened gateway exited with $(docker inspect --format '{{.State.ExitCode}}' "$BOOT_CONTAINER") before it was ready:" >&2
    docker logs "$BOOT_CONTAINER" >&2 || true
    exit 1
  fi
  if [ "$attempt" -eq 120 ]; then
    echo "FAIL: /api/health/ready did not answer 200 in 120 tries a second apart (last: '$READY'):" >&2
    docker logs "$BOOT_CONTAINER" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "PASS: the gateway boots and answers /api/health/ready under the compose hardening"
docker rm -f "$BOOT_CONTAINER" > /dev/null
BOOT_CONTAINER=""

echo ""
echo "All smoke tests passed!"
