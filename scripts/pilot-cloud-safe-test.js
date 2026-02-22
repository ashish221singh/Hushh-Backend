const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, value) {
  console.log(`[pilot-cloud] ${label}${value ? `: ${value}` : ''}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  const expectedStatuses = Array.isArray(options.expectStatus)
    ? options.expectStatus
    : options.expectStatus != null
      ? [options.expectStatus]
      : null;

  if (expectedStatuses && expectedStatuses.includes(response.status)) {
    return { status: response.status, data: payload?.data, payload };
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(
      `Request failed ${response.status} ${path}: ${payload?.error?.message || text}`
    );
  }

  return { status: response.status, data: payload?.data, payload };
}

async function run() {
  logStep('base_url', BASE_URL);

  const health = await request('/health');
  assert(health.data?.status === 'ok', 'health.status must be ok');
  logStep('health', 'ok');

  const db = await request('/api/v1/admin/db-status', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert(db.data?.healthy === true, 'db-status must be healthy');
  logStep('db-status', `${db.data?.mode || 'unknown'}:healthy`);

  const overview = await request('/api/v1/admin/overview', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  const runtime = overview.data?.runtime || null;
  if (runtime) {
    assert(runtime.auth_mode === 'firebase_otp', 'runtime.auth_mode must be firebase_otp');
    assert(runtime.allow_otp_fallback === false, 'ALLOW_OTP_FALLBACK must be false');
    assert(runtime.allow_found_fallback === false, 'ALLOW_FOUND_FALLBACK must be false');
    assert(runtime.dev_match_helpers_enabled === false, 'DEV_MATCH_HELPERS_ENABLED must be false');
    assert(runtime.admin_matcher_seed_enabled === false, 'ADMIN_MATCHER_SEED_ENABLED must be false');
    logStep('runtime-flags', 'safe');
  } else {
    logStep('runtime-flags', 'not exposed in current deploy; validating via endpoint behavior');
  }

  const logs = await request('/api/v1/admin/logs?limit=5', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert(Array.isArray(logs.data?.logs), 'admin logs payload missing');
  logStep('admin-logs', String(logs.data.logs.length));

  const adminSeed = await request('/api/v1/admin/matcher/seed-demo-group', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: { vibe: 'Coffee', availability_slot: 'Today' },
    expectStatus: 404,
  });
  assert(adminSeed.status === 404, 'admin seed endpoint must be disabled in pilot');
  logStep('admin-seed-route', 'disabled');

  const devSeed = await request('/api/v1/dev/matcher/seed-self', {
    method: 'POST',
    body: { vibe: 'Coffee', availability_slot: 'Today' },
    expectStatus: 404,
  });
  assert(devSeed.status === 404, 'dev seed endpoint must be disabled in pilot');
  logStep('dev-seed-route', 'disabled');

  const pushToken = await request('/api/v1/notifications/push-token', {
    method: 'POST',
    body: { token: 'ExpoPushToken[test]' },
    expectStatus: [401, 403],
  });
  assert([401, 403].includes(pushToken.status), 'push token route should require auth');
  logStep('push-token-auth', String(pushToken.status));

  console.log('[pilot-cloud] all checks passed');
}

run().catch((error) => {
  console.error('[pilot-cloud] failed:', error?.message || error);
  process.exit(1);
});
