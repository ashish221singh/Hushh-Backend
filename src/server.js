import http from 'http';
import { URL } from 'url';
import {
  closeStore,
  getStore,
  getStoreDiagnostics,
  initStore,
  mutateStore,
} from './store.js';
import {
  methodNotAllowed,
  normalizePhone,
  notFound,
  nowIso,
  parseJsonBody,
  randomId,
  randomSessionToken,
  randomToken,
  sendJson,
  toMs,
  validateProfileInput,
} from './utils.js';
import {
  buildVerificationSmsPayload,
  getSmsProviderName,
  normalizeInboundSmsPayload,
  normalizeSmsSenderPhone,
  verifySmsWebhookSignature,
} from './smsProvider.js';
import {
  buildPaymentIntentProviderMeta,
  getPaymentClientAction,
  getPaymentProviderName,
  normalizePaymentWebhookPayload,
  verifyPaymentWebhookSignature,
} from './paymentProvider.js';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${PORT}`;
const SIM_TOKEN_TTL_MINUTES = Number(process.env.SIM_TOKEN_TTL_MINUTES || 10);
const OTP_TTL_MINUTES = Number(process.env.OTP_TTL_MINUTES || 5);
const OTP_RESEND_SECONDS = Number(process.env.OTP_RESEND_SECONDS || 30);
const OTP_LENGTH = Number(process.env.OTP_LENGTH || 6);
const TOKEN_TTL_SECONDS = Number(process.env.TOKEN_TTL_SECONDS || 86400);
const AUTH_MODE = String(process.env.AUTH_MODE || 'firebase_otp').toLowerCase();
const ALLOW_OTP_FALLBACK = String(process.env.ALLOW_OTP_FALLBACK || 'false').toLowerCase() === 'true';
const FIREBASE_WEB_API_KEY = String(
  process.env.FIREBASE_WEB_API_KEY ||
  process.env.FIREBASE_API_KEY ||
  process.env.EXPO_PUBLIC_FIREBASE_API_KEY ||
  ''
).trim();
const FIREBASE_PROJECT_ID = String(process.env.FIREBASE_PROJECT_ID || '');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';
const PUSH_PROVIDER = String(process.env.PUSH_PROVIDER || 'expo').toLowerCase();
const EXPO_PUSH_API_URL = process.env.EXPO_PUSH_API_URL || 'https://exp.host/--/api/v2/push/send';
const EXPO_ACCESS_TOKEN = String(process.env.EXPO_ACCESS_TOKEN || '').trim();
const DEFAULT_COMMITMENT_FEE = 39900;
const COMMITMENT_RESPONSE_WINDOW_MINUTES = Number(
  process.env.COMMITMENT_RESPONSE_WINDOW_MINUTES || 30
);
const MATCH_GROUP_SIZE = 5;
const MATCHER_INTERVAL_MS = Number(process.env.MATCHER_INTERVAL_MS || 7000);
const MATCH_REQUEST_TTL_MINUTES = Number(process.env.MATCH_REQUEST_TTL_MINUTES || 360);
const MATCH_REQUEST_RETRY_COOLDOWN_SECONDS = Number(process.env.MATCH_REQUEST_RETRY_COOLDOWN_SECONDS || 8);
const MATCH_RELAXED_MIXED_AFTER_MINUTES = Number(
  process.env.MATCH_RELAXED_MIXED_AFTER_MINUTES || 8
);
const MATCH_RELAXED_ANY_AFTER_MINUTES = Number(
  process.env.MATCH_RELAXED_ANY_AFTER_MINUTES || 18
);
const MAX_SESSIONS_PER_USER = Number(process.env.MAX_SESSIONS_PER_USER || 3);
const IDEMPOTENCY_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_MS || 10 * 60 * 1000);
const ALLOW_FOUND_FALLBACK =
  String(process.env.ALLOW_FOUND_FALLBACK || 'false').toLowerCase() === 'true';
const DEV_MATCH_HELPERS_ENABLED =
  String(process.env.DEV_MATCH_HELPERS_ENABLED || 'false').toLowerCase() === 'true';
const ADMIN_MATCHER_SEED_ENABLED =
  String(process.env.ADMIN_MATCHER_SEED_ENABLED || 'false').toLowerCase() === 'true';

const DEFAULT_FOUND_PARTICIPANTS = [
  { id: 'mike', name: 'Mike, 26', subtitle: 'Tech & Hiking', initial: 'M' },
  { id: 'jessica', name: 'Jessica, 23', subtitle: 'Writer & Cafe', initial: 'J' },
  { id: 'sarah', name: 'Sarah, 24', subtitle: 'Designer', initial: 'S' },
];

let matcherRunning = false;
const rateLimitBuckets = new Map();
const idempotencyBuckets = new Map();
const pushDispatchInFlight = new Set();
const venuePushDispatchInFlight = new Set();

function cleanupExpiredIdempotencyEntries() {
  const now = Date.now();
  for (const [key, value] of idempotencyBuckets.entries()) {
    if (!value || value.expiresAt <= now) {
      idempotencyBuckets.delete(key);
    }
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function randomNumericOtp(size = 6) {
  let output = '';
  for (let i = 0; i < size; i += 1) {
    output += String(Math.floor(Math.random() * 10));
  }
  return output;
}

function isExpoPushToken(value) {
  const token = String(value || '').trim();
  return token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[');
}

function requireJsonObjectBody(res, body) {
  if (isPlainObject(body)) return true;
  sendJson(res, 400, {
    success: false,
    error: { code: 'VALIDATION_ERROR', message: 'Body must be a JSON object' },
  });
  return false;
}

function makeIdempotencyKey(pathname, rawKey) {
  if (!rawKey) return null;
  const cleaned = String(rawKey).trim();
  if (!cleaned) return null;
  return `idem:${pathname}:${cleaned}`;
}

function getCachedIdempotentResponse(pathname, rawKey) {
  cleanupExpiredIdempotencyEntries();
  const key = makeIdempotencyKey(pathname, rawKey);
  if (!key) return null;
  return idempotencyBuckets.get(key)?.response || null;
}

function setCachedIdempotentResponse(pathname, rawKey, status, payload) {
  const key = makeIdempotencyKey(pathname, rawKey);
  if (!key || !payload) return;
  idempotencyBuckets.set(key, {
    response: { status, payload },
    expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
  });
}

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(bucketKey, limit, windowMs) {
  const now = Date.now();
  const existing = rateLimitBuckets.get(bucketKey);
  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (existing.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  existing.count += 1;
  return { allowed: true };
}

function enforceRouteRateLimit(req, res, pathname) {
  const ip = getClientIp(req);
  const token = getBearerToken(req) || 'anon';

  const rules = [
    {
      when: req.method === 'POST' && pathname === '/api/v1/auth/sim/request',
      key: `rl:sim_request:ip:${ip}`,
      limit: 8,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/auth/token',
      key: `rl:auth_token:ip:${ip}`,
      limit: 12,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/auth/otp/request',
      key: `rl:auth_otp_request:ip:${ip}`,
      limit: 10,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/auth/otp/verify',
      key: `rl:auth_otp_verify:ip:${ip}`,
      limit: 25,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/auth/firebase/token',
      key: `rl:auth_firebase_token:ip:${ip}`,
      limit: 20,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'GET' && pathname === '/api/v1/auth/sim/status',
      key: `rl:sim_status:ip:${ip}`,
      limit: 150,
      windowMs: 5 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/match-requests',
      key: `rl:match_requests:token:${token}`,
      limit: 20,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/payments/callback',
      key: `rl:payments_callback:ip:${ip}`,
      limit: 60,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: req.method === 'POST' && pathname === '/api/v1/payments/webhook',
      key: `rl:payments_webhook:ip:${ip}`,
      limit: 120,
      windowMs: 10 * 60 * 1000,
    },
    {
      when: pathname.startsWith('/api/v1/admin/'),
      key: `rl:admin:ip:${ip}`,
      limit: 180,
      windowMs: 5 * 60 * 1000,
    },
  ];

  for (const rule of rules) {
    if (!rule.when) continue;
    const verdict = checkRateLimit(rule.key, rule.limit, rule.windowMs);
    if (verdict.allowed) return true;
    return sendJson(res, 429, {
      success: false,
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Please retry shortly.',
        retry_after_sec: verdict.retryAfterSec,
      },
    });
  }
  return true;
}

function withAdmin(req, res) {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== ADMIN_KEY) {
    sendJson(res, 401, {
      success: false,
      error: {
        code: 'UNAUTHORIZED_ADMIN',
        message: 'Invalid admin key',
      },
    });
    return false;
  }
  return true;
}

function addRequestLog(entry) {
  mutateStore((draft) => {
    const next = draft.requestLogs || [];
    next.push(entry);
    if (next.length > 400) {
      next.splice(0, next.length - 400);
    }
    draft.requestLogs = next;
  });
}

function collectAdminOverview() {
  const store = getStore();
  const users = Object.values(store.users || {});
  const sessions = Object.values(store.sessions || {});
  const verificationRequests = Object.values(store.verificationRequests || {});
  const meets = Object.values(store.meets || {});
  const payments = Object.values(store.payments || {});
  const feedback = Object.values(store.feedback || {});
  const blockedUsers = Object.values(store.blockedUsers || {});
  const matchRequests = Object.values(store.matchRequests || {});
  const matchGroups = Object.values(store.matchGroups || {});
  const requestLogs = store.requestLogs || [];

  const failedLogs = requestLogs
    .filter((item) => Number(item.status_code) >= 400 || item.error)
    .slice(-100)
    .reverse();
  const totalRequests = requestLogs.length;
  const failedRequests = requestLogs.filter(
    (item) => Number(item.status_code) >= 400 || item.error
  ).length;
  const failureRatePct = totalRequests
    ? Number(((failedRequests / totalRequests) * 100).toFixed(2))
    : 0;

  const failuresByPath = {};
  failedLogs.forEach((item) => {
    const key = String(item.path || 'unknown');
    failuresByPath[key] = (failuresByPath[key] || 0) + 1;
  });

  const statuses = verificationRequests.reduce(
    (acc, item) => {
      const key = item.status || 'UNKNOWN';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    },
    {}
  );

  const latestRequestByUser = {};
  matchRequests
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .forEach((req) => {
      if (!latestRequestByUser[req.userId]) {
        latestRequestByUser[req.userId] = req;
      }
    });

  const usersPayload = users.map((u) => {
    const req = latestRequestByUser[u.userId] || null;
    const hasPreferencePayload = Boolean(
      req &&
      req.availabilitySlot &&
      req.vibe &&
      req.ageMin != null &&
      req.ageMax != null &&
      req.lat != null &&
      req.lng != null &&
      req.voiceDurationSec != null &&
      req.voiceDurationSec >= 15 &&
      req.voiceStorageUrl
    );
    return {
      user_id: u.userId,
      phone: `${u.countryCode || ''}${u.phone || ''}`,
      created_at: u.createdAt,
      onboarding_completed: !!u.profile?.onboardingCompleted,
      preference_data_received: hasPreferencePayload,
      latest_preference: req
        ? {
            request_id: req.requestId,
            status: req.status,
            availability_slot: req.availabilitySlot,
            availability_date: req.availabilityDate,
            vibe: req.vibe,
            age_min: req.ageMin,
            age_max: req.ageMax,
            lat: req.lat,
            lng: req.lng,
            radius_km: req.radiusKm,
            voice_duration_sec: req.voiceDurationSec,
            voice_intro_id: req.voiceIntroId || null,
            voice_storage_url: req.voiceStorageUrl || null,
            voice_mime_type: req.voiceMimeType || null,
            voice_size_bytes: req.voiceSizeBytes ?? null,
            voice_recorded_at: req.voiceRecordedAt || null,
            updated_at: req.updatedAt,
          }
        : null,
      profile: u.profile
        ? {
            full_name: u.profile.fullName,
            gender: u.profile.gender,
            age: u.profile.age,
            profession: u.profile.profession,
            updated_at: u.profile.updatedAt,
          }
        : null,
    };
  });

  const usersWithPreferences = usersPayload.filter((u) => u.preference_data_received).length;

  return {
    counts: {
      users: users.length,
      users_with_preferences: usersWithPreferences,
      active_sessions: sessions.length,
      verification_requests: verificationRequests.length,
      meets: meets.length,
      payments: payments.length,
      feedback: feedback.length,
      blocked_users: blockedUsers.length,
      match_requests: matchRequests.length,
      match_groups: matchGroups.length,
      total_requests: totalRequests,
      failed_requests: failedRequests,
      failure_rate_pct: failureRatePct,
      verification_status_breakdown: statuses,
    },
    users: usersPayload,
    recent_logs: requestLogs.slice(-50).reverse(),
    recent_failed_logs: failedLogs.slice(0, 50),
    failure_breakdown_by_path: Object.entries(failuresByPath)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([path, count]) => ({ path, count })),
  };
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  const [, token] = auth.match(/^Bearer\s+(.+)$/i) || [];
  return token || null;
}

function getSession(req) {
  const token = getBearerToken(req);
  if (!token) return null;
  const store = getStore();
  const session = store.sessions[token];
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    mutateStore((draft) => {
      delete draft.sessions[token];
    });
    return null;
  }
  return { token, ...session };
}

function withAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, {
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid access token',
      },
    });
    return null;
  }
  return session;
}

function issueSessionForNormalizedPhone({
  normalizedPhone,
  countryCode,
  phone,
  requestId = null,
}) {
  const store = getStore();
  let userId = store.phoneToUserId[normalizedPhone];
  if (!userId) {
    userId = randomId('user');
  }

  const token = randomSessionToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString();

  mutateStore((draft) => {
    if (!draft.users[userId]) {
      draft.users[userId] = {
        userId,
        countryCode,
        phone,
        normalizedPhone,
        createdAt: nowIso(),
        profile: null,
      };
    }

    draft.phoneToUserId[normalizedPhone] = userId;
    draft.sessions[token] = {
      userId,
      requestId,
      issuedAt: nowIso(),
      expiresAt,
    };

    const sessionsForUser = Object.entries(draft.sessions || {})
      .filter(([, item]) => item.userId === userId)
      .sort(
        (a, b) =>
          new Date(b[1].issuedAt || 0).getTime() - new Date(a[1].issuedAt || 0).getTime()
      );
    sessionsForUser.slice(MAX_SESSIONS_PER_USER).forEach(([oldToken]) => {
      delete draft.sessions[oldToken];
    });
  });

  return { token, expiresAt, userId };
}

function splitE164PhoneNumber(e164Value) {
  const e164 = String(e164Value || '').trim();
  if (!e164.startsWith('+')) return null;
  const digits = e164.replace(/\D/g, '');
  if (!digits) return null;

  if (e164.startsWith('+91') && digits.length >= 12) {
    return { countryCode: '+91', phone: digits.slice(-10) };
  }

  const phone = digits.length > 10 ? digits.slice(-10) : digits;
  const ccDigits = digits.slice(0, digits.length - phone.length);
  const countryCode = ccDigits ? `+${ccDigits}` : '+91';
  return { countryCode, phone };
}

async function verifyFirebaseIdTokenAndGetUser(idToken) {
  if (!FIREBASE_WEB_API_KEY) {
    const err = new Error('Firebase API key not configured (set FIREBASE_WEB_API_KEY)');
    err.code = 'FIREBASE_NOT_CONFIGURED';
    throw err;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: idToken }),
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(payload?.error?.message || 'Firebase token verification failed');
    err.code = 'FIREBASE_TOKEN_INVALID';
    throw err;
  }
  const user = Array.isArray(payload?.users) ? payload.users[0] : null;
  if (!user?.phoneNumber) {
    const err = new Error('Firebase user phone number not available');
    err.code = 'FIREBASE_PHONE_MISSING';
    throw err;
  }
  if (FIREBASE_PROJECT_ID) {
    const issuer = String(user?.providerUserInfo?.[0]?.federatedId || '');
    if (issuer && !issuer.includes(FIREBASE_PROJECT_ID)) {
      const err = new Error('Firebase project mismatch');
      err.code = 'FIREBASE_PROJECT_MISMATCH';
      throw err;
    }
  }
  return {
    localId: String(user.localId || '').trim() || null,
    phoneNumber: String(user.phoneNumber || '').trim(),
  };
}

function createDefaultMeetForUser(userId) {
  const meetId = randomId('meet');
  const participantIds = DEFAULT_FOUND_PARTICIPANTS.map(() => randomId('mp'));

  const deadlineAt = new Date(
    Date.now() + COMMITMENT_RESPONSE_WINDOW_MINUTES * 60 * 1000
  ).toISOString();
  mutateStore((draft) => {
    if (!draft.meets) draft.meets = {};
    if (!draft.meetParticipants) draft.meetParticipants = {};
    draft.meets[meetId] = {
      meetId,
      ownerUserId: userId,
      status: 'FOUND',
      topicLabel: 'Sunday Crowd',
      matchTimeLabel: 'Tomorrow, 6 PM.',
      participantIds,
      venueName: null,
      venueAddress: null,
      venueLat: null,
      venueLng: null,
      venueManagerName: null,
      venuePhone: null,
      hostReview: null,
      venueHidden: true,
      venueShareEtaMins: 30,
      commitmentFeePaise: DEFAULT_COMMITMENT_FEE,
      commitmentDeadlineAt: deadlineAt,
      paymentStatus: 'PENDING',
      paymentId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    DEFAULT_FOUND_PARTICIPANTS.forEach((item, index) => {
      const participantId = participantIds[index];
      draft.meetParticipants[participantId] = {
        participantId,
        meetId,
        userId: null,
        name: item.name,
        subtitle: item.subtitle,
        initial: item.initial,
        createdAt: nowIso(),
      };
    });
  });

  return meetId;
}

function getUserMeets(userId) {
  const store = getStore();
  return Object.values(store.meets || {})
    .filter((meet) => meet.ownerUserId === userId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function formatMeetPayload(meet, store) {
  if (!meet) return null;
  const commitmentDeadlineAt =
    meet.commitmentDeadlineAt ||
    new Date(
      new Date(meet.createdAt).getTime() + COMMITMENT_RESPONSE_WINDOW_MINUTES * 60 * 1000
    ).toISOString();
  const commitmentExpired = new Date(commitmentDeadlineAt).getTime() <= Date.now();

  const participantContext = getMeetParticipantContext(store, meet);
  const participants = participantContext.participants;

  const payment = meet.paymentId ? store.payments?.[meet.paymentId] : null;
  const fee = {
    amount: Number((meet.commitmentFeePaise || 0) / 100).toFixed(2),
    amount_paise: meet.commitmentFeePaise || 0,
    currency: 'INR',
    payment_status: meet.paymentStatus || 'PENDING',
    receipt: payment
      ? {
          payment_id: payment.paymentId,
          receipt_id: payment.receiptId,
          confirmed_at: payment.confirmedAt,
        }
      : null,
  };

  return {
    meet_id: meet.meetId,
    status: meet.status,
    topic_label: meet.topicLabel,
    match_time_label: meet.matchTimeLabel,
    participants,
    venue: {
      is_hidden: !!meet.venueHidden,
      share_eta_mins: meet.venueShareEtaMins ?? null,
      name: meet.venueName,
      address: meet.venueAddress,
      lat: meet.venueLat ?? null,
      lng: meet.venueLng ?? null,
      manager_name: meet.venueManagerName || null,
      phone: meet.venuePhone || null,
    },
    host_review: meet.hostReview || null,
    fee,
    commitment: {
      response_window_mins: COMMITMENT_RESPONSE_WINDOW_MINUTES,
      deadline_at: commitmentDeadlineAt,
      is_expired: commitmentExpired,
      total_members: participantContext.summary.total_members,
      committed_members: participantContext.summary.committed_members,
      pending_members: participantContext.summary.pending_members,
      cancelled_members: participantContext.summary.cancelled_members,
    },
    updated_at: meet.updatedAt,
  };
}

function isCommitmentExpired(meet) {
  const deadlineAt =
    meet?.commitmentDeadlineAt ||
    new Date(
      new Date(meet?.createdAt || nowIso()).getTime() +
        COMMITMENT_RESPONSE_WINDOW_MINUTES * 60 * 1000
    ).toISOString();
  return new Date(deadlineAt).getTime() <= Date.now();
}

function ensureMeetCommitmentDeadline(draft, meetId) {
  const meet = draft.meets?.[meetId];
  if (!meet) return null;
  if (meet.commitmentDeadlineAt) return meet.commitmentDeadlineAt;
  const deadlineAt = new Date(
    Date.now() + COMMITMENT_RESPONSE_WINDOW_MINUTES * 60 * 1000
  ).toISOString();
  meet.commitmentDeadlineAt = deadlineAt;
  meet.updatedAt = nowIso();
  return deadlineAt;
}

function normalizePaymentStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (['PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED', 'REFUNDED'].includes(normalized)) {
    return normalized;
  }
  return null;
}

function formatPaymentPayload(payment) {
  if (!payment) return null;
  return {
    payment_id: payment.paymentId,
    meet_id: payment.meetId,
    user_id: payment.userId,
    amount_paise: payment.amountPaise,
    amount: Number((payment.amountPaise || 0) / 100).toFixed(2),
    currency: payment.currency || 'INR',
    status: payment.status,
    receipt_id: payment.receiptId,
    confirmed_at: payment.confirmedAt || null,
    updated_at: payment.updatedAt,
  };
}

function ensurePendingPaymentIntent(draft, meetId, userId) {
  if (!draft.payments) draft.payments = {};
  if (!draft.meets?.[meetId]) return null;

  const meet = draft.meets[meetId];
  const now = nowIso();
  const paymentId = meet.paymentId || randomId('pay');
  const existing = draft.payments[paymentId];
  const receiptId = existing?.receiptId || `rcpt_${String(paymentId).replace(/^pay_/, '')}`;
  const amountPaise = meet.commitmentFeePaise || DEFAULT_COMMITMENT_FEE;

  draft.payments[paymentId] = {
    paymentId,
    meetId,
    userId,
    amountPaise,
    currency: 'INR',
    status: 'PENDING',
    receiptId,
    confirmedAt: existing?.confirmedAt || now,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  meet.paymentId = paymentId;
  meet.paymentStatus = 'PENDING';
  meet.updatedAt = now;
  return draft.payments[paymentId];
}

function applyPaymentStatusUpdate(draft, paymentId, nextStatus, meta = {}) {
  if (!draft.payments?.[paymentId]) return null;
  const payment = draft.payments[paymentId];
  const meet = draft.meets?.[payment.meetId];
  const now = nowIso();

  payment.status = nextStatus;
  if (meta.receiptId) payment.receiptId = String(meta.receiptId);
  payment.confirmedAt = nextStatus === 'CONFIRMED' ? now : payment.confirmedAt || now;
  payment.updatedAt = now;

  if (meet) {
    meet.paymentId = paymentId;
    meet.paymentStatus = nextStatus;
    if (nextStatus === 'CONFIRMED') {
      meet.status = 'CONFIRMED';
    } else if (['FAILED', 'CANCELLED', 'REFUNDED'].includes(nextStatus)) {
      if (meet.status !== 'VENUE_SHARED') {
        meet.status = 'FOUND';
      }
      if (nextStatus === 'REFUNDED') {
        meet.venueHidden = true;
        meet.venueShareEtaMins = 30;
      }
    }
    meet.updatedAt = now;
  }

  return { payment, meet };
}

function parseNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeVenuePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length > 10) return `+${digits}`;
  return digits;
}

function isoDateFromSlot(slot) {
  const now = new Date();
  const d = new Date(now);
  const normalized = String(slot || '').toLowerCase();
  if (normalized === 'tomorrow') {
    d.setDate(d.getDate() + 1);
  } else if (normalized === 'this weekend') {
    const day = d.getDay(); // 0=Sun, 6=Sat
    const add = day === 6 ? 0 : day === 0 ? 6 : 6 - day;
    d.setDate(d.getDate() + add);
  }
  return d.toISOString().slice(0, 10);
}

function getUserGender(user) {
  const g = String(user?.profile?.gender || '').trim().toLowerCase();
  if (g === 'male') return 'male';
  if (g === 'female') return 'female';
  return 'other';
}

function getLatestRequestForUser(store, userId) {
  return Object.values(store.matchRequests || {})
    .filter((r) => r.userId === userId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;
}

function getLatestActiveRequestForUser(store, userId) {
  return (
    Object.values(store.matchRequests || {})
      .filter((r) => r.userId === userId && (r.status === 'QUEUED' || r.status === 'MATCHED'))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
  );
}

function getLatestMatchedRequestWithGroupForUser(store, userId) {
  return (
    Object.values(store.matchRequests || {})
      .filter((r) => r.userId === userId && r.status === 'MATCHED' && r.matchedGroupId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
  );
}

function getLatestMatchedRequestForUserInGroup(store, userId, groupId) {
  return (
    Object.values(store.matchRequests || {})
      .filter(
        (r) =>
          r.userId === userId &&
          r.status === 'MATCHED' &&
          String(r.matchedGroupId || '') === String(groupId || '')
      )
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
  );
}

function getOpenMeetForUserAndGroup(store, userId, groupId) {
  const matchedReq = getLatestMatchedRequestForUserInGroup(store, userId, groupId);
  const threshold = matchedReq?.createdAt ? new Date(matchedReq.createdAt).getTime() : null;
  return (
    Object.values(store.meets || {})
      .filter((m) => m.ownerUserId === userId)
      .filter((m) => ['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(String(m.status || '')))
      .filter((m) => (threshold ? new Date(m.createdAt).getTime() >= threshold : true))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null
  );
}

function findGroupIdForMeet(store, meet) {
  const ownerRequests = Object.values(store.matchRequests || {})
    .filter((r) => r.userId === meet.ownerUserId && r.matchedGroupId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  if (!ownerRequests.length) return null;
  const meetTs = new Date(meet.createdAt).getTime();
  const aligned = ownerRequests.find(
    (r) => Math.abs(new Date(r.createdAt).getTime() - meetTs) <= 5 * 60 * 1000
  );
  return (aligned || ownerRequests[0])?.matchedGroupId || null;
}

function getMeetParticipantContext(store, meet) {
  const groupId = findGroupIdForMeet(store, meet);
  if (!groupId) {
    const fallbackParticipants = (meet.participantIds || [])
      .map((id) => store.meetParticipants?.[id])
      .filter(Boolean)
      .map((item) => ({
        participant_id: item.participantId,
        user_id: item.userId || null,
        name: item.name,
        subtitle: item.subtitle,
        initial: item.initial,
        status: 'PENDING',
        is_owner: false,
      }));
    return {
      participants: fallbackParticipants,
      summary: {
        total_members: fallbackParticipants.length + 1,
        committed_members: 1,
        pending_members: fallbackParticipants.length,
        cancelled_members: 0,
      },
    };
  }

  const members = Object.values(store.matchGroupMembers || {})
    .filter((m) => m.groupId === groupId)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let committed = 0;
  let pending = 0;
  let cancelled = 0;
  const participants = [];

  members.forEach((member) => {
    const user = store.users?.[member.userId];
    const req = store.matchRequests?.[member.requestId];
    const openMeet = getOpenMeetForUserAndGroup(store, member.userId, groupId);
    let status = 'PENDING';
    if (String(req?.status || '').toUpperCase() === 'CANCELLED') {
      status = 'CANCELLED';
      cancelled += 1;
    } else if (
      String(openMeet?.paymentStatus || '').toUpperCase() === 'CONFIRMED' ||
      ['CONFIRMED', 'VENUE_SHARED'].includes(String(openMeet?.status || ''))
    ) {
      status = 'COMMITTED';
      committed += 1;
    } else {
      pending += 1;
    }

    const isOwner = member.userId === meet.ownerUserId;
    if (!isOwner) {
      const profileName = user?.profile?.fullName || null;
      participants.push({
        participant_id: member.memberId,
        user_id: member.userId || null,
        name:
          profileName && user?.profile?.age != null
            ? `${profileName}, ${user.profile.age}`
            : profileName || 'Member',
        subtitle: user?.profile?.profession || 'Member',
        initial:
          String(profileName || 'M')
            .trim()
            .charAt(0)
            .toUpperCase() || 'M',
        status,
        is_owner: false,
      });
    }
  });

  return {
    participants,
    summary: {
      total_members: members.length || participants.length + 1,
      committed_members: committed,
      pending_members: pending,
      cancelled_members: cancelled,
    },
  };
}

function serializeMatchRequest(store, request) {
  if (!request) return null;
  const ageMinutes = requestAgeMinutes(request);
  const matchingMode = getMatchingModeByAgeMinutes(ageMinutes);
  const slaState = getRequestSlaState(store, request);
  const members = request.matchedGroupId
    ? Object.values(store.matchGroupMembers || {})
        .filter((m) => m.groupId === request.matchedGroupId)
        .map((m) => {
          const u = store.users[m.userId];
          return {
            user_id: m.userId,
            name: u?.profile?.fullName || 'Unknown',
            gender: u?.profile?.gender || null,
            age: u?.profile?.age || null,
            profession: u?.profile?.profession || null,
          };
        })
    : [];
  return {
    request_id: request.requestId,
    status: request.status,
    sla_state: slaState,
    matching_mode: request.status === 'QUEUED' ? matchingMode : null,
    score: request.score ?? null,
    matched_group_id: request.matchedGroupId || null,
    availability_date: request.availabilityDate,
    availability_slot: request.availabilitySlot,
    vibe: request.vibe,
    age_min: request.ageMin,
    age_max: request.ageMax,
    lat: request.lat,
    lng: request.lng,
    radius_km: request.radiusKm,
    voice_duration_sec: request.voiceDurationSec,
    voice_intro_id: request.voiceIntroId || null,
    voice_storage_url: request.voiceStorageUrl || null,
    voice_mime_type: request.voiceMimeType || null,
    voice_size_bytes: request.voiceSizeBytes ?? null,
    voice_recorded_at: request.voiceRecordedAt || null,
    members,
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  };
}

function cancelLatestQueuedRequestForUser(draft, userId, reason = 'superseded') {
  const latest = Object.values(draft.matchRequests || {})
    .filter((r) => r.userId === userId && (r.status === 'QUEUED' || r.status === 'MATCHED'))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (!latest) return null;
  latest.status = 'CANCELLED';
  latest.updatedAt = nowIso();
  addMatchEvent(draft, {
    requestId: latest.requestId,
    type: 'CANCELLED',
    message: `Match request cancelled (${reason})`,
  });
  return latest;
}

function archiveOpenMeetsForUser(draft, userId, reason = 'superseded') {
  if (!draft.meets) return 0;
  let count = 0;
  for (const meet of Object.values(draft.meets)) {
    if (
      meet.ownerUserId === userId &&
      ['FOUND'].includes(meet.status)
    ) {
      meet.status = 'ARCHIVED';
      meet.updatedAt = nowIso();
      count += 1;
    }
  }
  return count;
}

function addMatchEvent(draft, { requestId = null, groupId = null, type, message = null, payload = null }) {
  if (!draft.matchEvents) draft.matchEvents = {};
  const eventId = randomId('mevt');
  draft.matchEvents[eventId] = {
    eventId,
    requestId,
    groupId,
    type,
    message,
    payload: payload ? JSON.stringify(payload) : null,
    createdAt: nowIso(),
  };
}

function getLastMatchEvent(store, requestId, type) {
  const events = Object.values(store.matchEvents || {})
    .filter((e) => e.requestId === requestId && (!type || e.type === type))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return events[0] || null;
}

function shouldEmitNoMatchEvent(store, requestId, reason) {
  const last = getLastMatchEvent(store, requestId, 'NO_MATCH');
  if (!last) return true;
  const lastReason = String(last.message || '');
  const ageMs = Date.now() - new Date(last.createdAt).getTime();
  if (lastReason !== reason) return true;
  return ageMs > 60_000;
}

function markExpiredQueuedRequests() {
  const ttlMs = MATCH_REQUEST_TTL_MINUTES * 60 * 1000;
  mutateStore((draft) => {
    Object.values(draft.matchRequests || {}).forEach((req) => {
      if (req.status !== 'QUEUED') return;
      const ageMs = Date.now() - new Date(req.createdAt).getTime();
      if (ageMs > ttlMs) {
        req.status = 'EXPIRED';
        req.updatedAt = nowIso();
        addMatchEvent(draft, {
          requestId: req.requestId,
          groupId: req.matchedGroupId || null,
          type: 'EXPIRED',
          message: 'Match request expired by TTL',
        });
      }
    });
  });
}

function areUsersBlocked(store, userAId, userBId) {
  const blocks = Object.values(store.blockedUsers || {});
  return blocks.some(
    (item) =>
      (item.userId === userAId && item.blockedUserId === userBId) ||
      (item.userId === userBId && item.blockedUserId === userAId)
  );
}

function hasAgeOverlap(a, b) {
  if (a.ageMin == null || a.ageMax == null || b.ageMin == null || b.ageMax == null) return true;
  return Math.max(a.ageMin, b.ageMin) <= Math.min(a.ageMax, b.ageMax);
}

function distanceKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v == null)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const aa =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));
}

function hardCompatible(store, reqA, reqB) {
  if (reqA.userId === reqB.userId) return false;
  const userA = store.users[reqA.userId];
  const userB = store.users[reqB.userId];
  if (!userA?.profile || !userB?.profile) return false;
  if (getUserGender(userA) === 'other' || getUserGender(userB) === 'other') return false;
  if (areUsersBlocked(store, reqA.userId, reqB.userId)) return false;
  if (reqA.availabilityDate && reqB.availabilityDate && reqA.availabilityDate !== reqB.availabilityDate) return false;
  if (reqA.availabilitySlot && reqB.availabilitySlot && reqA.availabilitySlot !== reqB.availabilitySlot) return false;
  if (reqA.vibe && reqB.vibe && reqA.vibe !== reqB.vibe) return false;
  if (!hasAgeOverlap(reqA, reqB)) return false;

  const dist = distanceKm(reqA.lat, reqA.lng, reqB.lat, reqB.lng);
  if (dist != null) {
    const radiusA = reqA.radiusKm || 10;
    const radiusB = reqB.radiusKm || 10;
    if (dist > Math.min(radiusA, radiusB)) return false;
  }
  return true;
}

function compatibilityScore(store, reqA, reqB) {
  let score = 100;
  if (reqA.vibe && reqB.vibe && reqA.vibe !== reqB.vibe) score -= 25;
  const dist = distanceKm(reqA.lat, reqA.lng, reqB.lat, reqB.lng);
  if (dist != null) score -= Math.min(30, dist * 2);
  const overlap =
    reqA.ageMin != null && reqA.ageMax != null && reqB.ageMin != null && reqB.ageMax != null
      ? Math.min(reqA.ageMax, reqB.ageMax) - Math.max(reqA.ageMin, reqB.ageMin)
      : 8;
  score += Math.max(0, Math.min(12, overlap));
  return Math.max(0, Number(score.toFixed(2)));
}

function hasValidGenderRatio(store, requests) {
  let female = 0;
  let male = 0;
  for (const req of requests) {
    const g = getUserGender(store.users[req.userId]);
    if (g === 'female') female += 1;
    if (g === 'male') male += 1;
  }
  return (female === 2 && male === 3) || (female === 3 && male === 2);
}

function hasMixedGender(store, requests) {
  let female = 0;
  let male = 0;
  for (const req of requests) {
    const g = getUserGender(store.users[req.userId]);
    if (g === 'female') female += 1;
    if (g === 'male') male += 1;
  }
  return female >= 1 && male >= 1;
}

function getMatchingModeByAgeMinutes(ageMinutes) {
  if (ageMinutes < MATCH_RELAXED_MIXED_AFTER_MINUTES) return 'STRICT';
  if (ageMinutes < MATCH_RELAXED_ANY_AFTER_MINUTES) return 'RELAXED_MIXED';
  return 'RELAXED_ANY';
}

function isGroupValidForMode(store, requests, mode) {
  if (mode === 'STRICT') return hasValidGenderRatio(store, requests);
  if (mode === 'RELAXED_MIXED') return hasMixedGender(store, requests);
  return true; // RELAXED_ANY
}

function getRequestSlaState(store, request) {
  if (!request) return null;
  if (request.status === 'MATCHED') return 'MATCHED';
  if (request.status === 'CANCELLED') return 'CANCELLED';
  if (request.status === 'EXPIRED') return 'EXPIRED';
  if (request.status !== 'QUEUED') return request.status || 'UNKNOWN';

  const lastNoMatch = getLastMatchEvent(store, request.requestId, 'NO_MATCH');
  return lastNoMatch ? 'NO_MATCH_RETRYING' : 'SEARCHING';
}

function combinationsOfSize(items, size) {
  const out = [];
  const cur = [];
  function dfs(start) {
    if (cur.length === size) {
      out.push([...cur]);
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      cur.push(items[i]);
      dfs(i + 1);
      cur.pop();
    }
  }
  dfs(0);
  return out;
}

function allPairwiseCompatible(store, requests) {
  for (let i = 0; i < requests.length; i += 1) {
    for (let j = i + 1; j < requests.length; j += 1) {
      if (!hardCompatible(store, requests[i], requests[j])) return false;
    }
  }
  return true;
}

function groupScore(store, requests) {
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < requests.length; i += 1) {
    for (let j = i + 1; j < requests.length; j += 1) {
      total += compatibilityScore(store, requests[i], requests[j]);
      pairs += 1;
    }
  }
  return pairs ? Number((total / pairs).toFixed(2)) : 0;
}

function requestAgeMinutes(request) {
  return Math.max(0, (Date.now() - new Date(request.createdAt).getTime()) / 60000);
}

function groupPriorityScore(store, requests) {
  const base = groupScore(store, requests);
  const avgAge = requests.reduce((sum, r) => sum + requestAgeMinutes(r), 0) / requests.length;
  const oldestAge = requests.reduce((max, r) => Math.max(max, requestAgeMinutes(r)), 0);
  const noMatchCount = requests.reduce(
    (sum, r) =>
      sum +
      Object.values(store.matchEvents || {}).filter(
        (e) => e.requestId === r.requestId && e.type === 'NO_MATCH'
      ).length,
    0
  );
  const avgAgeBoost = Math.min(20, avgAge / 2.5);
  const oldestBoost = Math.min(20, oldestAge / 3);
  const noMatchBoost = Math.min(15, noMatchCount * 1.5);
  const starvationBoost = avgAgeBoost + oldestBoost + noMatchBoost;
  return Number((base + starvationBoost).toFixed(2));
}

function ensureFoundMeetForUser(draft, userId, requests, groupScoreValue) {
  if (!draft.meets) draft.meets = {};
  if (!draft.meetParticipants) draft.meetParticipants = {};

  const userRequest = requests.find((r) => r.userId === userId) || null;
  const existing = Object.values(draft.meets || {}).find((m) => {
    if (m.ownerUserId !== userId) return false;
    if (!['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(m.status)) return false;
    // Idempotency per matched request window:
    // if we already created an open meet after this request was created, don't duplicate.
    if (userRequest?.createdAt) {
      return new Date(m.createdAt).getTime() >= new Date(userRequest.createdAt).getTime();
    }
    return true;
  });
  if (existing) {
    return null;
  }

  const meetId = randomId('meet');
  const otherRequests = requests.filter((r) => r.userId !== userId).slice(0, 4);
  const participantIds = otherRequests.map(() => randomId('mp'));
  const deadlineAt = new Date(
    Date.now() + COMMITMENT_RESPONSE_WINDOW_MINUTES * 60 * 1000
  ).toISOString();
  draft.meets[meetId] = {
    meetId,
    ownerUserId: userId,
    status: 'FOUND',
    topicLabel: 'Matched Group',
    matchTimeLabel: 'Tomorrow, 6 PM.',
    participantIds,
    venueName: null,
    venueAddress: null,
    venueLat: null,
    venueLng: null,
    venueManagerName: null,
    venuePhone: null,
    hostReview: null,
    venueHidden: true,
    venueShareEtaMins: 30,
    commitmentFeePaise: DEFAULT_COMMITMENT_FEE,
    commitmentDeadlineAt: deadlineAt,
    paymentStatus: 'PENDING',
    paymentId: null,
    matchFoundPushSentAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  otherRequests.forEach((req, index) => {
    const participantId = participantIds[index];
    const user = draft.users[req.userId];
    draft.meetParticipants[participantId] = {
      participantId,
      meetId,
      userId: req.userId,
      name: `${user?.profile?.fullName || 'User'}, ${user?.profile?.age || ''}`.replace(/,\s*$/, ''),
      subtitle: user?.profile?.profession || 'Member',
      initial: String(user?.profile?.fullName || 'U').trim().charAt(0).toUpperCase() || 'U',
      createdAt: nowIso(),
    };
  });

  addMatchEvent(draft, {
    requestId: null,
    groupId: null,
    type: 'MEET_CREATED',
    message: 'Found meet created from match group',
    payload: { userId, meetId, score: groupScoreValue },
  });
  return meetId;
}

async function sendPushNotification(payloads) {
  if (!Array.isArray(payloads) || !payloads.length) return { ok: true, data: [] };
  if (PUSH_PROVIDER !== 'expo') {
    return { ok: false, error: `Unsupported push provider: ${PUSH_PROVIDER}` };
  }

  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (EXPO_ACCESS_TOKEN) {
    headers.authorization = `Bearer ${EXPO_ACCESS_TOKEN}`;
  }

  const response = await fetch(EXPO_PUSH_API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(payloads),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = json?.errors?.[0]?.message || `Push send failed (${response.status})`;
    throw new Error(message);
  }
  return { ok: true, data: Array.isArray(json?.data) ? json.data : [] };
}

async function sendMatchFoundPushForMeet(userId, meetId) {
  if (!meetId || pushDispatchInFlight.has(meetId)) return;
  pushDispatchInFlight.add(meetId);
  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet || meet.matchFoundPushSentAt) {
    pushDispatchInFlight.delete(meetId);
    return;
  }

  const tokens = Object.values(store.pushTokens || {})
    .filter((t) => t.userId === userId && t.status === 'ACTIVE' && isExpoPushToken(t.pushToken))
    .map((t) => ({ pushTokenId: t.pushTokenId, token: t.pushToken }));
  if (!tokens.length) {
    pushDispatchInFlight.delete(meetId);
    return;
  }

  const messages = tokens.map((entry) => ({
    to: entry.token,
    sound: 'default',
    title: 'Meet found',
    body: 'Your group is ready. Secure your spot now.',
    data: {
      type: 'MATCH_FOUND',
      route: 'matchFound',
      meet_id: meetId,
    },
  }));

  try {
    const result = await sendPushNotification(messages);
    mutateStore((draft) => {
      const nextMeet = draft.meets?.[meetId];
      const itemResults = Array.isArray(result?.data) ? result.data : [];
      const successfulCount = itemResults.filter((item) => item?.status === 'ok').length;
      if (nextMeet && successfulCount > 0) {
        nextMeet.matchFoundPushSentAt = nowIso();
        nextMeet.updatedAt = nowIso();
      }
      addMatchEvent(draft, {
        requestId: null,
        groupId: null,
        type: 'PUSH_SENT',
        message: 'Match-found push notification sent',
        payload: { userId, meetId, count: tokens.length, success_count: successfulCount },
      });

      itemResults.forEach((item, index) => {
        if (item?.status !== 'error') return;
        const errCode = String(item?.details?.error || '');
        if (errCode !== 'DeviceNotRegistered') return;
        const pushTokenId = tokens[index]?.pushTokenId;
        if (pushTokenId && draft.pushTokens?.[pushTokenId]) {
          draft.pushTokens[pushTokenId].status = 'INACTIVE';
          draft.pushTokens[pushTokenId].updatedAt = nowIso();
        }
      });
    });
  } catch (error) {
    mutateStore((draft) => {
      addMatchEvent(draft, {
        requestId: null,
        groupId: null,
        type: 'PUSH_FAILED',
        message: String(error?.message || 'Push dispatch failed'),
        payload: { userId, meetId, count: tokens.length },
      });
    });
  } finally {
    pushDispatchInFlight.delete(meetId);
  }
}

async function sendVenueSharedPushForMeet(userId, meetId) {
  if (!meetId || venuePushDispatchInFlight.has(meetId)) return;
  venuePushDispatchInFlight.add(meetId);
  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet) {
    venuePushDispatchInFlight.delete(meetId);
    return;
  }

  const tokens = Object.values(store.pushTokens || {})
    .filter((t) => t.userId === userId && t.status === 'ACTIVE' && isExpoPushToken(t.pushToken))
    .map((t) => ({ pushTokenId: t.pushTokenId, token: t.pushToken }));
  if (!tokens.length) {
    venuePushDispatchInFlight.delete(meetId);
    return;
  }

  const venueTitle = String(meet.venueName || 'Venue');
  const messages = tokens.map((entry) => ({
    to: entry.token,
    sound: 'default',
    title: 'Venue shared',
    body: `${venueTitle} is now shared. Tap to view meet details.`,
    data: {
      type: 'VENUE_SHARED',
      route: 'meetDetails',
      meet_id: meetId,
    },
  }));

  try {
    const result = await sendPushNotification(messages);
    mutateStore((draft) => {
      const itemResults = Array.isArray(result?.data) ? result.data : [];
      const successfulCount = itemResults.filter((item) => item?.status === 'ok').length;
      addMatchEvent(draft, {
        requestId: null,
        groupId: null,
        type: 'PUSH_SENT',
        message: 'Venue-shared push notification sent',
        payload: { userId, meetId, count: tokens.length, success_count: successfulCount },
      });

      itemResults.forEach((item, index) => {
        if (item?.status !== 'error') return;
        const errCode = String(item?.details?.error || '');
        if (errCode !== 'DeviceNotRegistered') return;
        const pushTokenId = tokens[index]?.pushTokenId;
        if (pushTokenId && draft.pushTokens?.[pushTokenId]) {
          draft.pushTokens[pushTokenId].status = 'INACTIVE';
          draft.pushTokens[pushTokenId].updatedAt = nowIso();
        }
      });
    });
  } catch (error) {
    mutateStore((draft) => {
      addMatchEvent(draft, {
        requestId: null,
        groupId: null,
        type: 'PUSH_FAILED',
        message: String(error?.message || 'Push dispatch failed'),
        payload: { userId, meetId, count: tokens.length, category: 'VENUE_SHARED' },
      });
    });
  } finally {
    venuePushDispatchInFlight.delete(meetId);
  }
}

function runMatchingCycle() {
  if (matcherRunning) return;
  matcherRunning = true;
  try {
    markExpiredQueuedRequests();
    const store = getStore();
    const queued = Object.values(store.matchRequests || {})
      .filter((r) => r.status === 'QUEUED')
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    if (queued.length < MATCH_GROUP_SIZE) return;

    for (const anchor of queued) {
      const freshStore = getStore();
      const anchorNow = freshStore.matchRequests?.[anchor.requestId];
      if (!anchorNow || anchorNow.status !== 'QUEUED') continue;
      const anchorAgeMin = requestAgeMinutes(anchorNow);
      const matchingMode = getMatchingModeByAgeMinutes(anchorAgeMin);
      const candidateLimit = matchingMode === 'STRICT' ? 24 : 48;

      const candidates = Object.values(freshStore.matchRequests || {})
        .filter((r) => r.status === 'QUEUED' && r.requestId !== anchorNow.requestId)
        .filter((r) => hardCompatible(freshStore, anchorNow, r))
        .slice(0, candidateLimit);
      if (candidates.length < MATCH_GROUP_SIZE - 1) {
        if (
          shouldEmitNoMatchEvent(
            freshStore,
            anchorNow.requestId,
            `Not enough compatible candidates (${matchingMode})`
          )
        ) {
          mutateStore((draft) => {
            addMatchEvent(draft, {
              requestId: anchorNow.requestId,
              type: 'NO_MATCH',
              message: `Not enough compatible candidates (${matchingMode})`,
            });
          });
        }
        continue;
      }

      const candidateCombos = combinationsOfSize(candidates, MATCH_GROUP_SIZE - 1);
      let best = null;

      for (const combo of candidateCombos) {
        const groupRequests = [anchorNow, ...combo];
        if (!isGroupValidForMode(freshStore, groupRequests, matchingMode)) continue;
        if (!allPairwiseCompatible(freshStore, groupRequests)) continue;
        const score = groupPriorityScore(freshStore, groupRequests);
        if (!best || score > best.score) {
          best = { groupRequests, score };
        }
      }

      if (!best) {
        const reason = `Constraints unsatisfied for ${matchingMode} mode`;
        if (shouldEmitNoMatchEvent(freshStore, anchorNow.requestId, reason)) {
          mutateStore((draft) => {
            addMatchEvent(draft, {
              requestId: anchorNow.requestId,
              type: 'NO_MATCH',
              message: reason,
            });
          });
        }
        continue;
      }

      const { groupRequests, score } = best;
      const newlyCreatedMeets = [];
      mutateStore((draft) => {
        if (!draft.matchGroups) draft.matchGroups = {};
        if (!draft.matchGroupMembers) draft.matchGroupMembers = {};
        if (!draft.matchRequests) draft.matchRequests = {};

        const groupId = randomId('mgrp');
        const baseReq = groupRequests[0];
        draft.matchGroups[groupId] = {
          groupId,
          status: 'FORMED',
          availabilityDate: baseReq.availabilityDate || null,
          availabilitySlot: baseReq.availabilitySlot || null,
          vibe: baseReq.vibe || null,
          score,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };

        groupRequests.forEach((req) => {
          const memberId = randomId('mgm');
          draft.matchGroupMembers[memberId] = {
            memberId,
            groupId,
            userId: req.userId,
            requestId: req.requestId,
            createdAt: nowIso(),
          };
          if (draft.matchRequests[req.requestId]) {
            draft.matchRequests[req.requestId].status = 'MATCHED';
            draft.matchRequests[req.requestId].score = score;
            draft.matchRequests[req.requestId].matchedGroupId = groupId;
            draft.matchRequests[req.requestId].updatedAt = nowIso();
          }
          addMatchEvent(draft, {
            requestId: req.requestId,
            groupId,
            type: 'MATCHED',
            message: 'Request matched into group',
            payload: { score, matching_mode: matchingMode },
          });
          const createdMeetId = ensureFoundMeetForUser(draft, req.userId, groupRequests, score);
          if (createdMeetId) {
            newlyCreatedMeets.push({ userId: req.userId, meetId: createdMeetId });
          }
        });
      });
      newlyCreatedMeets.forEach((item) => {
        void sendMatchFoundPushForMeet(item.userId, item.meetId);
      });
      break;
    }
  } finally {
    matcherRunning = false;
  }
}

async function handleSimRequest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const countryCode = String(body.country_code || '').trim();
  const phone = String(body.phone || '').trim();

  if (!countryCode || !phone.replace(/\D/g, '')) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'country_code and phone are required',
      },
    });
  }

  const normalizedPhone = normalizePhone(countryCode, phone);
  const requestId = randomId('simreq');
  const token = randomToken(6);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + toMs(SIM_TOKEN_TTL_MINUTES));
  const smsPayload = buildVerificationSmsPayload({
    token,
    countryCode,
    phone: phone.replace(/\D/g, ''),
    normalizedPhone,
  });

  mutateStore((draft) => {
    draft.verificationRequests[requestId] = {
      requestId,
      countryCode,
      phone: phone.replace(/\D/g, ''),
      normalizedPhone,
      token,
      status: 'PENDING',
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      verifiedAt: null,
    };
    draft.tokenIndex[token] = requestId;
  });

  return sendJson(res, 201, {
    success: true,
    data: {
      request_id: requestId,
      expires_at: expiresAt.toISOString(),
      sms_destination: smsPayload.sms_destination,
      sms_body: smsPayload.sms_body,
      provider: smsPayload.provider,
      provider_meta: smsPayload.provider_meta,
      status_check_url: `${API_BASE_URL}/api/v1/auth/sim/status?request_id=${requestId}`,
    },
  });
}

async function handleSimStatus(req, res, url) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const requestId = url.searchParams.get('request_id');
  if (!requestId) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'request_id is required',
      },
    });
  }

  const record = getStore().verificationRequests[requestId];
  if (!record) {
    return sendJson(res, 404, {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Verification request not found',
      },
    });
  }

  let status = record.status;
  if (status === 'PENDING' && new Date(record.expiresAt).getTime() < Date.now()) {
    status = 'EXPIRED';
    mutateStore((draft) => {
      if (draft.verificationRequests[requestId]) {
        draft.verificationRequests[requestId].status = 'EXPIRED';
      }
    });
  }

  return sendJson(res, 200, {
    success: true,
    data: {
      request_id: requestId,
      status,
      verified_at: record.verifiedAt,
      expires_at: record.expiresAt,
    },
  });
}

async function handleInboundSms(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  if (!verifySmsWebhookSignature(JSON.stringify(body || {}), req.headers || {})) {
    return sendJson(res, 401, {
      success: false,
      error: {
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'Invalid SMS webhook signature',
      },
    });
  }

  const normalized = normalizeInboundSmsPayload(body || {});
  const from = normalizeSmsSenderPhone(normalized.from);
  const message = String(normalized.message || '').trim().toUpperCase();

  const match = message.match(/HUSHH\s+VERIFY\s+([A-Z0-9]{4,10})/i);
  if (!match) {
    return sendJson(res, 200, {
      success: true,
      data: { processed: false, reason: 'token_not_found_in_message' },
    });
  }

  const token = match[1].toUpperCase();
  const requestId = getStore().tokenIndex[token];
  if (!requestId) {
    return sendJson(res, 200, {
      success: true,
      data: { processed: false, reason: 'invalid_token' },
    });
  }

  const store = getStore();
  const record = store.verificationRequests[requestId];
  if (!record) {
    return sendJson(res, 200, {
      success: true,
      data: { processed: false, reason: 'request_not_found' },
    });
  }

  const normalizedFrom = String(from).replace(/\D/g, '');
  const normalizedExpected = String(record.normalizedPhone).replace(/\D/g, '');
  if (normalizedFrom && normalizedExpected && !normalizedFrom.endsWith(normalizedExpected.slice(-10))) {
    return sendJson(res, 200, {
      success: true,
      data: { processed: false, reason: 'sender_mismatch' },
    });
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    mutateStore((draft) => {
      draft.verificationRequests[requestId].status = 'EXPIRED';
    });
    return sendJson(res, 200, {
      success: true,
      data: { processed: false, reason: 'token_expired' },
    });
  }

  mutateStore((draft) => {
    draft.verificationRequests[requestId].status = 'VERIFIED';
    draft.verificationRequests[requestId].verifiedAt = nowIso();
  });

  return sendJson(res, 200, {
    success: true,
    data: { processed: true, request_id: requestId },
  });
}

async function handleInboundSmsProviderWebhook(req, res) {
  // Alias route for provider dashboards; reuses canonical inbound processing.
  return handleInboundSms(req, res);
}

async function handleMockVerify(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const requestId = String(body.request_id || '').trim();

  if (!requestId) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'request_id is required',
      },
    });
  }

  const record = getStore().verificationRequests[requestId];
  if (!record) {
    return sendJson(res, 404, {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Verification request not found',
      },
    });
  }

  mutateStore((draft) => {
    draft.verificationRequests[requestId].status = 'VERIFIED';
    draft.verificationRequests[requestId].verifiedAt = nowIso();
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      request_id: requestId,
      status: 'VERIFIED',
    },
  });
}

async function handleToken(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const requestId = String(body.request_id || '').trim();
  if (!requestId) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'request_id is required',
      },
    });
  }

  const store = getStore();
  const record = store.verificationRequests[requestId];
  if (!record || record.status !== 'VERIFIED') {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'UNVERIFIED',
        message: 'SIM verification is not completed',
      },
    });
  }

  const { token, expiresAt, userId } = issueSessionForNormalizedPhone({
    normalizedPhone: record.normalizedPhone,
    countryCode: record.countryCode,
    phone: record.phone,
    requestId,
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      access_token: token,
      token_type: 'Bearer',
      expires_at: expiresAt,
      user_id: userId,
    },
  });
}

async function handleOtpRequest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (AUTH_MODE === 'firebase_otp' && !ALLOW_OTP_FALLBACK) {
    return sendJson(res, 409, {
      success: false,
      error: {
        code: 'OTP_FALLBACK_DISABLED',
        message: 'OTP fallback is disabled. Use Firebase OTP flow.',
      },
    });
  }
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;

  const countryCode = String(body.country_code || '').trim() || '+91';
  const phone = String(body.phone || '').replace(/\D/g, '').slice(-10);
  if (!phone) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'country_code and phone are required',
      },
    });
  }

  const normalizedPhone = normalizePhone(countryCode, phone);
  const now = Date.now();
  const requestId = randomId('otpreq');
  const otp = randomNumericOtp(OTP_LENGTH);
  const expiresAt = new Date(now + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  const resendAvailableAt = new Date(now + OTP_RESEND_SECONDS * 1000).toISOString();

  mutateStore((draft) => {
    if (!draft.otpRequests) draft.otpRequests = {};
    draft.otpRequests[requestId] = {
      requestId,
      countryCode,
      phone,
      normalizedPhone,
      otp,
      status: 'PENDING',
      expiresAt,
      resendAvailableAt,
      verifiedAt: null,
      createdAt: nowIso(),
      attempts: 0,
    };
  });

  const payload = {
    request_id: requestId,
    expires_at: expiresAt,
    resend_available_at: resendAvailableAt,
    auth_mode: AUTH_MODE,
    masked_phone: `${countryCode}${phone.slice(0, 2)}******${phone.slice(-2)}`,
  };
  if (process.env.NODE_ENV !== 'production' && ALLOW_OTP_FALLBACK) {
    payload.dev_otp = otp;
  }

  return sendJson(res, 201, {
    success: true,
    data: payload,
  });
}

async function handleOtpVerify(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (AUTH_MODE === 'firebase_otp' && !ALLOW_OTP_FALLBACK) {
    return sendJson(res, 409, {
      success: false,
      error: {
        code: 'OTP_FALLBACK_DISABLED',
        message: 'OTP fallback is disabled. Use Firebase OTP flow.',
      },
    });
  }
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;

  const requestId = String(body.request_id || '').trim();
  const otp = String(body.otp || '').trim();
  if (!requestId || !otp) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'request_id and otp are required',
      },
    });
  }
  if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(otp)) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: `otp must be a ${OTP_LENGTH}-digit code`,
      },
    });
  }

  const record = getStore().otpRequests?.[requestId];
  if (!record) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'OTP request not found' },
    });
  }
  if (record.status === 'VERIFIED') {
    const { token, expiresAt, userId } = issueSessionForNormalizedPhone({
      normalizedPhone: record.normalizedPhone,
      countryCode: record.countryCode,
      phone: record.phone,
      requestId,
    });
    return sendJson(res, 200, {
      success: true,
      data: {
        access_token: token,
        token_type: 'Bearer',
        expires_at: expiresAt,
        user_id: userId,
      },
    });
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    mutateStore((draft) => {
      if (draft.otpRequests?.[requestId]) {
        draft.otpRequests[requestId].status = 'EXPIRED';
      }
    });
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'OTP_EXPIRED',
        message: 'OTP expired. Please request a new OTP.',
      },
    });
  }

  if (record.otp !== otp) {
    let attempts = 0;
    mutateStore((draft) => {
      if (!draft.otpRequests?.[requestId]) return;
      draft.otpRequests[requestId].attempts = Number(draft.otpRequests[requestId].attempts || 0) + 1;
      attempts = draft.otpRequests[requestId].attempts;
      if (attempts >= 5) {
        draft.otpRequests[requestId].status = 'FAILED';
      }
    });
    return sendJson(res, 400, {
      success: false,
      error: {
        code: attempts >= 5 ? 'OTP_ATTEMPTS_EXCEEDED' : 'OTP_INVALID',
        message: attempts >= 5
          ? 'Too many incorrect attempts. Request a new OTP.'
          : 'Invalid OTP. Please try again.',
      },
    });
  }

  mutateStore((draft) => {
    if (!draft.otpRequests?.[requestId]) return;
    draft.otpRequests[requestId].status = 'VERIFIED';
    draft.otpRequests[requestId].verifiedAt = nowIso();
  });

  const { token, expiresAt, userId } = issueSessionForNormalizedPhone({
    normalizedPhone: record.normalizedPhone,
    countryCode: record.countryCode,
    phone: record.phone,
    requestId,
  });
  return sendJson(res, 200, {
    success: true,
    data: {
      access_token: token,
      token_type: 'Bearer',
      expires_at: expiresAt,
      user_id: userId,
    },
  });
}

async function handleFirebaseToken(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;

  const idToken = String(body.id_token || '').trim();
  if (!idToken) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'BAD_REQUEST', message: 'id_token is required' },
    });
  }

  try {
    const firebaseUser = await verifyFirebaseIdTokenAndGetUser(idToken);
    const split = splitE164PhoneNumber(firebaseUser.phoneNumber);
    if (!split?.phone) {
      return sendJson(res, 400, {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Could not normalize Firebase phone number' },
      });
    }

    const normalizedPhone = normalizePhone(split.countryCode, split.phone);
    const { token, expiresAt, userId } = issueSessionForNormalizedPhone({
      normalizedPhone,
      countryCode: split.countryCode,
      phone: split.phone,
      requestId: firebaseUser.localId ? `firebase:${firebaseUser.localId}` : 'firebase',
    });

    return sendJson(res, 200, {
      success: true,
      data: {
        access_token: token,
        token_type: 'Bearer',
        expires_at: expiresAt,
        user_id: userId,
      },
    });
  } catch (error) {
    const code = String(error?.code || '');
    const status =
      code === 'FIREBASE_NOT_CONFIGURED'
        ? 500
        : code === 'FIREBASE_TOKEN_INVALID' || code === 'FIREBASE_PHONE_MISSING'
          ? 401
          : code === 'FIREBASE_PROJECT_MISMATCH'
            ? 403
            : 400;
    return sendJson(res, status, {
      success: false,
      error: {
        code: code || 'FIREBASE_AUTH_FAILED',
        message: error?.message || 'Firebase authentication failed',
      },
    });
  }
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  mutateStore((draft) => {
    delete draft.sessions[session.token];
  });

  return sendJson(res, 200, {
    success: true,
    data: { logged_out: true },
  });
}

async function handleProfile(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const session = withAuth(req, res);
  if (!session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const validation = validateProfileInput(body);
  if (!validation.ok) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: validation.message,
      },
    });
  }

  const { fullName, gender, age, profession } = validation.value;

  mutateStore((draft) => {
    const user = draft.users[session.userId];
    if (user) {
      user.profile = {
        fullName,
        gender,
        age,
        profession,
        updatedAt: nowIso(),
        onboardingCompleted: true,
      };
    }
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      user_id: session.userId,
      onboarding_completed: true,
      profile: {
        full_name: fullName,
        gender,
        age,
        profession,
      },
    },
  });
}

async function handleMe(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);

  const session = withAuth(req, res);
  if (!session) return;
  const user = getStore().users[session.userId];

  return sendJson(res, 200, {
    success: true,
    data: {
      user_id: user?.userId,
      phone: user?.phone,
      country_code: user?.countryCode,
      profile: user?.profile
        ? {
            full_name: user.profile.fullName,
            gender: user.profile.gender,
            age: user.profile.age,
            profession: user.profile.profession,
            onboarding_completed: user.profile.onboardingCompleted,
          }
        : null,
      push_notifications: {
        registered: Object.values(getStore().pushTokens || {}).some(
          (item) => item.userId === user?.userId && item.status === 'ACTIVE'
        ),
      },
    },
  });
}

async function handlePushToken(req, res) {
  const session = withAuth(req, res);
  if (!session) return;

  if (req.method === 'POST') {
    const body = await parseJsonBody(req);
    if (!requireJsonObjectBody(res, body)) return;

    const pushToken = String(body.push_token || '').trim();
    const platform = String(body.platform || '').trim().toLowerCase() || null;
    const deviceId = String(body.device_id || '').trim() || null;

    if (!pushToken || !isExpoPushToken(pushToken)) {
      return sendJson(res, 400, {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Valid Expo push token is required' },
      });
    }

    const existing = Object.values(getStore().pushTokens || {}).find(
      (item) => item.pushToken === pushToken
    );
    const pushTokenId = existing?.pushTokenId || randomId('ptok');
    mutateStore((draft) => {
      if (!draft.pushTokens) draft.pushTokens = {};
      Object.values(draft.pushTokens || {}).forEach((item) => {
        if (item.userId === session.userId && item.pushToken !== pushToken && item.status === 'ACTIVE') {
          item.status = 'INACTIVE';
          item.updatedAt = nowIso();
        }
      });
      draft.pushTokens[pushTokenId] = {
        pushTokenId,
        userId: session.userId,
        pushToken,
        platform,
        deviceId,
        status: 'ACTIVE',
        createdAt: existing?.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      addMatchEvent(draft, {
        requestId: null,
        groupId: null,
        type: 'PUSH_TOKEN_REGISTERED',
        message: 'Push token registered',
        payload: { userId: session.userId, pushTokenId, platform },
      });
    });

    const latestFoundMeet = getUserMeets(session.userId)
      .filter((meet) => meet.status === 'FOUND' && !meet.matchFoundPushSentAt)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (latestFoundMeet?.meetId) {
      void sendMatchFoundPushForMeet(session.userId, latestFoundMeet.meetId);
    }

    return sendJson(res, 200, {
      success: true,
      data: { push_token_id: pushTokenId, status: 'ACTIVE' },
    });
  }

  if (req.method === 'DELETE') {
    const body = await parseJsonBody(req).catch(() => ({}));
    const pushToken = String(body?.push_token || '').trim();
    if (!pushToken) {
      return sendJson(res, 400, {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'push_token is required' },
      });
    }
    mutateStore((draft) => {
      const tokenEntry = Object.values(draft.pushTokens || {}).find(
        (item) => item.userId === session.userId && item.pushToken === pushToken
      );
      if (!tokenEntry) return;
      draft.pushTokens[tokenEntry.pushTokenId].status = 'INACTIVE';
      draft.pushTokens[tokenEntry.pushTokenId].updatedAt = nowIso();
    });
    return sendJson(res, 200, { success: true, data: { deactivated: true } });
  }

  return methodNotAllowed(res);
}

async function handleMeetActive(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const store = getStore();
  const active = getUserMeets(session.userId).find((meet) =>
    ['CONFIRMED', 'VENUE_SHARED'].includes(meet.status)
  );
  if (active?.meetId && !active?.commitmentDeadlineAt) {
    mutateStore((draft) => {
      ensureMeetCommitmentDeadline(draft, active.meetId);
    });
  }

  return sendJson(res, 200, {
    success: true,
    data: {
      meet: formatMeetPayload(active || null, store),
    },
  });
}

async function handleMeetOpen(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const store = getStore();
  const meets = getUserMeets(session.userId).filter((meet) =>
    ['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(meet.status)
  );
  return sendJson(res, 200, {
    success: true,
    data: {
      meets: meets.map((meet) => formatMeetPayload(meet, store)),
    },
  });
}

function isPastMeetForUser(store, userId, meet, feedbackMeetIds) {
  if (!meet || meet.ownerUserId !== userId) return false;
  if (feedbackMeetIds.has(meet.meetId)) return true;
  if (meet.status === 'ARCHIVED') {
    return String(meet.paymentStatus || '').toUpperCase() === 'CONFIRMED' || !meet.venueHidden;
  }
  if (!['CONFIRMED', 'VENUE_SHARED'].includes(String(meet.status || ''))) return false;
  const newerOpen = Object.values(store.meets || {}).some(
    (m) =>
      m.ownerUserId === userId &&
      ['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(String(m.status || '')) &&
      new Date(m.createdAt).getTime() > new Date(meet.createdAt).getTime()
  );
  return newerOpen;
}

async function handleMeetPast(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;
  const store = getStore();
  const feedbackMeetIds = new Set(
    Object.values(store.feedback || {})
      .filter((f) => f.userId === session.userId)
      .map((f) => f.meetId)
  );

  const payload = Object.values(store.meets || {})
    .filter((meet) => isPastMeetForUser(store, session.userId, meet, feedbackMeetIds))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((meet) => formatMeetPayload(meet, store));

  return sendJson(res, 200, {
    success: true,
    data: {
      meets: payload,
    },
  });
}

async function handleMeetFound(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  let foundMeet = getUserMeets(session.userId).find((meet) => meet.status === 'FOUND');
  if (foundMeet?.meetId && !foundMeet?.commitmentDeadlineAt) {
    mutateStore((draft) => {
      ensureMeetCommitmentDeadline(draft, foundMeet.meetId);
    });
    foundMeet = getUserMeets(session.userId).find((meet) => meet.status === 'FOUND') || foundMeet;
  }
  if (!foundMeet) {
    const store = getStore();
    const latestReq = getLatestRequestForUser(store, session.userId);
    const matchedReq =
      (latestReq?.status === 'MATCHED' && latestReq?.matchedGroupId ? latestReq : null) ||
      getLatestMatchedRequestWithGroupForUser(store, session.userId);
    if (matchedReq?.matchedGroupId) {
      mutateStore((draft) => {
        const reqNow = draft.matchRequests?.[matchedReq.requestId];
        if (!reqNow?.matchedGroupId) return;
        const groupId = reqNow.matchedGroupId;
        const group = draft.matchGroups?.[groupId];
        const memberReqs = Object.values(draft.matchGroupMembers || {})
          .filter((m) => m.groupId === groupId)
          .map((m) => draft.matchRequests?.[m.requestId])
          .filter(Boolean);
        ensureFoundMeetForUser(
          draft,
          session.userId,
          memberReqs.length ? memberReqs : [reqNow],
          group?.score ?? reqNow.score ?? 0
        );
      });
      foundMeet = getUserMeets(session.userId).find((meet) => meet.status === 'FOUND') || null;
    }
    if (!foundMeet) {
      if (ALLOW_FOUND_FALLBACK) {
        const createdMeetId = createDefaultMeetForUser(session.userId);
        foundMeet = getStore().meets?.[createdMeetId] || null;
      } else {
        return sendJson(res, 200, {
          success: true,
          data: {
            meet: null,
            meta: {
              strict_match_mode: true,
              active_request_status: latestReq?.status || null,
              message: latestReq?.status === 'QUEUED'
                ? 'No match found yet. Request is still queued.'
                : 'No matched group available yet.',
            },
          },
        });
      }
    }
  }

  return sendJson(res, 200, {
    success: true,
    data: {
      meet: formatMeetPayload(foundMeet, getStore()),
    },
  });
}

async function handleCreateMatchRequest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const requeue = Boolean(body.requeue);
  const lookForAnother = Boolean(body.look_for_another);
  const skipCreate = Boolean(body.skip_create);
  const availabilitySlot = String(body.availability_slot || '').trim() || null;
  const availabilityDateInput = String(body.availability_date || '').trim() || null;
  const availabilityDate = availabilityDateInput || isoDateFromSlot(availabilitySlot || 'today');
  const vibe = String(body.vibe || '').trim() || null;
  const ageMin = parseNumberOrNull(body.age_min);
  const ageMax = parseNumberOrNull(body.age_max);
  const lat = parseNumberOrNull(body.lat);
  const lng = parseNumberOrNull(body.lng);
  const radiusKm = parseNumberOrNull(body.radius_km) ?? 10;
  let voiceDurationSec = parseNumberOrNull(body.voice_duration_sec);
  let voiceIntroId = String(body.voice_intro_id || '').trim() || null;
  let voiceStorageUrlInput = String(body.voice_storage_url || '').trim() || null;
  let voiceMimeTypeInput = String(body.voice_mime_type || '').trim() || null;
  let voiceSizeBytesInput = parseNumberOrNull(body.voice_size_bytes);
  let voiceRecordedAtInput = String(body.voice_recorded_at || '').trim() || null;

  const user = getStore().users?.[session.userId];
  if (!user?.profile?.onboardingCompleted) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'PROFILE_REQUIRED', message: 'Complete onboarding profile first' },
    });
  }

  const openFoundMeet = getUserMeets(session.userId).find((m) => m.status === 'FOUND');
  if (openFoundMeet && lookForAnother) {
    mutateStore((draft) => {
      if (draft.meets?.[openFoundMeet.meetId]) {
        draft.meets[openFoundMeet.meetId].status = 'ARCHIVED';
        draft.meets[openFoundMeet.meetId].updatedAt = nowIso();
      }
      const latestMatched = Object.values(draft.matchRequests || {})
        .filter((r) => r.userId === session.userId && r.status === 'MATCHED')
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
      if (latestMatched && draft.matchRequests?.[latestMatched.requestId]) {
        draft.matchRequests[latestMatched.requestId].status = 'CANCELLED';
        draft.matchRequests[latestMatched.requestId].updatedAt = nowIso();
        addMatchEvent(draft, {
          requestId: latestMatched.requestId,
          groupId: latestMatched.matchedGroupId || null,
          type: 'CANCELLED',
          message: 'Match request cancelled (look-another)',
        });
      }
    });
    if (skipCreate) {
      return sendJson(res, 200, {
        success: true,
        data: {
          request: serializeMatchRequest(getStore(), getLatestRequestForUser(getStore(), session.userId)),
          meta: { look_for_another_archived: true, skip_create: true },
        },
      });
    }
  }

  if (lookForAnother) {
    const latestVoiceSource = Object.values(getStore().matchRequests || {})
      .filter((r) => r.userId === session.userId)
      .filter((r) => (r.voiceStorageUrl || r.voiceIntroId) && Number(r.voiceDurationSec || 0) >= 15)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];
    if (latestVoiceSource) {
      voiceDurationSec = voiceDurationSec ?? latestVoiceSource.voiceDurationSec ?? null;
      voiceIntroId = voiceIntroId || latestVoiceSource.voiceIntroId || null;
      voiceStorageUrlInput = voiceStorageUrlInput || latestVoiceSource.voiceStorageUrl || null;
      voiceMimeTypeInput = voiceMimeTypeInput || latestVoiceSource.voiceMimeType || null;
      voiceSizeBytesInput = voiceSizeBytesInput ?? latestVoiceSource.voiceSizeBytes ?? null;
      voiceRecordedAtInput = voiceRecordedAtInput || latestVoiceSource.voiceRecordedAt || null;
    }
  }

  if (ageMin != null && ageMax != null && ageMin > ageMax) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'age_min cannot be greater than age_max' },
    });
  }

  if (!availabilitySlot || !['Today', 'Tomorrow', 'This Weekend'].includes(availabilitySlot)) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'availability_slot must be Today, Tomorrow, or This Weekend',
      },
    });
  }

  if (voiceDurationSec == null || voiceDurationSec < 15) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'voice_duration_sec must be at least 15 seconds',
      },
    });
  }

  let voiceStorageUrl = voiceStorageUrlInput;
  let voiceMimeType = voiceMimeTypeInput || 'audio/m4a';
  let voiceSizeBytes = voiceSizeBytesInput;
  let voiceRecordedAt = voiceRecordedAtInput || nowIso();
  if (voiceIntroId) {
    const intro = getStore().voiceIntros?.[voiceIntroId];
    if (!intro || intro.userId !== session.userId) {
      return sendJson(res, 400, {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'voice_intro_id is invalid for this user',
        },
      });
    }
    voiceStorageUrl = voiceStorageUrl || intro.storageUrl || null;
    voiceMimeType = voiceMimeTypeInput || intro.mimeType || 'audio/m4a';
    voiceSizeBytes = voiceSizeBytesInput ?? intro.sizeBytes ?? null;
    voiceRecordedAt = voiceRecordedAtInput || intro.recordedAt || nowIso();
  }
  if (!voiceStorageUrl) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'voice_storage_url is required',
      },
    });
  }

  const existingQueued = Object.values(getStore().matchRequests || {})
    .filter((r) => r.userId === session.userId && r.status === 'QUEUED')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  if (existingQueued && !requeue) {
    return sendJson(res, 200, {
      success: true,
      data: {
        request: serializeMatchRequest(getStore(), existingQueued),
        meta: {
          reused_existing_queued: true,
        },
      },
    });
  }

  const latestForUser = getLatestRequestForUser(getStore(), session.userId);
  if (!lookForAnother && !openFoundMeet && latestForUser && ['CANCELLED', 'EXPIRED'].includes(latestForUser.status)) {
    const ageSec = Math.floor((Date.now() - new Date(latestForUser.updatedAt).getTime()) / 1000);
    if (ageSec < MATCH_REQUEST_RETRY_COOLDOWN_SECONDS) {
      return sendJson(res, 429, {
        success: false,
        error: {
          code: 'RETRY_COOLDOWN',
          message: 'Please wait a few seconds before creating another request',
          retry_after_sec: MATCH_REQUEST_RETRY_COOLDOWN_SECONDS - ageSec,
        },
      });
    }
  }

  const requestId = randomId('mreq');
  mutateStore((draft) => {
    if (!draft.matchRequests) draft.matchRequests = {};
    cancelLatestQueuedRequestForUser(draft, session.userId, 're-requested');
    draft.matchRequests[requestId] = {
      requestId,
      userId: session.userId,
      availabilityDate,
      availabilitySlot,
      vibe,
      ageMin,
      ageMax,
      genderPreference: null,
      lat,
      lng,
      radiusKm,
      voiceDurationSec,
      voiceIntroId,
      voiceStorageUrl,
      voiceMimeType,
      voiceSizeBytes,
      voiceRecordedAt,
      status: 'QUEUED',
      score: null,
      matchedGroupId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    addMatchEvent(draft, {
      requestId,
      type: 'QUEUED',
      message: 'Match request queued',
    });
  });

  runMatchingCycle();
  const next = getStore().matchRequests?.[requestId];
  return sendJson(res, 201, {
    success: true,
    data: {
      request: serializeMatchRequest(getStore(), next),
    },
  });
}

async function handleVoiceIntroCreate(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const durationSec = parseNumberOrNull(body.voice_duration_sec);
  const localUri = String(body.local_uri || '').trim() || null;
  const mimeType = String(body.mime_type || '').trim() || 'audio/m4a';
  const sizeBytes = parseNumberOrNull(body.size_bytes);
  const recordedAt = String(body.recorded_at || '').trim() || nowIso();

  if (durationSec == null || durationSec < 15) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'voice_duration_sec must be at least 15 seconds',
      },
    });
  }

  const voiceIntroId = randomId('vintro');
  const storageUrl = `local://voice-intros/${voiceIntroId}`;

  mutateStore((draft) => {
    if (!draft.voiceIntros) draft.voiceIntros = {};
    draft.voiceIntros[voiceIntroId] = {
      voiceIntroId,
      userId: session.userId,
      storageUrl,
      localUri,
      mimeType,
      sizeBytes: sizeBytes ?? null,
      durationSec,
      recordedAt,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
  });

  return sendJson(res, 201, {
    success: true,
    data: {
      voice_intro: {
        voice_intro_id: voiceIntroId,
        storage_url: storageUrl,
        duration_sec: durationSec,
        mime_type: mimeType,
        size_bytes: sizeBytes ?? null,
        recorded_at: recordedAt,
      },
    },
  });
}

