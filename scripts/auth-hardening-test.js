const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');

function logStep(label, value) {
  console.log(`[auth-hardening] ${label}${value ? `: ${value}` : ''}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonRequest(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON (${path}): ${text.slice(0, 200)}`);
  }
  return { status: res.status, payload };
}

async function createToken(phone) {
  const req = await jsonRequest('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: '+91', phone },
  });
  assert(req.status === 200 || req.status === 201, 'sim/request must return 200/201');
  const requestId = req.payload?.data?.request_id;
  assert(requestId, 'request_id missing');

  const verify = await jsonRequest('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: requestId },
  });
  assert(verify.status === 200, 'sim/mock-verify must return 200');

  const token = await jsonRequest('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: requestId },
  });
  assert(token.status === 200, 'auth/token must return 200');
  const accessToken = token.payload?.data?.access_token;
  assert(accessToken, 'access_token missing');
  return accessToken;
}

async function run() {
  logStep('base_url', BASE_URL);
  const health = await jsonRequest('/health');
  assert(health.status === 200, 'health must be 200');
  logStep('health', 'ok');

  const phone = String(Number(String(Date.now()).slice(-10)) + Math.floor(Math.random() * 10)).slice(
    -10
  );
  const token = await createToken(phone);
  logStep('token-issued', 'ok');

  const meBefore = await jsonRequest('/api/v1/auth/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(meBefore.status === 200, 'auth/me before logout should be 200');
  logStep('auth/me-before-logout', 'ok');

  const logout = await jsonRequest('/api/v1/auth/logout', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert(logout.status === 200, 'logout should return 200');
  logStep('auth/logout', 'ok');

  const meAfter = await jsonRequest('/api/v1/auth/me', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert(meAfter.status === 401, 'auth/me after logout should be 401');
  logStep('auth/me-after-logout', '401');

  const statuses = [];
  for (let i = 0; i < 10; i += 1) {
    const p = String(Number(phone) + i + 100).slice(-10);
    const r = await jsonRequest('/api/v1/auth/sim/request', {
      method: 'POST',
      body: { country_code: '+91', phone: p },
    });
    statuses.push(r.status);
  }
  const has429 = statuses.includes(429);
  assert(has429, 'sim/request rate limiting should return 429 after burst');
  logStep('sim/request-rate-limit', 'ok');

  console.log('[auth-hardening] all checks passed');
}

run().catch((error) => {
  console.error('[auth-hardening] failed:', error?.message || error);
  process.exit(1);
});
