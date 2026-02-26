import { spawnSync } from 'node:child_process';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const SCENARIO_ID = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const SCENARIO_VIBE = `RF_${SCENARIO_ID}`;
const SCENARIO_DATE = '2030-01-02';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, options = {}) {
  const args = [
    '-s',
    '-X',
    options.method || 'GET',
    `${BASE_URL}${path}`,
    '-H',
    'content-type: application/json',
  ];
  const headers = options.headers || {};
  for (const [key, value] of Object.entries(headers)) {
    args.push('-H', `${key}: ${value}`);
  }
  if (options.body) {
    args.push('--data', JSON.stringify(options.body));
  }
  args.push('-w', '\n%{http_code}');

  const result = spawnSync('curl', args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  const output = String(result.stdout || '').trimEnd();
  const splitIndex = output.lastIndexOf('\n');
  const text = splitIndex >= 0 ? output.slice(0, splitIndex) : output;
  const statusCode = Number(splitIndex >= 0 ? output.slice(splitIndex + 1) : '0');
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 220)}`);
  }
  if (statusCode < 200 || statusCode >= 300 || payload?.success === false) {
    const err = new Error(`Request failed ${statusCode} ${path}: ${payload?.error?.message || text}`);
    err.status = statusCode;
    err.code = payload?.error?.code || null;
    err.retryAfterSec = Number(payload?.error?.retry_after_sec || 0);
    throw err;
  }
  return payload?.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiWithRetry(path, options = {}, maxAttempts = 4) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await api(path, options);
    } catch (error) {
      const isRateLimited =
        Number(error?.status) === 429 || String(error?.code || '').toUpperCase() === 'RATE_LIMITED';
      if (!isRateLimited || attempt >= maxAttempts) throw error;
      const waitMs = Math.max(2, Number(error?.retryAfterSec || 5)) * 1000;
      await sleep(waitMs);
    }
  }
  throw new Error(`Failed after ${maxAttempts} attempts: ${path}`);
}

function logStep(label, value) {
  console.log(`[refund-deadline] ${label}${value ? `: ${value}` : ''}`);
}

async function createUser(index) {
  const phone = String(
    Number(String(Date.now() + index).slice(-10)) + Math.floor(Math.random() * 10)
  ).slice(-10);
  const sim = await apiWithRetry('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: '+91', phone },
  });
  await apiWithRetry('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: sim.request_id },
  });
  const tokenData = await apiWithRetry('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: sim.request_id },
  });
  const token = tokenData.access_token;
  const userId = tokenData.user_id;
  const gender = index < 3 ? 'Male' : 'Female';
  await apiWithRetry('/api/v1/onboarding/profile', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      full_name: `Refund User ${index + 1}`,
      gender,
      age: 24 + (index % 5),
      profession: gender === 'Male' ? 'Engineer' : 'Designer',
    },
  });
  const voice = await apiWithRetry('/api/v1/voice-intros', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      voice_duration_sec: 18,
      local_uri: `file:///tmp/refund-${index}.m4a`,
      mime_type: 'audio/m4a',
      size_bytes: 180000,
      recorded_at: '2026-02-25T00:00:00.000Z',
    },
  });
  const intro = voice?.voice_intro;
  await apiWithRetry('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      availability_date: SCENARIO_DATE,
      availability_slot: 'Today',
      vibe: SCENARIO_VIBE,
      age_min: 22,
      age_max: 35,
      lat: 12.9716,
      lng: 77.5946,
      radius_km: 12,
      voice_duration_sec: 18,
      voice_intro_id: intro.voice_intro_id,
      voice_storage_url: intro.storage_url,
      voice_mime_type: intro.mime_type,
      voice_size_bytes: intro.size_bytes,
      voice_recorded_at: intro.recorded_at,
    },
  });
  return { token, userId };
}

