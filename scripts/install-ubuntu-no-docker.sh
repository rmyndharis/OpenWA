#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="/var/www/OpenWa"
APP_USER="angel"
APP_GROUP="openwa"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REMOTE_HOST="82.223.115.45"
REMOTE_USER="root"
REMOTE_PORT="22"
SSH_KEY_PATH=""
REMOTE_EXEC="false"
API_PORT="2785"
DOMAIN=""
EMAIL=""
ENABLE_SSL="false"
TUNE_AUTH="false"
MIN_TOTAL_MEM_MB="2048"
SWAPFILE_PATH="/swapfile-openwa"

log_info() { printf '[INFO] %s\n' "$1"; }
log_warn() { printf '[WARN] %s\n' "$1"; }
log_error() { printf '[ERROR] %s\n' "$1"; }

usage() {
  cat <<'EOF'
Install OpenWA on Ubuntu without Docker (systemd + nginx)

Usage:
  # Run inside the VPS:
  sudo bash scripts/install-ubuntu-no-docker.sh [options]

  # Run from local machine (SSH deploy + remote install):
  bash scripts/install-ubuntu-no-docker.sh --remote-host <host> [options]

Options:
  --app-dir <path>         Install directory (default: /var/www/OpenWa)
  --app-user <user>        Service user (default: angel)
  --app-group <group>      Service group (default: openwa)
  --source-dir <path>      Local project directory to sync (default: parent dir of this script)
  --remote-host <host>     Remote server host/IP for SSH install
  --remote-user <user>     SSH user (default: root)
  --remote-port <port>     SSH port (default: 22)
  --ssh-key <path>         SSH private key path (optional)
  --api-port <port>        API port for OpenWA (default: 2785)
  --min-mem-mb <mb>        Minimum RAM+swap target before install (default: 2048)
  --domain <domain>        Public domain for nginx (single host for dashboard + /api)
  --email <email>          Email for Certbot (required only if --enable-ssl)
  --enable-ssl             Enable HTTPS with Certbot + nginx
  --tune-auth              Apply WhatsApp auth performance tuning to .env
  -h, --help               Show this help

Examples:
  sudo bash scripts/install-ubuntu-no-docker.sh --domain wa.midominio.com
  sudo bash scripts/install-ubuntu-no-docker.sh --domain wa.midominio.com --enable-ssl --email admin@midominio.com
  sudo bash scripts/install-ubuntu-no-docker.sh --domain wa.midominio.com --tune-auth
  bash scripts/install-ubuntu-no-docker.sh --remote-host 203.0.113.10 --remote-user ubuntu --source-dir .
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
    --repo-url)
      log_warn "--repo-url is deprecated and ignored. Using local source directory."
      shift 2
      ;;
    --repo-branch)
      log_warn "--repo-branch is deprecated and ignored. Using local source directory."
      shift 2
      ;;
    --api-port)
      API_PORT="$2"
      shift 2
      ;;
    --min-mem-mb)
      MIN_TOTAL_MEM_MB="$2"
      shift 2
      ;;
    --domain)
      DOMAIN="$2"
      shift 2
      ;;
    --email)
      EMAIL="$2"
      shift 2
      ;;
    --enable-ssl)
      ENABLE_SSL="true"
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

validate_ssl_flags() {
  if [[ "${ENABLE_SSL}" == "true" ]]; then
    if [[ -z "${DOMAIN}" ]]; then
      log_error "--enable-ssl requires --domain"
      exit 1
    fi
    if [[ -z "${EMAIL}" ]]; then
      log_error "--enable-ssl requires --email"
      exit 1
    fi
  fi
}

