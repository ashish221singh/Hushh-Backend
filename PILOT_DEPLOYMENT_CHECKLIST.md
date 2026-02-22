# Pilot Deployment Checklist

## A) Infrastructure

- [ ] Backend deployed to cloud (not local laptop)
- [ ] Managed Postgres provisioned and connected
- [ ] HTTPS domain configured for backend API
- [ ] Restart policy enabled for backend process/container

## B) Environment / Secrets

Required environment variables:

- [ ] `AUTH_MODE=firebase_otp`
- [ ] `ALLOW_OTP_FALLBACK=false`
- [ ] `FIREBASE_WEB_API_KEY=<set>`
- [ ] `ADMIN_KEY=<rotated_non_default>`
- [ ] `DEV_MATCH_HELPERS_ENABLED=false`
- [ ] `ADMIN_MATCHER_SEED_ENABLED=false`
- [ ] `ALLOW_FOUND_FALLBACK=false`
- [ ] `DATABASE_URL=<managed_postgres_url>`

Validation:

```bash
cd backend
npm run pilot:config-check
BASE_URL=https://<pilot-api-domain> ADMIN_KEY=<admin_key> npm run pilot:cloud-safe:test
BASE_URL=https://<pilot-api-domain> ADMIN_KEY=<admin_key> npm run pilot:admin-ops:test
```

## C) Health / Readiness

- [ ] `/health` returns 200 and `status=ok`
- [ ] `/api/v1/admin/db-status` returns `healthy=true`
- [ ] Runtime flags are pilot-safe (`dev/admin matcher seed disabled`, OTP fallback disabled)

Validation:

```bash
cd backend
BASE_URL=https://<pilot-api-domain> ADMIN_KEY=<admin_key> npm run pilot:health-check
```

## D) QA Automation

- [ ] Full QA suite passes against pilot backend

Validation:

```bash
cd backend
BASE_URL=https://<pilot-api-domain> ADMIN_KEY=<admin_key> npm run pilot:qa
```

## E) Mobile App Wiring

- [ ] App build points to pilot API URL
- [ ] Firebase OTP config points to pilot project
- [ ] Dev helper disabled in app env

## F) Observability

- [ ] Admin dashboard reachable at `/admin`
- [ ] Logs visible at `/api/v1/admin/logs`
- [ ] Match telemetry visible at `/api/v1/admin/match-queue`

Useful filtered logs examples:

```bash
curl -s "https://<pilot-api-domain>/api/v1/admin/logs?only_failures=true&status_min=400&limit=200" \
  -H "x-admin-key: <admin_key>" | jq

curl -s "https://<pilot-api-domain>/api/v1/admin/logs?path_contains=/api/v1/auth&limit=100" \
  -H "x-admin-key: <admin_key>" | jq
```

## G) Go/No-Go

Go only if all sections A-F are checked.
