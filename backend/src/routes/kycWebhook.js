const db = require('../config/database');
const logger = require('../config/logger');
const { extractWebhookResult, verifyPersonaWebhookSignature } = require('../services/kycProvider');
const { sendKycApprovedEmail, sendKycRejectedEmail } = require('../services/emailService');
const {
  issueKycAttestation,
  attestationTypeForTier,
} = require('../services/contributorIdentityService');

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

async function handleKycWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).set('Allow', 'POST').json({ error: 'Method not allowed' });
  }
  try {
    const rawBody = req.body;
    const signatureHeader = req.headers['persona-signature'] || req.headers['Persona-Signature'];

    if (!verifyPersonaWebhookSignature(rawBody, signatureHeader)) {
      return res.status(401).json({ error: 'Invalid Persona webhook signature' });
    }

    let payload;
    try {
      const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
      payload = JSON.parse(bodyStr);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    const eventId = payload?.data?.id || null;
    if (eventId) {
      try {
        await db.query('INSERT INTO webhook_events(event_source, event_id) VALUES ($1, $2)', [
          'persona',
          eventId,
        ]);
      } catch (dupErr) {
        if (dupErr.code === '23505') {
          return res.status(200).json({ received: true, duplicate: true });
        }
        throw dupErr;
      }
    }

    const result = extractWebhookResult(payload);
    if (!result.providerReference && !result.userId) {
      return res.status(400).json({ error: 'KYC webhook payload missing provider reference' });
    }

    if (!['verified', 'rejected', 'pending'].includes(result.kycStatus)) {
      return res.status(400).json({ error: 'Unsupported KYC status' });
    }

    const eventType =
      result.kycStatus === 'verified'
        ? 'inquiry.approved'
        : result.kycStatus === 'rejected'
          ? 'inquiry.declined'
          : 'inquiry.pending';
    const prior = await db.query(
      'SELECT 1 FROM kyc_events WHERE persona_inquiry_id = $1 AND event_type = $2 LIMIT 1',
      [result.providerReference, eventType]
    );
    if (prior.rows.length) {
      return res.json({ received: true, duplicate: true });
    }

    const params = [result.kycStatus, result.providerReference || null];
    let lookup = 'kyc_provider_reference = $2';
    if (result.userId) {
      params.push(result.userId);
      lookup = `(kyc_provider_reference = $2 OR id = $3)`;
    }

    const { rows } = await db.query(
      `UPDATE users
       SET kyc_status = $1::kyc_status,
           kyc_provider_reference = COALESCE($2, kyc_provider_reference),
           kyc_completed_at = CASE WHEN $1::kyc_status = 'verified' THEN NOW() ELSE NULL END,
           verification_status = CASE
             WHEN $1::kyc_status = 'verified' THEN 'approved'::verification_status
             WHEN $1::kyc_status = 'rejected' THEN 'declined'::verification_status
             ELSE verification_status
           END,
           verification_tier = CASE
             WHEN $1::kyc_status = 'verified' THEN COALESCE($4::verification_tier, verification_tier)
             WHEN $1::kyc_status = 'rejected' THEN 'none'::verification_tier
             ELSE verification_tier
           END,
           persona_inquiry_id = COALESCE($2, persona_inquiry_id)
       WHERE ${lookup}
       RETURNING id, email, name, kyc_status, kyc_completed_at, verification_status, verification_tier, wallet_public_key`,
      [...params, result.tier || 'basic']
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'KYC subject not found' });
    }

    // Record the KYC event for audit trail
    try {
      await db.query(
        `INSERT INTO kyc_events (user_id, persona_inquiry_id, event_type, tier_granted, decline_reason, received_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [
          rows[0].id,
          result.providerReference,
          eventType,
          result.tier || null,
          result.reason || null,
        ]
      );
    } catch (eventErr) {
      logger.warn('Failed to record KYC event', { user_id: rows[0].id, error: eventErr.message });
    }

    // Issue on-chain KYC attestation (#689) when the verification is approved.
    // Fire-and-forget — a Soroban RPC hiccup must not block the webhook response.
    if (rows[0].kyc_status === 'verified' && rows[0].wallet_public_key) {
      issueKycAttestation(
        rows[0].wallet_public_key,
        rows[0].id,
        result.tier || 'basic',
        result.providerReference
      ).catch(err =>
        logger.warn('KYC on-chain attestation failed', {
          user_id: rows[0].id,
          error: err.message,
        })
      );
    }

    if (rows[0].email) {
      if (rows[0].kyc_status === 'verified') {
        sendKycApprovedEmail({
          to: rows[0].email,
          userId: rows[0].id,
          name: rows[0].name,
          dashboardUrl: `${frontendBaseUrl()}/dashboard`,
        }).catch(err => logger.error('KYC approved email failed', { error: err.message }));
      } else if (rows[0].kyc_status === 'rejected') {
        sendKycRejectedEmail({
          to: rows[0].email,
          userId: rows[0].id,
          name: rows[0].name,
          reason: result.reason,
          retryUrl: `${frontendBaseUrl()}/dashboard?kyc=retry`,
        }).catch(err => logger.error('KYC rejected email failed', { error: err.message }));
      }
    }

    res.json({
      received: true,
      user_id: rows[0].id,
      kyc_status: rows[0].kyc_status,
      kyc_completed_at: rows[0].kyc_completed_at,
      verification_status: rows[0].verification_status,
      verification_tier: rows[0].verification_tier,
    });
  } catch (err) {
    logger.error('KYC webhook handler failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = handleKycWebhook;
