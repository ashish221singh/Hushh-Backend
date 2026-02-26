#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3001}"
ADMIN_KEY="${ADMIN_KEY:-dev-admin-key}"

reset_rate_limits() {
  curl -s -X POST "${BASE_URL}/api/v1/admin/test/reset-rate-limits" \
    -H "x-admin-key: ${ADMIN_KEY}" \
    -H "content-type: application/json" >/dev/null || true
}

run_step() {
  echo "[pilot-qa] $1"
  shift
  "$@"
  reset_rate_limits
  sleep 1
}

run_step "smoke:test" npm run smoke:test
run_step "matching-policy:test" npm run matching-policy:test
run_step "past-meets:test" npm run past-meets:test
run_step "readiness:test" npm run readiness:test
run_step "auth-hardening:test" npm run auth-hardening:test
run_step "commitment-threshold:test" npm run commitment-threshold:test
run_step "refund-deadline:test" npm run refund-deadline:test
run_step "openapi:check" npm run openapi:check

echo "[pilot-qa] all checks passed"
