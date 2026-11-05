#!/usr/bin/env bash
# Runs deploy/install.sh against fake system commands and a scratch prefix, so nothing on the machine changes.
set -u
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/install.sh"
BASE="$(mktemp -d)"
FAKE="$BASE/fake"
BIN="$FAKE/bin"
FIX="$FAKE/fixture"
mkdir -p "$BIN" "$FIX"
export FAKE
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  pass: $1"; }
no() {
  fail=$((fail+1))
  echo "  FAIL: $1"
  # Shows on the GitHub run page, where reading the raw log needs a login.
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error::$1"; fi
}
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

cat >"$BIN/id" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = -u ] && [ "$#" -eq 1 ]; then echo "${FAKE_UID:-0}"; exit 0; fi
[ -f "$FAKE/user_created" ]
EOF
cat >"$BIN/useradd" <<'EOF'
#!/usr/bin/env bash
echo "useradd $*" >>"$FAKE/log"; touch "$FAKE/user_created"
EOF
for name in systemctl apt-get chown; do
  cat >"$BIN/$name" <<EOF
#!/usr/bin/env bash
echo "$name \$*" >>"\$FAKE/log"
EOF
done
printf '#!/usr/bin/env bash\necho "fake journal line"\n' >"$BIN/journalctl"
printf '#!/usr/bin/env bash\nexit 0\n' >"$BIN/sleep"
cat >"$BIN/ss" <<'EOF'
#!/usr/bin/env bash
port="${2##*:}"
case " ${FAKE_BUSY:-} " in *" $port "*) echo "LISTEN 0 511 0.0.0.0:$port 0.0.0.0:*";; esac
EOF
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
url="${@: -1}"; out=""; code=0
prev=""
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  [ "$arg" = "-w" ] && code=1
  prev="$arg"
done
if [ "$code" = 1 ]; then
  if [ -n "${FAKE_HTTP:-}" ]; then printf '%s' "$FAKE_HTTP"; exit 0; fi
  case "$url" in */api/session) printf 200 ;; */api/state) printf 401 ;; *) printf 404 ;; esac
  exit 0
fi
echo "curl $url" >>"$FAKE/log"
case "$url" in
  *SHASUMS256.txt) cp "$FAKE/fixture/SHASUMS256.txt" "$out" ;;
  *) cp "$FAKE/fixture/${url##*/}" "$out" ;;
esac
EOF
chmod +x "$BIN"/*

# A stand-in Node release, with decoys in the checksum list to prove the right file gets picked.
REL="node-v24.99.0-linux-x64"
mkdir -p "$FIX/$REL/bin"
printf '#!/usr/bin/env bash\necho v24.99.0\n' >"$FIX/$REL/bin/node"
cat >"$FIX/$REL/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$FAKE/log"; mkdir -p node_modules/express
EOF
chmod +x "$FIX/$REL/bin/"*
tar -C "$FIX" -cJf "$FIX/$REL.tar.xz" "$REL"
{
  echo "aaaa  node-v24.99.0-linux-arm64.tar.xz"
  sha256sum "$FIX/$REL.tar.xz" | awk -v f="$REL.tar.xz" '{print $1 "  " f}'
  echo "bbbb  node-v24.99.0-linux-x64.tar.gz"
  echo "cccc  node-v24.99.0-linux-x64-pointer-compression.tar.xz"
} >"$FIX/SHASUMS256.txt"

SAFE_PATH="$BIN:/usr/bin:/mingw64/bin"
# These checks need FFmpeg to start out missing, so a real one on this machine has to stay out of sight.
if [ -x /usr/bin/ffmpeg ] || [ -x /usr/bin/ffprobe ]; then
  SYSTEM_BIN="$BASE/system-bin"
  mkdir -p "$SYSTEM_BIN"
  for tool in /usr/bin/*; do
    case "${tool##*/}" in
      ffmpeg|ffprobe) ;;
      *) ln -s "$tool" "$SYSTEM_BIN/" ;;
    esac
  done
  SAFE_PATH="$BIN:$SYSTEM_BIN"
fi
run() { # usage: run <prefix> [args]; env passes through
  local prefix="$1"; shift
  AIRSLOT_TEST_PREFIX="$prefix" PATH="$SAFE_PATH" bash "$SCRIPT" "$@" >"$BASE/out" 2>&1
  echo $? >"$BASE/rc"
}
rc() { cat "$BASE/rc"; }
out_has() { grep -q -- "$1" "$BASE/out"; }

