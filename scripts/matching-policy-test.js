const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const REQUEUE_WAIT_MS = Number(process.env.REQUEUE_WAIT_MS || 9000);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, value) {
  console.log(`[matching-policy] ${label}${value ? `: ${value}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON ${path}: ${text.slice(0, 200)}`);
  }

  if (!res.ok || payload?.success === false) {
    const err = new Error(
      `Request failed ${res.status} ${path}: ${payload?.error?.message || text}`
    );
    err.status = res.status;
    err.code = payload?.error?.code || null;
    err.payload = payload;
    throw err;
  }

  return payload?.data;
}

async function expectError(path, options = {}, expectedStatus = null, expectedCode = null) {
  try {
    await request(path, options);
  } catch (error) {
    if (expectedStatus != null) {
      assert(error.status === expectedStatus, `expected status ${expectedStatus}, got ${error.status}`);
    }
    if (expectedCode != null) {
      assert(error.code === expectedCode, `expected code ${expectedCode}, got ${error.code}`);
    }
    return error;
  }
  throw new Error(`Expected error for ${path} but request succeeded`);
}

async function createSession() {
  const phone = String(
    Number(String(Date.now()).slice(-10)) + Math.floor(Math.random() * 10)
  ).slice(-10);

  const simReq = await request('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: '+91', phone },
  });
  const requestId = simReq?.request_id;
  assert(requestId, 'sim request id missing');

  await request('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: requestId },
  });

  const tokenPayload = await request('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: requestId },
  });
  assert(tokenPayload?.access_token, 'access token missing');

  await request('/api/v1/onboarding/profile', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
    body: {
      full_name: 'Matching Policy User',
      gender: 'Male',
      age: 27,
      profession: 'QA',
    },
  });

  return {
    token: tokenPayload.access_token,
    userId: tokenPayload.user_id,
  };
}

async function run() {
  logStep('base_url', BASE_URL);
  const health = await request('/health');
  assert(health?.status === 'ok', 'health must be ok');

  const { token, userId } = await createSession();
  logStep('session', userId);

  const voiceIntro = await request('/api/v1/voice-intros', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      voice_duration_sec: 18,
      local_uri: 'file:///tmp/policy-intro.m4a',
      mime_type: 'audio/m4a',
      size_bytes: 180000,
      recorded_at: '2026-02-21T00:00:00.000Z',
    },
  });
  const voiceIntroId = voiceIntro?.voice_intro?.voice_intro_id;
  assert(voiceIntroId, 'voice intro id missing');

  const requestBody = {
    availability_slot: 'Today',
    vibe: 'Coffee',
    age_min: 22,
    age_max: 34,
    lat: 12.9716,
    lng: 77.5946,
    radius_km: 12,
    voice_duration_sec: 18,
    voice_intro_id: voiceIntroId,
    voice_storage_url: voiceIntro.voice_intro.storage_url,
    voice_mime_type: voiceIntro.voice_intro.mime_type,
    voice_size_bytes: voiceIntro.voice_intro.size_bytes,
    voice_recorded_at: voiceIntro.voice_intro.recorded_at,
  };

  const firstReq = await request('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: requestBody,
  });
  assert(firstReq?.request?.request_id, 'first match request missing');
  logStep('match-create-1', firstReq.request.status);

  const cancelled = await request('/api/v1/match-requests/cancel-active', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert(cancelled?.cancelled_request_id, 'cancelled_request_id missing');
  logStep('cancel-active', cancelled.cancelled_request_id);

  await expectError(
    '/api/v1/match-requests',
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: requestBody,
    },
    429,
    'RETRY_COOLDOWN'
  );
  logStep('retry-cooldown', 'ok');

  await sleep(REQUEUE_WAIT_MS);

  const secondReq = await request('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: requestBody,
  });
  assert(secondReq?.request?.request_id, 'second match request missing');
  logStep('match-create-2', secondReq.request.status);

  const seeded = await request('/api/v1/admin/matcher/seed-demo-group', {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
    body: {
      anchor_user_id: userId,
      availability_slot: 'Today',
      vibe: 'Coffee',
      lat: 12.9716,
      lng: 77.5946,
    },
  });
  assert(seeded?.matched_request_count >= 1, 'seed did not produce match');

  let found = null;
  for (let i = 0; i < 10; i += 1) {
    const data = await request('/api/v1/meets/found', {
      headers: { authorization: `Bearer ${token}` },
    });
    if (data?.meet?.meet_id) {
      found = data.meet;
      break;
    }
    await sleep(600);
  }

  assert(found?.meet_id, 'found meet missing after seed');
  logStep('found-meet', found.meet_id);

  const activeBeforeLookAnother = await request('/api/v1/match-requests/active', {
    headers: { authorization: `Bearer ${token}` },
  });
  const previousRequestId = activeBeforeLookAnother?.request?.request_id;

  const lookAnother = await request('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      ...requestBody,
      look_for_another: true,
    },
  });

  assert(lookAnother?.request?.request_id, 'look for another did not return request');
  assert(
    lookAnother.request.request_id !== previousRequestId,
    'look for another should create a new active request'
  );
  logStep('look-another', lookAnother.request.request_id);

  const queue = await request('/api/v1/admin/match-queue?limit=120', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  const lookAnotherCancelEvent = (queue?.events || []).find(
    (e) => e.type === 'CANCELLED' && String(e.message || '').toLowerCase().includes('look-another')
  );
  assert(Boolean(lookAnotherCancelEvent), 'look-another cancellation event missing');
  logStep('look-another-event', lookAnotherCancelEvent.event_id);

  console.log('[matching-policy] all checks passed');
}

run().catch((error) => {
  console.error('[matching-policy] failed:', error?.message || error);
  process.exit(1);
});
