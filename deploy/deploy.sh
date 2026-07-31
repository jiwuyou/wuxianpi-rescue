#!/bin/sh
set -eu

ROOT="${ROOT:-/opt/wuxianpi-hub}"
cd "$ROOT"
git pull --ff-only
mkdir -p /var/lib/wuxianpi-hub
docker compose -f deploy/docker-compose.yml up -d --build
curl --fail --silent --show-error http://127.0.0.1:20877/health
printf '\nWuxianPi Hub deployed.\n'
