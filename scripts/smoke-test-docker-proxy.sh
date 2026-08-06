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
echo "==> Verifying the proxy permits the read operations orchestration needs (from openwa-api)..."
# openwa-api is the only container that can reach docker-proxy:2375 (internal network), so
# the ACL is exercised from inside it. Node's global fetch (Node 18+) avoids a curl dependency.
for endpoint in _ping containers/json; do
  CODE=$(docker exec openwa-api node -e "fetch('http://docker-proxy:2375/$endpoint').then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
  if [ "$CODE" != "200" ]; then
    echo "FAIL: GET /$endpoint via proxy returned HTTP $CODE (expected 200)" >&2
    exit 1
  fi
  echo "PASS: GET /$endpoint via proxy -> 200"
done

echo ""
echo "==> Verifying a denied endpoint family stays denied (GET /networks must be 403)..."
CODE=$(docker exec openwa-api node -e "fetch('http://docker-proxy:2375/networks').then(r=>console.log(r.status)).catch(()=>console.log(0))" 2>/dev/null || echo 0)
if [ "$CODE" != "403" ]; then
  echo "FAIL: GET /networks via proxy returned HTTP $CODE (expected 403)" >&2
  exit 1
fi
echo "PASS: GET /networks via proxy -> 403 (denied)"
# NOTE: there is intentionally no "DELETE is rejected" check. With POST=1 the pinned proxy
# (tecnativa/docker-socket-proxy v0.4.2) admits EVERY method to the enabled paths — its
# DELETE env flag is dead config — so such a check would fail against the working
# configuration. OpenWA itself never issues deletes (profile teardown is stop-only);
# see SECURITY.md "Docker socket proxy — scope and residual risk".

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