async function handleCancelMatchRequest(req, res, requestId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const existing = getStore().matchRequests?.[requestId];
  if (!existing || existing.userId !== session.userId) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Match request not found' },
    });
  }

  mutateStore((draft) => {
    const reqItem = draft.matchRequests?.[requestId];
    if (!reqItem) return;
    if (reqItem.status === 'QUEUED') {
      reqItem.status = 'CANCELLED';
      reqItem.updatedAt = nowIso();
      addMatchEvent(draft, {
        requestId,
        groupId: reqItem.matchedGroupId || null,
        type: 'CANCELLED',
        message: 'Match request cancelled by user',
      });
    }
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      request: serializeMatchRequest(getStore(), getStore().matchRequests?.[requestId]),
    },
  });
}

async function handleCancelActiveMatchRequest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  let cancelledId = null;
  mutateStore((draft) => {
    const cancelled = cancelLatestQueuedRequestForUser(
      draft,
      session.userId,
      'cancel-active'
    );
    cancelledId = cancelled?.requestId || null;
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      cancelled_request_id: cancelledId,
      request: serializeMatchRequest(getStore(), getLatestRequestForUser(getStore(), session.userId)),
    },
  });
}

async function handleGetActiveMatchRequest(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  runMatchingCycle();
  const store = getStore();
  const request =
    getLatestActiveRequestForUser(store, session.userId) ||
    getLatestRequestForUser(store, session.userId);
  return sendJson(res, 200, {
    success: true,
    data: {
      request: serializeMatchRequest(store, request),
    },
  });
}

