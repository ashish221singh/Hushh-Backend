import crypto from 'crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function toMs(minutes) {
  return minutes * 60 * 1000;
}

export function randomId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function randomToken(size = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < size; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export function randomSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function normalizePhone(countryCode, phone) {
  const cc = String(countryCode || '').replace(/\s+/g, '');
  const number = String(phone || '').replace(/\D/g, '');
  return `${cc}${number}`;
}

export function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

export function notFound(res) {
  sendJson(res, 404, {
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
}

export function methodNotAllowed(res) {
  sendJson(res, 405, {
    success: false,
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed',
    },
  });
}

export function validateProfileInput(body) {
  const fullName = String(body.full_name || '').trim();
  const gender = String(body.gender || '').trim();
  const age = Number(body.age);
  const profession = String(body.profession || '').trim();

  if (fullName.length < 2) {
    return { ok: false, message: 'full_name must be at least 2 characters' };
  }
  if (!['Male', 'Female', 'Other'].includes(gender)) {
    return { ok: false, message: 'gender must be Male, Female, or Other' };
  }
  if (!Number.isInteger(age) || age < 18 || age > 99) {
    return { ok: false, message: 'age must be an integer between 18 and 99' };
  }
  if (profession.length < 2) {
    return { ok: false, message: 'profession must be at least 2 characters' };
  }

  return {
    ok: true,
    value: {
      fullName,
      gender,
      age,
      profession,
    },
  };
}
