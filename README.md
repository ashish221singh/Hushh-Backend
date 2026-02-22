# Hushh Backend (Onboarding MVP)

Lightweight onboarding backend with no external dependencies.

Now supports a Postgres-backed mode (via Prisma) while preserving existing API contracts.

## Run

```bash
cd backend
npm run start
```

Server starts on `http://localhost:3001` by default.

## Local Postgres (Docker)

```bash
cd backend
npm install
npm run db:up
npm run db:push
npm run db:generate
USE_POSTGRES=true DATABASE_URL=postgresql://hushh:hushh@localhost:5432/hushh?schema=public npm run start
```

To stop DB:
```bash
npm run db:down
```

Notes:
- On first boot in Postgres mode, backend auto-imports current `data/store.json` into Postgres.
- After that, runtime persistence is served from Postgres.

## API Smoke Test

Run backend first, then in a new terminal:

```bash
cd backend
npm run smoke:test
```

Optional env:
- `BASE_URL` (default: `http://localhost:3001`)
- `ADMIN_KEY` (default: `dev-admin-key`)

Example:
```bash
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run smoke:test
```

The smoke test validates:
- health
- SIM request/mock-verify/token
- auth/me + onboarding profile
- strict `/meets/found` behavior (or fallback mode)
- admin matcher seed flow (`/api/v1/admin/matcher/seed-demo-group`)
- meet found/confirm/active/share-venue
- feedback
- block/unblock
- admin overview
- admin db-status

## Integration Readiness Test

Run backend first, then in a new terminal:

```bash
cd backend
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run readiness:test
```

This validates:
- idempotent replay for `/api/v1/payments/callback`
- idempotent replay for `/api/v1/payments/webhook`
- idempotent replay for `/api/v1/meets/:meet_id/share-venue`
- strict write-route behavior on real matched/seeded data

## Matching Policy Test

Run backend first, then in a new terminal:

```bash
cd backend
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run matching-policy:test
```

This validates:
- cooldown enforcement after cancel (`RETRY_COOLDOWN`)
- requeue after cooldown window
- strict match + found meet creation
- `look_for_another` creates a new request and logs cancellation event

## Past Meets Test

Run backend first, then in a new terminal:

```bash
cd backend
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run past-meets:test
```

This validates:
- `/api/v1/meets/past` returns archived/finished meets
- past meet payload includes participant statuses
- commitment summary fields are present
- feedback flow archives meet and makes it visible in past list

## Pilot QA Automation

Run all backend reliability checks in one command:

```bash
cd backend
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run pilot:qa
```

Includes:
- `smoke:test`
- `matching-policy:test`
- `auth-hardening:test`
- `readiness:test`
- `openapi:check`

Pilot preflight checks:

```bash
cd backend
npm run pilot:config-check
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run pilot:health-check
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run pilot:cloud-safe:test
BASE_URL=http://localhost:3001 ADMIN_KEY=dev-admin-key npm run pilot:admin-ops:test
```

`pilot:cloud-safe:test` is read-only and validates:
- runtime safety flags are locked for pilot (`dev/admin seed` disabled, OTP fallback disabled)
- health + db-status
- admin logs access
- protected routes still require auth

`pilot:admin-ops:test` is read-only and validates:
- admin match groups visibility for committed groups
- admin meets visibility for venue operations
- admin queue telemetry visibility

Deployment checklist:
- `backend/PILOT_DEPLOYMENT_CHECKLIST.md`

## OpenAPI Contract (Locked)

- Contract file: `backend/openapi.yaml`
- Contract version: `info.version = 1.0.0`
- Current API namespace: `/api/v1/*`

Validation:

```bash
cd backend
npm run openapi:check
```

Contract conventions:
- Do not make backward-incompatible response-shape changes under the same `info.version`.
- Add fields in a backward-compatible way (optional additions).
- For breaking changes, bump version and publish new contract revision.
- Error envelope is standardized as:
  - `success: false`
  - `error.code` (stable machine code)
  - `error.message` (human-readable)

## Env

