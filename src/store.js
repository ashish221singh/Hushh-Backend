import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STORE_PATH = path.join(__dirname, '..', 'data', 'store.json');

const initialData = {
  verificationRequests: {},
  tokenIndex: {},
  sessions: {},
  users: {},
  pushTokens: {},
  phoneToUserId: {},
  meets: {},
  meetParticipants: {},
  payments: {},
  feedback: {},
  blockedUsers: {},
  voiceIntros: {},
  matchRequests: {},
  matchGroups: {},
  matchGroupMembers: {},
  matchEvents: {},
  requestLogs: [],
};

const usePostgres =
  String(process.env.USE_POSTGRES || '').toLowerCase() === 'true' ||
  Boolean(process.env.DATABASE_URL);

let prisma = null;
let persistChain = Promise.resolve();
let data = readFileStore();

function modelSupportsField(modelName, fieldName) {
  const model = prisma?._runtimeDataModel?.models?.[modelName];
  if (!model) return false;
  if (Array.isArray(model.fields)) {
    return model.fields.some((field) => field?.name === fieldName);
  }
  if (model.fields && typeof model.fields === 'object') {
    if (Object.prototype.hasOwnProperty.call(model.fields, fieldName)) return true;
    return Object.values(model.fields).some((field) => field?.name === fieldName);
  }
  return false;
}

function ensureStoreFile() {
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

function readFileStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...initialData, ...parsed };
  } catch {
    return { ...initialData };
  }
}

function saveFileStore(next) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), 'utf8');
}

function rebuildDerivedIndexes(snapshot) {
  const tokenIndex = {};
  Object.values(snapshot.verificationRequests || {}).forEach((item) => {
    if (item?.token) tokenIndex[item.token] = item.requestId;
  });

  const phoneToUserId = {};
  Object.values(snapshot.users || {}).forEach((user) => {
    if (user?.normalizedPhone && user?.userId) {
      phoneToUserId[user.normalizedPhone] = user.userId;
    }
  });

  return {
    ...snapshot,
    tokenIndex,
    phoneToUserId,
  };
}

