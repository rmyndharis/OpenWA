#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="/var/www/OpenWa"
APP_USER="angel"
APP_GROUP="openwa"
SERVICE_NAME="openwa"
REMOTE_HOST="82.223.115.45"
REMOTE_USER="root"
REMOTE_PORT="22"
SSH_KEY_PATH=""
REMOTE_EXEC="false"
API_PORT="2785"
RUN_MIGRATIONS="false"
SKIP_NPM_CI="false"
SKIP_BUILD="false"
RELOAD_NGINX="true"
TUNE_AUTH="false"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

log_info() { printf '[INFO] %s\n' "$1"; }
log_warn() { printf '[WARN] %s\n' "$1"; }
log_error() { printf '[ERROR] %s\n' "$1"; }

usage() {
  cat <<'EOF'
Update OpenWA on Ubuntu (systemd + nginx) without Docker

Usage:
  # Run inside the VPS:
  sudo bash scripts/update-ubuntu-no-docker.sh [options]

  # Run from local machine (SSH sync + remote update):
  bash scripts/update-ubuntu-no-docker.sh --remote-host <host> [options]

Options:
  --app-dir <path>         Install directory (default: /var/www/OpenWa)
  --app-user <user>        Service user (default: angel)
  --app-group <group>      Service group (default: openwa)
  --service <name>         systemd service name (default: openwa)
  --source-dir <path>      Local project directory to sync (default: parent dir of this script)
  --remote-host <host>     Remote server host/IP for SSH update
  --remote-user <user>     SSH user (default: root)
  --remote-port <port>     SSH port (default: 22)
  --ssh-key <path>         SSH private key path (optional)
  --api-port <port>        API port for health check (default: 2785)
  --run-migrations         Run DB migrations after build
  --skip-npm-ci            Skip npm ci
  --skip-build             Skip npm build steps
  --reload-nginx           Validate and reload nginx after app restart
  --tune-auth              Apply WhatsApp auth performance tuning to .env
  -h, --help               Show this help

Examples:
  sudo bash scripts/update-ubuntu-no-docker.sh
  sudo bash scripts/update-ubuntu-no-docker.sh --source-dir /var/www/OpenWa-src --run-migrations
  sudo bash scripts/update-ubuntu-no-docker.sh --tune-auth
  bash scripts/update-ubuntu-no-docker.sh --remote-host 203.0.113.10 --remote-user ubuntu --source-dir .
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --app-user)
      APP_USER="$2"
      shift 2
      ;;
    --app-group)
      APP_GROUP="$2"
      shift 2
      ;;
    --service)
      SERVICE_NAME="$2"
      shift 2
      ;;
    --source-dir)
      SOURCE_DIR="$2"
      shift 2
      ;;
    --remote-host)
      REMOTE_HOST="$2"
      shift 2
      ;;
    --remote-user)
      REMOTE_USER="$2"
      shift 2
      ;;
    --remote-port)
      REMOTE_PORT="$2"
      shift 2
      ;;
    --ssh-key)
      SSH_KEY_PATH="$2"
      shift 2
      ;;
    --remote-exec)
      REMOTE_EXEC="true"
      shift 1
      ;;
    --api-port)
      API_PORT="$2"
      shift 2
      ;;
    --run-migrations)
      RUN_MIGRATIONS="true"
      shift 1
      ;;
    --skip-npm-ci)
      SKIP_NPM_CI="true"
      shift 1
      ;;
    --skip-build)
      SKIP_BUILD="true"
      shift 1
      ;;
    --reload-nginx)
      RELOAD_NGINX="true"
      shift 1
      ;;
    --tune-auth)
      TUNE_AUTH="true"
      shift 1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    log_error "Run this script with sudo/root."
    exit 1
  fi
}

resolve_source_dir() {
  SOURCE_DIR="$(cd "${SOURCE_DIR}" 2>/dev/null && pwd || true)"
}

