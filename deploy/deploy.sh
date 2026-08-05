#!/bin/sh
set -eu

ROOT="${ROOT:-/opt/wuxianpi-rescue}"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
cd "$ROOT"
git pull --ff-only
install -d -o 1000 -g 1000 /var/lib/wuxianpi-rescue
if [ -f "$ENV_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f deploy/docker-compose.yml up -d --build
else
    docker compose -f deploy/docker-compose.yml up -d --build
fi
curl --fail --silent --show-error --retry 30 --retry-connrefused --retry-all-errors --retry-delay 1 http://127.0.0.1:20877/health
printf '\nWuxianPi Rescue deployed.\n'
