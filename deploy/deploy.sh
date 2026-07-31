#!/bin/sh
set -eu

ROOT="${ROOT:-/opt/wuxianpi-hub}"
cd "$ROOT"
git pull --ff-only
install -d -o 1000 -g 1000 /var/lib/wuxianpi-hub
docker compose -f deploy/docker-compose.yml up -d --build
curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1 http://127.0.0.1:20877/health
printf '\nWuxianPi Hub deployed.\n'