validate_source_dir() {
  if [[ -z "${SOURCE_DIR}" || ! -d "${SOURCE_DIR}" ]]; then
    log_error "Invalid --source-dir. Directory not found."
    exit 1
  fi
  if [[ ! -f "${SOURCE_DIR}/package.json" ]]; then
    log_error "Invalid --source-dir. package.json not found in ${SOURCE_DIR}"
    exit 1
  fi
}

resolve_ssh_key_path() {
  if [[ -n "${SSH_KEY_PATH}" && "${SSH_KEY_PATH}" == "~/"* ]]; then
    SSH_KEY_PATH="${HOME}/${SSH_KEY_PATH#~/}"
  fi
}

validate_local_orchestrator() {
  if [[ -z "${REMOTE_HOST}" ]]; then
    log_error "--remote-host is required for local SSH update mode."
    exit 1
  fi

  if ! command -v ssh >/dev/null 2>&1; then
    log_error "ssh not found on local machine."
    exit 1
  fi
  if ! command -v rsync >/dev/null 2>&1; then
    log_error "rsync not found on local machine."
    exit 1
  fi
  resolve_ssh_key_path

  if [[ -n "${SSH_KEY_PATH}" && ! -f "${SSH_KEY_PATH}" ]]; then
    log_error "SSH key not found: ${SSH_KEY_PATH}"
    exit 1
  fi

  resolve_source_dir
  validate_source_dir
}

build_ssh_remote_cmd() {
  local out="" part quoted=""
  for part in "$@"; do
    printf -v quoted '%q' "$part"
    out+="${quoted} "
  done
  printf '%s' "${out% }"
}

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"

  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ ("^" k "=") { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
}

run_remote_update_from_local() {
  local ssh_target
  local ssh_args=("-p" "${REMOTE_PORT}")
  local rsync_ssh
  local rsync_remote_bin="rsync"
  local remote_mkdir_cmd
  local -a remote_runner
  local remote_cmd
  local remote_args=(
    "--remote-exec"
    "--app-dir" "${APP_DIR}"
    "--app-user" "${APP_USER}"
    "--app-group" "${APP_GROUP}"
    "--service" "${SERVICE_NAME}"
    "--source-dir" "${APP_DIR}"
    "--api-port" "${API_PORT}"
  )

  ssh_target="${REMOTE_USER}@${REMOTE_HOST}"
  if [[ "${REMOTE_USER}" != "root" ]]; then
    ssh_args+=("-tt")
  fi
  if [[ -n "${SSH_KEY_PATH}" ]]; then
    ssh_args+=("-i" "${SSH_KEY_PATH}")
  fi

  if [[ "${REMOTE_USER}" == "root" ]]; then
    remote_mkdir_cmd="$(build_ssh_remote_cmd mkdir -p "${APP_DIR}")"
  else
    remote_mkdir_cmd="$(build_ssh_remote_cmd sudo mkdir -p "${APP_DIR}")"
    rsync_remote_bin="sudo rsync"
  fi

  if [[ "${RUN_MIGRATIONS}" == "true" ]]; then
    remote_args+=("--run-migrations")
  fi
  if [[ "${SKIP_NPM_CI}" == "true" ]]; then
    remote_args+=("--skip-npm-ci")
  fi
  if [[ "${SKIP_BUILD}" == "true" ]]; then
    remote_args+=("--skip-build")
  fi
  if [[ "${RELOAD_NGINX}" == "true" ]]; then
    remote_args+=("--reload-nginx")
  fi
  if [[ "${TUNE_AUTH}" == "true" ]]; then
    remote_args+=("--tune-auth")
  fi

  log_info "Ensuring remote production directory exists: ${APP_DIR}"
  ssh "${ssh_args[@]}" "${ssh_target}" "${remote_mkdir_cmd}"

  if [[ -n "${SSH_KEY_PATH}" ]]; then
    printf -v rsync_ssh 'ssh -p %q -i %q' "${REMOTE_PORT}" "${SSH_KEY_PATH}"
  else
    printf -v rsync_ssh 'ssh -p %q' "${REMOTE_PORT}"
  fi

  log_info "Syncing local project directly to ${ssh_target}:${APP_DIR}..."
  rsync -az --delete -e "${rsync_ssh}" --rsync-path "${rsync_remote_bin}" \
    --exclude '.git/' \
    --exclude '.github/' \
    --exclude '.ruff_cache/' \
    --exclude '.dockerignore/' \
    --exclude '.gitignore/' \
    --exclude '.prettierrc/' \
    --exclude 'node_modules/' \
    --exclude 'dist/' \
    --exclude 'dashboard/node_modules/' \
    --exclude 'dashboard/dist/' \
    --exclude '.env' \
    --exclude 'data/' \
    "${SOURCE_DIR}/" "${ssh_target}:${APP_DIR}/"

  if [[ "${REMOTE_USER}" == "root" ]]; then
    remote_runner=(bash)
  else
    remote_runner=(sudo bash)
  fi
  remote_cmd="$(build_ssh_remote_cmd "${remote_runner[@]}" "${APP_DIR}/scripts/update-ubuntu-no-docker.sh" "${remote_args[@]}")"

  log_info "Running remote updater on ${ssh_target}..."
  ssh "${ssh_args[@]}" "${ssh_target}" "${remote_cmd}"
}

