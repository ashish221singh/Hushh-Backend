#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
ADMIN_KEY="${ADMIN_KEY:-dev-admin-key}"

echo "[pilot-health] BASE_URL=$BASE_URL"

health=$(curl -s "$BASE_URL/health")
echo "$health" | jq . >/dev/null || { echo "[pilot-health] ERROR: /health non-JSON"; exit 1; }
status=$(echo "$health" | jq -r '.data.status // empty')
[[ "$status" == "ok" ]] || { echo "[pilot-health] ERROR: /health not ok"; exit 1; }

db=$(curl -s "$BASE_URL/api/v1/admin/db-status" -H "x-admin-key: $ADMIN_KEY")
echo "$db" | jq . >/dev/null || { echo "[pilot-health] ERROR: /api/v1/admin/db-status non-JSON"; exit 1; }
healthy=$(echo "$db" | jq -r '.data.healthy // false')
[[ "$healthy" == "true" ]] || { echo "[pilot-health] ERROR: db status unhealthy"; exit 1; }

echo "[pilot-health] OK: health + db-status are healthy"
