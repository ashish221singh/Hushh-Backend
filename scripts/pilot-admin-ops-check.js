const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(label, value) {
  console.log(`[pilot-admin] ${label}${value ? `: ${value}` : ''}`);
}

async function request(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      'x-admin-key': ADMIN_KEY,
    },
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
  return payload?.data || {};
}

async function run() {
  logStep('base_url', BASE_URL);

  const groups = await request('/api/v1/admin/match-groups?committed_only=true&limit=20');
  const groupRows = groups?.groups || [];
  assert(Array.isArray(groupRows), 'match-groups payload missing');
  logStep('committed-groups', String(groupRows.length));

  if (groupRows.length > 0) {
    const sample = groupRows[0];
    assert(sample.group_id, 'group_id missing in match group');
    assert(Array.isArray(sample.members), 'members missing in match group');
    logStep('sample-group', sample.group_id);
  }

  const needsVenue = await request('/api/v1/admin/meets?status=NEEDS_VENUE&limit=20');
  const needsVenueRows = needsVenue?.meets || [];
  assert(Array.isArray(needsVenueRows), 'admin meets payload missing');
  logStep('meets-needing-venue', String(needsVenueRows.length));

  if (needsVenueRows.length > 0) {
    const sampleMeet = needsVenueRows[0];
    assert(sampleMeet.meet_id, 'meet_id missing in admin meet row');
    assert(Array.isArray(sampleMeet.participants), 'participants missing in admin meet row');
    logStep('sample-meet', sampleMeet.meet_id);
  }

  const queue = await request('/api/v1/admin/match-queue?limit=20');
  assert(queue?.counts && typeof queue.counts === 'object', 'match queue counts missing');
  logStep('queue-counts', `queued=${queue.counts.queued || 0}, matched=${queue.counts.matched || 0}`);

  console.log('[pilot-admin] all checks passed');
}

run().catch((error) => {
  console.error('[pilot-admin] failed:', error?.message || error);
  process.exit(1);
});
