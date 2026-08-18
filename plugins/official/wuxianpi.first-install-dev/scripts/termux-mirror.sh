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
  printf '%s\n' \
    'https://packages-cf.termux.dev/apt/termux-main' \
    'https://packages.termux.dev/apt/termux-main'
  if [ "$region" != official ] && [ -d "$PREFIX/etc/termux/mirrors/$region" ]; then
    find "$PREFIX/etc/termux/mirrors/$region" -maxdepth 1 -type f -print \
      | sort | head -n 3 \
      | while IFS= read -r file; do
          main="$(awk -F= '$1 == "MAIN" { gsub(/^"|"$/, "", $2); print $2; exit }' "$file")"
          [ -n "$main" ] && printf '%s\n' "$main"
        done
  fi
}

probe_repo() {
  local repo="$1" inrelease status result speed
  inrelease="$(mktemp "$STATE_DIR/inrelease.XXXXXX")"
  if ! status="$(curl -sSL --connect-timeout 4 --max-time 10 \
    -o "$inrelease" -w '%{http_code}' \
    "$repo/dists/stable/InRelease" 2>/dev/null)"; then
    rm -f "$inrelease"
    printf 'FAIL\t%s\tinrelease_http_failed\n' "$repo"
    return 0
  fi
  if [ "$status" != 200 ] \
    || ! grep -Fxq -- '-----BEGIN PGP SIGNED MESSAGE-----' "$inrelease" \
    || ! grep -Fxq -- 'Suite: stable' "$inrelease" \
    || ! grep -Fxq -- 'Codename: stable' "$inrelease" \
    || ! grep -Fxq -- '-----BEGIN PGP SIGNATURE-----' "$inrelease"; then
    rm -f "$inrelease"
    printf 'FAIL\t%s\tinrelease_not_termux_signed\n' "$repo"
    return 0
  fi
  rm -f "$inrelease"
  result="$(curl -fsSL --connect-timeout 4 --max-time 10 \
    --speed-time 5 --speed-limit 1024 -r 0-262143 -o /dev/null \
    -w '%{http_code} %{size_download} %{time_total}' \
    "$repo/dists/stable/main/binary-$(dpkg --print-architecture)/Packages.xz" 2>/dev/null || true)"
  set -- $result
  if { [ "${1:-}" != 200 ] && [ "${1:-}" != 206 ]; } || [ "${2:-0}" -le 0 ]; then
    printf 'FAIL\t%s\tpackages_probe_failed\n' "$repo"
    return 0
  fi
  speed="$(awk -v bytes="$2" -v seconds="$3" \
    'BEGIN { if (seconds > 0) printf "%.0f", bytes / seconds; else print 0 }')"
  if [ "$speed" -le 0 ]; then
    printf 'FAIL\t%s\tpackages_probe_failed\n' "$repo"
    return 0
  fi
  printf 'OK\t%s\t%s\n' "$repo" "$speed"
}

is_main_repo() {
  [ "$1" = 'https://packages-cf.termux.dev/apt/termux-main' ] \
    || [ "$1" = 'https://packages.termux.dev/apt/termux-main' ]
}

apt_validate_repo() {
  local repo="$1" output_file="$2" work_dir="$3"
  local candidate_sources="$work_dir/sources.list"
  local candidate_lists="$work_dir/lists"
  mkdir -p "$candidate_lists/partial"
  printf 'deb %s stable main\n' "$repo" > "$candidate_sources"
  command -v timeout >/dev/null 2>&1 || return 127
  timeout -k 2 12 env DEBIAN_FRONTEND=noninteractive apt-get \
    -o Acquire::Retries=0 -o Acquire::http::Timeout=8 \
    -o Acquire::https::Timeout=8 \
    -o Dir::Etc::sourcelist="$candidate_sources" \
    -o Dir::Etc::sourceparts=- \
    -o Dir::State::lists="$candidate_lists" \
    update > "$output_file" 2>&1
}

restore_sources() {
  local sources_file="$1" original_sources="$2"
  if [ -f "$original_sources" ]; then
    cp "$original_sources" "$sources_file"
  else
    rm -f "$sources_file"
  fi
}

country="$(detect_country)"
region="$(region_for_country "$country")"
log "公网国家：$country；区域候选：$region；包含两个主流基准源"

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

