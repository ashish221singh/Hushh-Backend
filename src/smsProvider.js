import crypto from 'crypto';

const DEFAULT_PROVIDER = String(process.env.SMS_PROVIDER || 'mock').toLowerCase();
const DEFAULT_DESTINATION = process.env.SIM_VERIFY_DESTINATION || '+919900000001';
const SMS_WEBHOOK_SECRET = String(process.env.SMS_WEBHOOK_SECRET || '');

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function getSmsProviderName() {
  return DEFAULT_PROVIDER;
}

export function buildVerificationSmsPayload({
  token,
  countryCode,
  phone,
  normalizedPhone,
}) {
  const message = `HUSHH VERIFY ${token}`;

  if (DEFAULT_PROVIDER === 'direct') {
    return {
      provider: DEFAULT_PROVIDER,
      sms_destination: normalizedPhone || `${countryCode || '+91'}${phone || ''}`,
      sms_body: message,
      provider_meta: { mode: 'device-compose' },
    };
  }

  // For provider-based inbound verification, destination can remain a shared provider number.
  return {
    provider: DEFAULT_PROVIDER,
    sms_destination: process.env.SMS_VERIFY_DESTINATION || DEFAULT_DESTINATION,
    sms_body: message,
    provider_meta: { mode: 'provider-inbound' },
  };
}

export function verifySmsWebhookSignature(rawBody, headers = {}) {
  if (!SMS_WEBHOOK_SECRET) return true;
  const provided =
    headers['x-sms-signature'] ||
    headers['x-webhook-signature'] ||
    headers['x-signature'] ||
    '';
  if (!provided) return false;
  const digest = crypto
    .createHmac('sha256', SMS_WEBHOOK_SECRET)
    .update(String(rawBody || ''), 'utf8')
    .digest('hex');
  if (provided.length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(digest));
}

export function normalizeInboundSmsPayload(body = {}) {
  // Canonical format support
  const canonicalFrom = String(body.from || '').trim();
  const canonicalMessage = String(body.message || '').trim();
  if (canonicalFrom && canonicalMessage) {
    return { from: canonicalFrom, message: canonicalMessage };
  }

  const provider = DEFAULT_PROVIDER;
  if (provider === 'twilio') {
    return {
      from: String(body.From || body.from || '').trim(),
      message: String(body.Body || body.message || '').trim(),
    };
  }

  if (provider === 'msg91') {
    return {
      from: String(body.sender || body.mobile || body.from || '').trim(),
      message: String(body.text || body.message || '').trim(),
    };
  }

  if (provider === 'exotel') {
    return {
      from: String(body.From || body.from || body.Caller || '').trim(),
      message: String(body.Body || body.message || body.Text || '').trim(),
    };
  }

  return {
    from: String(body.from || '').trim(),
    message: String(body.message || '').trim(),
  };
}

export function normalizeSmsSenderPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const d = digits(raw);
  if (!d) return '';
  if (d.length <= 10) return `+91${d}`;
  return `+${d}`;
}