async function handleMeetPaymentIntent(req, res, meetId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet || meet.ownerUserId !== session.userId) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Meet not found' },
    });
  }
  if (!['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(meet.status)) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'INVALID_MEET_STATUS', message: 'Cannot create payment intent for this meet' },
    });
  }
  if (!meet.commitmentDeadlineAt) {
    mutateStore((draft) => {
      ensureMeetCommitmentDeadline(draft, meetId);
    });
  }
  const freshMeet = getStore().meets?.[meetId] || meet;
  if (isCommitmentExpired(freshMeet)) {
    return sendJson(res, 410, {
      success: false,
      error: {
        code: 'RESPONSE_WINDOW_EXPIRED',
        message: 'Response window expired. Please look for another meet.',
      },
    });
  }

  let paymentId = null;
  mutateStore((draft) => {
    const payment = ensurePendingPaymentIntent(draft, meetId, session.userId);
    paymentId = payment?.paymentId || null;
  });

  const nextStore = getStore();
  const payment = paymentId ? nextStore.payments?.[paymentId] : null;
  return sendJson(res, 200, {
    success: true,
    data: {
      provider: getPaymentProviderName(),
      provider_meta: buildPaymentIntentProviderMeta(payment, nextStore.meets?.[meetId]),
      payment: formatPaymentPayload(payment),
      meet: formatMeetPayload(nextStore.meets?.[meetId], nextStore),
      client_action: getPaymentClientAction(),
    },
  });
}

