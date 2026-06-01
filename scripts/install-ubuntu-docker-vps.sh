#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/openwa}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  printf '[openwa-vps] %s\n' "$*"
}

die() {
  printf '[openwa-vps] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    die "Run as root: sudo bash scripts/install-ubuntu-docker-vps.sh"
  fi
}

check_ubuntu() {
  if [ ! -r /etc/os-release ]; then
    die "Cannot detect OS. This installer is for Ubuntu 24.04."
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "ubuntu" ]; then
    die "Unsupported OS '${ID:-unknown}'. Expected Ubuntu 24.04."
  fi
  if [ "${VERSION_ID:-}" != "24.04" ]; then
    log "Warning: detected Ubuntu ${VERSION_ID:-unknown}; this script is tuned for Ubuntu 24.04."
  fi
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker and Compose plugin already installed."
    return
  fi

  log "Installing Docker Engine and Compose plugin..."
  apt-get update
  apt-get install -y ca-certificates curl gnupg rsync
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

copy_project() {
  log "Copying project to ${APP_DIR}..."
  mkdir -p "${APP_DIR}"
  rsync -a --delete \
    --exclude '.git/' \
    --exclude 'node_modules/' \
    --exclude 'dashboard/node_modules/' \
    --exclude 'dist/' \
    --exclude 'dashboard/dist/' \
    --exclude 'coverage/' \
    --exclude 'data/' \
    "${SOURCE_DIR}/" "${APP_DIR}/"

  mkdir -p "${APP_DIR}/data/sessions" "${APP_DIR}/data/media" "${APP_DIR}/data/plugins"
  if [ ! -f "${APP_DIR}/.env" ]; then
    cp "${APP_DIR}/.env.vps.example" "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
    db_password="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 || true)"
    if [ -n "${db_password}" ]; then
      sed -i "s/^DATABASE_PASSWORD=.*/DATABASE_PASSWORD=${db_password}/" "${APP_DIR}/.env"
    fi
    log "Created ${APP_DIR}/.env from .env.vps.example. Edit it for domain/HTTPS when needed."
  fi
}

open_firewall_ports() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    log "Opening ports 80/tcp and 443/tcp in ufw..."
    ufw allow 80/tcp
    ufw allow 443/tcp
  fi
}

start_stack() {
  log "Building and starting OpenWA..."
  cd "${APP_DIR}"
  docker compose -f docker-compose.vps.yml up -d --build
  docker compose -f docker-compose.vps.yml ps
}

print_next_steps() {
  cat <<EOF

OpenWA is installed in: ${APP_DIR}

Useful commands:
  cd ${APP_DIR}
  docker compose -f docker-compose.vps.yml ps
  docker compose -f docker-compose.vps.yml logs -f --tail=120
  docker compose -f docker-compose.vps.yml restart

Config:
  ${APP_DIR}/.env

PostgreSQL:
  Container: openwa-postgres
  Database:  openwa
  User:      openwa
  Password:  stored in ${APP_DIR}/.env

If you have a domain, edit .env:
  OPENWA_SITE_ADDRESS=openwa.example.com
  BASE_URL=https://openwa.example.com
  DASHBOARD_URL=https://openwa.example.com
  CORS_ORIGINS=https://openwa.example.com

Then restart:
  docker compose -f docker-compose.vps.yml up -d

EOF
}

main() {
  require_root
  check_ubuntu
  install_docker
  copy_project
  open_firewall_ports
  start_stack
  print_next_steps
}

main "$@"
