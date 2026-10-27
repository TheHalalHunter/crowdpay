const crypto = require('crypto');
const ff = require('./featureFlags');
const logger = require('../config/logger');

function isKycRequiredForCampaigns() {
  return ff.isEnabled('kyc-required-for-campaigns');
}

function appBaseUrl() {
  return (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(
    /\/$/,
    ''
  );
}

function devKycSession({ user }) {
  const reference = `dev_kyc_${user.id}_${crypto.randomBytes(8).toString('hex')}`;
  return {
    provider: 'dev',
    providerReference: reference,
    redirectUrl: `${appBaseUrl()}/dashboard?kyc=started&reference=${encodeURIComponent(reference)}`,
    sessionToken: reference,
  };
}

async function createPersonaInquiry({ user }) {
  if (!process.env.PERSONA_API_KEY || !process.env.PERSONA_TEMPLATE_ID) {
    throw new Error(
      'Persona KYC is not configured. Set PERSONA_API_KEY and PERSONA_TEMPLATE_ID, or set KYC_PROVIDER=dev for local development.'
    );
  }

  const response = await fetch('https://withpersona.com/api/v1/inquiries', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PERSONA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      data: {
        type: 'inquiry',
        attributes: {
          'inquiry-template-id': process.env.PERSONA_TEMPLATE_ID,
          'reference-id': user.id,
          'redirect-uri': `${appBaseUrl()}/dashboard?kyc=returned`,
          fields: {
            name: user.name,
            email: user.email,
          },
        },
      },
    }),
  });

  const body = await response.json().catch(err => {
    logger.warn('Could not parse Persona inquiry response body', {
      status: response.status,
      error: err.message,
    });
    return {};
  });
  if (!response.ok) {
    const message =
      body?.errors?.[0]?.detail || body?.errors?.[0]?.title || 'Could not create KYC session';
    throw new Error(message);
  }

  const inquiry = body.data || {};
  return {
    provider: 'persona',
    providerReference: inquiry.id,
    redirectUrl: inquiry.attributes?.['inquiry-url'] || inquiry.attributes?.['hosted-inquiry-url'],
    sessionToken: inquiry.attributes?.['session-token'] || null,
  };
}

async function createKycSession({ user }) {
  const provider = String(process.env.KYC_PROVIDER || 'persona').toLowerCase();

  if (provider === 'dev') {
    return devKycSession({ user });
  }

  if (provider === 'persona') {
    return createPersonaInquiry({ user });
  }

  throw new Error(`Unsupported KYC_PROVIDER "${provider}". Use "persona" or "dev".`);
}

const VERIFICATION_TIER_LIMITS = {
  none: 0,
  basic: 5000,
  standard: 50000,
  enhanced: Infinity,
};

function getTierLimit(tier) {
  return VERIFICATION_TIER_LIMITS[tier] ?? 0;
}

function determineVerificationTier(webhookPayload = {}) {
  const data = webhookPayload.data || webhookPayload;
  const attrs = data.attributes || {};
  const nested = attrs.payload?.data || webhookPayload.payload?.data || {};
  const nestedAttrs = nested.attributes || {};

  const checks = nestedAttrs.checks || attrs.checks || [];
  const tags = nestedAttrs.tags || attrs.tags || [];
  const verificationPackages =
    nestedAttrs['verification-packages'] ||
    nestedAttrs.verification_packages ||
    attrs['verification-packages'] ||
    [];

  const checkTypes = new Set();
  for (const check of checks) {
    const checkType = (check.type || check.name || check['check-type'] || '').toLowerCase();
    if (checkType) checkTypes.add(checkType);
  }

  for (const pkg of verificationPackages) {
    const methods = pkg.methods || pkg.checks || [];
    for (const method of methods) {
      const name = (method.name || method.type || method['check-type'] || '').toLowerCase();
      if (name) checkTypes.add(name);
    }
  }

  const tagSet = new Set(Array.isArray(tags) ? tags.map(String) : []);

  const hasLiveness =
    checkTypes.has('liveness') ||
    checkTypes.has('face-detection') ||
    checkTypes.has('selfie') ||
    checkTypes.has('liveness_check') ||
    tagSet.has('liveness') ||
    tagSet.has('selfie');

  const hasAddress =
    checkTypes.has('address') ||
    checkTypes.has('address-verification') ||
    checkTypes.has('proof-of-address') ||
    checkTypes.has('address-check') ||
    tagSet.has('address');

  const hasGovernmentId =
    checkTypes.has('government-id') ||
    checkTypes.has('id-document') ||
    checkTypes.has('document') ||
    checkTypes.has('government_id') ||
    checkTypes.has('id_check') ||
    tagSet.has('government-id') ||
    tagSet.has('id-document');

  if (hasGovernmentId || hasLiveness || hasAddress || checkTypes.size > 0) {
    if (hasLiveness && hasAddress && hasGovernmentId) return 'enhanced';
    if (hasAddress && hasGovernmentId) return 'standard';
    if (hasGovernmentId) return 'basic';
    if (hasLiveness) return 'enhanced';
    if (hasAddress) return 'standard';
  }

  return 'basic';
}

