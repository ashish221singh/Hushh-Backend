#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3001}"
AUTH_MODE="${AUTH_MODE:-firebase_otp}"
ALLOW_OTP_FALLBACK="${ALLOW_OTP_FALLBACK:-false}"
ADMIN_KEY="${ADMIN_KEY:-dev-admin-key}"
DEV_MATCH_HELPERS_ENABLED="${DEV_MATCH_HELPERS_ENABLED:-true}"
ADMIN_MATCHER_SEED_ENABLED="${ADMIN_MATCHER_SEED_ENABLED:-true}"
FIREBASE_WEB_API_KEY="${FIREBASE_WEB_API_KEY:-}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-hushh-8d894}"
BASE_URL="${BASE_URL:-http://localhost:${PORT}}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

lsof -ti :"$PORT" | xargs kill -9 2>/dev/null || true

HOST="$HOST" \
PORT="$PORT" \
AUTH_MODE="$AUTH_MODE" \
ALLOW_OTP_FALLBACK="$ALLOW_OTP_FALLBACK" \
ADMIN_KEY="$ADMIN_KEY" \
DEV_MATCH_HELPERS_ENABLED="$DEV_MATCH_HELPERS_ENABLED" \
ADMIN_MATCHER_SEED_ENABLED="$ADMIN_MATCHER_SEED_ENABLED" \
FIREBASE_WEB_API_KEY="$FIREBASE_WEB_API_KEY" \
FIREBASE_PROJECT_ID="$FIREBASE_PROJECT_ID" \
npm run start >/tmp/hushh_backend_pilot_qa.log 2>&1 &
SERVER_PID=$!

sleep 2
curl -fsS "${BASE_URL}/health" >/dev/null

BASE_URL="$BASE_URL" ADMIN_KEY="$ADMIN_KEY" npm run pilot:qa

echo "[pilot-qa-local] done"
