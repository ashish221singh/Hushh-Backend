const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, value) {
  console.log(`[readiness] ${label}${value ? `: ${value}` : ''}`);
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
    throw new Error(`Invalid JSON (${path}): ${text.slice(0, 250)}`);
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(
      `Request failed ${response.status} ${path}: ${payload?.error?.message || text}`
    );
  }

  return payload?.data;
}

async function createSession() {
  const phone = String(Number(String(Date.now()).slice(-10)) + Math.floor(Math.random() * 10)).slice(-10);

  const sim = await request('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: '+91', phone },
  });
  assert(sim?.request_id, 'request_id missing');

  await request('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: sim.request_id },
  });

  const token = await request('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: sim.request_id },
  });
  assert(token?.access_token, 'access_token missing');

  await request('/api/v1/onboarding/profile', {
    method: 'POST',
    headers: { authorization: `Bearer ${token.access_token}` },
    body: {
      full_name: 'Readiness User',
      gender: 'Male',
      age: 28,
      profession: 'QA',
    },
  });

  return { token: token.access_token, userId: token.user_id };
}

async function run() {
  logStep('base_url', BASE_URL);
  const health = await request('/health');
  assert(health?.status === 'ok', 'health.status must be ok');
  logStep('health', 'ok');

  const { token, userId } = await createSession();
  logStep('session', userId);

  let meetId = null;
  for (let i = 0; i < 4 && !meetId; i += 1) {
    const seeded = await request('/api/v1/admin/matcher/seed-demo-group', {
      method: 'POST',
      headers: { 'x-admin-key': ADMIN_KEY },
      body: {
        anchor_user_id: userId,
        vibe: 'Coffee',
        availability_slot: 'Today',
        lat: 12.9716,
        lng: 77.5946,
      },
    });
    assert(seeded?.matched_request_count >= 1, 'seed must produce at least one match');
    logStep('seeded', String(seeded.matched_request_count));

    for (let j = 0; j < 8 && !meetId; j += 1) {
      const found = await request('/api/v1/meets/found', {
        headers: { authorization: `Bearer ${token}` },
      });
      meetId = found?.meet?.meet_id || null;
      if (!meetId) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  assert(meetId, 'meet not found after seeding');
  logStep('meet', meetId);

  const intent = await request(`/api/v1/meets/${encodeURIComponent(meetId)}/payment-intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  const paymentId = intent?.payment?.payment_id;
  assert(paymentId, 'payment intent missing payment_id');

  const callbackIdem = `cb-${Date.now()}`;
  const callback1 = await request('/api/v1/payments/callback', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': callbackIdem,
    },
    body: {
      payment_id: paymentId,
      status: 'CONFIRMED',
      receipt_id: `rcpt_${callbackIdem}`,
    },
  });
  const callback2 = await request('/api/v1/payments/callback', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': callbackIdem,
    },
    body: {
      payment_id: paymentId,
      status: 'FAILED',
      receipt_id: 'rcpt_should_not_apply',
    },
  });
  assert(callback1?.payment?.status === 'CONFIRMED', 'callback first response should confirm payment');
  assert(callback2?.payment?.status === 'CONFIRMED', 'callback idempotency should replay confirmed response');
  logStep('payments/callback idempotency', 'ok');

  const shareIdem = `share-${Date.now()}`;
  const share1 = await request(`/api/v1/meets/${encodeURIComponent(meetId)}/share-venue`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': shareIdem,
    },
    body: {},
  });
  const share2 = await request(`/api/v1/meets/${encodeURIComponent(meetId)}/share-venue`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': shareIdem,
    },
    body: { unexpected_mutation: true },
  });
  assert(share1?.meet?.status === 'VENUE_SHARED', 'share-venue should set meet VENUE_SHARED');
  assert(share2?.meet?.status === 'VENUE_SHARED', 'share-venue idempotency should replay same response');
  logStep('meets/share-venue idempotency', 'ok');

  const webhookIdem = `wh-${Date.now()}`;
  const webhook1 = await request('/api/v1/payments/webhook', {
    method: 'POST',
    headers: {
      'idempotency-key': webhookIdem,
    },
    body: {
      payment_id: paymentId,
      status: 'CONFIRMED',
      receipt_id: `webhook_${webhookIdem}`,
    },
  });
  const webhook2 = await request('/api/v1/payments/webhook', {
    method: 'POST',
    headers: {
      'idempotency-key': webhookIdem,
    },
    body: {
      payment_id: paymentId,
      status: 'FAILED',
      receipt_id: 'webhook_should_not_apply',
    },
  });
  assert(webhook1?.payment?.status === 'CONFIRMED', 'webhook first response should confirm payment');
  assert(webhook2?.payment?.status === 'CONFIRMED', 'webhook idempotency should replay confirmed response');
  logStep('payments/webhook idempotency', 'ok');

  console.log('[readiness] all checks passed');
}

run().catch((error) => {
  console.error('[readiness] failed:', error?.message || error);
  process.exit(1);
});