function extractWebhookResult(payload = {}) {
  const data = payload.data || payload;
  const attrs = data.attributes || {};
  const nested = attrs.payload?.data || payload.payload?.data || {};
  const nestedAttrs = nested.attributes || {};
  const eventName = attrs.name || data.type || payload.event || payload.type || '';
  const status =
    nestedAttrs.status ||
    nestedAttrs['review-status'] ||
    attrs.status ||
    attrs['review-status'] ||
    payload.status ||
    payload.verification?.status ||
    '';
  const reference =
    nested.id ||
    data.id ||
    nestedAttrs['inquiry-id'] ||
    nestedAttrs.inquiry_id ||
    attrs['inquiry-id'] ||
    attrs.inquiry_id ||
    payload.inquiry_id ||
    payload.applicant_id ||
    payload.verification?.id ||
    payload.resource?.id ||
    null;
  const userId =
    nestedAttrs['reference-id'] ||
    nestedAttrs.reference_id ||
    attrs['reference-id'] ||
    attrs.reference_id ||
    payload.reference_id ||
    payload.vendorData ||
    payload.verification?.vendorData ||
    payload.user_id ||
    null;

  const reason =
    nestedAttrs['decline-reason'] ||
    nestedAttrs.decline_reason ||
    nestedAttrs['failure-reason'] ||
    nestedAttrs.failure_reason ||
    attrs['decline-reason'] ||
    attrs.decline_reason ||
    attrs.note ||
    payload.reason ||
    null;

  const normalized = String(status || eventName).toLowerCase();
  let kycStatus = 'pending';
  let verificationStatus = 'pending';
  if (
    normalized.includes('approved') ||
    normalized.includes('completed') ||
    normalized.includes('verified') ||
    normalized === 'success' ||
    normalized.includes('passed')
  ) {
    kycStatus = 'verified';
    verificationStatus = 'approved';
  } else if (
    normalized.includes('declined') ||
    normalized.includes('failed') ||
    normalized.includes('rejected') ||
    normalized.includes('expired')
  ) {
    kycStatus = 'rejected';
    verificationStatus = 'declined';
  }

  let tier = 'none';
  if (verificationStatus === 'approved') {
    tier = determineVerificationTier(payload);
  }

  return { providerReference: reference, userId, kycStatus, verificationStatus, tier, reason };
}

const PERSONA_WEBHOOK_MAX_AGE_SECONDS = 300;

function verifyPersonaWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PERSONA_WEBHOOK_SECRET;
  if (!secret) {
    return (
      process.env.NODE_ENV === 'test' ||
      String(process.env.KYC_PROVIDER || '').toLowerCase() === 'dev'
    );
  }

  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return false;
  }

  const parts = signatureHeader.split(',');
  let timestamp = null;
  const signatures = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }

  if (!timestamp || !signatures.length) {
    return false;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const parsedTimestamp = parseInt(timestamp, 10);
  if (
    !timestamp ||
    isNaN(parsedTimestamp) ||
    nowSec - parsedTimestamp > PERSONA_WEBHOOK_MAX_AGE_SECONDS
  ) {
    return false;
  }

  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${bodyStr}`)
    .digest('hex');

  return signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  });
}

module.exports = {
  createKycSession,
  extractWebhookResult,
  isKycRequiredForCampaigns,
  verifyPersonaWebhookSignature,
  determineVerificationTier,
  getTierLimit,
  VERIFICATION_TIER_LIMITS,
};
