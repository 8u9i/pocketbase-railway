#!/bin/sh
# PocketBase entrypoint for Railway.
#
# Beginner-friendly: if PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD are provided (or the
# defaults are left in place), the first superuser is created automatically on
# first boot so the admin dashboard works immediately. Intermediate/advanced
# users can override every value via environment variables.

set -e

PB_DATA_DIR="${PB_DATA_DIR:-/pb/pb_data}"
PB_PORT="${PORT:-8080}"

# Resolve admin credentials: env var > default.
# WARNING: the defaults are public (this is a template repo) and should only be
# used for a throwaway first login. Set PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD to
# real values (or leave PB_SKIP_ADMIN=true) for anything serious.
PB_ADMIN_EMAIL="${PB_ADMIN_EMAIL:-admin@example.com}"
PB_ADMIN_PASSWORD="${PB_ADMIN_PASSWORD:-changeme123}"

mkdir -p "${PB_DATA_DIR}"

if [ "${PB_SKIP_ADMIN}" != "true" ]; then
  echo "==> Ensuring superuser ${PB_ADMIN_EMAIL} exists..."
  # If any superuser already exists (first boot already happened), this is a
  # no-op and the command exits non-zero, which is expected and ignored.
  /pb/pocketbase superuser create "${PB_ADMIN_EMAIL}" "${PB_ADMIN_PASSWORD}" \
    --dir="${PB_DATA_DIR}" --yes >/dev/null 2>&1 || true
  echo "==> Superuser ready (login at /_/ with ${PB_ADMIN_EMAIL})."
fi

echo "==> Starting PocketBase on 0.0.0.0:${PB_PORT}"
exec /pb/pocketbase serve --http="0.0.0.0:${PB_PORT}" --dir="${PB_DATA_DIR}"