Copy `.env.example` values into your shell/environment if needed:

- `PORT` (default `3001`)
- `API_BASE_URL` (default `http://localhost:3001`)
- `SIM_VERIFY_DESTINATION` (default `+919900000001`)
- `SMS_PROVIDER` (`mock|direct|twilio|msg91|exotel`, default `mock`)
- `SMS_VERIFY_DESTINATION` (provider inbound number/shortcode if different from SIM_VERIFY_DESTINATION)
- `SMS_WEBHOOK_SECRET` (optional HMAC secret for inbound SMS webhook signature validation)
- `TOKEN_TTL_SECONDS` (default `86400`)
- `MAX_SESSIONS_PER_USER` (default `3`; oldest sessions are removed when exceeded)
- `SIM_TOKEN_TTL_MINUTES` (default `10`)
- `AUTH_MODE` (`firebase_otp` default; app uses OTP flow when enabled)
- `ALLOW_OTP_FALLBACK` (`true|false`, default `false`; keep `false` for strict Firebase OTP)
- `OTP_TTL_MINUTES` (default `5`)
- `OTP_RESEND_SECONDS` (default `30`)
- `OTP_LENGTH` (default `6`)
- `FIREBASE_WEB_API_KEY` (required for `/api/v1/auth/firebase/token`)
- `FIREBASE_PROJECT_ID` (optional project consistency check)
- `PUSH_PROVIDER` (`expo` default)
- `EXPO_PUSH_API_URL` (default Expo push send endpoint)
- `EXPO_ACCESS_TOKEN` (optional Expo access token for enhanced push throughput/security)
- `ADMIN_KEY` (default `dev-admin-key`)
- `USE_POSTGRES` (`true|false`, default uses Postgres when `DATABASE_URL` is present)
- `DATABASE_URL` (Postgres connection string)
- `MATCHER_INTERVAL_MS` (background matching cycle interval, default `7000`)
- `MATCH_REQUEST_TTL_MINUTES` (queued request expiry window, default `360`)
- `MATCH_REQUEST_RETRY_COOLDOWN_SECONDS` (cooldown before re-request after cancel/expire, default `8`)
- `MATCH_RELAXED_MIXED_AFTER_MINUTES` (default `8`; after this age, ratio relaxes to mixed-gender)
- `MATCH_RELAXED_ANY_AFTER_MINUTES` (default `18`; after this age, allows any-gender mix)
- `PAYMENT_PROVIDER` (`mock` default; gateway adapter selector)
- `PAYMENT_WEBHOOK_SECRET` (HMAC secret for `/api/v1/payments/webhook`)
- `IDEMPOTENCY_TTL_MS` (default `600000`; idempotent response cache window)
- `COMMITMENT_RESPONSE_WINDOW_MINUTES` (default `30`; response/payment window after a meet is found)
- `ALLOW_FOUND_FALLBACK` (`true|false`, default `false`; strict mode should keep this `false`)
- `DEV_MATCH_HELPERS_ENABLED` (`true|false`, default `false`; enables `/api/v1/dev/matcher/seed-self`)
- `ADMIN_MATCHER_SEED_ENABLED` (`true|false`, default `false`; enables `/api/v1/admin/matcher/seed-demo-group`)

## API Endpoints

### Request Validation Rules
- For all `POST` endpoints with body input, payload must be a JSON object (not array/string/number).
- Invalid JSON now returns `400 INVALID_JSON`.
- Oversized payloads now return `413 PAYLOAD_TOO_LARGE`.
- Field-level validation errors return `400 VALIDATION_ERROR`.

### 1) Request SIM Verification
`POST /api/v1/auth/sim/request`

Body:
```json
{ "country_code": "+91", "phone": "9900000001" }
```

Returns:
- `request_id`
- `sms_destination`
- `sms_body` (`HUSHH VERIFY <token>`)
- `status_check_url`

### 2) Check SIM Status
`GET /api/v1/auth/sim/status?request_id=<id>`

Statuses: `PENDING | VERIFIED | EXPIRED`