async function handlePaymentCallback(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const adminAuthorized = req.headers['x-admin-key'] === ADMIN_KEY;
  const session = adminAuthorized ? null : withAuth(req, res);
  if (!adminAuthorized && !session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const idempotencyHeader = req.headers['idempotency-key'];
  const callbackFallbackKey = [
    String(body.meet_id || '').trim(),
    String(body.payment_id || '').trim(),
    String(body.status || '').trim().toUpperCase(),
    String(body.receipt_id || '').trim(),
  ]
    .filter(Boolean)
    .join(':');
  const cached = getCachedIdempotentResponse(
    '/api/v1/payments/callback',
    idempotencyHeader || callbackFallbackKey
  );
  if (cached) {
    return sendJson(res, cached.status, cached.payload);
  }
  const paymentId = String(body.payment_id || '').trim() || null;
  const meetId = String(body.meet_id || '').trim() || null;
  const nextStatus = normalizePaymentStatus(body.status);
  const receiptId = String(body.receipt_id || '').trim() || null;
  if (!nextStatus) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'status must be PENDING/CONFIRMED/FAILED/CANCELLED/REFUNDED' },
    });
  }
  if (!paymentId && !meetId) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'payment_id or meet_id is required' },
    });
  }

  const store = getStore();
  let targetPayment = paymentId ? store.payments?.[paymentId] : null;
  if (!targetPayment && meetId) {
    const meet = store.meets?.[meetId];
    targetPayment = meet?.paymentId ? store.payments?.[meet.paymentId] : null;
  }
  if (!targetPayment) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Payment not found' },
    });
  }
  if (!adminAuthorized && targetPayment.userId !== session.userId) {
    return sendJson(res, 403, {
      success: false,
      error: { code: 'FORBIDDEN', message: 'Cannot modify this payment' },
    });
  }
  const targetMeet = store.meets?.[targetPayment.meetId];
  if (nextStatus === 'CONFIRMED' && targetMeet && isCommitmentExpired(targetMeet)) {
    return sendJson(res, 410, {
      success: false,
      error: {
        code: 'RESPONSE_WINDOW_EXPIRED',
        message: 'Response window expired. Please look for another meet.',
      },
    });
  }

  let updated = null;
  mutateStore((draft) => {
    updated = applyPaymentStatusUpdate(draft, targetPayment.paymentId, nextStatus, { receiptId });
  });

  const after = getStore();
  const meet = updated?.meet ? after.meets?.[updated.meet.meetId] : null;
  const payload = {
    success: true,
    data: {
      payment: formatPaymentPayload(after.payments?.[targetPayment.paymentId]),
      meet: formatMeetPayload(meet, after),
    },
  };
  setCachedIdempotentResponse(
    '/api/v1/payments/callback',
    idempotencyHeader || callbackFallbackKey,
    200,
    payload
  );
  return sendJson(res, 200, payload);
}

