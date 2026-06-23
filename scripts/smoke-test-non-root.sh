#!/bin/sh
# Smoke test: verify the built image runs its process as the openwa user (not root).
# Usage: ./scripts/smoke-test-non-root.sh
# Requires Docker to be running locally.
set -e

# The Dockerfile pins the builder to $BUILDPLATFORM (BuildKit-injected) for multi-arch correctness,
# so the build requires BuildKit. It's the modern default, but force it on in case the host disabled it.
export DOCKER_BUILDKIT=1

IMAGE_TAG="openwa-test-non-root:smoke"

echo "==> Building test image..."
docker build -t "$IMAGE_TAG" .

echo ""
echo "==> Checking process user inside container..."
# Override CMD with 'id' so docker-entrypoint.sh runs: exec gosu openwa id
USER_OUTPUT=$(docker run --rm "$IMAGE_TAG" id)
echo "    $USER_OUTPUT"

if echo "$USER_OUTPUT" | grep -q "uid=0(root)"; then
  echo "FAIL: process is running as root!" >&2
  docker rmi "$IMAGE_TAG" > /dev/null 2>&1 || true
  exit 1
fi

if echo "$USER_OUTPUT" | grep -q "openwa"; then
  echo "PASS: process runs as openwa (non-root)"
else
  echo "FAIL: process is not running as the openwa user" >&2
  docker rmi "$IMAGE_TAG" > /dev/null 2>&1 || true
  exit 1
fi

echo ""
echo "==> Verifying dumb-init is PID 1..."
PID1=$(docker run --rm "$IMAGE_TAG" sh -c 'cat /proc/1/comm 2>/dev/null || ps -p 1 -o comm= 2>/dev/null || echo unknown')
echo "    PID 1: $PID1"
if echo "$PID1" | grep -q "dumb-init"; then
  echo "PASS: dumb-init is PID 1"
else
  echo "WARN: PID 1 is '$PID1' (expected dumb-init) — check entrypoint chain"
fi

docker rmi "$IMAGE_TAG" > /dev/null 2>&1 || true
echo ""
echo "All smoke tests passed!"
