#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
TERMUX_HOME="${HOME:-/data/data/com.termux/files/home}"
STATE_DIR="${TERMUX_HOME}/.local/state/wuxianpi-setup/mirror"
LOG_FILE="${STATE_DIR}/benchmark.log"
PROFILE_FILE="${STATE_DIR}/profile.json"

[ "${1:-}" = "--pre-tmux" ] && [ "$#" -eq 1 ] || {
  printf '%s\n' 'usage: wuxianpi-termux-mirror.sh --pre-tmux' >&2
  exit 2
}

mkdir -p "$STATE_DIR"
log() {
  printf '[WuxianPi mirror] %s\n' "$*" | tee -a "$LOG_FILE"
}

detect_country() {
  local country
  country="$(curl -fsSL --connect-timeout 4 --max-time 7 \
    https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null \
    | awk -F= '$1 == "loc" { print $2; exit }' || true)"
  if [ -z "$country" ]; then
    country="$(curl -fsSL --connect-timeout 4 --max-time 7 \
      https://ipapi.co/country/ 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  printf '%s\n' "${country:-unknown}" | tr '[:lower:]' '[:upper:]'
}

region_for_country() {
  case "$1" in
    CN) printf '%s\n' chinese_mainland ;;
    RU) printf '%s\n' russia ;;
    US|CA|MX) printf '%s\n' north_america ;;
    AU|NZ) printf '%s\n' oceania ;;
    JP|KR|IN|SG|MY|TH|VN|ID|PH|TW|HK|MO) printf '%s\n' asia ;;
    AT|BE|BG|CH|CY|CZ|DE|DK|EE|ES|FI|FR|GB|GR|HR|HU|IE|IS|IT|LT|LU|LV|MT|NL|NO|PL|PT|RO|SE|SI|SK) printf '%s\n' europe ;;
    *) printf '%s\n' official ;;
  esac
}

candidate_rows() {
  local region="$1" file main
  if [ "$region" != official ] && [ -d "$PREFIX/etc/termux/mirrors/$region" ]; then
    for file in "$PREFIX/etc/termux/mirrors/$region"/*; do
      [ -f "$file" ] || continue
      main="$(awk -F= '$1 == "MAIN" { gsub(/^"|"$/, "", $2); print $2; exit }' "$file")"
      [ -n "$main" ] && printf '%s\n' "$main"
    done
  fi
  printf '%s\n' \
    'https://packages-cf.termux.dev/apt/termux-main' \
    'https://packages.termux.dev/apt/termux-main'
}

probe_repo() {
  local repo="$1" result speed
  result="$(curl -fsSL --connect-timeout 4 --max-time 10 \
    --speed-time 5 --speed-limit 1024 -r 0-262143 -o /dev/null \
    -w '%{http_code} %{size_download} %{time_total}' \
    "$repo/dists/stable/main/binary-$(dpkg --print-architecture)/Packages.xz" 2>/dev/null || true)"
  set -- $result
  [ "${1:-}" = 200 ] || [ "${1:-}" = 206 ] || return 1
  [ "${2:-0}" -gt 0 ] || return 1
  speed="$(awk -v bytes="$2" -v seconds="$3" \
    'BEGIN { if (seconds > 0) printf "%.0f", bytes / seconds; else print 0 }')"
  [ "$speed" -gt 0 ] || return 1
  printf '%s\t%s\n' "$repo" "$speed"
}

country="$(detect_country)"
region="$(region_for_country "$country")"
log "公网国家：$country；测速区域：$region"

tmp_dir="$(mktemp -d "$STATE_DIR/probe.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT
index=0
while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  index=$((index + 1))
  (probe_repo "$repo" > "$tmp_dir/$index") &
done <<EOF
$(candidate_rows "$region")
EOF
wait || true

best_repo=""
best_speed=0
for result_file in "$tmp_dir"/*; do
  [ -s "$result_file" ] || continue
  result="$(head -n 1 "$result_file")"
  repo="${result%%$'\t'*}"
  speed="${result##*$'\t'}"
  log "候选：$repo，速度：${speed}B/s"
  if [ "$speed" -gt "$best_speed" ]; then
    best_repo="$repo"
    best_speed="$speed"
  fi
done

if [ -z "$best_repo" ]; then
  best_repo="$(awk '/^deb / { print $2; exit }' "$PREFIX/etc/apt/sources.list" 2>/dev/null || true)"
  best_repo="${best_repo:-https://packages-cf.termux.dev/apt/termux-main}"
  log "测速没有成功候选，保留当前源或使用官方 CDN：$best_repo"
else
  log "选择最快源：$best_repo（${best_speed}B/s）"
fi

sources_file="$PREFIX/etc/apt/sources.list"
mkdir -p "$(dirname "$sources_file")"
printf 'deb %s stable main\n' "$best_repo" > "$sources_file"
selected_file="$PREFIX/etc/termux/wuxianpi-selected-mirror"
chosen_file="$PREFIX/etc/termux/chosen_mirrors"
mkdir -p "$(dirname "$selected_file")"
printf 'WEIGHT=1\nMAIN="%s"\n' "$best_repo" > "$selected_file"
if [ -L "$chosen_file" ] || [ -f "$chosen_file" ]; then rm -f "$chosen_file"; fi
[ -e "$chosen_file" ] || ln -s "$selected_file" "$chosen_file"

timestamp="$(date +%s)"
printf '{"schema":1,"country":"%s","region":"%s","selected":"%s","speedBps":%s,"measuredAt":%s}\n' \
  "$country" "$region" "$best_repo" "${best_speed:-0}" "$timestamp" > "$PROFILE_FILE"

TERMUX_PKG_NO_MIRROR_SELECT=1 pkg update -y
DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold install -y tmux
tmux new-session -d -s wuxianpi-setup "exec \"$PREFIX/bin/bash\" -l" 2>/dev/null || true
tmux has-session -t wuxianpi-setup
log "tmux 已准备完成"
printf 'WUXIANPI_MIRROR_RESULT={"country":"%s","region":"%s","selected":"%s","speedBps":%s,"tmuxReady":true}\n' \
  "$country" "$region" "$best_repo" "${best_speed:-0}"
