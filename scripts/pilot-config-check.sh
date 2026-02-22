#!/usr/bin/env bash
set -euo pipefail

err() { echo "[pilot-config] ERROR: $*"; exit 1; }
warn() { echo "[pilot-config] WARN: $*"; }
ok() { echo "[pilot-config] OK: $*"; }

AUTH_MODE="${AUTH_MODE:-firebase_otp}"
ALLOW_OTP_FALLBACK="${ALLOW_OTP_FALLBACK:-false}"
DEV_MATCH_HELPERS_ENABLED="${DEV_MATCH_HELPERS_ENABLED:-false}"
ADMIN_MATCHER_SEED_ENABLED="${ADMIN_MATCHER_SEED_ENABLED:-false}"
ALLOW_FOUND_FALLBACK="${ALLOW_FOUND_FALLBACK:-false}"
ADMIN_KEY="${ADMIN_KEY:-dev-admin-key}"
FIREBASE_WEB_API_KEY="${FIREBASE_WEB_API_KEY:-}"

[[ "$AUTH_MODE" == "firebase_otp" ]] || err "AUTH_MODE must be firebase_otp for pilot"
[[ "$ALLOW_OTP_FALLBACK" == "false" ]] || err "ALLOW_OTP_FALLBACK must be false"
[[ "$DEV_MATCH_HELPERS_ENABLED" == "false" ]] || err "DEV_MATCH_HELPERS_ENABLED must be false"
[[ "$ADMIN_MATCHER_SEED_ENABLED" == "false" ]] || err "ADMIN_MATCHER_SEED_ENABLED must be false"
[[ "$ALLOW_FOUND_FALLBACK" == "false" ]] || err "ALLOW_FOUND_FALLBACK must be false"
[[ -n "$FIREBASE_WEB_API_KEY" ]] || err "FIREBASE_WEB_API_KEY is required"

if [[ "$ADMIN_KEY" == "dev-admin-key" ]]; then
  warn "ADMIN_KEY is still default dev-admin-key. Rotate before pilot goes live."
else
  ok "ADMIN_KEY appears rotated"
fi

ok "Pilot config checks passed"
