#!/bin/sh
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-/opt/wuxianpi-rescue/deploy/docker-compose.yml}"
DATA_DIR="${DATA_DIR:-/var/lib/wuxianpi-rescue}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/wuxianpi-rescue}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
docker compose -f "$COMPOSE_FILE" stop rescue
cp "$DATA_DIR/comments.db" "$BACKUP_DIR/comments-$STAMP.db"
docker compose -f "$COMPOSE_FILE" start rescue
find "$BACKUP_DIR" -type f -name 'comments-*.db' -mtime +30 -delete
printf '%s\n' "$BACKUP_DIR/comments-$STAMP.db"