validate_local_orchestrator() {
  validate_ssl_flags

  if [[ -z "${REMOTE_HOST}" ]]; then
    log_error "--remote-host is required for local SSH install mode."
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

run_remote_install_from_local() {
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
    "--source-dir" "${APP_DIR}"
    "--api-port" "${API_PORT}"
    "--min-mem-mb" "${MIN_TOTAL_MEM_MB}"
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

  if [[ -n "${DOMAIN}" ]]; then
    remote_args+=("--domain" "${DOMAIN}")
  fi
  if [[ -n "${EMAIL}" ]]; then
    remote_args+=("--email" "${EMAIL}")
  fi
  if [[ "${ENABLE_SSL}" == "true" ]]; then
    remote_args+=("--enable-ssl")
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
  remote_cmd="$(build_ssh_remote_cmd "${remote_runner[@]}" "${APP_DIR}/scripts/install-ubuntu-no-docker.sh" "${remote_args[@]}")"

  log_info "Running remote installer on ${ssh_target}..."
  ssh "${ssh_args[@]}" "${ssh_target}" "${remote_cmd}"
}

validate_env() {
  local os_id="${ID:-}"
  local os_pretty="${PRETTY_NAME:-unknown}"

  if [[ "$(uname -s)" != "Linux" ]]; then
    log_error "This installer must run on Linux (Ubuntu server), not on $(uname -s)."
    log_error "Connect to your VPS first (ssh user@your-vps) and run it there."
    exit 1
  fi

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    os_id="${ID:-unknown}"
    os_pretty="${PRETTY_NAME:-unknown}"
  fi

  if ! command -v apt-get >/dev/null 2>&1; then
    log_error "apt-get not found. This script is only for Ubuntu/Debian with apt."
    log_error "Detected OS: ${os_pretty} (${os_id})"
    log_error "If your VPS is not Ubuntu, tell me the distro and I will generate the correct script."
    exit 1
  fi

  if [[ "${os_id}" != "ubuntu" ]]; then
    log_warn "Detected distro: ${os_id}. Script is optimized for Ubuntu."
  fi

  if ! command -v systemctl >/dev/null 2>&1; then
    log_error "systemctl not found. This script requires a systemd-based server."
    exit 1
  fi

  validate_ssl_flags
  resolve_source_dir
  validate_source_dir
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

install_base_packages() {
  log_info "Installing base packages..."
  apt-get update -y
  apt-get install -y \
    ca-certificates \
    curl \
    gnupg \
    rsync \
    nginx \
    build-essential \
    python3 \
    make \
    g++ \
    pkg-config \
    libsqlite3-dev
}

get_ram_mb() {
  awk '/MemTotal:/ { printf "%d\n", $2 / 1024 }' /proc/meminfo
}

get_swap_mb() {
  if [[ -r /proc/swaps ]]; then
    awk 'NR > 1 { sum += $3 } END { printf "%d\n", sum / 1024 }' /proc/swaps
  else
    echo 0
  fi
}

ensure_minimum_memory() {
  local ram_mb swap_mb total_mb needed_mb rounded_mb
  ram_mb="$(get_ram_mb)"
  swap_mb="$(get_swap_mb)"
  total_mb=$((ram_mb + swap_mb))

  log_info "Detected RAM=${ram_mb}MB, swap=${swap_mb}MB (total=${total_mb}MB)"

  if (( total_mb >= MIN_TOTAL_MEM_MB )); then
    return
  fi

  needed_mb=$((MIN_TOTAL_MEM_MB - total_mb))
  if (( needed_mb < 1024 )); then
    needed_mb=1024
  fi
  rounded_mb=$(( (needed_mb + 255) / 256 * 256 ))

  if grep -qE "^${SWAPFILE_PATH}[[:space:]]" /proc/swaps 2>/dev/null; then
    log_info "Swapfile already active: ${SWAPFILE_PATH}"
    return
  fi

  if [[ -f "${SWAPFILE_PATH}" ]]; then
    log_info "Activating existing swapfile: ${SWAPFILE_PATH}"
    chmod 600 "${SWAPFILE_PATH}"
    mkswap "${SWAPFILE_PATH}" >/dev/null 2>&1 || true
    swapon "${SWAPFILE_PATH}"
  else
    log_warn "Low memory detected. Creating ${rounded_mb}MB swapfile at ${SWAPFILE_PATH}..."
    if command -v fallocate >/dev/null 2>&1; then
      fallocate -l "${rounded_mb}M" "${SWAPFILE_PATH}"
    else
      dd if=/dev/zero of="${SWAPFILE_PATH}" bs=1M count="${rounded_mb}" status=progress
    fi
    chmod 600 "${SWAPFILE_PATH}"
    mkswap "${SWAPFILE_PATH}"
    swapon "${SWAPFILE_PATH}"
  fi

  if ! grep -qF "${SWAPFILE_PATH} none swap sw 0 0" /etc/fstab; then
    echo "${SWAPFILE_PATH} none swap sw 0 0" >> /etc/fstab
  fi

  log_info "Swap ready:"
  swapon --show || true
}

install_nodejs() {
  local node_major
  node_major=0

  if command -v node >/dev/null 2>&1; then
    node_major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  fi

  if [[ "${node_major}" -ge 22 ]]; then
    log_info "Node.js $(node -v) already installed."
    return
  fi

  log_info "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  log_info "Installed Node.js $(node -v)"
}

install_browser_runtime_deps() {
  log_info "Installing browser runtime dependencies for whatsapp-web.js..."
  apt-get install -y \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libgbm1 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxkbcommon0 \
    libpango-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    fonts-liberation

  if ! apt-get install -y libasound2t64; then
    log_warn "libasound2t64 not available, trying libasound2..."
    apt-get install -y libasound2
  fi
}

ensure_app_user() {
  if ! getent group "${APP_GROUP}" >/dev/null 2>&1; then
    log_info "Creating group ${APP_GROUP}..."
    groupadd --system "${APP_GROUP}"
  fi

  if ! id -u "${APP_USER}" >/dev/null 2>&1; then
    log_info "Creating user ${APP_USER}..."
    useradd --system --create-home --shell /usr/sbin/nologin --gid "${APP_GROUP}" "${APP_USER}"
  fi
}

prepare_source() {
  local normalized_app_dir
  normalized_app_dir="$(cd "${APP_DIR}" 2>/dev/null && pwd || true)"
  if [[ -n "${normalized_app_dir}" && "${SOURCE_DIR}" == "${normalized_app_dir}" ]]; then
    log_info "Source directory already matches APP_DIR; skipping server-side sync."
    chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
    return
  fi

  log_info "Syncing project files from local source: ${SOURCE_DIR}"
  mkdir -p "${APP_DIR}"
  mkdir -p "${APP_DIR}/data"

  rsync -a --delete \
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
    "${SOURCE_DIR}/" "${APP_DIR}/"

  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"
}

configure_env_file() {
  if [[ ! -f "${APP_DIR}/.env" ]]; then
    log_info "Creating .env from .env.minimal..."
    cp "${APP_DIR}/.env.minimal" "${APP_DIR}/.env"
  else
    log_info "Using existing .env in ${APP_DIR}"
  fi

  upsert_env "${APP_DIR}/.env" "NODE_ENV" "production"
  upsert_env "${APP_DIR}/.env" "PORT" "${API_PORT}"
  upsert_env "${APP_DIR}/.env" "SESSION_DATA_PATH" "./data/sessions"
  upsert_env "${APP_DIR}/.env" "STORAGE_LOCAL_PATH" "./data/media"
  upsert_env "${APP_DIR}/.env" "DASHBOARD_PORT" "80"

  if [[ -n "${DOMAIN}" ]]; then
    local public_scheme alt_domain cors_origins
    public_scheme="http"
    if [[ "${ENABLE_SSL}" == "true" ]]; then
      public_scheme="https"
    fi

    if [[ "${DOMAIN}" == www.* ]]; then
      alt_domain="${DOMAIN#www.}"
    else
      alt_domain="www.${DOMAIN}"
    fi

    cors_origins="http://${DOMAIN},https://${DOMAIN},http://${alt_domain},https://${alt_domain}"

    upsert_env "${APP_DIR}/.env" "BASE_URL" "${public_scheme}://${DOMAIN}"
    upsert_env "${APP_DIR}/.env" "DASHBOARD_URL" "${public_scheme}://${DOMAIN}"
    upsert_env "${APP_DIR}/.env" "CORS_ORIGINS" "${cors_origins}"
  fi

  mkdir -p "${APP_DIR}/data/sessions" "${APP_DIR}/data/media" "${APP_DIR}/data/plugins"
  chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}/data"
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

install_app_dependencies() {
  log_info "Installing Node.js dependencies (this can take a few minutes)..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm_config_jobs=1 NODE_OPTIONS=--max-old-space-size=1024 npm ci --no-audit --no-fund"
}

build_app() {
  log_info "Building API..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm run build"

  log_info "Building dashboard..."
  runuser -u "${APP_USER}" -- bash -lc "cd '${APP_DIR}' && npm run dashboard:build"
}

write_systemd_service() {
  log_info "Creating systemd service..."
  cat > /etc/systemd/system/openwa.service <<EOF
[Unit]
Description=OpenWA API (no Docker)
After=network.target
Wants=network.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
EnvironmentFile=-${APP_DIR}/.env
Environment=NODE_ENV=production
Environment=PORT=${API_PORT}
ExecStart=/usr/bin/node dist/main.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now openwa
}

write_nginx_config() {
  local server_name
  server_name="_"
  if [[ -n "${DOMAIN}" ]]; then
    server_name="${DOMAIN}"
  fi

  log_info "Configuring nginx site..."
  cat > /etc/nginx/sites-available/openwa <<EOF
server {
    listen 80;
    server_name ${server_name};

    root ${APP_DIR}/dashboard/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300;
        proxy_connect_timeout 300;
        proxy_send_timeout 300;
    }

    location /events/ {
        proxy_pass http://127.0.0.1:${API_PORT}/events/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:${API_PORT}/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF

  ln -sf /etc/nginx/sites-available/openwa /etc/nginx/sites-enabled/openwa
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl restart nginx
}

configure_ssl() {
  if [[ "${ENABLE_SSL}" != "true" ]]; then
    return
  fi

  log_info "Installing Certbot..."
  apt-get install -y certbot python3-certbot-nginx

  log_info "Requesting SSL certificate for ${DOMAIN}..."
  certbot --nginx --non-interactive --agree-tos --redirect -m "${EMAIL}" -d "${DOMAIN}"
}

print_summary() {
  log_info "OpenWA installation completed."
  if [[ "${TUNE_AUTH}" == "true" ]]; then
    echo "Auth tuning: applied (PUPPETEER/WWEBJS variables updated in .env)"
  fi
  echo
  echo "Service status:"
  systemctl --no-pager --full status openwa | sed -n '1,14p'
  echo
  echo "Health check (waiting for startup):"
  local max_attempts=30
  local attempt
  for attempt in $(seq 1 "${max_attempts}"); do
    if curl -fsS "http://127.0.0.1:${API_PORT}/api/health" >/dev/null 2>&1; then
      echo "  OK on attempt ${attempt}/${max_attempts}"
      curl -fsS "http://127.0.0.1:${API_PORT}/api/health" || true
      break
    fi
    sleep 2
  done
  if (( attempt == max_attempts )); then
    log_warn "API did not become healthy on 127.0.0.1:${API_PORT}"
    log_warn "Last service logs:"
    journalctl -u openwa -n 120 --no-pager || true
  fi
  echo
  echo "Useful commands:"
  echo "  sudo journalctl -u openwa -f"
  echo "  sudo systemctl restart openwa"
  echo "  sudo systemctl restart nginx"
  echo
  if [[ -n "${DOMAIN}" ]]; then
    if [[ "${ENABLE_SSL}" == "true" ]]; then
      echo "Dashboard: https://${DOMAIN}"
      echo "Swagger:   https://${DOMAIN}/api/docs"
    else
      echo "Dashboard: http://${DOMAIN}"
      echo "Swagger:   http://${DOMAIN}/api/docs"
    fi
  else
    echo "Dashboard: http://SERVER_IP"
    echo "Swagger:   http://SERVER_IP/api/docs"
  fi
  echo
  echo "API key seed file (first run): ${APP_DIR}/data/.api-key"
}

main() {
  if [[ -n "${REMOTE_HOST}" && "${REMOTE_EXEC}" != "true" ]]; then
    validate_local_orchestrator
    run_remote_install_from_local
    return
  fi

  require_root
  validate_env
  install_base_packages
  ensure_minimum_memory
  install_nodejs
  install_browser_runtime_deps
  ensure_app_user
  prepare_source
  configure_env_file
  apply_auth_tuning
  ensure_runtime_permissions
  install_app_dependencies
  build_app
  write_systemd_service
  write_nginx_config
  configure_ssl
  print_summary
}

main
