#!/usr/bin/env bash
# Installs or updates Airslot on an Ubuntu server without touching anything else on it.
#
#   bash deploy/install.sh --check                                   read-only report, changes nothing
#   sudo bash deploy/install.sh --base-url https://app.example.com   install or update
#   sudo bash deploy/install.sh --site-host example.com --contact-email you@example.com
#                                                                    also serve the public legal pages
#
# It only writes to /opt/airslot, /etc/airslot, /var/lib/airslot and the airslot.service unit, creates
# the airslot system user, and adds ffmpeg, curl and xz through apt if they are missing. It runs its own
# copy of Node, so other projects' Node versions don't matter. Updates keep the data and the settings.
set -euo pipefail

# Lets the test harness run the whole script inside a scratch folder.
PREFIX="${AIRSLOT_TEST_PREFIX:-}"

APP_ROOT="$PREFIX/opt/airslot"
APP_DIR="$APP_ROOT/app"
NODE_DIR="$APP_ROOT/node"
ETC_DIR="$PREFIX/etc/airslot"
ENV_FILE="$ETC_DIR/airslot.env"
DATA_DIR="$PREFIX/var/lib/airslot"
UNIT_FILE="$PREFIX/etc/systemd/system/airslot.service"
SERVICE_USER="airslot"
NODE_MAJOR="24"
MIN_FREE_GB="5"
FIRST_PORT="3180"
LAST_PORT="3199"

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR=""
BASE_URL=""
SITE_HOST=""
CONTACT_EMAIL=""
MODE="install"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
good() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; WARNINGS=$((WARNINGS + 1)); }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
WARNINGS=0

port_in_use() {
  [ -n "$(ss -Htln "sport = :$1" 2>/dev/null)" ]
}

saved_port() {
  [ -f "$ENV_FILE" ] && sed -n 's/^PORT=//p' "$ENV_FILE" | head -n 1
}

choose_port() {
  local port
  for port in $(seq "$FIRST_PORT" "$LAST_PORT"); do
    if ! port_in_use "$port"; then
      printf '%s' "$port"
      return 0
    fi
  done
  return 1
}

node_arch() {
  case "$(uname -m)" in
    x86_64) printf 'x64' ;;
    aarch64) printf 'arm64' ;;
    *) return 1 ;;
  esac
}

can_reach() {
  timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
}