### 3) Inbound SMS Webhook
`POST /api/v1/auth/sim/inbound-sms`

Body:
```json
{ "from": "+919900000001", "message": "HUSHH VERIFY ABC123" }
```

Provider alias endpoint:
`POST /api/v1/auth/sim/provider-webhook`

Notes:
- Supports canonical payload (`from`, `message`) and provider variants (Twilio/MSG91/Exotel basic field mapping).
- If `SMS_WEBHOOK_SECRET` is set, request signature is validated using HMAC-SHA256 against header:
  - `x-sms-signature` (or `x-webhook-signature`, `x-signature`).

### 4) Mock Verify (Dev)
`POST /api/v1/auth/sim/mock-verify`

Body:
```json
{ "request_id": "simreq_..." }
```

### 5) Create Access Token
`POST /api/v1/auth/token`

Body:
```json
{ "request_id": "simreq_..." }
```

Returns bearer `access_token`.

### 5b) Request OTP (MVP)
`POST /api/v1/auth/otp/request`

Note:
- When `AUTH_MODE=firebase_otp` and `ALLOW_OTP_FALLBACK=false`, this endpoint returns `409 OTP_FALLBACK_DISABLED`.
- Use Firebase client OTP + `/api/v1/auth/firebase/token` in that mode.

Body:
```json
{ "country_code": "+91", "phone": "9900000001" }
```

Returns:
- `request_id`
- `expires_at`
- `resend_available_at`
- `masked_phone`
- `dev_otp` (non-production only, and only when `ALLOW_OTP_FALLBACK=true`)

### 5c) Verify OTP (MVP)
`POST /api/v1/auth/otp/verify`

Note:
- When `AUTH_MODE=firebase_otp` and `ALLOW_OTP_FALLBACK=false`, this endpoint returns `409 OTP_FALLBACK_DISABLED`.

Body:
```json
{ "request_id": "otpreq_...", "otp": "123456" }
```

Returns bearer `access_token`.

### 5d) Firebase Token Exchange (production OTP path)
`POST /api/v1/auth/firebase/token`

Body:
```json
{ "id_token": "<firebase_user_id_token>" }
```

Returns bearer `access_token`.

### 5e) Register Push Token
`POST /api/v1/notifications/push-token`

Headers:
`Authorization: Bearer <access_token>`

Body:
```json
{
  "push_token": "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
  "platform": "ios"
}
```

Returns active token registration id.

### 6) Save Onboarding Profile
`POST /api/v1/onboarding/profile`

Headers:
`Authorization: Bearer <access_token>`

Body:
```json
{
  "full_name": "Ashish Singh",
  "gender": "Male",
  "age": 32,
  "profession": "Designer"
}
```

### 7) Get Current User
`GET /api/v1/auth/me`

Headers:
`Authorization: Bearer <access_token>`

### 7b) Logout Session
`POST /api/v1/auth/logout`

Headers:
`Authorization: Bearer <access_token>`

Returns:
```json
{ "logged_out": true }
```

Note:
- Sensitive routes use in-memory rate limiting and can return `429 RATE_LIMITED` with `retry_after_sec`.

### 8) Get Active Meet
`GET /api/v1/meets/active`

Headers:
`Authorization: Bearer <access_token>`

Returns:
- `meet` object or `null` (same shape as found/confirm/share responses)

### 9) Get Found Meet (Thin Demo Slice)
`GET /api/v1/meets/found`

Headers:
`Authorization: Bearer <access_token>`

Behavior:
- returns existing `FOUND` meet for user
- strict mode (default): if no found meet, returns `meet: null` with `meta.strict_match_mode=true`
- optional dev fallback (`ALLOW_FOUND_FALLBACK=true`): auto-creates demo found meet

### 10) Create Meet Payment Intent
`POST /api/v1/meets/:meet_id/payment-intent`

Headers:
`Authorization: Bearer <access_token>`

Returns:
- `payment` with status `PENDING`
- provider metadata (`provider`, `provider_meta`, `client_action`)