async function waitForGroup(users, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshots = [];
    for (const user of users) {
      const req = await apiWithRetry('/api/v1/match-requests/active', {
        headers: { authorization: `Bearer ${user.token}` },
      });
      const found = await apiWithRetry('/api/v1/meets/found', {
        headers: { authorization: `Bearer ${user.token}` },
      });
      snapshots.push({
        userId: user.userId,
        matchedGroupId: req?.request?.matched_group_id || null,
        requestStatus: req?.request?.status || null,
        meetId: found?.meet?.meet_id || null,
      });
    }
    const allMatched = snapshots.every((s) => s.requestStatus === 'MATCHED' && s.matchedGroupId);
    const sameGroup = allMatched && new Set(snapshots.map((s) => s.matchedGroupId)).size === 1;
    const allMeets = snapshots.every((s) => Boolean(s.meetId));
    if (sameGroup && allMeets) {
      return {
        groupId: snapshots[0].matchedGroupId,
        byUser: snapshots.reduce((acc, item) => {
          acc[item.userId] = item;
          return acc;
        }, {}),
      };
    }
    await sleep(700);
  }
  throw new Error('Timed out waiting for group formation');
}

async function confirmMeet(user, meetId, suffix) {
  await apiWithRetry(`/api/v1/meets/${encodeURIComponent(meetId)}/payment-intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}` },
  });
  await apiWithRetry('/api/v1/payments/callback', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}` },
    body: {
      meet_id: meetId,
      status: 'CONFIRMED',
      receipt_id: `rcpt_refund_${suffix}`,
    },
  });
}

async function run() {
  logStep('base_url', BASE_URL);
  logStep('scenario_vibe', SCENARIO_VIBE);

  const health = await apiWithRetry('/health');
  assert(health?.status === 'ok', 'health check failed');
  logStep('health', 'ok');

  const users = [];
  for (let i = 0; i < 5; i += 1) {
    users.push(await createUser(i));
  }
  logStep('users-created', '5');

  const grouped = await waitForGroup(users);
  logStep('group-id', grouped.groupId);

  const committedUsers = users.slice(0, 2);
  const pendingUsers = users.slice(2);
  for (let i = 0; i < committedUsers.length; i += 1) {
    const user = committedUsers[i];
    const meetId = grouped.byUser[user.userId]?.meetId;
    assert(meetId, 'missing meet id');
    await confirmMeet(user, meetId, `${i}_${Date.now()}`);
  }
  logStep('committed-users', '2');

  await apiWithRetry(`/api/v1/admin/match-groups/${encodeURIComponent(grouped.groupId)}/expire-deadline`, {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  await sleep(1200);
  logStep('deadline-expired', 'ok');

  for (const user of committedUsers) {
    const cancelled = await apiWithRetry('/api/v1/meets/cancelled', {
      headers: { authorization: `Bearer ${user.token}` },
    });
    const list = Array.isArray(cancelled?.meets) ? cancelled.meets : [];
    assert(list.length >= 1, 'committed user expected cancelled meet');
    const top = list[0];
    assert(String(top?.status || '').toUpperCase() === 'CANCELLED', 'expected cancelled status');
    const feeStatus = String(top?.fee?.payment_status || '').toUpperCase();
    assert(feeStatus === 'REFUNDED', `expected REFUNDED, got ${feeStatus || 'none'}`);
  }
  logStep('refund-assertion', 'ok');

  for (const user of pendingUsers) {
    const cancelled = await apiWithRetry('/api/v1/meets/cancelled', {
      headers: { authorization: `Bearer ${user.token}` },
    });
    const list = Array.isArray(cancelled?.meets) ? cancelled.meets : [];
    assert(list.length >= 1, 'pending user expected cancelled meet');
    const top = list[0];
    assert(String(top?.status || '').toUpperCase() === 'CANCELLED', 'pending user cancelled status mismatch');
  }
  logStep('pending-cancelled', 'ok');

  console.log('[refund-deadline] all checks passed');
}

run().catch((error) => {
  console.error('[refund-deadline] failed:', error?.message || error);
  process.exit(1);
});

