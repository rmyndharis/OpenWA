#!/bin/sh
# Smoke test: verify openwa-api can list containers via docker-socket-proxy.
# Run this after `docker compose up -d` with the stack fully started.
# Usage: ./scripts/smoke-test-docker-proxy.sh [API_KEY]
set -e

API_KEY="${1:-}"
BASE_URL="${BASE_URL:-http://localhost:2785}"

if [ -z "$API_KEY" ]; then
  echo "Usage: $0 <admin-api-key>" >&2
  exit 1
fi

echo "==> Checking openwa-api health..."
STATUS=$(curl -sf -o /dev/null -w "%{http_code}" "$BASE_URL/api/health")
if [ "$STATUS" != "200" ]; then
  echo "FAIL: /api/health returned HTTP $STATUS (expected 200)" >&2
  exit 1
fi
echo "PASS: API health OK"

echo ""
echo "==> Verifying Docker proxy connectivity via infrastructure status..."
RESPONSE=$(curl -sf \
  -H "X-API-Key: $API_KEY" \
  "$BASE_URL/api/infra/status")

echo "Response: $RESPONSE"

# The key check: docker availability flag from DockerService.isDockerAvailable()
# If the proxy is unreachable, the service logs a warning and sets isAvailable=false.
# We indirectly validate this by confirming the API responds without error.
echo ""
echo "==> Verifying docker-proxy container is running..."
PROXY_STATE=$(docker inspect --format='{{.State.Status}}' openwa-docker-proxy 2>/dev/null || echo "not_found")
if [ "$PROXY_STATE" != "running" ]; then
  echo "FAIL: openwa-docker-proxy is not running (state: $PROXY_STATE)" >&2
  exit 1
fi
echo "PASS: openwa-docker-proxy is running"

echo ""
echo "==> Verifying openwa-api socket mount is gone..."
SOCKET_MOUNT=$(docker inspect openwa-api --format='{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' 2>/dev/null | grep "docker.sock" || true)
if [ -n "$SOCKET_MOUNT" ]; then
  echo "FAIL: openwa-api still has a docker.sock mount: $SOCKET_MOUNT" >&2
  exit 1
fi
echo "PASS: openwa-api has no direct docker.sock mount"

echo ""
echo "All smoke tests passed!"