### 11) Payment Callback (app/backend)
`POST /api/v1/payments/callback`

Headers:
`Authorization: Bearer <access_token>` or `x-admin-key`
- optional `Idempotency-Key: <client-generated-key>`

Body:
```json
{ "payment_id": "pay_...", "status": "CONFIRMED|FAILED|CANCELLED|REFUNDED", "receipt_id": "optional" }
```

Notes:
- Body must be a JSON object.
- Duplicate callbacks with same idempotency key return cached response.

### 12) Payment Webhook (gateway)
`POST /api/v1/payments/webhook`

Headers:
- `x-payment-signature` (or `x-webhook-signature`) when `PAYMENT_WEBHOOK_SECRET` is set
- optional `Idempotency-Key: <gateway-event-id>`

Body:
- Canonical payload: `payment_id`, `status`, optional `receipt_id`
- Adapter also normalizes provider variants (Razorpay/Stripe basic shapes)

Notes:
- Body must be a JSON object.
- Duplicate webhook events with same idempotency key return cached response.

### 13) Confirm Meet Payment (Backward-compatible)
`POST /api/v1/meets/:meet_id/confirm`

Headers:
`Authorization: Bearer <access_token>`
- optional `Idempotency-Key: <client-generated-key>`

Returns:
- updated `meet` with status `CONFIRMED`
- fee receipt fields under `meet.fee.receipt`

Notes:
- Body must be a JSON object (empty `{}` is allowed).

### 14) Share Venue
`POST /api/v1/meets/:meet_id/share-venue`

Headers:
`Authorization: Bearer <access_token>`
- optional `Idempotency-Key: <client-generated-key>`

Returns:
- updated `meet` with status `VENUE_SHARED`
- `venue.is_hidden=false` with venue name/address

Notes:
- Body must be a JSON object (empty `{}` is allowed).

### 15) Submit Feedback
`POST /api/v1/meets/:meet_id/feedback`

Headers:
`Authorization: Bearer <access_token>`

Body:
```json
{ "rating": 5, "note": "Great vibe" }
```

### 16) Block User
`POST /api/v1/users/block`

Headers:
`Authorization: Bearer <access_token>`

Body:
```json
{ "blocked_user_id": "participant_mike", "reason": "optional" }
```

### 17) Unblock User
`POST /api/v1/users/unblock`

Headers:
`Authorization: Bearer <access_token>`

Body:
```json
{ "blocked_user_id": "participant_mike" }
```

### 18) Create Match Request
`POST /api/v1/match-requests`

Headers:
`Authorization: Bearer <access_token>`

Body (minimum):
```json
{
  "availability_slot": "Today",
  "vibe": "Coffee",
  "age_min": 22,
  "age_max": 34,
  "lat": 12.9716,
  "lng": 77.5946,
  "radius_km": 12,
  "voice_duration_sec": 18,
  "voice_intro_id": "vintro_...",
  "voice_storage_url": "local://voice-intros/vintro_..."
}
```

Validation:
- `availability_slot` must be `Today | Tomorrow | This Weekend`
- `voice_duration_sec` must be at least `15`
- `voice_storage_url` is required

### 19) Create Voice Intro Metadata
`POST /api/v1/voice-intros`

Headers:
`Authorization: Bearer <access_token>`

Body:
```json
{
  "voice_duration_sec": 18,
  "local_uri": "file:///path/to/audio.m4a",
  "mime_type": "audio/m4a",
  "size_bytes": 180000,
  "recorded_at": "2026-02-20T00:00:00.000Z"
}
```

Response:
- `voice_intro.voice_intro_id`
- `voice_intro.storage_url`
- normalized metadata fields
### 20) Get Active Match Request
`GET /api/v1/match-requests/active`

Headers:
`Authorization: Bearer <access_token>`

Response includes:
- `request.sla_state`: `SEARCHING | NO_MATCH_RETRYING | MATCHED | CANCELLED | EXPIRED`
- `request.matching_mode` (while queued): `STRICT | RELAXED_MIXED | RELAXED_ANY`

