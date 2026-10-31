#!/bin/sh
# Smoke test: verify openwa-api can list containers via docker-socket-proxy.
# Run this after `docker compose up -d` with the stack fully started.
# Usage: ./scripts/smoke-test-docker-proxy.sh <unscoped-admin-api-key>
set -e

API_KEY="${1:-}"
BASE_URL="${BASE_URL:-http://localhost:2785}"

if [ -z "$API_KEY" ]; then
  echo "Usage: $0 <unscoped-admin-api-key>" >&2
  exit 1
fi

echo "==> Checking openwa-api health..."
# No -f on these calls: under set -e a failing status would end the script before the check says why.
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" || true)
if [ "$STATUS" != "200" ]; then
  echo "FAIL: /api/health returned HTTP $STATUS (expected 200)" >&2
  exit 1
fi
echo "PASS: API health OK"

echo ""
echo "==> Checking the admin API answers (infrastructure status)..."
RESPONSE=$(curl -s -w '\n%{http_code}' \
  -H "X-API-Key: $API_KEY" \
  "$BASE_URL/api/infra/status" || true)
CODE=$(printf '%s\n' "$RESPONSE" | tail -n 1)
if [ "$CODE" != "200" ]; then
  # Only an auth failure is about the key. The route also refuses a session-scoped ADMIN key and one
  # used from outside its IP allow-list.
  HINT=''
  case "$CODE" in
    401 | 403) HINT='; the key must be an unscoped ADMIN key allowed from this IP' ;;
  esac
  echo "FAIL: /api/infra/status returned HTTP $CODE (expected 200$HINT)" >&2
  exit 1
fi
echo "Response: $(printf '%s\n' "$RESPONSE" | sed '$d')"

# This proves only that the admin API answers: the status payload carries no Docker flag. Whether
# the proxy admits what orchestration needs is checked from inside openwa-api below.
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
for endpoint in _ping containers/json images/json volumes; do
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
# (tecnativa/docker-socket-proxy v0.5.0) admits EVERY method to the enabled paths — its
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