echo "--- refusals"
P="$BASE/p0"
FAKE_UID=1000 run "$P" --base-url https://a.example.com
check "non-root is refused" '[ "$(rc)" = 1 ] && out_has "Run this with sudo"'
run "$P"
check "first install needs --base-url" '[ "$(rc)" = 1 ] && out_has "first install needs"'
run "$P" --base-url http://a.example.com
check "plain http is refused" '[ "$(rc)" = 1 ] && out_has "must look like https"'
run "$P" --base-url "https://a.example.com|x"
check "a sed-breaking address is refused" '[ "$(rc)" = 1 ] && out_has "must look like https"'
run "$P" --nonsense
check "unknown options are refused" '[ "$(rc)" = 1 ] && out_has "Unknown option"'
check "refusals created nothing" '[ ! -e "$P" ]'

echo "--- read-only check"
P="$BASE/p1"
FAKE_BUSY="3180" run "$P" --check
check "check exits cleanly" '[ "$(rc)" = 0 ]'
check "check reports the free port" 'out_has "would use port 3181"'
check "check says nothing changed" 'out_has "Nothing was changed"'
check "check created nothing" '[ ! -e "$P" ] && [ ! -e "$FAKE/log" ]'

echo "--- first install, FFmpeg missing, port 3180 taken"
P="$BASE/p2"
rm -f "$FAKE/log" "$FAKE/user_created"
FAKE_BUSY="3180" run "$P" --base-url https://airslot.example.com/
check "install succeeds" '[ "$(rc)" = 0 ]'
[ "$(rc)" = 0 ] || cat "$BASE/out"
check "app files in place" '[ -f "$P/opt/airslot/app/src/main.js" ] && [ -f "$P/opt/airslot/app/public/index.html" ] && [ -d "$P/opt/airslot/app/node_modules/express" ]'
check "demo and test code stay out" '[ ! -e "$P/opt/airslot/app/test" ] && [ ! -e "$P/opt/airslot/app/scripts" ]'
check "picked the right Node file" 'grep -q "curl .*/node-v24.99.0-linux-x64.tar.xz" "$FAKE/log"'
check "private Node in place" '[ "$("$P/opt/airslot/node/bin/node" -v)" = v24.99.0 ]'
check "chose a free port" 'grep -q "^PORT=3181$" "$P/etc/airslot/airslot.env"'
check "trailing slash removed" 'grep -q "^BASE_URL=https://airslot.example.com$" "$P/etc/airslot/airslot.env"'
check "password is long and random" '[ "$(sed -n "s/^APP_PASSWORD=//p" "$P/etc/airslot/airslot.env" | wc -c)" -ge 48 ]'
check "password never printed" '! out_has "$(sed -n "s/^APP_PASSWORD=//p" "$P/etc/airslot/airslot.env")"'
check "only ffmpeg requested from apt" 'grep -q "apt-get install -y -qq --no-upgrade ffmpeg$" "$FAKE/log"'
check "system packages are not upgraded wholesale" '! grep -Eq "apt-get (dist-)?upgrade" "$FAKE/log"'
check "npm skips install scripts" 'grep -q "npm ci --omit=dev --ignore-scripts" "$FAKE/log"'
check "user created once" '[ "$(grep -c "^useradd" "$FAKE/log")" = 1 ]'
check "unit runs as the service user" 'grep -q "^User=airslot$" "$P/etc/systemd/system/airslot.service"'
check "unit writes only to its data dir" 'grep -q "^ProtectSystem=strict$" "$P/etc/systemd/system/airslot.service" && grep -q "^ReadWritePaths=.*var/lib/airslot$" "$P/etc/systemd/system/airslot.service"'
check "service enabled and restarted" 'grep -q "systemctl enable --quiet airslot" "$FAKE/log" && grep -q "systemctl restart airslot" "$FAKE/log"'
check "only airslot is restarted" '[ "$(grep -c "systemctl restart" "$FAKE/log")" = 1 ]'
check "summary gives the tunnel target" 'out_has "http://localhost:3181"'
check "summary says where the setup code is" 'out_has "setup code" && out_has "APP_PASSWORD"'
check "password rescue tool is in place" '[ -x "$P/opt/airslot/reset-password" ] && grep -q "runuser -u airslot" "$P/opt/airslot/reset-password" && grep -q "src/reset-password.js" "$P/opt/airslot/reset-password"'
check "rescue tool file is in the app" '[ -f "$P/opt/airslot/app/src/reset-password.js" ]'
check "rescue tool is not readable by others" '[ "$(stat -c %a "$P/opt/airslot/reset-password" | cut -c3)" = 0 ] || [ "$(uname -o)" = Msys ]'
check "no temp app dir left" '[ ! -e "$P/opt/airslot/app.next" ] && [ ! -e "$P/opt/airslot/node.next" ]'

