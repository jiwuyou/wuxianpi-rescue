#!/data/data/com.termux/files/usr/bin/bash

set -euo pipefail

BEGIN_MARKER='# BEGIN WUXIANPI KEYBOARD'
END_MARKER='# END WUXIANPI KEYBOARD'

TERMUX_DIR="${HOME:?HOME is not set}/.termux"
PROPERTIES_FILE="$TERMUX_DIR/termux.properties"
BACKUP_DIR="$TERMUX_DIR/wuxianpi-backups"
ORIGINAL_STATE="$BACKUP_DIR/termux.properties.original.state"
ORIGINAL_FILE="$BACKUP_DIR/termux.properties.original"
LATEST_STATE="$BACKUP_DIR/termux.properties.latest-good.state"
LATEST_FILE="$BACKUP_DIR/termux.properties.latest-good"
LOCK_DIR="$BACKUP_DIR/.termux-keyboard.lock"

usage() {
    printf '%s\n' "Usage: $0 {apply|remove|restore-original --confirm|status}" >&2
}

die() {
    printf 'termux-keyboard: %s\n' "$*" >&2
    exit 1
}

managed_block() {
    cat <<'EOF'
# BEGIN WUXIANPI KEYBOARD
extra-keys = [['ESC','/','-','HOME','UP',{macro: 'exit ENTER', display: 'exit'},{macro: 'proot-distro SPACE login SPACE ubuntu ENTER', display: 'ubuntu'}],['TAB','CTRL','ALT','LEFT','DOWN','RIGHT','KEYBOARD'],['DRAWER','ENTER',{key: 'claude ', display: 'claude'},{key: 'codex ', display: 'codex'},{key: 'cloudcli ', display: 'cloudcli'},{key: 'service-manager status smallphone-core', display: 'smallphone'},{key: '--continue', display: '--continue'}]]
# END WUXIANPI KEYBOARD
EOF
}

marker_state() {
    local file=$1 begin_count end_count begin_line end_line

    if [[ ! -e "$file" ]]; then
        printf '%s\n' absent
        return 0
    fi
    [[ -f "$file" ]] || die "$file is not a regular file"

    begin_count=$(awk -v marker="$BEGIN_MARKER" '$0 == marker { count++ } END { print count + 0 }' "$file")
    end_count=$(awk -v marker="$END_MARKER" '$0 == marker { count++ } END { print count + 0 }' "$file")

    if [[ "$begin_count" -eq 0 && "$end_count" -eq 0 ]]; then
        printf '%s\n' unmanaged
        return 0
    fi
    if [[ "$begin_count" -ne 1 || "$end_count" -ne 1 ]]; then
        printf '%s\n' malformed
        return 0
    fi

    begin_line=$(awk -v marker="$BEGIN_MARKER" '$0 == marker { print NR; exit }' "$file")
    end_line=$(awk -v marker="$END_MARKER" '$0 == marker { print NR; exit }' "$file")
    if [[ "$begin_line" -ge "$end_line" ]]; then
        printf '%s\n' malformed
    else
        printf '%s\n' managed
    fi
}

require_valid_markers() {
    local state
    state=$(marker_state "$PROPERTIES_FILE")
    [[ "$state" != malformed ]] || die "malformed or duplicate WuxianPi keyboard markers in $PROPERTIES_FILE"
    printf '%s\n' "$state"
}

acquire_lock() {
    mkdir -p "$BACKUP_DIR"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        die "another termux-keyboard operation is running"
    fi
    trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM
}

atomic_text_file() {
    local destination=$1 content=$2 temporary
    temporary=$(mktemp "$(dirname "$destination")/.termux-keyboard.XXXXXX")
    printf '%s\n' "$content" > "$temporary"
    mv -f "$temporary" "$destination"
}

snapshot_file_state() {
    local state_file=$1 backup_file=$2 temporary
    if [[ -f "$PROPERTIES_FILE" ]]; then
        temporary=$(mktemp "$BACKUP_DIR/.termux-properties.XXXXXX")
        cp "$PROPERTIES_FILE" "$temporary"
        mv -f "$temporary" "$backup_file"
        atomic_text_file "$state_file" present
    else
        rm -f "$backup_file"
        atomic_text_file "$state_file" absent
    fi
}

ensure_original_backup() {
    local state
    if [[ -f "$ORIGINAL_STATE" ]]; then
        state=$(sed -n '1p' "$ORIGINAL_STATE")
        case "$state" in
            present) [[ -f "$ORIGINAL_FILE" ]] || die "original backup metadata exists but its file is missing" ;;
            absent) ;;
            *) die "invalid original backup metadata" ;;
        esac
        return 0
    fi

    if [[ -f "$ORIGINAL_FILE" ]]; then
        atomic_text_file "$ORIGINAL_STATE" present
    elif [[ -f "$PROPERTIES_FILE" ]]; then
        snapshot_file_state "$ORIGINAL_STATE" "$ORIGINAL_FILE"
    else
        atomic_text_file "$ORIGINAL_STATE" absent
    fi
}

snapshot_latest_good() {
    snapshot_file_state "$LATEST_STATE" "$LATEST_FILE"
}

new_properties_temp() {
    mktemp "$TERMUX_DIR/.termux.properties.XXXXXX"
}

preserve_mode() {
    local temporary=$1 mode
    if [[ -f "$PROPERTIES_FILE" ]]; then
        mode=$(stat -c '%a' "$PROPERTIES_FILE" 2>/dev/null || true)
        [[ -z "$mode" ]] || chmod "$mode" "$temporary"
    fi
}