async function handlePaymentWebhook(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const rawBody = JSON.stringify(body || {});
  if (!verifyPaymentWebhookSignature(rawBody, req.headers || {})) {
    return sendJson(res, 401, {
      success: false,
      error: { code: 'INVALID_SIGNATURE', message: 'Webhook signature invalid' },
    });
  }

  const normalized = normalizePaymentWebhookPayload(body || {});
  const idempotencyHeader = req.headers['idempotency-key'];
  const webhookFallbackKey = [
    String(normalized.payment_id || '').trim(),
    String(normalized.status || '').trim().toUpperCase(),
    String(normalized.receipt_id || '').trim(),
  ]
    .filter(Boolean)
    .join(':');
  const cached = getCachedIdempotentResponse(
    '/api/v1/payments/webhook',
    idempotencyHeader || webhookFallbackKey
  );
  if (cached) {
    return sendJson(res, cached.status, cached.payload);
  }
  const paymentId = String(normalized.payment_id || '').trim();
  const status = normalizePaymentStatus(normalized.status);
  const receiptId = normalized.receipt_id ? String(normalized.receipt_id).trim() : null;
  if (!paymentId || !status) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'payment_id and valid status are required' },
    });
  }

  const existing = getStore().payments?.[paymentId];
  if (!existing) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Payment not found' },
    });
  }

  let updated = null;
  mutateStore((draft) => {
    updated = applyPaymentStatusUpdate(draft, paymentId, status, { receiptId });
  });
  const after = getStore();
  const meet = updated?.meet ? after.meets?.[updated.meet.meetId] : null;
  const payload = {
    success: true,
    data: {
      payment: formatPaymentPayload(after.payments?.[paymentId]),
      meet: formatMeetPayload(meet, after),
    },
  };
  setCachedIdempotentResponse(
    '/api/v1/payments/webhook',
    idempotencyHeader || webhookFallbackKey,
    200,
    payload
  );
  return sendJson(res, 200, payload);
}

async function handleMeetConfirm(req, res, meetId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const idempotentPath = `/api/v1/meets/${meetId}/confirm`;
  const idempotencyHeader = req.headers['idempotency-key'];
  const fallbackKey = `meet:${meetId}:confirm:${session.userId}`;
  const cached = getCachedIdempotentResponse(idempotentPath, idempotencyHeader || fallbackKey);
  if (cached) {
    return sendJson(res, cached.status, cached.payload);
  }

  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet || meet.ownerUserId !== session.userId) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Meet not found' },
    });
  }

  if (!['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(meet.status)) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'INVALID_MEET_STATUS', message: 'Meet cannot be confirmed' },
    });
  }
  if (!meet.commitmentDeadlineAt) {
    mutateStore((draft) => {
      ensureMeetCommitmentDeadline(draft, meetId);
    });
  }
  const freshMeet = getStore().meets?.[meetId] || meet;
  if (isCommitmentExpired(freshMeet)) {
    return sendJson(res, 410, {
      success: false,
      error: {
        code: 'RESPONSE_WINDOW_EXPIRED',
        message: 'Response window expired. Please look for another meet.',
      },
    });
  }

  let paymentId = null;
  mutateStore((draft) => {
    const payment = ensurePendingPaymentIntent(draft, meetId, session.userId);
    paymentId = payment?.paymentId || null;
    if (paymentId) {
      applyPaymentStatusUpdate(draft, paymentId, 'CONFIRMED');
    }
  });

  const payload = {
    success: true,
    data: {
      meet: formatMeetPayload(getStore().meets?.[meetId], getStore()),
    },
  };
  setCachedIdempotentResponse(idempotentPath, idempotencyHeader || fallbackKey, 200, payload);
  return sendJson(res, 200, payload);
}

async function handleMeetShareVenue(req, res, meetId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const idempotentPath = `/api/v1/meets/${meetId}/share-venue`;
  const idempotencyHeader = req.headers['idempotency-key'];
  const fallbackKey = `meet:${meetId}:share-venue:${session.userId}`;
  const cached = getCachedIdempotentResponse(idempotentPath, idempotencyHeader || fallbackKey);
  if (cached) {
    return sendJson(res, cached.status, cached.payload);
  }

  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet || meet.ownerUserId !== session.userId) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Meet not found' },
    });
  }

  mutateStore((draft) => {
    if (!draft.meets?.[meetId]) return;
    draft.meets[meetId].status = 'VENUE_SHARED';
    draft.meets[meetId].venueHidden = false;
    draft.meets[meetId].venueShareEtaMins = null;
    draft.meets[meetId].venueName = draft.meets[meetId].venueName || 'The Social';
    draft.meets[meetId].venueAddress = draft.meets[meetId].venueAddress || 'Indiranagar, 100ft Road';
    draft.meets[meetId].venueManagerName =
      draft.meets[meetId].venueManagerName || 'Rahul';
    draft.meets[meetId].venuePhone =
      draft.meets[meetId].venuePhone || '+919999999999';
    draft.meets[meetId].hostReview =
      draft.meets[meetId].hostReview ||
      "Look for the reserved table under 'Hushh' near the window. Ask the manager if you need help.";
    draft.meets[meetId].updatedAt = nowIso();
  });

  const payload = {
    success: true,
    data: {
      meet: formatMeetPayload(getStore().meets?.[meetId], getStore()),
    },
  };
  setCachedIdempotentResponse(idempotentPath, idempotencyHeader || fallbackKey, 200, payload);
  return sendJson(res, 200, payload);
}