### 21) Cancel Active Match Request
`POST /api/v1/match-requests/cancel-active`

Headers:
`Authorization: Bearer <access_token>`

### 22) Cancel Match Request By ID
`POST /api/v1/match-requests/:request_id/cancel`

Headers:
`Authorization: Bearer <access_token>`

### 23) Admin Seed Demo Match Group
`POST /api/v1/admin/matcher/seed-demo-group`

Headers:
`x-admin-key: <ADMIN_KEY>`

Purpose:
- seeds a compatible 5-user queued set and runs matcher once
- useful for strict-mode demos where `/meets/found` should only appear after a real match

## Meet Payload Shape

Used consistently in:
- `GET /api/v1/meets/active`
- `GET /api/v1/meets/found`
- `POST /api/v1/meets/:meet_id/confirm`
- `POST /api/v1/meets/:meet_id/share-venue`
- `GET /api/v1/meets/past`

```json
{
  "meet_id": "meet_...",
  "status": "FOUND|CONFIRMED|VENUE_SHARED",
  "topic_label": "Sunday Crowd",
  "match_time_label": "Tomorrow, 6 PM.",
  "participants": [
    {
      "participant_id": "mp_...",
      "user_id": null,
      "name": "Mike, 26",
      "subtitle": "Tech & Hiking",
      "initial": "M"
    }
  ],
  "venue": {
    "is_hidden": true,
    "share_eta_mins": 30,
    "name": null,
    "address": null
  },
  "fee": {
    "amount": "399.00",
    "amount_paise": 39900,
    "currency": "INR",
    "payment_status": "PENDING|CONFIRMED",
    "receipt": null
  },
  "commitment": {
    "response_window_mins": 30,
    "deadline_at": "ISO-8601",
    "is_expired": false
  },
  "updated_at": "ISO-8601"
}
```

## Data Storage

Persistent JSON storage at `backend/data/store.json`.

Meet-flow data collections added:
- `meets`
- `meetParticipants`
- `payments`
- `feedback`
- `blockedUsers`

This is for MVP/dev only. Next step is moving to PostgreSQL + Redis.

## Admin Dashboard

- Open: `http://localhost:3001/admin`
- Enter `ADMIN_KEY` (default: `dev-admin-key`)

Admin APIs:
- `GET /api/v1/admin/overview` (header: `x-admin-key`)
- `GET /api/v1/admin/users` (header: `x-admin-key`)
- `GET /api/v1/admin/logs?limit=50` (header: `x-admin-key`)
  - supports filters: `offset`, `method`, `path_contains`, `status`, `status_min`, `status_max`, `only_failures`, `ip`, `search`
- `GET /api/v1/admin/db-status` (header: `x-admin-key`)
- `GET /api/v1/admin/match-queue?limit=30` (header: `x-admin-key`)
- `GET /api/v1/admin/meets?status=open&limit=50` (header: `x-admin-key`)
- `GET /api/v1/admin/match-groups?limit=50&committed_only=true` (header: `x-admin-key`)
- `POST /api/v1/admin/meets/:meet_id/venue` (header: `x-admin-key`)
- `POST /api/v1/admin/match-groups/:group_id/share-venue` (header: `x-admin-key`)

Shows:
- user list and onboarding completion
- verification/session counts
- recent API request logs and errors
- API failure observability:
  - failed request count
  - failure rate %
  - recent failed requests table
  - top failing routes breakdown
- DB observability:
  - active storage mode (`file` or `postgres`)
  - health check (`SELECT 1` in Postgres mode)
  - runtime entity counts
  - provider/details payload
- Matcher observability:
  - latest match requests (queued/matched)
  - latest match groups and member counts
  - latest matcher events timeline
- Meet ops:
  - pick committed matched group (`group_id`) and share venue once
  - update venue name/address/manager/phone/review from host
  - trigger push to all committed users in that group
- Meet detail payload:
  - participant-level status (`COMMITTED|PENDING|CANCELLED`)
  - commitment summary (`committed_members`, `pending_members`, `cancelled_members`)