ranked="$tmp_dir/ranked"
: > "$ranked"
for result_file in "$tmp_dir"/*; do
  [ -s "$result_file" ] || continue
  IFS=$'\t' read -r status repo value < "$result_file"
  if [ "$status" = OK ]; then
    log "测速通过：$repo，速度：${value}B/s"
    printf '%s\t%s\n' "$repo" "$value" >> "$ranked"
  else
    log "候选拒绝：$repo，原因：$value"
  fi
done
[ -s "$ranked" ] || { log '没有通过 InRelease 和 Packages 初检的镜像。'; exit 1; }

sources_file="$PREFIX/etc/apt/sources.list"
mkdir -p "$(dirname "$sources_file")"
original_sources="$tmp_dir/sources.list.original"
cp "$sources_file" "$original_sources" 2>/dev/null || :
validated="$tmp_dir/validated"
: > "$validated"
attempts=0
while IFS=$'\t' read -r repo speed; do
  [ -n "$repo" ] || continue
  attempts=$((attempts + 1))
  apt_log="$tmp_dir/apt-$attempts.log"
  log "APT 验证：$repo"
  if apt_validate_repo "$repo" "$apt_log" "$tmp_dir/apt-$attempts"; then
    printf '%s\t%s\n' "$repo" "$speed" >> "$validated"
    log "APT 验证通过：$repo"
  else
    log "APT 验证失败：$repo"
    tail -n 3 "$apt_log" | sed 's/^/[WuxianPi mirror] apt: /' | tee -a "$LOG_FILE" || true
  fi
done < <(sort -t $'\t' -k2,2nr "$ranked")
[ -s "$validated" ] || {
  log '所有候选均未通过 APT 验证。'
  exit 1
}

best_repo="$(sort -t $'\t' -k2,2nr "$validated" | head -n 1 | cut -f1)"
best_speed="$(sort -t $'\t' -k2,2nr "$validated" | head -n 1 | cut -f2)"
main_repo=""
main_speed=0
while IFS=$'\t' read -r repo speed; do
  if is_main_repo "$repo" && [ "$speed" -gt "$main_speed" ]; then
    main_repo="$repo"
    main_speed="$speed"
  fi
done < "$validated"
if [ -n "$main_repo" ] && [ "$best_repo" != "$main_repo" ] \
  && [ "$best_speed" -lt $((main_speed + main_speed / 5)) ]; then
  best_repo="$main_repo"
  best_speed="$main_speed"
  log "区域源优势不足 20%，使用主流基准源：$best_repo"
fi
printf 'deb %s stable main\n' "$best_repo" > "$sources_file"
final_apt_log="$tmp_dir/apt-final.log"
log "最终源验证：$best_repo"
if ! timeout -k 2 15 env DEBIAN_FRONTEND=noninteractive apt-get \
  -o Acquire::Retries=0 -o Acquire::http::Timeout=10 \
  -o Acquire::https::Timeout=10 update > "$final_apt_log" 2>&1; then
  restore_sources "$sources_file" "$original_sources"
  log "最终源 APT 验证失败：$best_repo"
  tail -n 5 "$final_apt_log" | sed 's/^/[WuxianPi mirror] apt: /' | tee -a "$LOG_FILE" || true
  exit 1
fi
log "最终选择：$best_repo（${best_speed}B/s；APT 验证通过）"
selected_file="$PREFIX/etc/termux/wuxianpi-selected-mirror"
chosen_file="$PREFIX/etc/termux/chosen_mirrors"
mkdir -p "$(dirname "$selected_file")"
printf 'WEIGHT=1\nMAIN="%s"\n' "$best_repo" > "$selected_file"
if [ -L "$chosen_file" ] || [ -f "$chosen_file" ]; then rm -f "$chosen_file"; fi
[ -e "$chosen_file" ] || ln -s "$selected_file" "$chosen_file"

timestamp="$(date +%s)"
printf '{"schema":2,"country":"%s","region":"%s","selected":"%s","speedBps":%s,"validated":true,"measuredAt":%s}\n' \
  "$country" "$region" "$best_repo" "${best_speed:-0}" "$timestamp" > "$PROFILE_FILE"

DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Options::=--force-confold install -y tmux
tmux new-session -d -s wuxianpi-setup "exec \"$PREFIX/bin/bash\" -l" 2>/dev/null || true
tmux has-session -t wuxianpi-setup
log "tmux 已准备完成"
printf 'WUXIANPI_MIRROR_RESULT={"country":"%s","region":"%s","selected":"%s","speedBps":%s,"tmuxReady":true}\n' \
  "$country" "$region" "$best_repo" "${best_speed:-0}"