async function handleMeetFeedback(req, res, meetId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet || meet.ownerUserId !== session.userId) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Meet not found' },
    });
  }

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const rating = Number(body.rating);
  const note = String(body.note || '').trim();
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'rating must be an integer between 1 and 5' },
    });
  }

  const feedbackId = randomId('fb');
  mutateStore((draft) => {
    if (!draft.feedback) draft.feedback = {};
    draft.feedback[feedbackId] = {
      feedbackId,
      meetId,
      userId: session.userId,
      rating,
      note: note || null,
      createdAt: nowIso(),
    };
    if (draft.meets?.[meetId]) {
      draft.meets[meetId].status = 'ARCHIVED';
      draft.meets[meetId].updatedAt = nowIso();
    }
  });

  return sendJson(res, 201, {
    success: true,
    data: {
      feedback_id: feedbackId,
      meet_id: meetId,
      rating,
      note: note || null,
      created_at: nowIso(),
    },
  });
}

async function handleBlockUser(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const blockedUserId = String(body.blocked_user_id || '').trim();
  const reason = String(body.reason || '').trim();
  if (!blockedUserId) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'blocked_user_id is required' },
    });
  }

  const blockId = randomId('blk');
  mutateStore((draft) => {
    if (!draft.blockedUsers) draft.blockedUsers = {};
    draft.blockedUsers[blockId] = {
      blockId,
      userId: session.userId,
      blockedUserId,
      reason: reason || null,
      createdAt: nowIso(),
    };
  });

  return sendJson(res, 201, {
    success: true,
    data: {
      block_id: blockId,
      blocked_user_id: blockedUserId,
      reason: reason || null,
      created_at: nowIso(),
    },
  });
}

async function handleUnblockUser(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  const session = withAuth(req, res);
  if (!session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const blockedUserId = String(body.blocked_user_id || '').trim();
  if (!blockedUserId) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'blocked_user_id is required' },
    });
  }

  let removedCount = 0;
  mutateStore((draft) => {
    const records = draft.blockedUsers || {};
    Object.keys(records).forEach((blockId) => {
      const item = records[blockId];
      if (
        item?.userId === session.userId &&
        String(item?.blockedUserId || '') === blockedUserId
      ) {
        delete records[blockId];
        removedCount += 1;
      }
    });
    draft.blockedUsers = records;
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      blocked_user_id: blockedUserId,
      removed_count: removedCount,
    },
  });
}

function serializeAdminMeet(store, meet) {
  const owner = store.users?.[meet.ownerUserId] || null;
  const participantRows = (meet.participantIds || [])
    .map((id) => store.meetParticipants?.[id])
    .filter(Boolean)
    .map((item) => ({
      participant_id: item.participantId,
      user_id: item.userId || null,
      name: item.name,
      subtitle: item.subtitle,
      initial: item.initial,
    }));

  return {
    meet_id: meet.meetId,
    owner_user_id: meet.ownerUserId,
    owner: owner
      ? {
          user_id: owner.userId,
          phone: `${owner.countryCode || ''}${owner.phone || ''}`,
          full_name: owner.profile?.fullName || null,
          gender: owner.profile?.gender || null,
          age: owner.profile?.age ?? null,
          profession: owner.profile?.profession || null,
        }
      : null,
    status: meet.status,
    topic_label: meet.topicLabel,
    match_time_label: meet.matchTimeLabel,
    participants: participantRows,
    venue: {
      is_hidden: !!meet.venueHidden,
      share_eta_mins: meet.venueShareEtaMins ?? null,
      name: meet.venueName || null,
      address: meet.venueAddress || null,
      lat: meet.venueLat ?? null,
      lng: meet.venueLng ?? null,
      manager_name: meet.venueManagerName || null,
      phone: meet.venuePhone || null,
    },
    host_review: meet.hostReview || null,
    payment_status: meet.paymentStatus || null,
    commitment_deadline_at: meet.commitmentDeadlineAt || null,
    created_at: meet.createdAt,
    updated_at: meet.updatedAt,
  };
}

async function handleAdminMeets(req, res, url) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const statusFilter = String(url.searchParams.get('status') || 'open')
    .trim()
    .toUpperCase();
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
  const store = getStore();

  const meets = Object.values(store.meets || {})
    .filter((meet) => {
      if (statusFilter === 'ALL') return true;
      if (statusFilter === 'OPEN') {
        return ['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(String(meet.status || ''));
      }
      if (statusFilter === 'NEEDS_VENUE') {
        return (
          ['CONFIRMED', 'VENUE_SHARED'].includes(String(meet.status || '')) &&
          (!meet.venueName || !meet.venueAddress || !meet.venueManagerName || !meet.venuePhone)
        );
      }
      return true;
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit)
    .map((meet) => serializeAdminMeet(store, meet));

  return sendJson(res, 200, {
    success: true,
    data: {
      meets,
      filters: {
        status: statusFilter,
        limit,
      },
    },
  });
}

async function handleAdminMatchGroups(req, res, url) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 50)));
  const committedOnly =
    String(url.searchParams.get('committed_only') || 'false').toLowerCase() === 'true';
  const store = getStore();

  const groups = Object.values(store.matchGroups || {})
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map((group) => {
      const members = Object.values(store.matchGroupMembers || {})
        .filter((m) => m.groupId === group.groupId)
        .map((m) => {
          const user = store.users?.[m.userId];
          const request = store.matchRequests?.[m.requestId];
          const openMeet = getOpenMeetForUserAndGroup(store, m.userId, group.groupId);
          const paymentStatus = String(openMeet?.paymentStatus || '').toUpperCase();
          const committed =
            paymentStatus === 'CONFIRMED' ||
            ['CONFIRMED', 'VENUE_SHARED'].includes(String(openMeet?.status || ''));
          return {
            member_id: m.memberId,
            user_id: m.userId,
            request_id: m.requestId,
            full_name: user?.profile?.fullName || null,
            gender: user?.profile?.gender || null,
            age: user?.profile?.age ?? null,
            profession: user?.profile?.profession || null,
            phone: user ? `${user.countryCode || ''}${user.phone || ''}` : null,
            meet_id: openMeet?.meetId || null,
            meet_status: openMeet?.status || null,
            payment_status: openMeet?.paymentStatus || null,
            committed,
            preference: request
              ? {
                  vibe: request.vibe || null,
                  availability_date: request.availabilityDate || null,
                  availability_slot: request.availabilitySlot || null,
                  age_min: request.ageMin ?? null,
                  age_max: request.ageMax ?? null,
                  lat: request.lat ?? null,
                  lng: request.lng ?? null,
                }
              : null,
          };
        });
      const committedMembers = members.filter((m) => m.committed);
      const canShareVenue = committedMembers.length > 0;

      return {
        group_id: group.groupId,
        status: group.status,
        vibe: group.vibe || null,
        availability_date: group.availabilityDate || null,
        availability_slot: group.availabilitySlot || null,
        score: group.score ?? null,
        member_count: members.length,
        committed_count: committedMembers.length,
        can_share_venue: canShareVenue,
        members,
        created_at: group.createdAt,
        updated_at: group.updatedAt,
      };
    })
    .filter((g) => (committedOnly ? g.committed_count > 0 : true))
    .slice(0, limit);

  return sendJson(res, 200, {
    success: true,
    data: {
      groups,
      filters: {
        committed_only: committedOnly,
      },
      limit,
    },
  });
}

async function handleAdminMeetVenueUpdate(req, res, meetId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;

  const store = getStore();
  const meet = store.meets?.[meetId];
  if (!meet) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Meet not found' },
    });
  }
  if (!['FOUND', 'CONFIRMED', 'VENUE_SHARED'].includes(String(meet.status || ''))) {
    return sendJson(res, 400, {
      success: false,
      error: { code: 'INVALID_MEET_STATUS', message: 'Only open meets can be updated' },
    });
  }

  const venueName = String(body.venue_name || '').trim();
  const venueAddress = String(body.venue_address || '').trim();
  const managerName = String(body.manager_name || '').trim();
  const venuePhone = normalizeVenuePhone(body.venue_phone);
  const hostReview = String(body.host_review || '').trim();
  const venueLat = parseNumberOrNull(body.venue_lat);
  const venueLng = parseNumberOrNull(body.venue_lng);
  const shareEtaMinsRaw = parseNumberOrNull(body.share_eta_mins);
  const shareEtaMins = Number.isInteger(shareEtaMinsRaw) ? shareEtaMinsRaw : null;

  if (!venueName || !venueAddress || !managerName || !venuePhone) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'venue_name, venue_address, manager_name, and venue_phone are required',
      },
    });
  }

  mutateStore((draft) => {
    const next = draft.meets?.[meetId];
    if (!next) return;
    next.status = 'VENUE_SHARED';
    next.venueHidden = false;
    next.venueShareEtaMins = shareEtaMins;
    next.venueName = venueName;
    next.venueAddress = venueAddress;
    next.venueManagerName = managerName;
    next.venuePhone = venuePhone;
    next.hostReview = hostReview || null;
    next.venueLat = venueLat;
    next.venueLng = venueLng;
    next.updatedAt = nowIso();

    addMatchEvent(draft, {
      requestId: null,
      groupId: null,
      type: 'VENUE_SHARED',
      message: 'Venue details updated by admin',
      payload: {
        meet_id: meetId,
        owner_user_id: next.ownerUserId,
      },
    });
  });

  const nextStore = getStore();
  const updated = nextStore.meets?.[meetId];
  if (updated?.ownerUserId) {
    void sendVenueSharedPushForMeet(updated.ownerUserId, meetId);
  }

  return sendJson(res, 200, {
    success: true,
    data: {
      meet: formatMeetPayload(updated, nextStore),
    },
  });
}

async function handleAdminMatchGroupShareVenue(req, res, groupId) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;

  const venueName = String(body.venue_name || '').trim();
  const venueAddress = String(body.venue_address || '').trim();
  const managerName = String(body.manager_name || '').trim();
  const venuePhone = normalizeVenuePhone(body.venue_phone);
  const hostReview = String(body.host_review || '').trim();
  const venueLat = parseNumberOrNull(body.venue_lat);
  const venueLng = parseNumberOrNull(body.venue_lng);
  const shareEtaMinsRaw = parseNumberOrNull(body.share_eta_mins);
  const shareEtaMins = Number.isInteger(shareEtaMinsRaw) ? shareEtaMinsRaw : null;

  if (!venueName || !venueAddress || !managerName || !venuePhone) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'venue_name, venue_address, manager_name, and venue_phone are required',
      },
    });
  }

  const store = getStore();
  const group = store.matchGroups?.[groupId];
  if (!group) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Match group not found' },
    });
  }

  const members = Object.values(store.matchGroupMembers || {}).filter((m) => m.groupId === groupId);
  const committedUsers = members
    .map((m) => {
      const meet = getOpenMeetForUserAndGroup(store, m.userId, groupId);
      const committed =
        String(meet?.paymentStatus || '').toUpperCase() === 'CONFIRMED' ||
        ['CONFIRMED', 'VENUE_SHARED'].includes(String(meet?.status || ''));
      return {
        userId: m.userId,
        meetId: meet?.meetId || null,
        committed,
      };
    })
    .filter((item) => item.committed && item.meetId);

  if (!committedUsers.length) {
    return sendJson(res, 400, {
      success: false,
      error: {
        code: 'NO_COMMITTED_MEMBERS',
        message: 'No committed members found in this group',
      },
    });
  }

  mutateStore((draft) => {
    committedUsers.forEach((item) => {
      const next = draft.meets?.[item.meetId];
      if (!next) return;
      next.status = 'VENUE_SHARED';
      next.venueHidden = false;
      next.venueShareEtaMins = shareEtaMins;
      next.venueName = venueName;
      next.venueAddress = venueAddress;
      next.venueManagerName = managerName;
      next.venuePhone = venuePhone;
      next.hostReview = hostReview || null;
      next.venueLat = venueLat;
      next.venueLng = venueLng;
      next.updatedAt = nowIso();
    });
    addMatchEvent(draft, {
      requestId: null,
      groupId,
      type: 'VENUE_SHARED',
      message: 'Venue details shared for committed group members',
      payload: {
        group_id: groupId,
        committed_count: committedUsers.length,
      },
    });
  });

  committedUsers.forEach((item) => {
    void sendVenueSharedPushForMeet(item.userId, item.meetId);
  });

  const after = getStore();
  const updatedMeets = committedUsers
    .map((item) => after.meets?.[item.meetId])
    .filter(Boolean)
    .map((meet) => formatMeetPayload(meet, after));

  return sendJson(res, 200, {
    success: true,
    data: {
      group_id: groupId,
      committed_count: committedUsers.length,
      meets: updatedMeets,
    },
  });
}

function renderAdminHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Hushh Admin</title>
  <style>
    :root { --bg:#f5f5f5; --card:#fff; --line:#e5e5e5; --text:#171717; --muted:#737373; --danger:#b91c1c; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,sans-serif; }
    .wrap { max-width:1200px; margin:0 auto; padding:16px; }
    .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; margin-bottom:12px; }
    .top { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .title { margin:0; font-size:18px; }
    .muted { color:var(--muted); font-size:12px; }
    .grid { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:10px; }
    .grid2 { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; }
    .metric { background:#fafafa; border:1px solid var(--line); border-radius:10px; padding:10px; }
    .k { font-size:11px; color:var(--muted); }
    .v { font-size:20px; font-weight:600; margin-top:3px; }
    .panel-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; gap:8px; }
    .panel-title { margin:0; font-size:15px; }
    .pill { border-radius:999px; padding:2px 8px; font-size:11px; background:#f5f5f5; border:1px solid var(--line); }
    .danger { color:var(--danger); }
    .list { border:1px solid var(--line); border-radius:10px; overflow:hidden; }
    .row { display:grid; grid-template-columns: 1fr auto; gap:8px; align-items:center; padding:8px 10px; border-bottom:1px solid #f0f0f0; }
    .row:last-child { border-bottom:none; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .truncate { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    button { min-height:36px; border:0; border-radius:8px; padding:0 12px; background:#171717; color:#fff; cursor:pointer; }
    button.secondary { background:#fff; color:#171717; border:1px solid var(--line); }
    input, select, textarea { min-height:36px; border:1px solid #d4d4d4; border-radius:8px; padding:0 10px; background:#fff; }
    textarea { min-height:88px; padding:10px; font-size:12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .api-grid { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .modal { position:fixed; inset:0; background:rgba(0,0,0,.38); display:none; align-items:center; justify-content:center; padding:16px; z-index:20; }
    .modal-card { width:min(1000px,100%); max-height:80vh; overflow:auto; background:#fff; border-radius:12px; border:1px solid var(--line); padding:12px; }
    table { width:100%; border-collapse:collapse; font-size:12px; }
    th, td { text-align:left; border-bottom:1px solid #f0f0f0; padding:7px 6px; vertical-align:top; }
    @media (max-width:980px){ .grid{grid-template-columns:repeat(2,minmax(0,1fr));} .grid2,.api-grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="top">
        <h2 class="title">Hushh Admin Dashboard</h2>
        <input id="adminKey" placeholder="ADMIN_KEY" style="min-width:220px" />
        <button id="loadBtn">Load</button>
        <button id="refreshBtn" class="secondary">Refresh</button>
        <span id="status" class="muted"></span>
      </div>
      <div class="muted">Compact latest view. Use “View Full” on each panel for complete data.</div>
    </div>

    <div id="content" style="display:none">
      <div class="card">
        <div class="panel-head"><h3 class="panel-title">Overview</h3></div>
        <div id="metrics" class="grid"></div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">Latest Users</h3><button class="secondary" id="fullUsersBtn">View Full</button></div>
          <div id="latestUsers" class="list"></div>
        </div>
        <div class="card">
          <div class="panel-head">
            <h3 class="panel-title">Latest Failures</h3>
            <div class="top">
              <select id="failedFilter">
                <option value="all">All</option>
                <option value="4xx">4xx</option>
                <option value="5xx">5xx</option>
                <option value="auth">Auth</option>
                <option value="match">Match</option>
                <option value="payment">Payment</option>
              </select>
              <button class="secondary" id="fullFailuresBtn">View Full</button>
            </div>
          </div>
          <div id="latestFailures" class="list"></div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">Latest API Logs</h3><button class="secondary" id="fullLogsBtn">View Full</button></div>
          <div id="latestLogs" class="list"></div>
        </div>
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">Latest Match Requests</h3><button class="secondary" id="fullRequestsBtn">View Full</button></div>
          <div id="latestRequests" class="list"></div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">Venue Share Ops (Committed Groups)</h3><button class="secondary" id="fullMeetsBtn">View Full</button></div>
          <div id="latestMeets" class="list" style="margin-bottom:10px"></div>
          <div class="top" style="margin-bottom:8px">
            <input id="venueGroupId" class="mono" placeholder="group_id" style="flex:1" />
          </div>
          <div class="grid2" style="margin-bottom:8px">
            <input id="venueName" placeholder="Venue name" />
            <input id="venueAddress" placeholder="Venue address" />
            <input id="venueManagerName" placeholder="Manager name" />
            <input id="venuePhone" placeholder="Venue phone (+91...)" />
            <input id="venueLat" placeholder="Venue lat (optional)" />
            <input id="venueLng" placeholder="Venue lng (optional)" />
          </div>
          <textarea id="venueHostReview" placeholder="Review from host"></textarea>
          <div class="top" style="margin-top:8px">
            <button id="submitVenueBtn">Share Venue To Committed + Notify</button>
            <span id="venueOpsStatus" class="muted"></span>
          </div>
        </div>
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">Matched Groups</h3><button class="secondary" id="fullGroupsBtn">View Full</button></div>
          <div id="latestGroups" class="list"></div>
        </div>
      </div>

      <div class="grid2">
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">Issue Summary</h3></div>
          <table id="issueSummaryTable"></table>
        </div>
        <div class="card">
          <div class="panel-head"><h3 class="panel-title">DB Status</h3></div>
          <table id="dbStatusTable"></table>
        </div>
      </div>

      <div class="card">
        <div class="panel-head"><h3 class="panel-title">API Test Console</h3></div>
        <div class="api-grid">
          <div>
            <div class="top" style="margin-bottom:8px">
              <select id="apiMethod"><option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option></select>
              <input id="apiPath" class="mono" value="/health" style="flex:1" />
            </div>
            <input id="apiToken" class="mono" placeholder="Optional Bearer token" style="width:100%; margin-bottom:8px" />
            <textarea id="apiBody" placeholder='JSON body for POST/PUT'></textarea>
            <div class="top" style="margin-top:8px"><button id="runApiTestBtn">Run</button><span id="apiTestStatus" class="muted"></span></div>
          </div>
          <div>
            <textarea id="apiTestOutput" readonly></textarea>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="modal" class="modal">
    <div class="modal-card">
      <div class="panel-head">
        <h3 id="modalTitle" class="panel-title">Full Data</h3>
        <button id="modalCloseBtn" class="secondary">Close</button>
      </div>
      <div id="modalBody"></div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('status');
    const contentEl = document.getElementById('content');
    const metricsEl = document.getElementById('metrics');
    const issueSummaryEl = document.getElementById('issueSummaryTable');
    const dbStatusEl = document.getElementById('dbStatusTable');
    const latestUsersEl = document.getElementById('latestUsers');
    const latestFailuresEl = document.getElementById('latestFailures');
    const latestLogsEl = document.getElementById('latestLogs');
    const latestRequestsEl = document.getElementById('latestRequests');
    const latestMeetsEl = document.getElementById('latestMeets');
    const latestGroupsEl = document.getElementById('latestGroups');
    const venueOpsStatusEl = document.getElementById('venueOpsStatus');
    const failedFilterEl = document.getElementById('failedFilter');
    const modalEl = document.getElementById('modal');
    const modalTitleEl = document.getElementById('modalTitle');
    const modalBodyEl = document.getElementById('modalBody');
    const apiMethodEl = document.getElementById('apiMethod');
    const apiPathEl = document.getElementById('apiPath');
    const apiTokenEl = document.getElementById('apiToken');
    const apiBodyEl = document.getElementById('apiBody');
    const apiTestStatusEl = document.getElementById('apiTestStatus');
    const apiTestOutputEl = document.getElementById('apiTestOutput');
    const state = { overview: null, db: null, matcher: null, meets: null, groups: null, failed: [] };

    function fmt(v){ return v == null ? '-' : String(v); }
    function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',\"'\":'&#39;'}[c])); }
    function classifyIssue(log){
      const status = Number(log?.status_code || 0);
      const path = String(log?.path || '').toLowerCase();
      if ([401,403].includes(status)) return 'Auth';
      if (status === 404) return 'Not Found';
      if (status >= 500) return 'Backend';
      if (path.includes('/payments')) return 'Payment';
      if (path.includes('/match') || path.includes('/meets')) return 'Match';
      if (status >= 400) return 'Client';
      return 'Other';
    }
    function filterFailures(rows, f){
      if (f === 'all') return rows;
      if (f === '4xx') return rows.filter(r => Number(r.status_code) >= 400 && Number(r.status_code) < 500);
      if (f === '5xx') return rows.filter(r => Number(r.status_code) >= 500);
      if (f === 'auth') return rows.filter(r => [401,403].includes(Number(r.status_code)));
      if (f === 'match') return rows.filter(r => String(r.path || '').includes('/match') || String(r.path || '').includes('/meets'));
      if (f === 'payment') return rows.filter(r => String(r.path || '').includes('/payments'));
      return rows;
    }
    function renderList(el, rows, empty){
      el.innerHTML = rows.length
        ? rows.map(r => '<div class="row"><div class="truncate">'+ r.left +'</div><div>'+ r.right +'</div></div>').join('')
        : '<div class="row"><div class="muted">'+ empty +'</div><div></div></div>';
    }
    function openModal(title, tableHtml){
      modalTitleEl.textContent = title;
      modalBodyEl.innerHTML = tableHtml;
      modalEl.style.display = 'flex';
    }
    function closeModal(){ modalEl.style.display = 'none'; }
    document.getElementById('modalCloseBtn').addEventListener('click', closeModal);
    modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });

    function buildTable(headers, rows){
      return '<table><tr>' + headers.map(h => '<th>'+ escapeHtml(h) +'</th>').join('') + '</tr>' +
        rows.map(r => '<tr>' + r.map(c => '<td>'+ escapeHtml(fmt(c)) +'</td>').join('') + '</tr>').join('') +
      '</table>';
    }

    async function runApiTest(){
      const key = document.getElementById('adminKey').value.trim();
      const method = apiMethodEl.value;
      const path = apiPathEl.value.trim();
      const token = apiTokenEl.value.trim();
      apiTestStatusEl.textContent = 'Running...';
      apiTestOutputEl.value = '';
      try {
        const headers = { 'content-type': 'application/json' };
        if (key) headers['x-admin-key'] = key;
        if (token) headers.authorization = 'Bearer ' + token;
        const req = { method, headers };
        if (!['GET','DELETE'].includes(method) && apiBodyEl.value.trim()) req.body = apiBodyEl.value.trim();
        const res = await fetch(path, req);
        const text = await res.text();
        apiTestOutputEl.value = 'HTTP ' + res.status + '\\n\\n' + text;
        apiTestStatusEl.textContent = 'Done';
      } catch (e) {
        apiTestStatusEl.textContent = 'Failed';
        apiTestOutputEl.value = String(e?.message || e);
      }
    }

    async function submitVenueUpdate(){
      const key = document.getElementById('adminKey').value.trim();
      const groupId = document.getElementById('venueGroupId').value.trim();
      if (!key) { venueOpsStatusEl.textContent = 'Enter admin key'; return; }
      if (!groupId) { venueOpsStatusEl.textContent = 'Enter group_id'; return; }
      venueOpsStatusEl.textContent = 'Saving...';
      try {
        const body = {
          venue_name: document.getElementById('venueName').value.trim(),
          venue_address: document.getElementById('venueAddress').value.trim(),
          manager_name: document.getElementById('venueManagerName').value.trim(),
          venue_phone: document.getElementById('venuePhone').value.trim(),
          host_review: document.getElementById('venueHostReview').value.trim(),
          venue_lat: document.getElementById('venueLat').value.trim() || null,
          venue_lng: document.getElementById('venueLng').value.trim() || null,
        };
        const res = await fetch('/api/v1/admin/match-groups/' + encodeURIComponent(groupId) + '/share-venue', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-admin-key': key },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json.success === false) {
          throw new Error(json?.error?.message || ('HTTP ' + res.status));
        }
        venueOpsStatusEl.textContent = 'Shared + notifications triggered';
        await loadData();
      } catch (e) {
        venueOpsStatusEl.textContent = String(e?.message || e);
      }
    }

    function renderDashboard(){
      const d = state.overview;
      const db = state.db;
      const mq = state.matcher;
      const c = d.counts || {};
      metricsEl.innerHTML = [
        ['Users', c.users], ['Sessions', c.active_sessions], ['Meets', c.meets], ['Payments', c.payments],
        ['Prefs Received', c.users_with_preferences], 
        ['Match Requests', c.match_requests], ['Groups', c.match_groups], ['Total API', c.total_requests],
        ['Failed API', c.failed_requests + ''], ['Failure Rate', (c.failure_rate_pct || 0) + '%']
      ].map(m => '<div class="metric"><div class="k">'+ m[0] +'</div><div class="v'+ (m[0].includes('Failed') ? ' danger' : '') +'">'+ fmt(m[1]) +'</div></div>').join('');

      dbStatusEl.innerHTML =
        '<tr><th>Key</th><th>Value</th></tr>' +
        '<tr><td>Mode</td><td>'+ fmt(db.mode) +'</td></tr>' +
        '<tr><td>Healthy</td><td>'+ (db.healthy ? 'Yes' : 'No') +'</td></tr>' +
        '<tr><td>Provider</td><td>'+ fmt(db.details?.provider) +'</td></tr>' +
        '<tr><td>DATABASE_URL</td><td>'+ (db.database_url_configured ? 'Configured' : 'Missing') +'</td></tr>';

      const users = d.users || [];
      renderList(latestUsersEl, users.slice(0,5).map(u => ({
        left: '<span class="mono">'+ escapeHtml(u.user_id) +'</span> • '+ escapeHtml(u.phone || '-') + '<div class="muted">Vibe: ' + escapeHtml(u.latest_preference?.vibe || '-') + ' • Slot: ' + escapeHtml(u.latest_preference?.availability_slot || '-') + '</div>',
        right: '<span class="pill">'+ (u.preference_data_received ? 'Prefs OK' : 'Prefs Missing') +'</span>'
      })), 'No users yet');

      const failedFiltered = filterFailures(state.failed, failedFilterEl.value);
      renderList(latestFailuresEl, failedFiltered.slice(0,5).map(l => ({
        left: '<span class="mono">'+ escapeHtml(l.path || '-') +'</span> ('+ escapeHtml(classifyIssue(l)) +')',
        right: '<span class="pill danger">'+ escapeHtml(String(l.status_code || '-')) +'</span>'
      })), 'No failures');

      const logs = d.recent_logs || [];
      renderList(latestLogsEl, logs.slice(0,5).map(l => ({
        left: escapeHtml((l.method || '-') + ' ' + (l.path || '-')),
        right: '<span class="pill">'+ escapeHtml(String(l.status_code || '-')) +'</span>'
      })), 'No logs');

      const reqs = mq.requests || [];
      renderList(latestRequestsEl, reqs.slice(0,5).map(r => ({
        left: '<span class="mono">'+ escapeHtml(r.request_id || '-') +'</span>',
        right: '<span class="pill">'+ escapeHtml(r.status || '-') +'</span>'
      })), 'No match requests');

      const groupsForVenue = (state.groups?.groups || []).filter(g => Number(g.committed_count || 0) > 0);
      renderList(latestMeetsEl, groupsForVenue.slice(0,5).map(g => ({
        left: '<span class="mono">'+ escapeHtml(g.group_id || '-') +'</span><div class="muted">' + escapeHtml((g.vibe || '-') + ' • ' + (g.availability_slot || '-') + ' • committed: ' + String(g.committed_count || 0)) + '</div>',
        right: '<span class="pill">'+ escapeHtml(String(g.member_count || 0)) +' members</span>'
      })), 'No committed groups yet');

      const groups = state.groups?.groups || [];
      renderList(latestGroupsEl, groups.slice(0,5).map(g => ({
        left: '<span class="mono">'+ escapeHtml(g.group_id || '-') +'</span><div class="muted">' + escapeHtml((g.vibe || '-') + ' • ' + (g.availability_slot || '-') + ' • committed: ' + String(g.committed_count || 0)) + '</div>',
        right: '<span class="pill">'+ escapeHtml(String(g.member_count || 0)) +' members</span>'
      })), 'No groups');

      const issueCounts = {};
      state.failed.forEach(f => {
        const k = classifyIssue(f);
        issueCounts[k] = (issueCounts[k] || 0) + 1;
      });
      issueSummaryEl.innerHTML = '<tr><th>Issue Type</th><th>Count</th></tr>' +
        Object.entries(issueCounts).sort((a,b)=>b[1]-a[1]).map(([k,v]) => '<tr><td>'+ escapeHtml(k) +'</td><td>'+ v +'</td></tr>').join('');
      if (!Object.keys(issueCounts).length) issueSummaryEl.innerHTML += '<tr><td colspan="2" class="muted">No recent issues</td></tr>';
    }

    async function loadData(){
      const key = document.getElementById('adminKey').value.trim();
      if (!key) { statusEl.textContent = 'Enter admin key'; return; }
      statusEl.textContent = 'Loading...';
      try {
        const [ovRes, dbRes, mqRes, meetsRes, groupsRes] = await Promise.all([
          fetch('/api/v1/admin/overview', { headers: { 'x-admin-key': key } }),
          fetch('/api/v1/admin/db-status', { headers: { 'x-admin-key': key } }),
          fetch('/api/v1/admin/match-queue', { headers: { 'x-admin-key': key } }),
          fetch('/api/v1/admin/meets?status=open&limit=80', { headers: { 'x-admin-key': key } }),
          fetch('/api/v1/admin/match-groups?limit=80&committed_only=true', { headers: { 'x-admin-key': key } })
        ]);
        const ov = await ovRes.json(); const db = await dbRes.json(); const mq = await mqRes.json();
        const meets = await meetsRes.json(); const groups = await groupsRes.json();
        if (!ovRes.ok || ov.success === false) throw new Error(ov.error?.message || 'overview failed');
        if (!dbRes.ok || db.success === false) throw new Error(db.error?.message || 'db failed');
        if (!mqRes.ok || mq.success === false) throw new Error(mq.error?.message || 'matcher failed');
        if (!meetsRes.ok || meets.success === false) throw new Error(meets.error?.message || 'meets failed');
        if (!groupsRes.ok || groups.success === false) throw new Error(groups.error?.message || 'groups failed');
        state.overview = ov.data || {};
        state.db = db.data || {};
        state.matcher = mq.data || {};
        state.meets = meets.data || {};
        state.groups = groups.data || {};
        state.failed = state.overview.recent_failed_logs || [];
        renderDashboard();
        contentEl.style.display = 'block';
        statusEl.textContent = 'Loaded';
      } catch (e) {
        statusEl.textContent = String(e?.message || e);
      }
    }

    function wireFullButtons(){
      document.getElementById('fullUsersBtn').addEventListener('click', () => {
        const rows = (state.overview?.users || []).map(u => [
          u.user_id,
          u.phone,
          u.onboarding_completed ? 'Yes' : 'No',
          u.preference_data_received ? 'Yes' : 'No',
          u.latest_preference?.vibe || '-',
          u.latest_preference?.availability_slot || '-',
          u.latest_preference?.voice_duration_sec || '-',
          u.latest_preference?.voice_storage_url ? 'Yes' : 'No',
          u.profile?.full_name || '-',
          u.profile?.profession || '-'
        ]);
        openModal(
          'All Users',
          buildTable(
            ['User ID','Phone','Onboarding','Prefs Received','Vibe','Slot','Voice Sec','Voice URL','Name','Profession'],
            rows
          )
        );
      });
      document.getElementById('fullFailuresBtn').addEventListener('click', () => {
        const rows = filterFailures(state.failed || [], failedFilterEl.value || 'all').map(l => [l.time,l.method,l.path,l.status_code,l.error || '-', classifyIssue(l), l.remote_addr || '-']);
        openModal('All Failures', buildTable(['Time','Method','Path','Status','Error','Issue','IP'], rows));
      });
      document.getElementById('fullLogsBtn').addEventListener('click', () => {
        const rows = (state.overview?.recent_logs || []).map(l => [l.time,l.method,l.path,l.status_code,l.duration_ms,l.remote_addr,l.error || '-']);
        openModal('All Recent Logs', buildTable(['Time','Method','Path','Status','Duration(ms)','IP','Error'], rows));
      });
      document.getElementById('fullRequestsBtn').addEventListener('click', () => {
        const rows = (state.matcher?.requests || []).map(r => [r.request_id,r.user_id,r.status,r.vibe || '-',(r.availability_date || '-') + ' ' + (r.availability_slot || ''), r.created_at]);
        openModal('All Match Requests', buildTable(['Request','User','Status','Vibe','Slot','Created'], rows));
      });
      document.getElementById('fullMeetsBtn').addEventListener('click', () => {
        const rows = (state.groups?.groups || [])
          .filter(g => Number(g.committed_count || 0) > 0)
          .map(g => [
          g.group_id,
          g.status,
          g.vibe || '-',
          g.availability_slot || '-',
          g.committed_count || 0,
          (g.members || [])
            .filter(m => m.committed)
            .map(m => String(m.full_name || m.user_id) + ' (' + String(m.payment_status || 'PENDING') + ')')
            .join(', '),
          g.updated_at,
        ]);
        openModal(
          'Committed Groups Ready For Venue Share',
          buildTable(
            ['Group ID','Status','Vibe','Slot','Committed','Committed Members','Updated'],
            rows
          )
        );
      });
      document.getElementById('fullGroupsBtn').addEventListener('click', () => {
        const rows = (state.groups?.groups || []).map(g => [
          g.group_id,
          g.status,
          g.vibe || '-',
          g.availability_slot || '-',
          g.member_count || 0,
          g.committed_count || 0,
          (g.members || []).map(m => m.full_name || m.user_id).join(', '),
          JSON.stringify((g.members || []).map(m => ({
            user_id: m.user_id,
            name: m.full_name,
            committed: m.committed,
            payment_status: m.payment_status,
            gender: m.gender,
            age: m.age,
            preference: m.preference,
          }))),
          g.updated_at,
        ]);
        openModal(
          'Matched Groups',
          buildTable(
            ['Group ID','Status','Vibe','Slot','Members','Committed','Member Names','Member Detail','Updated'],
            rows
          )
        );
      });
    }

    document.getElementById('loadBtn').addEventListener('click', loadData);
    document.getElementById('refreshBtn').addEventListener('click', loadData);
    failedFilterEl.addEventListener('change', renderDashboard);
    document.getElementById('runApiTestBtn').addEventListener('click', runApiTest);
    document.getElementById('submitVenueBtn').addEventListener('click', submitVenueUpdate);
    wireFullButtons();
  </script>
</body>
</html>`;
}

async function handleAdminOverview(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  return sendJson(res, 200, { success: true, data: collectAdminOverview() });
}

async function handleAdminUsers(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const users = collectAdminOverview().users;
  return sendJson(res, 200, { success: true, data: { users } });
}

function classifyRequestLog(log) {
  const status = Number(log?.status_code || 0);
  const path = String(log?.path || '').toLowerCase();
  if ([401, 403].includes(status)) return 'AUTH';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 500) return 'BACKEND';
  if (path.includes('/payments')) return 'PAYMENT';
  if (path.includes('/match') || path.includes('/meets')) return 'MATCH';
  if (status >= 400) return 'CLIENT';
  return 'OTHER';
}

async function handleAdminLogs(req, res, url) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 50)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
  const methodFilter = String(url.searchParams.get('method') || '').trim().toUpperCase();
  const pathContains = String(url.searchParams.get('path_contains') || '').trim().toLowerCase();
  const ipFilter = String(url.searchParams.get('ip') || '').trim();
  const statusExact = Number(url.searchParams.get('status') || 0) || null;
  const statusMin = Number(url.searchParams.get('status_min') || 0) || null;
  const statusMax = Number(url.searchParams.get('status_max') || 0) || null;
  const onlyFailures = String(url.searchParams.get('only_failures') || 'false').toLowerCase() === 'true';
  const search = String(url.searchParams.get('search') || '').trim().toLowerCase();

  const allLogs = (getStore().requestLogs || []).slice().reverse();
  const filtered = allLogs.filter((log) => {
    const method = String(log?.method || '').toUpperCase();
    const path = String(log?.path || '');
    const ip = String(log?.remote_addr || '');
    const status = Number(log?.status_code || 0);
    const error = String(log?.error || '');

    if (methodFilter && method !== methodFilter) return false;
    if (pathContains && !path.toLowerCase().includes(pathContains)) return false;
    if (ipFilter && ip !== ipFilter) return false;
    if (statusExact != null && status !== statusExact) return false;
    if (statusMin != null && status < statusMin) return false;
    if (statusMax != null && status > statusMax) return false;
    if (onlyFailures && status < 400) return false;
    if (search) {
      const haystack = `${method} ${path} ${ip} ${status} ${error}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const paged = filtered.slice(offset, offset + limit);
  const summary = {
    total: filtered.length,
    by_status_class: {
      '2xx': filtered.filter((l) => Number(l.status_code) >= 200 && Number(l.status_code) < 300).length,
      '3xx': filtered.filter((l) => Number(l.status_code) >= 300 && Number(l.status_code) < 400).length,
      '4xx': filtered.filter((l) => Number(l.status_code) >= 400 && Number(l.status_code) < 500).length,
      '5xx': filtered.filter((l) => Number(l.status_code) >= 500).length,
    },
    by_issue_type: filtered.reduce((acc, log) => {
      const key = classifyRequestLog(log);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };

  return sendJson(res, 200, {
    success: true,
    data: {
      logs: paged,
      pagination: {
        offset,
        limit,
        total: filtered.length,
        has_more: offset + limit < filtered.length,
      },
      summary,
    },
  });
}

async function handleAdminDbStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;
  const status = await getStoreDiagnostics();
  return sendJson(res, 200, { success: true, data: status });
}

async function handleAdminMatchQueue(req, res, url) {
  if (req.method !== 'GET') return methodNotAllowed(res);
  if (!withAdmin(req, res)) return;

  const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 30)));
  const store = getStore();
  const requests = Object.values(store.matchRequests || {})
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
    .map((item) => ({
      request_id: item.requestId,
      user_id: item.userId,
      status: item.status,
      vibe: item.vibe,
      availability_date: item.availabilityDate,
      availability_slot: item.availabilitySlot,
      score: item.score ?? null,
      matched_group_id: item.matchedGroupId || null,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    }));

  const groupMemberCount = {};
  Object.values(store.matchGroupMembers || {}).forEach((m) => {
    groupMemberCount[m.groupId] = (groupMemberCount[m.groupId] || 0) + 1;
  });

  const groups = Object.values(store.matchGroups || {})
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit)
    .map((g) => ({
      group_id: g.groupId,
      status: g.status,
      availability_date: g.availabilityDate,
      availability_slot: g.availabilitySlot,
      vibe: g.vibe,
      score: g.score ?? null,
      member_count: groupMemberCount[g.groupId] || 0,
      created_at: g.createdAt,
      updated_at: g.updatedAt,
    }));

  const events = Object.values(store.matchEvents || {})
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, Math.max(20, limit))
    .map((e) => ({
      event_id: e.eventId,
      request_id: e.requestId || null,
      group_id: e.groupId || null,
      type: e.type,
      message: e.message || null,
      created_at: e.createdAt,
    }));

  const queuedCount = requests.filter((r) => r.status === 'QUEUED').length;
  const matchedCount = requests.filter((r) => r.status === 'MATCHED').length;
  const queuedAges = requests
    .filter((r) => r.status === 'QUEUED')
    .map((r) => (Date.now() - new Date(r.created_at).getTime()) / 60000);
  const avgQueueAgeMin = queuedAges.length
    ? Number((queuedAges.reduce((a, b) => a + b, 0) / queuedAges.length).toFixed(2))
    : 0;
  const oldestQueueAgeMin = queuedAges.length
    ? Number(Math.max(...queuedAges).toFixed(2))
    : 0;

  const cancellationReasons = {};
  const noMatchReasons = {};
  events.forEach((e) => {
    if (e.type === 'CANCELLED') {
      const reason = String(e.message || 'cancelled').toLowerCase();
      cancellationReasons[reason] = (cancellationReasons[reason] || 0) + 1;
    }
    if (e.type === 'NO_MATCH') {
      const reason = String(e.message || 'no_match').toLowerCase();
      noMatchReasons[reason] = (noMatchReasons[reason] || 0) + 1;
    }
  });

  return sendJson(res, 200, {
    success: true,
    data: {
      counts: {
        requests: requests.length,
        groups: groups.length,
        events: events.length,
        queued: queuedCount,
        matched: matchedCount,
        avg_queue_age_min: avgQueueAgeMin,
        oldest_queue_age_min: oldestQueueAgeMin,
      },
      cancellation_reasons: cancellationReasons,
      no_match_reasons: noMatchReasons,
      requests,
      groups,
      events,
    },
  });
}

async function handleAdminMatcherSeedDemo(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!ADMIN_MATCHER_SEED_ENABLED) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  }
  if (!withAdmin(req, res)) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const payload = seedDemoGroupForAnchor({
    anchorUserId: String(body.anchor_user_id || '').trim() || null,
    vibe: String(body.vibe || 'Coffee').trim(),
    availabilitySlot: String(body.availability_slot || 'Today').trim(),
    availabilityDate: String(body.availability_date || '').trim() || null,
    lat: parseNumberOrNull(body.lat) ?? 12.9716,
    lng: parseNumberOrNull(body.lng) ?? 77.5946,
  });
  return sendJson(res, 200, { success: true, data: payload });
}

function seedDemoGroupForAnchor({
  anchorUserId = null,
  vibe = 'Coffee',
  availabilitySlot = 'Today',
  availabilityDate = null,
  lat = 12.9716,
  lng = 77.5946,
} = {}) {
  const resolvedAvailabilityDate =
    String(availabilityDate || '').trim() || isoDateFromSlot(String(availabilitySlot || 'Today'));
  const seedRequests = [];
  const now = nowIso();

  mutateStore((draft) => {
    if (!draft.users) draft.users = {};
    if (!draft.matchRequests) draft.matchRequests = {};
    if (!draft.phoneToUserId) draft.phoneToUserId = {};

    const members = [];
    if (anchorUserId && draft.users[anchorUserId]?.profile) {
      const g = getUserGender(draft.users[anchorUserId]);
      if (g === 'male' || g === 'female') {
        members.push(anchorUserId);
      }
    }

    const targetFemale = 2;
    const targetMale = 3;
    let maleCount = members.filter((id) => getUserGender(draft.users[id]) === 'male').length;
    let femaleCount = members.filter((id) => getUserGender(draft.users[id]) === 'female').length;

    while (members.length < MATCH_GROUP_SIZE) {
      const needFemale = femaleCount < targetFemale;
      const gender = needFemale ? 'Female' : 'Male';
      const phone = `9${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, '0')}`;
      const normalizedPhone = `+91${phone}`;
      const userId = randomId('user');
      draft.users[userId] = {
        userId,
        countryCode: '+91',
        phone,
        normalizedPhone,
        createdAt: now,
        profile: {
          fullName: `${gender === 'Female' ? 'Ava' : 'Liam'} ${userId.slice(-4)}`,
          gender,
          age: 24 + Math.floor(Math.random() * 6),
          profession: gender === 'Female' ? 'Designer' : 'Engineer',
          updatedAt: now,
          onboardingCompleted: true,
        },
      };
      draft.phoneToUserId[normalizedPhone] = userId;
      members.push(userId);
      if (gender === 'Female') femaleCount += 1;
      if (gender === 'Male') maleCount += 1;
      if (maleCount >= targetMale && femaleCount >= targetFemale) break;
    }

    members.slice(0, MATCH_GROUP_SIZE).forEach((userId) => {
      cancelLatestQueuedRequestForUser(draft, userId, 'admin-seed');
      archiveOpenMeetsForUser(draft, userId, 'admin-seed');
      const requestId = randomId('mreq');
      const req = {
        requestId,
        userId,
        availabilityDate: resolvedAvailabilityDate,
        availabilitySlot: String(availabilitySlot || 'Today'),
        vibe: String(vibe || 'Coffee'),
        ageMin: 22,
        ageMax: 34,
        genderPreference: null,
        lat,
        lng,
        radiusKm: 12,
        voiceDurationSec: 18,
        status: 'QUEUED',
        score: null,
        matchedGroupId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      draft.matchRequests[requestId] = req;
      seedRequests.push(req);
      addMatchEvent(draft, {
        requestId,
        type: 'QUEUED',
        message: 'Seeded demo request',
      });
    });
  });

  runMatchingCycle();

  const after = getStore();
  const matched = seedRequests
    .map((r) => after.matchRequests?.[r.requestId])
    .filter((r) => r?.status === 'MATCHED');
  const groupId = matched[0]?.matchedGroupId || null;

  return {
    seeded_request_count: seedRequests.length,
    matched_request_count: matched.length,
    group_id: groupId,
    requests: seedRequests.map((r) => serializeMatchRequest(after, after.matchRequests?.[r.requestId])),
  };
}

async function handleDevMatcherSeedSelf(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res);
  if (!DEV_MATCH_HELPERS_ENABLED) {
    return sendJson(res, 404, {
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  }
  const session = withAuth(req, res);
  if (!session) return;

  const body = await parseJsonBody(req);
  if (!requireJsonObjectBody(res, body)) return;
  const payload = seedDemoGroupForAnchor({
    anchorUserId: session.userId,
    vibe: String(body.vibe || 'Coffee').trim(),
    availabilitySlot: String(body.availability_slot || 'Today').trim(),
    availabilityDate: String(body.availability_date || '').trim() || null,
    lat: parseNumberOrNull(body.lat) ?? 12.9716,
    lng: parseNumberOrNull(body.lng) ?? 77.5946,
  });

  const latestFoundMeet = getUserMeets(session.userId).find((meet) => meet.status === 'FOUND');
  if (latestFoundMeet?.meetId) {
    mutateStore((draft) => {
      if (draft.meets?.[latestFoundMeet.meetId]) {
        draft.meets[latestFoundMeet.meetId].matchFoundPushSentAt = null;
        draft.meets[latestFoundMeet.meetId].updatedAt = nowIso();
      }
    });
    void sendMatchFoundPushForMeet(session.userId, latestFoundMeet.meetId);
  }

  return sendJson(res, 200, { success: true, data: payload });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!enforceRouteRateLimit(req, res, url.pathname)) return;
  const matchRequestCancelMatch = url.pathname.match(/^\/api\/v1\/match-requests\/([^/]+)\/cancel$/);
  if (matchRequestCancelMatch) {
    return handleCancelMatchRequest(req, res, decodeURIComponent(matchRequestCancelMatch[1]));
  }
  const meetPaymentIntentMatch = url.pathname.match(/^\/api\/v1\/meets\/([^/]+)\/payment-intent$/);
  if (meetPaymentIntentMatch) {
    return handleMeetPaymentIntent(req, res, decodeURIComponent(meetPaymentIntentMatch[1]));
  }
  const meetConfirmMatch = url.pathname.match(/^\/api\/v1\/meets\/([^/]+)\/confirm$/);
  if (meetConfirmMatch) {
    return handleMeetConfirm(req, res, decodeURIComponent(meetConfirmMatch[1]));
  }
  const meetShareVenueMatch = url.pathname.match(/^\/api\/v1\/meets\/([^/]+)\/share-venue$/);
  if (meetShareVenueMatch) {
    return handleMeetShareVenue(req, res, decodeURIComponent(meetShareVenueMatch[1]));
  }
  const adminMeetVenueUpdateMatch = url.pathname.match(
    /^\/api\/v1\/admin\/meets\/([^/]+)\/venue$/
  );
  if (adminMeetVenueUpdateMatch) {
    return handleAdminMeetVenueUpdate(req, res, decodeURIComponent(adminMeetVenueUpdateMatch[1]));
  }
  const adminGroupVenueUpdateMatch = url.pathname.match(
    /^\/api\/v1\/admin\/match-groups\/([^/]+)\/share-venue$/
  );
  if (adminGroupVenueUpdateMatch) {
    return handleAdminMatchGroupShareVenue(
      req,
      res,
      decodeURIComponent(adminGroupVenueUpdateMatch[1])
    );
  }
  const meetFeedbackMatch = url.pathname.match(/^\/api\/v1\/meets\/([^/]+)\/feedback$/);
  if (meetFeedbackMatch) {
    return handleMeetFeedback(req, res, decodeURIComponent(meetFeedbackMatch[1]));
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      success: true,
      data: {
        status: 'ok',
        service: 'hushh-backend',
        time: nowIso(),
      },
    });
  }

  if (url.pathname === '/admin') {
    if (req.method !== 'GET') return methodNotAllowed(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(renderAdminHtml());
    return;
  }

  if (url.pathname === '/api/v1/auth/sim/request') return handleSimRequest(req, res);
  if (url.pathname === '/api/v1/auth/sim/status') return handleSimStatus(req, res, url);
  if (url.pathname === '/api/v1/auth/sim/inbound-sms') return handleInboundSms(req, res);
  if (url.pathname === '/api/v1/auth/sim/provider-webhook') return handleInboundSmsProviderWebhook(req, res);
  if (url.pathname === '/api/v1/auth/sim/mock-verify') return handleMockVerify(req, res);
  if (url.pathname === '/api/v1/auth/token') return handleToken(req, res);
  if (url.pathname === '/api/v1/auth/otp/request') return handleOtpRequest(req, res);
  if (url.pathname === '/api/v1/auth/otp/verify') return handleOtpVerify(req, res);
  if (url.pathname === '/api/v1/auth/firebase/token') return handleFirebaseToken(req, res);
  if (url.pathname === '/api/v1/notifications/push-token') return handlePushToken(req, res);
  if (url.pathname === '/api/v1/auth/logout') return handleLogout(req, res);
  if (url.pathname === '/api/v1/payments/callback') return handlePaymentCallback(req, res);
  if (url.pathname === '/api/v1/payments/webhook') return handlePaymentWebhook(req, res);
  if (url.pathname === '/api/v1/onboarding/profile') return handleProfile(req, res);
  if (url.pathname === '/api/v1/auth/me') return handleMe(req, res);
  if (url.pathname === '/api/v1/voice-intros') return handleVoiceIntroCreate(req, res);
  if (url.pathname === '/api/v1/match-requests') return handleCreateMatchRequest(req, res);
  if (url.pathname === '/api/v1/match-requests/cancel-active') return handleCancelActiveMatchRequest(req, res);
  if (url.pathname === '/api/v1/match-requests/active') return handleGetActiveMatchRequest(req, res);
  if (url.pathname === '/api/v1/meets/active') return handleMeetActive(req, res);
  if (url.pathname === '/api/v1/meets/open') return handleMeetOpen(req, res);
  if (url.pathname === '/api/v1/meets/past') return handleMeetPast(req, res);
  if (url.pathname === '/api/v1/meets/found') return handleMeetFound(req, res);
  if (url.pathname === '/api/v1/users/block') return handleBlockUser(req, res);
  if (url.pathname === '/api/v1/users/unblock') return handleUnblockUser(req, res);
  if (url.pathname === '/api/v1/admin/overview') return handleAdminOverview(req, res);
  if (url.pathname === '/api/v1/admin/users') return handleAdminUsers(req, res);
  if (url.pathname === '/api/v1/admin/logs') return handleAdminLogs(req, res, url);
  if (url.pathname === '/api/v1/admin/db-status') return handleAdminDbStatus(req, res);
  if (url.pathname === '/api/v1/admin/match-queue') return handleAdminMatchQueue(req, res, url);
  if (url.pathname === '/api/v1/admin/meets') return handleAdminMeets(req, res, url);
  if (url.pathname === '/api/v1/admin/match-groups') return handleAdminMatchGroups(req, res, url);
  if (url.pathname === '/api/v1/admin/matcher/seed-demo-group') return handleAdminMatcherSeedDemo(req, res);
  if (url.pathname === '/api/v1/dev/matcher/seed-self') return handleDevMatcherSeedSelf(req, res);

  return notFound(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const startedAt = Date.now();
    const remote =
      req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    console.log(`[req] ${req.method} ${req.url} from ${remote}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    await route(req, res);
    const duration = Date.now() - startedAt;
    addRequestLog({
      time: nowIso(),
      method: req.method,
      path: req.url,
      status_code: res.statusCode,
      duration_ms: duration,
      remote_addr: String(remote),
      error: null,
    });
    console.log(
      `[res] ${req.method} ${req.url} -> ${res.statusCode} (${duration}ms)`
    );
  } catch (err) {
    console.error(`[err] ${req.method} ${req.url}:`, err?.message || err);
    const message = String(err?.message || 'Unexpected error');
    const isInvalidJson = message === 'Invalid JSON';
    const isTooLarge = message === 'Payload too large';
    const statusCode = isInvalidJson ? 400 : isTooLarge ? 413 : 500;
    const errorCode = isInvalidJson
      ? 'INVALID_JSON'
      : isTooLarge
        ? 'PAYLOAD_TOO_LARGE'
        : 'INTERNAL_SERVER_ERROR';
    addRequestLog({
      time: nowIso(),
      method: req.method,
      path: req.url,
      status_code: statusCode,
      duration_ms: 0,
      remote_addr: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown'),
      error: message,
    });
    sendJson(res, statusCode, {
      success: false,
      error: {
        code: errorCode,
        message,
      },
    });
  }
});

await initStore();
setInterval(() => {
  try {
    runMatchingCycle();
  } catch (error) {
    console.error('[matcher] cycle failed:', error?.message || error);
  }
}, MATCHER_INTERVAL_MS);

server.listen(PORT, HOST, () => {
  console.log(`[hushh-backend] running on http://${HOST}:${PORT}`);
  console.log(
    `[hushh-backend] auth_mode=${AUTH_MODE} firebase_api_key=${FIREBASE_WEB_API_KEY ? 'loaded' : 'missing'}`
  );
  console.log(
    `[hushh-backend] flags dev_match_helpers=${DEV_MATCH_HELPERS_ENABLED} admin_matcher_seed=${ADMIN_MATCHER_SEED_ENABLED}`
  );
});

process.on('SIGINT', async () => {
  await closeStore();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeStore();
  process.exit(0);
});