run_check() {
  step "Server"
  local os_name
  os_name="$(lsb_release -ds 2>/dev/null || sed -n 's/^PRETTY_NAME=//p' /etc/os-release 2>/dev/null | tr -d '"' || true)"
  good "System: ${os_name:-unknown}, $(uname -m)"
  if command -v apt-get >/dev/null 2>&1; then good "apt is available"; else warn "apt was not found, this script expects Ubuntu"; fi
  if command -v systemctl >/dev/null 2>&1; then good "systemd is available"; else warn "systemd was not found"; fi
  if node_arch >/dev/null; then good "Processor type is supported"; else warn "Processor type $(uname -m) is not supported"; fi

  local free_gb
  free_gb="$(df -BG --output=avail /var 2>/dev/null | tail -n 1 | tr -dc '0-9' || true)"
  if [ -n "$free_gb" ] && [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
    warn "Only ${free_gb} GB free on /var, videos need room"
  else
    good "Free disk on /var: ${free_gb:-unknown} GB"
  fi
  good "Memory: $(free -h 2>/dev/null | awk '/^Mem:/ {print $2 " total, " $7 " available"}' || true)"

  local synced
  synced="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true)"
  if [ "$synced" = "yes" ]; then good "Clock is synchronized"; else warn "Clock may not be synchronized, and publish times depend on it"; fi

  step "What the install would do"
  if command -v ffmpeg >/dev/null 2>&1; then good "FFmpeg is already installed"; else good "FFmpeg is missing and would be added through apt"; fi
  if [ -f "$ENV_FILE" ]; then
    good "Airslot is already installed on port $(saved_port), this would be an update"
  else
    local port
    if port="$(choose_port)"; then good "Airslot would use port $port"; else warn "No free port between $FIRST_PORT and $LAST_PORT"; fi
  fi
  if command -v cloudflared >/dev/null 2>&1; then good "cloudflared is already installed"; else good "cloudflared is not installed yet, you add it from the Cloudflare dashboard"; fi

  step "Internet access from this server"
  local target
  for target in region1.v2.argotunnel.com:7844 nodejs.org:443 graph.facebook.com:443 rupload.facebook.com:443 www.googleapis.com:443 oauth2.googleapis.com:443; do
    if can_reach "${target%%:*}" "${target##*:}"; then good "$target"; else warn "$target is blocked or unreachable"; fi
  done

  printf '\n'
  if [ "$WARNINGS" -eq 0 ]; then
    say "Result: ready to install. Nothing was changed."
  else
    say "Result: $WARNINGS warning(s) to look at. Nothing was changed."
  fi
}

install_packages() {
  local missing=()
  command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1 || missing+=(ffmpeg)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v xz >/dev/null 2>&1 || missing+=(xz-utils)
  if [ "${#missing[@]}" -eq 0 ]; then
    good "FFmpeg, curl and xz are already installed"
    return
  fi
  # NEEDRESTART_MODE=l only lists affected services, so other projects are never restarted.
  export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
  apt-get update -qq || warn "apt-get update reported a problem, trying the install anyway"
  apt-get install -y -qq --no-upgrade "${missing[@]}"
  good "Added ${missing[*]}"
}

install_node() {
  if [ -x "$NODE_DIR/bin/node" ] && "$NODE_DIR/bin/node" -v 2>/dev/null | grep -q "^v$NODE_MAJOR\."; then
    good "Private Node $("$NODE_DIR/bin/node" -v) is already in place"
    return
  fi
  local arch base file
  arch="$(node_arch)" || die "Processor type $(uname -m) is not supported."
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"
  file="$(awk -v suffix="-linux-$arch.tar.xz" 'index($2, suffix) && substr($2, length($2) - length(suffix) + 1) == suffix {print $2}' "$WORK_DIR/SHASUMS256.txt" | head -n 1)"
  [ -n "$file" ] || die "Could not find a Node download for linux-$arch."
  curl -fsSL --retry 3 "$base/$file" -o "$WORK_DIR/$file"
  (cd "$WORK_DIR" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "The Node download failed its checksum, so it was not used."

  rm -rf "$NODE_DIR.next"
  mkdir -p "$NODE_DIR.next"
  tar -xJf "$WORK_DIR/$file" -C "$NODE_DIR.next" --strip-components=1
  "$NODE_DIR.next/bin/node" -v >/dev/null 2>&1 || die "Node $NODE_MAJOR does not run on this system. It needs a newer Ubuntu release."
  rm -rf "$NODE_DIR"
  mv "$NODE_DIR.next" "$NODE_DIR"
  good "Private Node $("$NODE_DIR/bin/node" -v) installed"
}

install_files() {
  local next="$APP_ROOT/app.next"
  rm -rf "$next"
  mkdir -p "$next"
  cp -R "$SOURCE_DIR/src" "$SOURCE_DIR/public" "$SOURCE_DIR/site" "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$next/"
  (cd "$next" && PATH="$NODE_DIR/bin:$PATH" npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error --cache "$WORK_DIR/npm-cache")
  chown -R root:root "$next"
  chmod -R a+rX "$next"
  rm -rf "$APP_ROOT/app.previous"
  if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$APP_ROOT/app.previous"; fi
  mv "$next" "$APP_DIR"
  good "Application files are in $APP_DIR"
}

set_setting() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

write_settings() {
  mkdir -p "$ETC_DIR"
  chmod 700 "$ETC_DIR"
  if [ ! -f "$ENV_FILE" ]; then
    local port password
    port="$(choose_port)" || die "No free port between $FIRST_PORT and $LAST_PORT."
    password="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    (
      umask 077
      cat >"$ENV_FILE" <<EOF
PORT=$port
BASE_URL=$BASE_URL
DATA_DIR=$DATA_DIR
APP_PASSWORD=$password
META_APP_ID=
META_APP_SECRET=
META_CONFIG_ID=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
TIKTOK_CLIENT_KEY=
TIKTOK_CLIENT_SECRET=
EOF
    )
    good "Settings created with a random setup code"
  else
    if [ -n "$BASE_URL" ]; then sed -i "s|^BASE_URL=.*|BASE_URL=$BASE_URL|" "$ENV_FILE"; fi
    good "Existing settings kept"
  fi
  # Settings added in later versions appear empty, so the guide's "type after the equals sign" works.
  local key
  for key in TIKTOK_CLIENT_KEY TIKTOK_CLIENT_SECRET; do
    grep -q "^$key=" "$ENV_FILE" || printf '%s=\n' "$key" >>"$ENV_FILE"
  done
  if [ -n "$SITE_HOST" ]; then set_setting SITE_HOST "$SITE_HOST"; fi
  if [ -n "$CONTACT_EMAIL" ]; then set_setting SITE_CONTACT_EMAIL "$CONTACT_EMAIL"; fi
  chmod 600 "$ENV_FILE"

  mkdir -p "$DATA_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
  chmod 700 "$DATA_DIR"
}

write_service() {
  mkdir -p "$(dirname "$UNIT_FILE")"
  cat >"$UNIT_FILE" <<EOF
[Unit]
Description=Airslot
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_DIR/bin/node --disable-warning=ExperimentalWarning src/main.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --quiet airslot
  systemctl restart airslot
  good "Service airslot started and set to run at boot"
}

write_tools() {
  cat >"$APP_ROOT/reset-password" <<EOF
#!/usr/bin/env bash
# Prints a new password for an Airslot user: sudo $APP_ROOT/reset-password USERNAME
set -euo pipefail
[ "\$#" -eq 1 ] || { echo "Usage: sudo \$0 USERNAME" >&2; exit 2; }
cd "$APP_DIR"
exec runuser -u $SERVICE_USER -- env DATA_DIR="$DATA_DIR" "$NODE_DIR/bin/node" --disable-warning=ExperimentalWarning src/reset-password.js "\$1"
EOF
  chmod 750 "$APP_ROOT/reset-password"
  good "Password rescue tool is at $APP_ROOT/reset-password"
}

confirm_running() {
  local port code private attempt
  port="$(saved_port)"
  for attempt in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/session" || true)"
    private="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/state" || true)"
    # The login page opens for anyone, and everything behind it has to refuse a stranger.
    if [ "$code" = "200" ] && [ "$private" = "401" ]; then
      good "Airslot answers on port $port and asks people to log in"
      return
    fi
    sleep 1
  done
  journalctl -u airslot -n 30 --no-pager || true
  die "Airslot did not come up on port $port. The log above says why."
}

