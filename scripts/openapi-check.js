import fs from 'fs';
import path from 'path';

const file = path.resolve(process.cwd(), 'openapi.yaml');

function fail(message) {
  console.error(`[openapi-check] failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(file)) fail('openapi.yaml not found');
const text = fs.readFileSync(file, 'utf8');
if (!text.trim()) fail('openapi.yaml is empty');
if (text.includes('\t')) fail('openapi.yaml contains tab characters; use spaces only');

const mustContain = [
  /^openapi:\s*3\.0\.3$/m,
  /^info:\s*$/m,
  /^\s{2}version:\s*1\.0\.0\s*$/m,
  /^paths:\s*$/m,
  /^components:\s*$/m,
  /^\s{2}schemas:\s*$/m,
  /^\s{2}securitySchemes:\s*$/m,
  /^\s{4}ErrorEnvelope:\s*$/m,
  /^\s{4}SuccessEnvelopeAny:\s*$/m,
];

for (const pattern of mustContain) {
  if (!pattern.test(text)) fail(`missing required section: ${pattern}`);
}

const requiredPaths = [
  '/health',
  '/api/v1/auth/sim/request',
  '/api/v1/auth/sim/status',
  '/api/v1/auth/sim/inbound-sms',
  '/api/v1/auth/sim/provider-webhook',
  '/api/v1/auth/sim/mock-verify',
  '/api/v1/auth/token',
  '/api/v1/auth/otp/request',
  '/api/v1/auth/otp/verify',
  '/api/v1/auth/firebase/token',
  '/api/v1/auth/logout',
  '/api/v1/auth/me',
  '/api/v1/onboarding/profile',
  '/api/v1/voice-intros',
  '/api/v1/match-requests',
  '/api/v1/match-requests/active',
  '/api/v1/match-requests/cancel-active',
  '/api/v1/match-requests/{request_id}/cancel',
  '/api/v1/meets/open',
  '/api/v1/meets/found',
  '/api/v1/meets/active',
  '/api/v1/meets/{meet_id}/payment-intent',
  '/api/v1/meets/{meet_id}/confirm',
  '/api/v1/meets/{meet_id}/share-venue',
  '/api/v1/meets/{meet_id}/feedback',
  '/api/v1/payments/callback',
  '/api/v1/payments/webhook',
  '/api/v1/users/block',
  '/api/v1/users/unblock',
  '/api/v1/admin/overview',
  '/api/v1/admin/users',
  '/api/v1/admin/logs',
  '/api/v1/admin/db-status',
  '/api/v1/admin/match-queue',
  '/api/v1/admin/matcher/seed-demo-group',
  '/api/v1/dev/matcher/seed-self',
];

for (const p of requiredPaths) {
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s{2}${escaped}:\\s*$`, 'm');
  if (!pattern.test(text)) fail(`missing path: ${p}`);
}

const opCount = (text.match(/\n\s{4}(get|post):\s*\n/g) || []).length;
if (opCount < requiredPaths.length) {
  fail(`expected at least ${requiredPaths.length} operations, found ${opCount}`);
}

console.log('[openapi-check] all checks passed');
