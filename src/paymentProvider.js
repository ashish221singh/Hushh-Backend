import crypto from 'crypto';

const PROVIDER = String(process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
const WEBHOOK_SECRET = String(process.env.PAYMENT_WEBHOOK_SECRET || '');

export function getPaymentProviderName() {
  return PROVIDER;
}

export function getPaymentClientAction() {
  if (PROVIDER === 'mock') {
    return {
      type: 'SIMULATED_CONFIRM',
      callback_path: '/api/v1/payments/callback',
    };
  }
  return {
    type: 'GATEWAY_REDIRECT',
    callback_path: '/api/v1/payments/callback',
  };
}

export function buildPaymentIntentProviderMeta(payment, meet) {
  if (!payment || !meet) return {};

  if (PROVIDER === 'razorpay') {
    return {
      order_id: `order_${String(payment.paymentId).replace(/^pay_/, '')}`,
      amount_paise: payment.amountPaise,
      currency: payment.currency || 'INR',
    };
  }

  if (PROVIDER === 'stripe') {
    return {
      payment_intent_id: `pi_${String(payment.paymentId).replace(/^pay_/, '')}`,
      amount_paise: payment.amountPaise,
      currency: String(payment.currency || 'INR').toLowerCase(),
    };
  }

  return {
    reference_id: payment.paymentId,
    amount_paise: payment.amountPaise,
    currency: payment.currency || 'INR',
  };
}

export function verifyPaymentWebhookSignature(rawBody, headers = {}) {
  if (!WEBHOOK_SECRET) return true;
  const signature =
    headers['x-payment-signature'] ||
    headers['x-webhook-signature'] ||
    headers['x-signature'] ||
    '';
  if (!signature) return false;
  const digest = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(String(rawBody || ''), 'utf8')
    .digest('hex');
  if (String(signature).length !== digest.length) return false;
  return crypto.timingSafeEqual(Buffer.from(String(signature)), Buffer.from(digest));
}

export function normalizePaymentWebhookPayload(body = {}) {
  // Canonical shape
  if (body.payment_id && body.status) {
    return {
      payment_id: String(body.payment_id).trim(),
      status: String(body.status).trim(),
      receipt_id: body.receipt_id ? String(body.receipt_id).trim() : null,
    };
  }

  if (PROVIDER === 'razorpay') {
    const paymentId =
      body?.payload?.payment?.entity?.id ||
      body?.payload?.payment?.id ||
      body?.payment_id ||
      '';
    const status =
      body?.payload?.payment?.entity?.status ||
      body?.payload?.payment?.status ||
      body?.status ||
      '';
    return {
      payment_id: String(paymentId).trim(),
      status: String(status).trim().toUpperCase(),
      receipt_id: body?.payload?.payment?.entity?.order_id
        ? String(body.payload.payment.entity.order_id)
        : null,
    };
  }

  if (PROVIDER === 'stripe') {
    const obj = body?.data?.object || {};
    const mappedStatus =
      String(obj.status || '').toLowerCase() === 'succeeded' ? 'CONFIRMED' : String(obj.status || '');
    return {
      payment_id: String(obj.id || body.payment_id || '').trim(),
      status: String(mappedStatus).trim().toUpperCase(),
      receipt_id: obj.latest_charge ? String(obj.latest_charge) : null,
    };
  }

  return {
    payment_id: String(body.payment_id || '').trim(),
    status: String(body.status || '').trim().toUpperCase(),
    receipt_id: body.receipt_id ? String(body.receipt_id).trim() : null,
  };
}

