const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, value) {
  console.log(`[past-meets] ${label}${value ? `: ${value}` : ''}`);
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
    throw new Error(
      `Request failed ${res.status} ${path}: ${payload?.error?.message || text}`
    );
  }

  return payload?.data;
}

async function createSession() {
  const phone = String(
    Number(String(Date.now()).slice(-10)) + Math.floor(Math.random() * 10)
  ).slice(-10);

  const simReq = await request('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: '+91', phone },
  });
  assert(simReq?.request_id, 'sim request id missing');

  await request('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: simReq.request_id },
  });

  const tokenPayload = await request('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: simReq.request_id },
  });
  assert(tokenPayload?.access_token, 'access token missing');

  await request('/api/v1/onboarding/profile', {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
    body: {
      full_name: 'Past Meets QA',
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

function assertMeetShape(meet) {
  assert(meet?.meet_id, 'meet_id missing');
  assert(meet?.commitment, 'commitment missing');
  assert(
    Number.isInteger(Number(meet.commitment.total_members)),
    'commitment.total_members missing'
  );
  assert(
    Number.isInteger(Number(meet.commitment.committed_members)),
    'commitment.committed_members missing'
  );
  assert(
    Number.isInteger(Number(meet.commitment.pending_members)),
    'commitment.pending_members missing'
  );
  assert(
    Number.isInteger(Number(meet.commitment.cancelled_members)),
    'commitment.cancelled_members missing'
  );

  const statuses = new Set(['COMMITTED', 'PENDING', 'CANCELLED']);
  for (const p of meet?.participants || []) {
    assert(p?.participant_id, 'participant_id missing');
    assert(p?.name, 'participant name missing');
    assert(statuses.has(String(p.status || '').toUpperCase()), 'invalid participant status');
  }
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
      local_uri: 'file:///tmp/past-meets-intro.m4a',
      mime_type: 'audio/m4a',
      size_bytes: 190000,
      recorded_at: '2026-02-21T00:00:00.000Z',
    },
  });
  const voiceIntroId = voiceIntro?.voice_intro?.voice_intro_id;
  assert(voiceIntroId, 'voice intro id missing');

  await request('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
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
    },
  });
  logStep('match-request', 'created');

  await request('/api/v1/admin/matcher/seed-demo-group', {
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
  logStep('seed', 'ok');

  let found = null;
  for (let round = 0; round < 4 && !found; round += 1) {
    for (let i = 0; i < 16 && !found; i += 1) {
      const data = await request('/api/v1/meets/found', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (data?.meet?.meet_id) {
        found = data.meet;
        break;
      }
      await sleep(500);
    }
    if (!found) {
      await request('/api/v1/admin/matcher/seed-demo-group', {
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
      logStep('re-seed', `round-${round + 1}`);
    }
  }
  assert(found?.meet_id, 'found meet missing');
  assertMeetShape(found);
  logStep('found', found.meet_id);

  const confirmed = await request(`/api/v1/meets/${encodeURIComponent(found.meet_id)}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  assert(
    ['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(String(confirmed?.meet?.status || '')),
    'confirm returned unexpected meet status'
  );
  assert(
    String(confirmed?.meet?.fee?.payment_status || '').toUpperCase() === 'CONFIRMED',
    'confirm did not set payment CONFIRMED'
  );
  assertMeetShape(confirmed.meet);
  logStep('confirm', `${confirmed.meet.status} / payment:${confirmed.meet.fee.payment_status}`);

  const feedback = await request(`/api/v1/meets/${encodeURIComponent(found.meet_id)}/feedback`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { rating: 5, note: 'past meets qa' },
  });
  assert(feedback?.feedback_id, 'feedback_id missing');
  logStep('feedback', feedback.feedback_id);

  const past = await request('/api/v1/meets/past', {
    headers: { authorization: `Bearer ${token}` },
  });
  const pastMeets = Array.isArray(past?.meets) ? past.meets : [];
  assert(pastMeets.length >= 1, 'past meets should not be empty after feedback/archive');
  const target = pastMeets.find((m) => m.meet_id === found.meet_id);
  assert(target, 'archived meet missing from /meets/past');
  assertMeetShape(target);
  logStep('past-meets', String(pastMeets.length));

  console.log('[past-meets] all checks passed');
}

run().catch((error) => {
  console.error('[past-meets] failed:', error?.message || error);
  process.exit(1);
});
