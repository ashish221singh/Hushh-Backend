const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const REQUEUE_WAIT_MS = Number(process.env.REQUEUE_WAIT_MS || 9000);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 250)}`);
  }

  if (!response.ok || payload?.success === false) {
    throw new Error(
      `Request failed ${response.status} ${path}: ${payload?.error?.message || text}`
    );
  }
  return payload?.data;
}

function logStep(label, value) {
  console.log(`[smoke] ${label}${value ? `: ${value}` : ''}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  logStep('base_url', BASE_URL);

  const health = await api('/health');
  assert(health?.status === 'ok', 'health.status must be ok');
  logStep('health', 'ok');

  const phone = String(
    Number(String(Date.now()).slice(-10)) + Math.floor(Math.random() * 10)
  ).slice(-10);
  const countryCode = '+91';

  const request = await api('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: countryCode, phone },
  });
  assert(request?.request_id, 'request_id missing');
  logStep('sim/request', request.request_id);

  await api('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: request.request_id },
  });
  logStep('sim/mock-verify', 'ok');

  const tokenPayload = await api('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: request.request_id },
  });
  assert(tokenPayload?.access_token, 'access_token missing');
  const bearer = tokenPayload.access_token;
  logStep('auth/token', tokenPayload.user_id);

  const meBefore = await api('/api/v1/auth/me', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert(meBefore?.user_id, 'auth/me user_id missing');
  logStep('auth/me', meBefore.user_id);

  await api('/api/v1/onboarding/profile', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: {
      full_name: 'Smoke Test User',
      gender: 'Male',
      age: 28,
      profession: 'QA',
    },
  });
  logStep('onboarding/profile', 'ok');

  const voiceIntro = await api('/api/v1/voice-intros', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: {
      voice_duration_sec: 18,
      local_uri: 'file:///tmp/smoke-intro.m4a',
      mime_type: 'audio/m4a',
      size_bytes: 180000,
      recorded_at: '2026-02-20T00:00:00.000Z',
    },
  });
  assert(voiceIntro?.voice_intro?.voice_intro_id, 'voice intro id missing');
  logStep('voice-intros', voiceIntro.voice_intro.voice_intro_id);

  const matchReq = await api('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: {
      availability_date: '2026-02-20',
      availability_slot: 'Today',
      vibe: 'Coffee',
      age_min: 22,
      age_max: 33,
      lat: 12.9716,
      lng: 77.5946,
      radius_km: 12,
      voice_duration_sec: 18,
      voice_intro_id: voiceIntro.voice_intro.voice_intro_id,
      voice_storage_url: voiceIntro.voice_intro.storage_url,
      voice_mime_type: voiceIntro.voice_intro.mime_type,
      voice_size_bytes: voiceIntro.voice_intro.size_bytes,
      voice_recorded_at: voiceIntro.voice_intro.recorded_at,
    },
  });
  assert(matchReq?.request?.request_id, 'match request id missing');
  assert(matchReq?.request?.sla_state, 'match request sla_state missing');
  assert(matchReq?.request?.matching_mode, 'match request matching_mode missing');
  logStep('match-requests', matchReq.request.status);

  const activeMatchReq = await api('/api/v1/match-requests/active', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert(activeMatchReq?.request?.request_id, 'active match request missing');
  assert(activeMatchReq?.request?.sla_state, 'active match request sla_state missing');
  logStep('match-requests/active', activeMatchReq.request.status);

  const cancelled = await api('/api/v1/match-requests/cancel-active', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
  });
  logStep('match-requests/cancel-active', cancelled?.cancelled_request_id || 'none');
  logStep('match-requests/requeue-wait-ms', String(REQUEUE_WAIT_MS));
  await sleep(REQUEUE_WAIT_MS);

  await api('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: {
      availability_date: '2026-02-20',
      availability_slot: 'Today',
      vibe: 'Coffee',
      age_min: 22,
      age_max: 33,
      lat: 12.9716,
      lng: 77.5946,
      radius_km: 12,
      voice_duration_sec: 18,
      voice_intro_id: voiceIntro.voice_intro.voice_intro_id,
      voice_storage_url: voiceIntro.voice_intro.storage_url,
      voice_mime_type: voiceIntro.voice_intro.mime_type,
      voice_size_bytes: voiceIntro.voice_intro.size_bytes,
      voice_recorded_at: voiceIntro.voice_intro.recorded_at,
    },
  });
  logStep('match-requests(requeue)', 'ok');

  const foundInitial = await api('/api/v1/meets/found', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  let meetId = foundInitial?.meet?.meet_id || null;
  if (!meetId) {
    assert(
      foundInitial?.meta?.strict_match_mode === true,
      'strict mode should return meta.strict_match_mode=true when no found meet'
    );
    logStep('meets/found(strict)', foundInitial?.meta?.active_request_status || 'none');

    for (let i = 0; i < 4 && !meetId; i += 1) {
      const seeded = await api('/api/v1/admin/matcher/seed-demo-group', {
        method: 'POST',
        headers: { 'x-admin-key': ADMIN_KEY },
        body: {
          anchor_user_id: meBefore.user_id,
          availability_slot: 'Today',
          vibe: 'Coffee',
          lat: 12.9716,
          lng: 77.5946,
        },
      });
      assert(seeded?.seeded_request_count >= 5, 'admin seed should create at least 5 requests');
      assert(seeded?.matched_request_count >= 1, 'admin seed should produce matched request(s)');
      logStep('admin/matcher/seed-demo-group', String(seeded.matched_request_count));

      for (let j = 0; j < 8 && !meetId; j += 1) {
        const foundAfterSeed = await api('/api/v1/meets/found', {
          headers: { authorization: `Bearer ${bearer}` },
        });
        meetId = foundAfterSeed?.meet?.meet_id || null;
        if (!meetId) {
          await sleep(500);
        }
      }
    }
  }
  assert(meetId, 'meets/found did not return meet_id');
  logStep('meets/found', meetId);

  const paymentIntent = await api(`/api/v1/meets/${encodeURIComponent(meetId)}/payment-intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert(paymentIntent?.payment?.status === 'PENDING', 'payment intent should be PENDING');
  logStep('meets/:id/payment-intent', paymentIntent.payment.status);

  const failedPayment = await api('/api/v1/payments/callback', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: { payment_id: paymentIntent.payment.payment_id, status: 'FAILED' },
  });
  assert(failedPayment?.payment?.status === 'FAILED', 'payment status should be FAILED');
  logStep('payments/callback(FAILED)', failedPayment.payment.status);

  const paymentIntent2 = await api(`/api/v1/meets/${encodeURIComponent(meetId)}/payment-intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert(paymentIntent2?.payment?.status === 'PENDING', 'payment intent2 should be PENDING');

  const confirmed = await api('/api/v1/payments/callback', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: { payment_id: paymentIntent2.payment.payment_id, status: 'CONFIRMED' },
  });
  assert(confirmed?.meet?.status === 'CONFIRMED', 'meet status should be CONFIRMED');
  logStep('payments/callback(CONFIRMED)', confirmed.payment.status);

  const active = await api('/api/v1/meets/active', {
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert(active?.meet?.meet_id === meetId, 'active meet id mismatch');
  logStep('meets/active', active.meet.status);

  const shared = await api(`/api/v1/meets/${encodeURIComponent(meetId)}/share-venue`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert(shared?.meet?.status === 'VENUE_SHARED', 'meet status should be VENUE_SHARED');
  logStep('meets/:id/share-venue', shared.meet.status);

  const fb = await api(`/api/v1/meets/${encodeURIComponent(meetId)}/feedback`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: { rating: 5, note: 'Smoke feedback' },
  });
  assert(fb?.feedback_id, 'feedback_id missing');
  logStep('meets/:id/feedback', fb.feedback_id);

  const blockedUserId = `participant_smoke_${Date.now()}`;
  const blocked = await api('/api/v1/users/block', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: { blocked_user_id: blockedUserId, reason: 'smoke-test' },
  });
  assert(blocked?.block_id, 'block_id missing');
  logStep('users/block', blocked.block_id);

  const unblocked = await api('/api/v1/users/unblock', {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: { blocked_user_id: blockedUserId },
  });
  assert(typeof unblocked?.removed_count === 'number', 'removed_count missing');
  logStep('users/unblock', String(unblocked.removed_count));

  const adminOverview = await api('/api/v1/admin/overview', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert(adminOverview?.counts, 'admin overview counts missing');
  logStep('admin/overview', 'ok');

  const dbStatus = await api('/api/v1/admin/db-status', {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  assert(dbStatus?.mode, 'db-status mode missing');
  assert(typeof dbStatus?.healthy === 'boolean', 'db-status healthy missing');
  logStep('admin/db-status', `${dbStatus.mode}:${dbStatus.healthy ? 'healthy' : 'unhealthy'}`);

  console.log('[smoke] all checks passed');
}

run().catch((error) => {
  console.error('[smoke] failed:', error?.message || error);
  process.exit(1);
});