validate_env() {
  local os_id="unknown"
  local os_pretty="unknown"

  if [[ "$(uname -s)" != "Linux" ]]; then
    log_error "This updater must run on Linux (Ubuntu server), not on $(uname -s)."
    exit 1
  fi

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    os_id="${ID:-unknown}"
    os_pretty="${PRETTY_NAME:-unknown}"
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    log_error "systemctl not found. This script requires a systemd-based server."
    exit 1
  fi

  if ! command -v rsync >/dev/null 2>&1; then
    log_error "rsync not found. Install it first: sudo apt-get install -y rsync"
    exit 1
  fi

  resolve_source_dir
  validate_source_dir

  if [[ ! -d "${APP_DIR}" ]]; then
    log_error "APP_DIR does not exist: ${APP_DIR}"
    log_error "Run install script first or set --app-dir correctly."
    exit 1
  fi

  if [[ ! -f "${APP_DIR}/.env" ]]; then
    log_warn "No .env found in ${APP_DIR}. The service may fail after restart."
  fi

  if ! command -v node >/dev/null 2>&1; then
    log_error "node not found on server. Install Node.js first."
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    log_error "npm not found on server. Install Node.js/npm first."
    exit 1
  fi

  if [[ "${os_id}" != "ubuntu" ]]; then
    log_warn "Detected distro: ${os_id} (${os_pretty}). Script is optimized for Ubuntu."
  fi
}

sync_source() {
  local normalized_app_dir
  normalized_app_dir="$(cd "${APP_DIR}" 2>/dev/null && pwd || true)"
  if [[ -n "${normalized_app_dir}" && "${SOURCE_DIR}" == "${normalized_app_dir}" ]]; then
    log_info "Source directory already matches APP_DIR; skipping server-side sync."
    chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
    return
  fi

  log_info "Syncing source from ${SOURCE_DIR} to ${APP_DIR}..."
  mkdir -p "${APP_DIR}/data"

  rsync -a --delete \
    --exclude '.git/' \
    --exclude '.github/' \
    --exclude 'node_modules/' \
    --exclude 'dist/' \
    --exclude 'dashboard/node_modules/' \
    --exclude 'dashboard/dist/' \
    --exclude '.env' \
    --exclude 'data/' \
    "${SOURCE_DIR}/" "${APP_DIR}/"

  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
}

ensure_runtime_permissions() {
  if [[ -f "${APP_DIR}/.env" ]]; then
    chown "${APP_USER}:${APP_GROUP}" "${APP_DIR}/.env"
    chmod 640 "${APP_DIR}/.env"
  fi

  if [[ -f "${APP_DIR}/data/.env.generated" ]]; then
    chown "${APP_USER}:${APP_GROUP}" "${APP_DIR}/data/.env.generated"
    chmod 640 "${APP_DIR}/data/.env.generated"
  fi

  if [[ -d "${APP_DIR}/data" ]]; then
    chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}/data"
    chmod 750 "${APP_DIR}/data" || true
  fi
}