async function loadFromPostgres() {
  const pushTokenPromise = prisma?.pushToken?.findMany
    ? prisma.pushToken.findMany()
    : Promise.resolve([]);

  const [
    verificationRequests,
    sessions,
    users,
    pushTokens,
    meets,
    meetParticipants,
    payments,
    feedback,
    blockedUsers,
    matchRequests,
    matchGroups,
    matchGroupMembers,
    matchEvents,
    requestLogs,
  ] = await Promise.all([
    prisma.verificationRequest.findMany(),
    prisma.session.findMany(),
    prisma.user.findMany(),
    pushTokenPromise,
    prisma.meet.findMany(),
    prisma.meetParticipant.findMany(),
    prisma.payment.findMany(),
    prisma.feedback.findMany(),
    prisma.blockedUser.findMany(),
    prisma.matchRequest.findMany(),
    prisma.matchGroup.findMany(),
    prisma.matchGroupMember.findMany(),
    prisma.matchEvent.findMany(),
    prisma.requestLog.findMany({ orderBy: { id: 'asc' } }),
  ]);

  const next = structuredClone(initialData);

  verificationRequests.forEach((item) => {
    next.verificationRequests[item.requestId] = {
      requestId: item.requestId,
      countryCode: item.countryCode,
      phone: item.phone,
      normalizedPhone: item.normalizedPhone,
      token: item.token,
      status: item.status,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      verifiedAt: item.verifiedAt || null,
    };
  });

  sessions.forEach((item) => {
    next.sessions[item.token] = {
      userId: item.userId,
      requestId: item.requestId,
      issuedAt: item.issuedAt,
      expiresAt: item.expiresAt,
    };
  });

  users.forEach((item) => {
    next.users[item.userId] = {
      userId: item.userId,
      countryCode: item.countryCode,
      phone: item.phone,
      normalizedPhone: item.normalizedPhone,
      createdAt: item.createdAt,
      profile: item.onboardingCompleted
        ? {
            fullName: item.profileFullName,
            gender: item.profileGender,
            age: item.profileAge,
            profession: item.profileProfession,
            updatedAt: item.profileUpdatedAt,
            onboardingCompleted: true,
          }
        : null,
    };
  });

  pushTokens.forEach((item) => {
    next.pushTokens[item.pushTokenId] = {
      pushTokenId: item.pushTokenId,
      userId: item.userId,
      pushToken: item.pushToken,
      platform: item.platform || null,
      deviceId: item.deviceId || null,
      status: item.status || 'ACTIVE',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  meets.forEach((item) => {
    next.meets[item.meetId] = {
      meetId: item.meetId,
      ownerUserId: item.ownerUserId,
      status: item.status,
      topicLabel: item.topicLabel,
      matchTimeLabel: item.matchTimeLabel,
      participantIds: item.participantIds || [],
      venueName: item.venueName,
      venueAddress: item.venueAddress,
      venueLat: item.venueLat ?? null,
      venueLng: item.venueLng ?? null,
      venueManagerName: item.venueManagerName || null,
      venuePhone: item.venuePhone || null,
      hostReview: item.hostReview || null,
      venueHidden: item.venueHidden,
      venueShareEtaMins: item.venueShareEtaMins,
      commitmentFeePaise: item.commitmentFeePaise,
      commitmentDeadlineAt: item.commitmentDeadlineAt || null,
      paymentStatus: item.paymentStatus,
      paymentId: item.paymentId,
      matchFoundPushSentAt: item.matchFoundPushSentAt || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  meetParticipants.forEach((item) => {
    next.meetParticipants[item.participantId] = {
      participantId: item.participantId,
      meetId: item.meetId,
      userId: item.userId,
      name: item.name,
      subtitle: item.subtitle,
      initial: item.initial,
      createdAt: item.createdAt,
    };
  });

  payments.forEach((item) => {
    next.payments[item.paymentId] = {
      paymentId: item.paymentId,
      meetId: item.meetId,
      userId: item.userId,
      amountPaise: item.amountPaise,
      currency: item.currency,
      status: item.status,
      receiptId: item.receiptId,
      confirmedAt: item.confirmedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  feedback.forEach((item) => {
    next.feedback[item.feedbackId] = {
      feedbackId: item.feedbackId,
      meetId: item.meetId,
      userId: item.userId,
      rating: item.rating,
      note: item.note,
      createdAt: item.createdAt,
    };
  });

  blockedUsers.forEach((item) => {
    next.blockedUsers[item.blockId] = {
      blockId: item.blockId,
      userId: item.userId,
      blockedUserId: item.blockedUserId,
      reason: item.reason,
      createdAt: item.createdAt,
    };
  });

  matchRequests.forEach((item) => {
    next.matchRequests[item.requestId] = {
      requestId: item.requestId,
      userId: item.userId,
      availabilityDate: item.availabilityDate,
      availabilitySlot: item.availabilitySlot,
      vibe: item.vibe,
      ageMin: item.ageMin,
      ageMax: item.ageMax,
      genderPreference: item.genderPreference,
      lat: item.lat,
      lng: item.lng,
      radiusKm: item.radiusKm,
      voiceDurationSec: item.voiceDurationSec,
      voiceIntroId: item.voiceIntroId || null,
      voiceStorageUrl: item.voiceStorageUrl || null,
      voiceMimeType: item.voiceMimeType || null,
      voiceSizeBytes: item.voiceSizeBytes ?? null,
      voiceRecordedAt: item.voiceRecordedAt || null,
      status: item.status,
      score: item.score,
      matchedGroupId: item.matchedGroupId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  matchGroups.forEach((item) => {
    next.matchGroups[item.groupId] = {
      groupId: item.groupId,
      status: item.status,
      availabilityDate: item.availabilityDate,
      availabilitySlot: item.availabilitySlot,
      vibe: item.vibe,
      score: item.score,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });

  matchGroupMembers.forEach((item) => {
    next.matchGroupMembers[item.memberId] = {
      memberId: item.memberId,
      groupId: item.groupId,
      userId: item.userId,
      requestId: item.requestId,
      createdAt: item.createdAt,
    };
  });

  matchEvents.forEach((item) => {
    next.matchEvents[item.eventId] = {
      eventId: item.eventId,
      requestId: item.requestId,
      groupId: item.groupId,
      type: item.type,
      message: item.message,
      payload: item.payload,
      createdAt: item.createdAt,
    };
  });

  next.requestLogs = requestLogs.map((item) => ({
    time: item.time,
    method: item.method,
    path: item.path,
    status_code: item.statusCode,
    duration_ms: item.durationMs,
    remote_addr: item.remoteAddr,
    error: item.error || null,
  }));

  return rebuildDerivedIndexes(next);
}

async function flushToPostgres(snapshot) {
  const safe = rebuildDerivedIndexes(snapshot);

  const verificationRows = Object.values(safe.verificationRequests || {}).map((item) => ({
    requestId: item.requestId,
    countryCode: item.countryCode,
    phone: item.phone,
    normalizedPhone: item.normalizedPhone,
    token: item.token,
    status: item.status,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    verifiedAt: item.verifiedAt || null,
  }));

  const sessionRows = Object.entries(safe.sessions || {}).map(([token, item]) => ({
    token,
    userId: item.userId,
    requestId: item.requestId,
    issuedAt: item.issuedAt,
    expiresAt: item.expiresAt,
  }));

  const userRows = Object.values(safe.users || {}).map((item) => ({
    userId: item.userId,
    countryCode: item.countryCode,
    phone: item.phone,
    normalizedPhone: item.normalizedPhone,
    createdAt: item.createdAt,
    profileFullName: item.profile?.fullName || null,
    profileGender: item.profile?.gender || null,
    profileAge: item.profile?.age ?? null,
    profileProfession: item.profile?.profession || null,
    profileUpdatedAt: item.profile?.updatedAt || null,
    onboardingCompleted: Boolean(item.profile?.onboardingCompleted),
  }));

  const pushTokenRows = Object.values(safe.pushTokens || {}).map((item) => ({
    pushTokenId: item.pushTokenId,
    userId: item.userId,
    pushToken: item.pushToken,
    platform: item.platform || null,
    deviceId: item.deviceId || null,
    status: item.status || 'ACTIVE',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  const supportsPushTokenModel = modelSupportsField('PushToken', 'pushTokenId');
  const supportsMeetPushSentAt = modelSupportsField('Meet', 'matchFoundPushSentAt');
  const supportsVenueLat = modelSupportsField('Meet', 'venueLat');
  const supportsVenueLng = modelSupportsField('Meet', 'venueLng');
  const supportsVenueManagerName = modelSupportsField('Meet', 'venueManagerName');
  const supportsVenuePhone = modelSupportsField('Meet', 'venuePhone');
  const supportsHostReview = modelSupportsField('Meet', 'hostReview');

  const meetRows = Object.values(safe.meets || {}).map((item) => {
    const row = {
      meetId: item.meetId,
      ownerUserId: item.ownerUserId,
      status: item.status,
      topicLabel: item.topicLabel || null,
      matchTimeLabel: item.matchTimeLabel || null,
      participantIds: item.participantIds || [],
      venueName: item.venueName || null,
      venueAddress: item.venueAddress || null,
      venueHidden: Boolean(item.venueHidden),
      venueShareEtaMins: item.venueShareEtaMins ?? null,
      commitmentFeePaise: item.commitmentFeePaise || 0,
      commitmentDeadlineAt: item.commitmentDeadlineAt || null,
      paymentStatus: item.paymentStatus || null,
      paymentId: item.paymentId || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
    if (supportsMeetPushSentAt) {
      row.matchFoundPushSentAt = item.matchFoundPushSentAt || null;
    }
    if (supportsVenueLat) row.venueLat = item.venueLat ?? null;
    if (supportsVenueLng) row.venueLng = item.venueLng ?? null;
    if (supportsVenueManagerName) row.venueManagerName = item.venueManagerName || null;
    if (supportsVenuePhone) row.venuePhone = item.venuePhone || null;
    if (supportsHostReview) row.hostReview = item.hostReview || null;
    return row;
  });

  const meetParticipantRows = Object.values(safe.meetParticipants || {}).map((item) => ({
    participantId: item.participantId,
    meetId: item.meetId,
    userId: item.userId || null,
    name: item.name,
    subtitle: item.subtitle,
    initial: item.initial,
    createdAt: item.createdAt,
  }));

  const paymentRows = Object.values(safe.payments || {}).map((item) => ({
    paymentId: item.paymentId,
    meetId: item.meetId,
    userId: item.userId,
    amountPaise: item.amountPaise,
    currency: item.currency,
    status: item.status,
    receiptId: item.receiptId,
    confirmedAt: item.confirmedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  const feedbackRows = Object.values(safe.feedback || {}).map((item) => ({
    feedbackId: item.feedbackId,
    meetId: item.meetId,
    userId: item.userId,
    rating: item.rating,
    note: item.note || null,
    createdAt: item.createdAt,
  }));

  const blockedRows = Object.values(safe.blockedUsers || {}).map((item) => ({
    blockId: item.blockId,
    userId: item.userId,
    blockedUserId: item.blockedUserId,
    reason: item.reason || null,
    createdAt: item.createdAt,
  }));

  const supportsVoiceIntroId = modelSupportsField('MatchRequest', 'voiceIntroId');
  const supportsVoiceStorageUrl = modelSupportsField('MatchRequest', 'voiceStorageUrl');
  const supportsVoiceMimeType = modelSupportsField('MatchRequest', 'voiceMimeType');
  const supportsVoiceSizeBytes = modelSupportsField('MatchRequest', 'voiceSizeBytes');
  const supportsVoiceRecordedAt = modelSupportsField('MatchRequest', 'voiceRecordedAt');

  const matchRequestRows = Object.values(safe.matchRequests || {}).map((item) => {
    const row = {
      requestId: item.requestId,
      userId: item.userId,
      availabilityDate: item.availabilityDate || null,
      availabilitySlot: item.availabilitySlot || null,
      vibe: item.vibe || null,
      ageMin: item.ageMin ?? null,
      ageMax: item.ageMax ?? null,
      genderPreference: item.genderPreference || null,
      lat: item.lat ?? null,
      lng: item.lng ?? null,
      radiusKm: item.radiusKm ?? null,
      voiceDurationSec: item.voiceDurationSec ?? null,
      status: item.status,
      score: item.score ?? null,
      matchedGroupId: item.matchedGroupId || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };

    if (supportsVoiceIntroId) row.voiceIntroId = item.voiceIntroId || null;
    if (supportsVoiceStorageUrl) row.voiceStorageUrl = item.voiceStorageUrl || null;
    if (supportsVoiceMimeType) row.voiceMimeType = item.voiceMimeType || null;
    if (supportsVoiceSizeBytes) row.voiceSizeBytes = item.voiceSizeBytes ?? null;
    if (supportsVoiceRecordedAt) row.voiceRecordedAt = item.voiceRecordedAt || null;
    return row;
  });

  const matchGroupRows = Object.values(safe.matchGroups || {}).map((item) => ({
    groupId: item.groupId,
    status: item.status,
    availabilityDate: item.availabilityDate || null,
    availabilitySlot: item.availabilitySlot || null,
    vibe: item.vibe || null,
    score: item.score ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  const matchGroupMemberRows = Object.values(safe.matchGroupMembers || {}).map((item) => ({
    memberId: item.memberId,
    groupId: item.groupId,
    userId: item.userId,
    requestId: item.requestId,
    createdAt: item.createdAt,
  }));

  const matchEventRows = Object.values(safe.matchEvents || {}).map((item) => ({
    eventId: item.eventId,
    requestId: item.requestId || null,
    groupId: item.groupId || null,
    type: item.type,
    message: item.message || null,
    payload: item.payload || null,
    createdAt: item.createdAt,
  }));

  const requestLogRows = (safe.requestLogs || []).map((item) => ({
    time: item.time,
    method: item.method,
    path: item.path,
    statusCode: Number(item.status_code) || 0,
    durationMs: Number(item.duration_ms) || 0,
    remoteAddr: String(item.remote_addr || ''),
    error: item.error || null,
  }));

  await prisma.$transaction(async (tx) => {
    await tx.requestLog.deleteMany();
    await tx.blockedUser.deleteMany();
    await tx.matchEvent.deleteMany();
    await tx.matchGroupMember.deleteMany();
    await tx.matchGroup.deleteMany();
    await tx.matchRequest.deleteMany();
    await tx.feedback.deleteMany();
    await tx.payment.deleteMany();
    await tx.meetParticipant.deleteMany();
    await tx.meet.deleteMany();
    if (supportsPushTokenModel && tx.pushToken?.deleteMany) {
      await tx.pushToken.deleteMany();
    }
    await tx.session.deleteMany();
    await tx.user.deleteMany();
    await tx.verificationRequest.deleteMany();

    if (verificationRows.length) await tx.verificationRequest.createMany({ data: verificationRows });
    if (userRows.length) await tx.user.createMany({ data: userRows });
    if (sessionRows.length) await tx.session.createMany({ data: sessionRows });
    if (supportsPushTokenModel && pushTokenRows.length && tx.pushToken?.createMany) {
      await tx.pushToken.createMany({ data: pushTokenRows });
    }
    if (meetRows.length) await tx.meet.createMany({ data: meetRows });
    if (meetParticipantRows.length) await tx.meetParticipant.createMany({ data: meetParticipantRows });
    if (paymentRows.length) await tx.payment.createMany({ data: paymentRows });
    if (feedbackRows.length) await tx.feedback.createMany({ data: feedbackRows });
    if (blockedRows.length) await tx.blockedUser.createMany({ data: blockedRows });
    if (matchRequestRows.length) await tx.matchRequest.createMany({ data: matchRequestRows });
    if (matchGroupRows.length) await tx.matchGroup.createMany({ data: matchGroupRows });
    if (matchGroupMemberRows.length) await tx.matchGroupMember.createMany({ data: matchGroupMemberRows });
    if (matchEventRows.length) await tx.matchEvent.createMany({ data: matchEventRows });
    if (requestLogRows.length) await tx.requestLog.createMany({ data: requestLogRows });
  });
}

function schedulePostgresFlush(snapshot) {
  if (!usePostgres || !prisma) return;
  const safeSnapshot = structuredClone(snapshot);
  persistChain = persistChain
    .then(() => flushToPostgres(safeSnapshot))
    .catch((error) => {
      console.error('[store] postgres flush failed:', error?.message || error);
    });
}

export async function initStore() {
  if (!usePostgres) {
    data = readFileStore();
    data = rebuildDerivedIndexes(data);
    return;
  }

  prisma = new PrismaClient();
  await prisma.$connect();
  data = await loadFromPostgres();

  const hasRows =
    Object.keys(data.users || {}).length > 0 ||
    Object.keys(data.verificationRequests || {}).length > 0 ||
    Object.keys(data.meets || {}).length > 0;
  if (!hasRows) {
    const fileSnapshot = rebuildDerivedIndexes(readFileStore());
    data = fileSnapshot;
    schedulePostgresFlush(data);
  }
}

export async function closeStore() {
  if (!usePostgres || !prisma) return;
  await persistChain.catch(() => {});
  await prisma.$disconnect();
}

export function getStore() {
  return data;
}

export function saveStore(next) {
  data = rebuildDerivedIndexes(next);
  if (usePostgres) {
    schedulePostgresFlush(data);
    return;
  }
  saveFileStore(data);
}

export function mutateStore(mutator) {
  const draft = structuredClone(data);
  mutator(draft);
  saveStore(draft);
  return draft;
}

export async function getStoreDiagnostics() {
  const snapshot = getStore();
  const counts = {
    users: Object.keys(snapshot.users || {}).length,
    push_tokens: Object.keys(snapshot.pushTokens || {}).length,
    sessions: Object.keys(snapshot.sessions || {}).length,
    verification_requests: Object.keys(snapshot.verificationRequests || {}).length,
    meets: Object.keys(snapshot.meets || {}).length,
    meet_participants: Object.keys(snapshot.meetParticipants || {}).length,
    payments: Object.keys(snapshot.payments || {}).length,
    feedback: Object.keys(snapshot.feedback || {}).length,
    blocked_users: Object.keys(snapshot.blockedUsers || {}).length,
    voice_intros: Object.keys(snapshot.voiceIntros || {}).length,
    match_requests: Object.keys(snapshot.matchRequests || {}).length,
    match_groups: Object.keys(snapshot.matchGroups || {}).length,
    match_group_members: Object.keys(snapshot.matchGroupMembers || {}).length,
    match_events: Object.keys(snapshot.matchEvents || {}).length,
    request_logs: (snapshot.requestLogs || []).length,
  };

  if (!usePostgres || !prisma) {
    return {
      mode: 'file',
      healthy: true,
      database_url_configured: Boolean(process.env.DATABASE_URL),
      counts,
      details: {
        provider: 'json-file',
        store_path: STORE_PATH,
      },
    };
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      mode: 'postgres',
      healthy: true,
      database_url_configured: Boolean(process.env.DATABASE_URL),
      counts,
      details: {
        provider: 'postgresql',
      },
    };
  } catch (error) {
    return {
      mode: 'postgres',
      healthy: false,
      database_url_configured: Boolean(process.env.DATABASE_URL),
      counts,
      details: {
        provider: 'postgresql',
        error: error?.message || 'db_check_failed',
      },
    };
  }
}