run_install() {
  [ "$(id -u)" -eq 0 ] || die "Run this with sudo. To look without changing anything, use --check."
  [ -f "$SOURCE_DIR/package-lock.json" ] && [ -d "$SOURCE_DIR/src" ] || die "Run this from the extracted Airslot package."
  if [ ! -f "$ENV_FILE" ] && [ -z "$BASE_URL" ]; then
    die "The first install needs --base-url, for example --base-url https://app.example.com"
  fi

  WORK_DIR="$(mktemp -d)"
  trap 'rm -rf "$WORK_DIR"' EXIT

  step "System packages"
  install_packages
  step "Service user"
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    good "User $SERVICE_USER already exists"
  else
    useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    good "Created system user $SERVICE_USER"
  fi
  step "Node"
  mkdir -p "$APP_ROOT"
  install_node
  step "Application"
  install_files
  write_settings
  write_tools
  step "Service"
  write_service
  confirm_running

  printf '\nDone. Airslot listens only on this server, on port %s.\n' "$(saved_port)"
  say "Point the Cloudflare tunnel at: http://localhost:$(saved_port)"
  say "If no admin account exists yet, open the address and create one. See the setup code with:"
  say "  sudo grep '^APP_PASSWORD=' $ENV_FILE"
  say "Lost the admin password? Run: sudo $APP_ROOT/reset-password USERNAME"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --base-url)
      [ "$#" -ge 2 ] || die "--base-url needs an address."
      BASE_URL="${2%/}"
      shift 2
      ;;
    --site-host)
      [ "$#" -ge 2 ] || die "--site-host needs a hostname."
      SITE_HOST="$2"
      shift 2
      ;;
    --contact-email)
      [ "$#" -ge 2 ] || die "--contact-email needs an address."
      CONTACT_EMAIL="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "Unknown option: $1" ;;
  esac
done

if [ -n "$BASE_URL" ] && ! printf '%s' "$BASE_URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$'; then
  die "--base-url must look like https://app.example.com, because Meta only accepts HTTPS addresses."
fi

if [ -n "$SITE_HOST" ] && ! printf '%s' "$SITE_HOST" | grep -Eq '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  die "--site-host must be a plain hostname, like example.com."
fi
if [ -n "$CONTACT_EMAIL" ] && ! printf '%s' "$CONTACT_EMAIL" | grep -Eq '^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
  die "--contact-email must be a plain email address."
fi

if [ "$MODE" = "check" ]; then run_check; else run_install; fi
