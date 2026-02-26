import { spawnSync } from 'node:child_process';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const SCENARIO_ID = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const SCENARIO_VIBE = `QA_${SCENARIO_ID}`;
const SCENARIO_DATE = '2030-01-01';

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
  if (result.error) {
    throw result.error;
  }
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
    err.path = path;
    throw err;
  }
  return payload?.data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logStep(label, value) {
  console.log(`[commitment-threshold] ${label}${value ? `: ${value}` : ''}`);
}

async function apiWithRateLimitRetry(path, options = {}, maxAttempts = 4) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await api(path, options);
    } catch (error) {
      const isRateLimited =
        Number(error?.status) === 429 || String(error?.code || '').toUpperCase() === 'RATE_LIMITED';
      if (!isRateLimited || attempt >= maxAttempts) {
        throw error;
      }
      const retryAfter = Math.max(2, Number(error?.retryAfterSec || 5));
      const waitMs = retryAfter * 1000 + Math.floor(Math.random() * 600);
      logStep('rate-limit-retry', `${path} wait ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${maxAttempts})`);
      await sleep(waitMs);
    }
  }
  throw new Error(`Failed to call ${path} after ${maxAttempts} attempts`);
}

async function createUser(index) {
  const phone = String(
    Number(String(Date.now() + index).slice(-10)) + Math.floor(Math.random() * 10)
  ).slice(-10);

  const sim = await apiWithRateLimitRetry('/api/v1/auth/sim/request', {
    method: 'POST',
    body: { country_code: '+91', phone },
  });
  await apiWithRateLimitRetry('/api/v1/auth/sim/mock-verify', {
    method: 'POST',
    body: { request_id: sim.request_id },
  });
  const tokenData = await apiWithRateLimitRetry('/api/v1/auth/token', {
    method: 'POST',
    body: { request_id: sim.request_id },
  });
  const token = tokenData.access_token;
  const userId = tokenData.user_id;
  assert(token && userId, 'auth token missing');

  const gender = index < 3 ? 'Male' : 'Female';
  await apiWithRateLimitRetry('/api/v1/onboarding/profile', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      full_name: `Threshold User ${index + 1}`,
      gender,
      age: 25 + (index % 4),
      profession: gender === 'Male' ? 'Engineer' : 'Designer',
    },
  });

  const voice = await apiWithRateLimitRetry('/api/v1/voice-intros', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: {
      voice_duration_sec: 18,
      local_uri: `file:///tmp/threshold-${index}.m4a`,
      mime_type: 'audio/m4a',
      size_bytes: 180000,
      recorded_at: '2026-02-25T00:00:00.000Z',
    },
  });
  const intro = voice?.voice_intro;
  assert(intro?.voice_intro_id, 'voice intro id missing');

  await apiWithRateLimitRetry('/api/v1/match-requests', {
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

  return { token, userId, voiceIntro: intro, phone };
}

async function waitForGroup(users, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const snapshots = [];
    for (const user of users) {
      const req = await apiWithRateLimitRetry('/api/v1/match-requests/active', {
        headers: { authorization: `Bearer ${user.token}` },
      });
      const found = await apiWithRateLimitRetry('/api/v1/meets/found', {
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
    const sameGroup =
      allMatched &&
      new Set(snapshots.map((s) => s.matchedGroupId)).size === 1;
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
  throw new Error('Timed out waiting for all 5 users to be matched into one group');
}

async function confirmMeetForUser(user, meetId, receiptSuffix) {
  await apiWithRateLimitRetry(`/api/v1/meets/${encodeURIComponent(meetId)}/payment-intent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}` },
  });
  await apiWithRateLimitRetry('/api/v1/payments/callback', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}` },
    body: {
      meet_id: meetId,
      status: 'CONFIRMED',
      receipt_id: `rcpt_threshold_${receiptSuffix}`,
    },
  });
}

async function lookForAnother(user) {
  await apiWithRateLimitRetry('/api/v1/match-requests', {
    method: 'POST',
    headers: { authorization: `Bearer ${user.token}` },
    body: {
      look_for_another: true,
      skip_create: true,
      availability_slot: 'Today',
      vibe: SCENARIO_VIBE,
      age_min: 22,
      age_max: 35,
    },
  });
}

async function run() {
  logStep('base_url', BASE_URL);
  logStep('scenario_vibe', SCENARIO_VIBE);
  const health = await apiWithRateLimitRetry('/health');
  assert(health?.status === 'ok', 'health check failed');
  logStep('health', 'ok');

  const users = [];
  for (let i = 0; i < 5; i += 1) {
    users.push(await createUser(i));
  }
  logStep('users-created', '5');

  const grouped = await waitForGroup(users);
  logStep('group-id', grouped.groupId);

  const confirmUsers = users.slice(0, 3);
  const otherUsers = users.slice(3);

  for (let i = 0; i < confirmUsers.length; i += 1) {
    const user = confirmUsers[i];
    const meetId = grouped.byUser[user.userId]?.meetId;
    assert(meetId, 'missing meet id for commit user');
    await confirmMeetForUser(user, meetId, `${i}_${Date.now()}`);
  }
  await sleep(1200);

  for (const user of confirmUsers) {
    const active = await apiWithRateLimitRetry('/api/v1/meets/active', {
      headers: { authorization: `Bearer ${user.token}` },
    });
    assert(
      ['CONFIRMED', 'VENUE_SHARED'].includes(String(active?.meet?.status || '')),
      'expected committed users to move to CONFIRMED/VENUE_SHARED'
    );
  }
  logStep('>=3-commit-confirmed', 'ok');

  for (const user of otherUsers) {
    const found = await apiWithRateLimitRetry('/api/v1/meets/found', {
      headers: { authorization: `Bearer ${user.token}` },
    });
    assert(found?.meet?.status === 'FOUND', 'expected remaining users to stay FOUND while pending');
  }
  logStep('pending-users-still-found', 'ok');

  // Force viability below threshold for the remaining pending users:
  // committed users continue in their confirmed path, while pending users hit cancellation outcome.
  for (const user of confirmUsers) {
    await lookForAnother(user);
  }
  await sleep(1600);

  for (const user of otherUsers) {
    const cancelled = await apiWithRateLimitRetry('/api/v1/meets/cancelled', {
      headers: { authorization: `Bearer ${user.token}` },
    });
    const cancelledList = Array.isArray(cancelled?.meets) ? cancelled.meets : [];
    assert(cancelledList.length >= 1, 'expected cancelled meet after viability drop below threshold');
    const top = cancelledList[0];
    assert(String(top?.status || '').toUpperCase() === 'CANCELLED', 'cancelled feed status mismatch');
    const participants = Array.isArray(top?.participants) ? top.participants : [];
    assert(participants.length >= 1, 'cancelled meet should still include participant list');
    const hasCancelledStatus = participants.some(
      (p) => String(p?.status || '').toUpperCase() === 'CANCELLED'
    );
    assert(hasCancelledStatus, 'cancelled meet should include cancelled participant status');
  }
  logStep('<3-viability-cancelled', 'ok');
  logStep('cancelled-participant-status', 'ok');

  console.log('[commitment-threshold] all checks passed');
}

run().catch((error) => {
  console.error('[commitment-threshold] failed:', error?.message || error);
  process.exit(1);
});