reload_settings() {
    if command -v termux-reload-settings >/dev/null 2>&1; then
        termux-reload-settings
    else
        printf '%s\n' 'termux-keyboard: settings changed; termux-reload-settings is unavailable' >&2
    fi
}

commit_candidate() {
    local candidate=$1

    preserve_mode "$candidate"
    ensure_original_backup
    snapshot_latest_good
    mv -f "$candidate" "$PROPERTIES_FILE"
    reload_settings
}

build_applied_candidate() {
    local state=$1 candidate=$2 block_file
    block_file=$(mktemp "$TERMUX_DIR/.wuxianpi-keyboard-block.XXXXXX")
    managed_block > "$block_file"

    if [[ "$state" == managed ]]; then
        awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" -v block_file="$block_file" '
            function emit_block(  line) {
                while ((getline line < block_file) > 0) print line
                close(block_file)
            }
            $0 == begin { emit_block(); skipping = 1; next }
            $0 == end { skipping = 0; next }
            !skipping { print }
        ' "$PROPERTIES_FILE" > "$candidate"
    else
        if [[ -f "$PROPERTIES_FILE" ]]; then
            cat "$PROPERTIES_FILE" > "$candidate"
            if [[ -s "$candidate" && $(tail -c 1 "$candidate" | wc -l) -eq 0 ]]; then
                printf '\n' >> "$candidate"
            fi
        fi
        cat "$block_file" >> "$candidate"
    fi
    rm -f "$block_file"
}

apply_keyboard() {
    local state candidate
    mkdir -p "$TERMUX_DIR"
    acquire_lock
    state=$(require_valid_markers)
    candidate=$(new_properties_temp)
    build_applied_candidate "$state" "$candidate"

    if [[ -f "$PROPERTIES_FILE" ]] && cmp -s "$candidate" "$PROPERTIES_FILE"; then
        rm -f "$candidate"
        printf '%s\n' 'already applied'
        return 0
    fi
    commit_candidate "$candidate"
    printf '%s\n' 'applied'
}

remove_keyboard() {
    local state candidate
    mkdir -p "$TERMUX_DIR"
    acquire_lock
    state=$(require_valid_markers)
    if [[ "$state" != managed ]]; then
        printf '%s\n' 'managed block not present'
        return 0
    fi

    candidate=$(new_properties_temp)
    awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
        $0 == begin { skipping = 1; next }
        $0 == end { skipping = 0; next }
        !skipping { print }
    ' "$PROPERTIES_FILE" > "$candidate"
    commit_candidate "$candidate"
    printf '%s\n' 'removed'
}

restore_original() {
    local original_state candidate trash
    [[ "${1:-}" == --confirm && $# -eq 1 ]] || die "restore-original requires --confirm"
    mkdir -p "$TERMUX_DIR"
    acquire_lock

    [[ -f "$ORIGINAL_STATE" ]] || die "no original backup has been recorded"
    original_state=$(sed -n '1p' "$ORIGINAL_STATE")
    case "$original_state" in
        present)
            [[ -f "$ORIGINAL_FILE" ]] || die "original backup file is missing"
            if [[ -f "$PROPERTIES_FILE" ]] && cmp -s "$ORIGINAL_FILE" "$PROPERTIES_FILE"; then
                printf '%s\n' 'original already restored'
                return 0
            fi
            candidate=$(new_properties_temp)
            cp "$ORIGINAL_FILE" "$candidate"
            commit_candidate "$candidate"
            ;;
        absent)
            if [[ ! -e "$PROPERTIES_FILE" ]]; then
                printf '%s\n' 'original absent state already restored'
                return 0
            fi
            snapshot_latest_good
            trash=$(new_properties_temp)
            rm -f "$trash"
            mv "$PROPERTIES_FILE" "$trash"
            rm -f "$trash"
            reload_settings
            ;;
        *) die "invalid original backup metadata" ;;
    esac
    printf '%s\n' 'original restored'
}

status_keyboard() {
    local state block_file current_block original latest
    state=$(marker_state "$PROPERTIES_FILE")
    if [[ "$state" == malformed ]]; then
        printf '%s\n' 'status=malformed'
        return 2
    fi

    if [[ "$state" == managed ]]; then
        block_file=$(mktemp "${TMPDIR:-/tmp}/wuxianpi-keyboard.XXXXXX")
        current_block=$(mktemp "${TMPDIR:-/tmp}/wuxianpi-keyboard-current.XXXXXX")
        managed_block > "$block_file"
        awk -v begin="$BEGIN_MARKER" -v end="$END_MARKER" '
            $0 == begin { printing = 1 }
            printing { print }
            $0 == end { exit }
        ' "$PROPERTIES_FILE" > "$current_block"
        if cmp -s "$block_file" "$current_block"; then
            state=applied
        else
            state=managed-drift
        fi
        rm -f "$block_file" "$current_block"
    fi

    original=unrecorded
    latest=unrecorded
    [[ ! -f "$ORIGINAL_STATE" ]] || original=$(sed -n '1p' "$ORIGINAL_STATE")
    [[ ! -f "$LATEST_STATE" ]] || latest=$(sed -n '1p' "$LATEST_STATE")
    printf 'status=%s\noriginal=%s\nlatest-good=%s\n' "$state" "$original" "$latest"
}

command=${1:-}
case "$command" in
    apply)
        [[ $# -eq 1 ]] || { usage; exit 2; }
        apply_keyboard
        ;;
    remove)
        [[ $# -eq 1 ]] || { usage; exit 2; }
        remove_keyboard
        ;;
    restore-original)
        shift
        restore_original "$@"
        ;;
    status)
        [[ $# -eq 1 ]] || { usage; exit 2; }
        status_keyboard
        ;;
    *)
        usage
        exit 2
        ;;
esac