echo "--- update keeps settings"
PW="$(sed -n 's/^APP_PASSWORD=//p' "$P/etc/airslot/airslot.env")"
mkdir -p "$P/var/lib/airslot/videos"; echo keep >"$P/var/lib/airslot/videos/clip.mp4"
sed -i 's/^META_APP_ID=.*/META_APP_ID=123/' "$P/etc/airslot/airslot.env"
: >"$FAKE/log"
FAKE_BUSY="3181" run "$P"
check "update succeeds without --base-url" '[ "$(rc)" = 0 ]'
check "password unchanged" '[ "$(sed -n "s/^APP_PASSWORD=//p" "$P/etc/airslot/airslot.env")" = "$PW" ]'
check "port unchanged though it is in use by itself" 'grep -q "^PORT=3181$" "$P/etc/airslot/airslot.env"'
check "keys unchanged" 'grep -q "^META_APP_ID=123$" "$P/etc/airslot/airslot.env"'
check "data unchanged" '[ "$(cat "$P/var/lib/airslot/videos/clip.mp4")" = keep ]'
check "Node not downloaded again" '! grep -q "^curl" "$FAKE/log"'
check "user not recreated" '! grep -q "^useradd" "$FAKE/log"'
check "previous version kept for rollback" '[ -f "$P/opt/airslot/app.previous/src/main.js" ]'
run "$P" --base-url https://new.example.com
check "address can be changed on update" 'grep -q "^BASE_URL=https://new.example.com$" "$P/etc/airslot/airslot.env"'
check "only one BASE_URL line" '[ "$(grep -c "^BASE_URL=" "$P/etc/airslot/airslot.env")" = 1 ]'

echo "--- failures"
P="$BASE/p3"
rm -f "$FAKE/user_created"
cp "$FIX/SHASUMS256.txt" "$BASE/good"
sed -i '2s/^[0-9a-f]\{64\}/0000000000000000000000000000000000000000000000000000000000000000/' "$FIX/SHASUMS256.txt"
run "$P" --base-url https://a.example.com
check "a bad checksum stops the install" '[ "$(rc)" = 1 ] && out_has "failed its checksum"'
check "bad download is not used" '[ ! -e "$P/opt/airslot/node/bin/node" ] && [ ! -e "$P/opt/airslot/app/src" ]'
cp "$BASE/good" "$FIX/SHASUMS256.txt"
P="$BASE/p4"
FAKE_HTTP=000 run "$P" --base-url https://a.example.com
check "a service that won't start is reported" '[ "$(rc)" = 1 ] && out_has "did not come up" && out_has "fake journal line"'
P="$BASE/p4b"
FAKE_HTTP=200 run "$P" --base-url https://a.example.com
check "a service open to strangers is reported" '[ "$(rc)" = 1 ] && out_has "did not come up"'

echo "--- FFmpeg already installed"
P="$BASE/p5"
printf '#!/usr/bin/env bash\n' >"$BIN/ffmpeg"; printf '#!/usr/bin/env bash\n' >"$BIN/ffprobe"; chmod +x "$BIN/ffmpeg" "$BIN/ffprobe"
: >"$FAKE/log"
run "$P" --base-url https://a.example.com
check "apt is left alone when nothing is missing" '[ "$(rc)" = 0 ] && ! grep -q "^apt-get" "$FAKE/log"'

echo "--- public site settings"
P="$BASE/p6"
run "$P" --base-url https://a.example.com --site-host example.com --contact-email me@example.com
check "site settings are saved" '[ "$(rc)" = 0 ] && grep -q "^SITE_HOST=example.com$" "$P/etc/airslot/airslot.env" && grep -q "^SITE_CONTACT_EMAIL=me@example.com$" "$P/etc/airslot/airslot.env"'
check "site pages are installed" '[ -f "$P/opt/airslot/app/site/privacy.html" ]'
PW="$(sed -n 's/^APP_PASSWORD=//p' "$P/etc/airslot/airslot.env")"
run "$P" --site-host other.example.com --contact-email new@example.com
check "site settings update in place" '[ "$(grep -c "^SITE_HOST=" "$P/etc/airslot/airslot.env")" = 1 ] && grep -q "^SITE_HOST=other.example.com$" "$P/etc/airslot/airslot.env" && grep -q "^SITE_CONTACT_EMAIL=new@example.com$" "$P/etc/airslot/airslot.env"'
check "password survives" '[ "$(sed -n "s/^APP_PASSWORD=//p" "$P/etc/airslot/airslot.env")" = "$PW" ]'
Q="$BASE/p7"
run "$Q" --base-url https://a.example.com
sed -i '/^SITE_/d' "$Q/etc/airslot/airslot.env"
run "$Q" --site-host added.example.com --contact-email a@example.com
check "settings are added to an older install" 'grep -q "^SITE_HOST=added.example.com$" "$Q/etc/airslot/airslot.env"'
run "$P" --site-host "bad host|x"
check "a bad hostname is refused" '[ "$(rc)" = 1 ] && out_has "plain hostname"'
run "$P" --contact-email "a@b.co|x"
check "a bad email is refused" '[ "$(rc)" = 1 ] && out_has "plain email"'

echo
echo "pass=$pass fail=$fail"
rm -rf "$BASE"
[ "$fail" = 0 ]