apply_auth_tuning() {
  if [[ "${TUNE_AUTH}" != "true" ]]; then
    return
  fi

  if [[ ! -f "${APP_DIR}/.env" ]]; then
    log_warn "Skipping auth tuning because .env was not found at ${APP_DIR}/.env"
    return
  fi

  log_info "Applying WhatsApp auth performance tuning to ${APP_DIR}/.env..."
  upsert_env "${APP_DIR}/.env" "PUPPETEER_HEADLESS" "true"
  upsert_env "${APP_DIR}/.env" "PUPPETEER_ARGS" "--no-sandbox,--disable-setuid-sandbox,--disable-dev-shm-usage,--disable-accelerated-2d-canvas,--disable-gpu,--no-first-run,--no-zygote,--disable-background-networking"
  upsert_env "${APP_DIR}/.env" "WWEBJS_TAKEOVER_ON_CONFLICT" "true"
  upsert_env "${APP_DIR}/.env" "WWEBJS_TAKEOVER_TIMEOUT_MS" "0"
  upsert_env "${APP_DIR}/.env" "WWEBJS_AUTH_TIMEOUT_MS" "90000"
  upsert_env "${APP_DIR}/.env" "WWEBJS_QR_MAX_RETRIES" "0"
}

install_dependencies() {
  if [[ "${SKIP_NPM_CI}" == "true" ]]; then
    log_info "Skipping npm ci by request."
    return
  fi

  log_info "Installing dependencies with npm ci..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=1024 npm ci --no-audit --no-fund"
}

build_app() {
  if [[ "${SKIP_BUILD}" == "true" ]]; then
    log_info "Skipping build by request."
    return
  fi

  log_info "Building API..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm run build"

  log_info "Building dashboard..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm run dashboard:build"
}

run_migrations() {
  if [[ "${RUN_MIGRATIONS}" != "true" ]]; then
    return
  fi

  log_info "Running production migrations..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm run migration:run:prod"
}

restart_services() {
  log_info "Restarting systemd service: ${SERVICE_NAME}"
  systemctl restart "${SERVICE_NAME}"

  if [[ "${RELOAD_NGINX}" == "true" ]]; then
    log_info "Validating and reloading nginx..."
    nginx -t
    systemctl reload nginx
  fi
}

health_check() {
  local health_url max_attempts attempt
  health_url="http://127.0.0.1:${API_PORT}/api/health"
  max_attempts=30

  log_info "Checking service status..."
  systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,14p' || true

  log_info "Waiting for API health endpoint: ${health_url}"
  for attempt in $(seq 1 "${max_attempts}"); do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
      log_info "Health check OK on attempt ${attempt}/${max_attempts}"
      curl -fsS "${health_url}" || true
      return 0
    fi
    sleep 2
  done

  log_warn "Health check failed after ${max_attempts} attempts."
  log_warn "Service status (extended):"
  systemctl --no-pager --full status "${SERVICE_NAME}" | sed -n '1,30p' || true
  log_warn "Last service logs:"
  journalctl -u "${SERVICE_NAME}" -n 200 --no-pager || true
  return 1
}

print_summary() {
  echo
  log_info "Update completed."
  if [[ "${TUNE_AUTH}" == "true" ]]; then
    echo "Auth tuning: applied (PUPPETEER/WWEBJS variables updated in .env)"
  fi
  echo "Useful commands:"
  echo "  sudo journalctl -u ${SERVICE_NAME} -f"
  echo "  sudo systemctl restart ${SERVICE_NAME}"
  echo "  curl -fsS http://127.0.0.1:${API_PORT}/api/health"
}

main() {
  if [[ -n "${REMOTE_HOST}" && "${REMOTE_EXEC}" != "true" ]]; then
    validate_local_orchestrator
    run_remote_update_from_local
    return
  fi

  require_root
  validate_env
  sync_source
  ensure_runtime_permissions
  apply_auth_tuning
  ensure_runtime_permissions
  install_dependencies
  build_app
  run_migrations
  restart_services
  health_check
  print_summary
}

main
