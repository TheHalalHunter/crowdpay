const crypto = require('crypto');
const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const {
  ensureCustodialAccountFundedAndTrusted,
  getSupportedAssetCodes,
} = require('../services/stellarService');
const { PUBLIC_CAMPAIGN_SELECT } = require('../lib/publicCampaignColumns');
const {
  buildContributionIntent,
  submitCustodialContribution,
} = require('../services/contributionService');
const {
  getAvailableAnchors,
  getAnchorById,
  publicAnchorInfo,
  isAnchorConfigured,
  authenticateWithAnchor,
  startInteractiveDeposit,
  getAnchorTransaction,
  isAnchorFailureStatus,
} = require('../services/anchorService');

// ── SEP-24 callback signature verification ───────────────────────────────────
// Providers sign POST /api/anchor/callbacks/sep24 with HMAC-SHA256 using the
// shared ANCHOR_CALLBACK_HMAC_SECRET. The signature is sent as:
//   X-Anchor-Signature: sha256=<lowercase-hex-digest>
// Timestamp freshness is validated via X-Anchor-Timestamp (Unix seconds).
// Both headers are required in production.

const CALLBACK_REPLAY_WINDOW_SECONDS =
  parseInt(process.env.ANCHOR_CALLBACK_REPLAY_WINDOW_SECONDS, 10) || 300;

/**
 * Verify the HMAC-SHA256 signature on an inbound provider callback.
 * Uses timing-safe comparison. Accepts an optional `sha256=` prefix.
 *
 * @param {Buffer|string} rawBody  Exact bytes received (before JSON parsing)
 * @param {string}        headerSig  Value of X-Anchor-Signature
 * @returns {boolean}
 */
function verifyCallbackSignature(rawBody, headerSig) {
  const secret = process.env.ANCHOR_CALLBACK_HMAC_SECRET;
  if (!secret) {
    // In test / development, skip verification when the secret is not set.
    const env = process.env.NODE_ENV || 'development';
    if (env === 'production') {
      logger.error(
        'ANCHOR_CALLBACK_HMAC_SECRET is not set — rejecting all callbacks in production'
      );
      return false;
    }
    logger.warn('ANCHOR_CALLBACK_HMAC_SECRET not set; skipping signature check (non-production)');
    return true;
  }

  if (!headerSig) return false;
  const provided = String(headerSig)
    .replace(/^sha256=/i, '')
    .trim();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf;
  try {
    providedBuf = Buffer.from(provided, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== providedBuf.length || providedBuf.length === 0) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Validate that the X-Anchor-Timestamp header is within the replay window.
 * Returns false if the timestamp is absent, non-numeric, or too old/future.
 *
 * @param {string|undefined} timestampHeader  Raw header value (Unix seconds string)
 * @returns {boolean}
 */
function isTimestampFresh(timestampHeader) {
  if (!timestampHeader) return false;
  const ts = parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.abs(nowSec - ts) <= CALLBACK_REPLAY_WINDOW_SECONDS;
}

// ── Idempotency key for provider events ──────────────────────────────────────
// We store processed provider event IDs in Redis so a redelivery cannot credit
// a customer twice.  The TTL is intentionally longer than the replay window so
// there is no gap between "replay window closed" and "idempotency forgotten".

const EVENT_IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 3600; // 7 days

/**
 * Check (and record) whether a provider event has already been processed.
 * Returns true the FIRST time an event ID is seen; false on subsequent calls.
 *
 * If Redis is unavailable this fails OPEN (returns true) so we never silently
 * drop a legitimate callback — the contribution service's own DB-level
 * idempotency key still prevents double-credits.
 *
 * @param {string} eventId  Stable opaque event/transaction ID from the provider
 * @returns {Promise<boolean>}  true = first delivery, false = duplicate
 */
async function claimProviderEvent(eventId) {
  const redis = require('../config/redis');
  const key = `anchor:event:${eventId}`;
  try {
    // SET NX returns 'OK' on first set, null if the key already existed.
    const result = await redis.set(key, '1', 'EX', EVENT_IDEMPOTENCY_TTL_SECONDS, 'NX');
    return result === 'OK';
  } catch (err) {
    logger.error('anchor event idempotency Redis error; failing open', {
      eventId,
      error: err.message,
    });
    return true; // fail open — DB idempotency is the last line of defence
  }
}

// ── DTO validation for SEP-24 callback payload ───────────────────────────────

const VALID_SEP24_STATUSES = new Set([
  'completed',
  'error',
  'expired',
  'no_market',
  'too_small',
  'too_large',
  'refunded',
  'pending_user_transfer_start',
  'pending_user_transfer_complete',
  'pending_anchor',
  'pending_external',
  'pending_stellar',
  'pending_trust',
  'pending_user',
  'incomplete',
]);

/**
 * Validate and normalise the SEP-24 callback transaction object.
 * Returns `{ valid: false, error, field }` for any invalid payload so callers
 * can return a 4xx without executing any business logic.
 *
 * @param {unknown} rawBody
 * @returns {{ valid: true, transaction: object }|{ valid: false, error: string, field: string }}
 */
function validateCallbackPayload(rawBody) {
  // rawBody arrives as a Buffer (express.raw middleware) — parse JSON manually.
  let parsed;
  try {
    const str = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    parsed = JSON.parse(str);
  } catch {
    return { valid: false, error: 'Invalid JSON', field: 'body' };
  }

  // Providers may wrap the transaction under a "transaction" key (SEP-24 style)
  // or send it at the root level.
  const transaction =
    parsed && typeof parsed === 'object' && parsed.transaction ? parsed.transaction : parsed;

  if (!transaction || typeof transaction !== 'object') {
    return { valid: false, error: 'Payload must be a JSON object', field: 'body' };
  }

  if (!transaction.id || typeof transaction.id !== 'string' || !transaction.id.trim()) {
    return {
      valid: false,
      error: 'transaction.id is required and must be a non-empty string',
      field: 'id',
    };
  }

  if (!transaction.status || typeof transaction.status !== 'string') {
    return { valid: false, error: 'transaction.status is required', field: 'status' };
  }

  const status = transaction.status.toLowerCase();
  if (!VALID_SEP24_STATUSES.has(status)) {
    return {
      valid: false,
      error: `transaction.status "${transaction.status}" is not a recognised SEP-24 status`,
      field: 'status',
    };
  }

  return { valid: true, transaction: { ...transaction, status } };
}

// ── Route helpers ─────────────────────────────────────────────────────────────

function mapSessionForClient(row) {
  const session = {
    id: row.id,
    anchor_id: row.anchor_id,
    anchor_transaction_id: row.anchor_transaction_id,
    anchor_asset: row.anchor_asset,
    anchor_amount: row.anchor_amount,
    deposit_type: row.deposit_type,
    status: row.status,
    anchor_status: row.last_anchor_status,
    interactive_url: row.interactive_url,
    last_error: row.last_error,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
  if (row.campaign_id) {
    session.campaign_id = row.campaign_id;
    session.contribution_amount = row.contribution_amount;
    session.contribution_tx_hash = row.contribution_tx_hash;
    session.contribution_id = row.contribution_id;
    session.conversion_quote = row.conversion_quote;
  }
  return session;
}

async function loadUserWallet(userId) {
  const { rows } = await db.query(
    'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [userId]
  );
  return rows[0] || null;
}

async function loadCampaignForContribution(campaignId) {
  const { rows } = await db.query(
    `SELECT ${PUBLIC_CAMPAIGN_SELECT}, u.email AS creator_email FROM campaigns c JOIN users u ON u.id = c.creator_id WHERE c.id = $1 AND c.status = $2`,
    [campaignId, 'active']
  );
  return rows[0] || null;
}

async function issueAnchorAuthToken({ anchor, user }) {
  return withDecryptedWalletSecret(
    user.wallet_secret_encrypted,
    { userId: user.id, walletPublicKey: user.wallet_public_key },
    async userSecret =>
      authenticateWithAnchor({
        anchor,
        userPublicKey: user.wallet_public_key,
        userSecret,
      })
  );
}

async function ensureAnchorAuth({ anchor, sessionRow, user }) {
  if (
    sessionRow.anchor_auth_token &&
    sessionRow.anchor_auth_expires_at &&
    new Date(sessionRow.anchor_auth_expires_at) > new Date(Date.now() + 30_000)
  ) {
    return {
      token: sessionRow.anchor_auth_token,
      expiresAt: sessionRow.anchor_auth_expires_at,
      refreshed: false,
    };
  }

  const auth = await issueAnchorAuthToken({ anchor, user });
  await db.query(
    `UPDATE anchor_deposits SET anchor_auth_token = $1, anchor_auth_expires_at = $2, updated_at = NOW() WHERE id = $3`,
    [auth.token, auth.expiresAt, sessionRow.id]
  );
  return { ...auth, refreshed: true };
}

// ── Public info endpoints (no auth) ──────────────────────────────────────────

router.get('/info', (_req, res) => {
  res.json({
    supported_assets: getSupportedAssetCodes(),
    anchors: getAvailableAnchors().map(publicAnchorInfo),
  });
});

router.get('/sep24/assets', (_req, res) => {
  res.json({
    supported_assets: getSupportedAssetCodes(),
    anchors: getAvailableAnchors().map(publicAnchorInfo),
  });
});

// ── Authenticated deposit-initiation endpoints ────────────────────────────────
// Both endpoints accept an optional Idempotency-Key header so a client retry
// after a network timeout cannot create a second deposit session.

router.post(
  '/deposits/start',
  requireAuth,
  idempotency('anchor:deposit:start'),
  asyncHandler(async (req, res) => {
    const { campaign_id, amount, anchor_id } = req.body || {};
    if (!campaign_id || !amount || !anchor_id) {
      return res.status(400).json({ error: 'campaign_id, amount and anchor_id are required' });
    }

    const anchor = getAnchorById(anchor_id);
    if (!anchor) {
      return res.status(404).json({ error: 'Anchor not found' });
    }
    if (!isAnchorConfigured(anchor)) {
      return res
        .status(503)
        .json({ error: 'This anchor is not configured for the current backend environment' });
    }
    if (!getSupportedAssetCodes().includes(anchor.assetCode)) {
      return res.status(409).json({
        error: `Anchor asset ${anchor.assetCode} is not enabled in CrowdPay's Stellar asset config`,
      });
    }

    const campaign = await loadCampaignForContribution(campaign_id);
    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found or no longer active' });
    }

    const user = await loadUserWallet(req.user.userId);
    if (!user) {
      return res.status(404).json({ error: 'User wallet not found' });
    }

    try {
      const session = await withDecryptedWalletSecret(
        user.wallet_secret_encrypted,
        { userId: user.id, walletPublicKey: user.wallet_public_key },
        async userSecret => {
          await ensureCustodialAccountFundedAndTrusted({
            publicKey: user.wallet_public_key,
            secret: userSecret,
          });

          const auth = await authenticateWithAnchor({
            anchor,
            userPublicKey: user.wallet_public_key,
            userSecret,
          });
          const intent = await buildContributionIntent({
            campaign,
            amount,
            sendAsset: anchor.assetCode,
            contributorPublicKey: user.wallet_public_key,
          });
          const anchorAmount = intent.kind === 'payment' ? String(amount) : intent.sendMax;

          // Use full-entropy reference (128 bits) instead of a truncated UUID
          // slice so collisions over the deposit lifetime are negligible.
          const depositReference = `dep_${crypto.randomBytes(16).toString('hex')}`;

          const interactive = await startInteractiveDeposit({
            anchor,
            authToken: auth.token,
            userPublicKey: user.wallet_public_key,
            amount: anchorAmount,
            memo: depositReference,
          });

          const { rows } = await db.query(
            `INSERT INTO anchor_deposits
               (user_id, campaign_id, anchor_id, anchor_transaction_id, anchor_asset, anchor_amount,
                campaign_asset, contribution_amount, contribution_flow, conversion_quote, interactive_url,
                anchor_auth_token, anchor_auth_expires_at, status, last_anchor_status, last_anchor_payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13,
                     'pending_anchor', $14, $15::jsonb)
             RETURNING *`,
            [
              user.id,
              campaign_id,
              anchor.id,
              interactive.id,
              anchor.assetCode,
              anchorAmount,
              campaign.asset_type,
              String(amount),
              JSON.stringify(intent),
              JSON.stringify(intent.conversionQuote),
              interactive.url,
              auth.token,
              auth.expiresAt,
              interactive.status || 'pending_anchor',
              JSON.stringify(interactive),
            ]
          );

          return rows[0];
        }
      );

      return res.status(201).json({
        ...mapSessionForClient(session),
        anchor: publicAnchorInfo(anchor),
      });
    } catch (err) {
      const status = err.statusCode || 503;
      logger.error('Anchor deposit start failed', {
        anchor_id,
        campaign_id,
        user_id: req.user.userId,
        error: err.message,
      });
      return res.status(status).json({
        error: err.message || 'Could not start the anchor deposit flow right now',
      });
    }
  })
);

router.post(
  '/sep24/deposit',
  requireAuth,
  idempotency('anchor:sep24:deposit'),
  asyncHandler(async (req, res) => {
    const { amount, anchor_id } = req.body || {};
    if (!amount || !anchor_id) {
      return res.status(400).json({ error: 'amount and anchor_id are required' });
    }

    const anchor = getAnchorById(anchor_id);
    if (!anchor) {
      return res.status(404).json({ error: 'Anchor not found' });
    }
    if (!isAnchorConfigured(anchor)) {
      return res
        .status(503)
        .json({ error: 'This anchor is not configured for the current backend environment' });
    }
    if (!getSupportedAssetCodes().includes(anchor.assetCode)) {
      return res.status(409).json({
        error: `Anchor asset ${anchor.assetCode} is not enabled in CrowdPay's Stellar asset config`,
      });
    }

    const { rows: userRows } = await db.query(
      'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!userRows.length) {
      return res.status(404).json({ error: 'User wallet not found' });
    }
    const user = userRows[0];

    try {
      const session = await withDecryptedWalletSecret(
        user.wallet_secret_encrypted,
        { userId: user.id, walletPublicKey: user.wallet_public_key },
        async userSecret => {
          await ensureCustodialAccountFundedAndTrusted({
            publicKey: user.wallet_public_key,
            secret: userSecret,
          });

          const auth = await authenticateWithAnchor({
            anchor,
            userPublicKey: user.wallet_public_key,
            userSecret,
          });

          // Full-entropy deposit reference (128 bits).
          const depositReference = `dep_${crypto.randomBytes(16).toString('hex')}`;

          const interactive = await startInteractiveDeposit({
            anchor,
            authToken: auth.token,
            userPublicKey: user.wallet_public_key,
            amount: String(amount),
            memo: depositReference,
          });

          const { rows } = await db.query(
            `INSERT INTO anchor_deposits
               (user_id, deposit_type, anchor_id, anchor_transaction_id, anchor_asset, anchor_amount,
                interactive_url, anchor_auth_token, anchor_auth_expires_at, status,
                last_anchor_status, last_anchor_payload)
             VALUES ($1, 'wallet', $2, $3, $4, $5, $6, $7, $8, 'pending_anchor', $9, $10::jsonb)
             RETURNING *`,
            [
              user.id,
              anchor.id,
              interactive.id,
              anchor.assetCode,
              String(amount),
              interactive.url,
              auth.token,
              auth.expiresAt,
              interactive.status || 'pending_anchor',
              JSON.stringify(interactive),
            ]
          );

          return rows[0];
        }
      );

      return res.status(201).json({
        ...mapSessionForClient(session),
        anchor: publicAnchorInfo(anchor),
      });
    } catch (err) {
      await db
        .query(
          'UPDATE users SET wallet_funding_failed_at = NOW() WHERE id = $1 AND wallet_funded_at IS NULL',
          [req.user.userId]
        )
        .catch(() => {});
      const status = err.statusCode || 503;
      logger.error('SEP-24 wallet deposit start failed', {
        anchor_id,
        user_id: req.user.userId,
        error: err.message,
      });
      return res.status(status).json({
        error: err.message || 'Could not start the wallet deposit flow right now',
      });
    }
  })
);

// ── Authenticated deposit status polling ──────────────────────────────────────

router.get(
  '/deposits/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT ad.*, u.wallet_public_key, u.wallet_secret_encrypted
     FROM anchor_deposits ad
     JOIN users u ON u.id = ad.user_id
     WHERE ad.id = $1 AND ad.user_id = $2`,
      [req.params.id, req.user.userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Anchor deposit session not found' });
    }

    let session = rows[0];
    const anchor = getAnchorById(session.anchor_id);
    if (!anchor) {
      return res
        .status(503)
        .json({ error: 'This anchor is no longer available in the current backend configuration' });
    }

    const user = {
      id: req.user.userId,
      wallet_public_key: session.wallet_public_key,
      wallet_secret_encrypted: session.wallet_secret_encrypted,
    };

    try {
      let auth = await ensureAnchorAuth({ anchor, sessionRow: session, user });
      let remote;
      try {
        remote = await getAnchorTransaction({
          anchor,
          authToken: auth.token,
          transactionId: session.anchor_transaction_id,
        });
      } catch (err) {
        if (err.statusCode !== 401) throw err;
        auth = await issueAnchorAuthToken({ anchor, user });
        await db.query(
          `UPDATE anchor_deposits SET anchor_auth_token = $1, anchor_auth_expires_at = $2, updated_at = NOW() WHERE id = $3`,
          [auth.token, auth.expiresAt, session.id]
        );
        remote = await getAnchorTransaction({
          anchor,
          authToken: auth.token,
          transactionId: session.anchor_transaction_id,
        });
      }

      const remoteTx = remote.transaction || remote;
      const remoteStatus = remoteTx.status || session.last_anchor_status || 'pending_anchor';
      let localStatus = session.status;
      if (isAnchorFailureStatus(remoteStatus)) {
        localStatus = 'failed';
      } else if (remoteStatus === 'completed' && session.contribution_id) {
        localStatus = 'completed';
      } else if (remoteStatus === 'completed' && session.contribution_tx_hash) {
        localStatus = 'contribution_submitted';
      } else if (remoteStatus === 'completed') {
        localStatus = 'deposit_completed';
      } else {
        localStatus = 'pending_anchor';
      }

      const remoteError =
        remoteTx.message ||
        remoteTx.error ||
        (localStatus === 'failed' ? 'Anchor deposit failed' : null);

      await db.query(
        `UPDATE anchor_deposits
       SET status = $1,
           last_anchor_status = $2,
           last_anchor_payload = $3::jsonb,
           last_error = CASE WHEN $1 = 'failed' THEN COALESCE($5, last_error) ELSE last_error END,
           updated_at = NOW(),
           completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN COALESCE(completed_at, NOW()) ELSE completed_at END
       WHERE id = $4`,
        [localStatus, remoteStatus, JSON.stringify(remoteTx), session.id, remoteError]
      );

      session = {
        ...session,
        status: localStatus,
        last_anchor_status: remoteStatus,
        last_anchor_payload: remoteTx,
      };

      if (localStatus === 'failed' && session.deposit_type === 'wallet') {
        await db.query(
          `UPDATE users SET wallet_funding_failed_at = NOW() WHERE id = $1 AND wallet_funded_at IS NULL`,
          [session.user_id]
        );
      }

      if (
        remoteStatus === 'completed' &&
        !session.contribution_tx_hash &&
        !session.contribution_id
      ) {
        if (session.deposit_type === 'wallet') {
          await db.query(
            `UPDATE anchor_deposits SET status = 'completed', last_error = NULL, updated_at = NOW(), completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`,
            [session.id]
          );
          await db.query(
            `UPDATE users SET wallet_funded_at = COALESCE(wallet_funded_at, NOW()), wallet_funding_failed_at = NULL WHERE id = $1`,
            [session.user_id]
          );
        } else {
          const campaign = await loadCampaignForContribution(session.campaign_id);
          if (!campaign) {
            await db.query(
              `UPDATE anchor_deposits SET status = 'failed', last_error = $1, updated_at = NOW(), completed_at = COALESCE(completed_at, NOW()) WHERE id = $2`,
              [
                'Deposit completed, but the campaign is no longer accepting contributions.',
                session.id,
              ]
            );
          } else {
            try {
              const result = await submitCustodialContribution({
                campaign,
                campaignId: session.campaign_id,
                userId: req.user.userId,
                walletPublicKey: session.wallet_public_key,
                walletSecretEncrypted: session.wallet_secret_encrypted,
                amount: session.contribution_amount,
                sendAsset: session.anchor_asset,
                intentOverride: session.contribution_flow,
                anchorMetadata: {
                  anchor_id: session.anchor_id,
                  anchor_transaction_id: session.anchor_transaction_id,
                  anchor_asset: session.anchor_asset,
                  anchor_amount: session.anchor_amount,
                  anchor_deposit_id: session.id,
                },
              });

              await db.query(
                `UPDATE anchor_deposits SET status = 'contribution_submitted', contribution_tx_hash = $1, contribution_stellar_transaction_id = $2, last_error = NULL, updated_at = NOW() WHERE id = $3`,
                [result.txHash, result.stellarTransactionId, session.id]
              );
            } catch (err) {
              logger.error('Anchor contribution submission failed after deposit completion', {
                anchor_deposit_id: session.id,
                error: err.message,
              });
              await db.query(
                `UPDATE anchor_deposits SET status = 'deposit_completed', last_error = $1, updated_at = NOW() WHERE id = $2`,
                [
                  err.message || 'Contribution submission failed after deposit completion',
                  session.id,
                ]
              );
            }
          }
        }
      }

      const { rows: refreshed } = await db.query('SELECT * FROM anchor_deposits WHERE id = $1', [
        session.id,
      ]);
      return res.json(mapSessionForClient(refreshed[0]));
    } catch (err) {
      logger.error('Anchor deposit status sync failed', {
        anchor_deposit_id: session.id,
        error: err.message,
      });
      return res.status(err.statusCode || 502).json({
        error: err.message || 'Could not refresh anchor transaction status',
      });
    }
  })
);

// ── Public provider callback endpoint ────────────────────────────────────────
// POST /api/anchor/callbacks/sep24
//
// This endpoint is PUBLIC — providers cannot present a CrowdPay API key.
// Protection is provided by:
//   1. HMAC-SHA256 signature over the raw request body (X-Anchor-Signature)
//   2. Timestamp freshness check to prevent replay attacks (X-Anchor-Timestamp)
//   3. Per-event idempotency via Redis so a redelivery cannot credit twice
//
// Error semantics — providers retry only on 5xx:
//   4xx  Permanent rejection: bad signature, stale timestamp, malformed payload,
//        resource not found, duplicate event. Provider MUST NOT retry.
//   5xx  Transient failure: DB error, contribution submission error. Provider
//        SHOULD retry with backoff.

router.post('/callbacks/sep24', async (req, res) => {
  const rawBody = req.body; // Buffer — set by the raw body parser in index.js

  // ── 1. Signature verification ──────────────────────────────────────────────
  const sigHeader = req.headers['x-anchor-signature'];
  if (!verifyCallbackSignature(rawBody, sigHeader)) {
    logger.warn('SEP-24 callback rejected: invalid signature', {
      ip: req.ip,
      sigHeader: sigHeader ? sigHeader.slice(0, 20) + '…' : '(absent)',
    });
    return res.status(401).json({ error: 'Invalid callback signature' });
  }

  // ── 2. Replay window (timestamp freshness) ─────────────────────────────────
  const secret = process.env.ANCHOR_CALLBACK_HMAC_SECRET;
  if (secret) {
    // Only enforce timestamp when a real secret is configured. In dev/test the
    // HMAC check already passed without a secret, so no replay protection is
    // needed (there is nothing to forge).
    const tsHeader = req.headers['x-anchor-timestamp'];
    if (!isTimestampFresh(tsHeader)) {
      logger.warn('SEP-24 callback rejected: stale or missing timestamp', {
        ip: req.ip,
        ts: tsHeader,
        windowSeconds: CALLBACK_REPLAY_WINDOW_SECONDS,
      });
      return res.status(401).json({
        error: `Callback timestamp missing or outside replay window (±${CALLBACK_REPLAY_WINDOW_SECONDS}s)`,
      });
    }
  }

  // ── 3. Payload validation (DTO) ────────────────────────────────────────────
  const validation = validateCallbackPayload(rawBody);
  if (!validation.valid) {
    logger.warn('SEP-24 callback rejected: invalid payload', {
      error: validation.error,
      field: validation.field,
    });
    return res.status(400).json({ error: validation.error, field: validation.field });
  }

  const { transaction } = validation;
  const providerEventId = transaction.id;

  // ── 4. Per-event idempotency ───────────────────────────────────────────────
  // Claim the event before any business logic so concurrent redeliveries
  // cannot race and credit twice.
  const isFirstDelivery = await claimProviderEvent(providerEventId);
  if (!isFirstDelivery) {
    logger.info('SEP-24 callback: duplicate event ignored', { providerEventId });
    // 200 — acknowledged, duplicate. Provider MUST NOT retry.
    return res.status(200).json({ received: true, duplicate: true });
  }

  // ── 5. Business logic ──────────────────────────────────────────────────────
  try {
    // Deduplication: ignore replayed callbacks for the same anchor transaction
    // Must be before the session lookup to short-circuit before any DB reads
    try {
      await db.query('INSERT INTO webhook_events(event_source, event_id) VALUES ($1, $2)', [
        'anchor',
        transaction.id,
      ]);
    } catch (dupErr) {
      if (dupErr.code === '23505') {
        return res.status(200).json({ success: true, duplicate: true });
      }
      throw dupErr;
    }

    const { rows } = await db.query(
      `SELECT ad.*, u.wallet_public_key, u.wallet_secret_encrypted
       FROM anchor_deposits ad
       JOIN users u ON u.id = ad.user_id
       WHERE ad.anchor_transaction_id = $1`,
      [providerEventId]
    );

    if (!rows.length) {
      // 4xx — we have no record of this transaction; no retry will help.
      return res
        .status(404)
        .json({ error: 'Anchor deposit session not found for this transaction ID' });
    }

    const session = rows[0];

    // Re-fetch the transaction from the anchor to avoid trusting the callback body
    const anchor = getAnchorById(session.anchor_id);
    if (!anchor) {
      return res.status(503).json({ error: 'Anchor not found' });
    }
    const user = {
      id: session.user_id,
      wallet_public_key: session.wallet_public_key,
      wallet_secret_encrypted: session.wallet_secret_encrypted,
    };
    let auth;
    try {
      auth = await issueAnchorAuthToken({ anchor, user });
    } catch (authErr) {
      logger.warn('Could not obtain anchor auth for re-fetch in callback', {
        anchor_deposit_id: session.id,
        error: authErr.message,
      });
      return res.status(503).json({ error: 'Could not verify transaction status with anchor' });
    }
    let remoteTx;
    try {
      const remote = await getAnchorTransaction({
        anchor,
        authToken: auth.token,
        transactionId: session.anchor_transaction_id,
      });
      remoteTx = remote.transaction || remote;
    } catch (fetchErr) {
      logger.warn('Anchor transaction re-fetch failed in callback', {
        anchor_deposit_id: session.id,
        error: fetchErr.message,
      });
      return res.status(503).json({ error: 'Could not re-verify transaction status with anchor' });
    }
    const remoteStatus = remoteTx.status;
    let localStatus = session.status;

    if (isAnchorFailureStatus(remoteStatus)) {
      localStatus = 'failed';
    } else if (remoteStatus === 'completed' && session.contribution_id) {
      localStatus = 'completed';
    } else if (remoteStatus === 'completed' && session.contribution_tx_hash) {
      localStatus = 'contribution_submitted';
    } else if (remoteStatus === 'completed') {
      localStatus = 'deposit_completed';
    } else {
      localStatus = 'pending_anchor';
    }

    const remoteError =
      transaction.message ||
      transaction.error ||
      (localStatus === 'failed' ? 'Anchor deposit failed' : null);

    // Transient DB errors below will escape the try/catch and become 500.
    await db.query(
      `UPDATE anchor_deposits
       SET status = $1,
           last_anchor_status = $2,
           last_anchor_payload = $3::jsonb,
           last_error = CASE WHEN $1 = 'failed' THEN COALESCE($5, last_error) ELSE last_error END,
           updated_at = NOW(),
           completed_at = CASE WHEN $1 IN ('completed', 'failed') THEN COALESCE(completed_at, NOW()) ELSE completed_at END
       WHERE id = $4`,
      [localStatus, remoteStatus, JSON.stringify(transaction), session.id, remoteError]
    );

    if (localStatus === 'failed' && session.deposit_type === 'wallet') {
      await db.query(
        `UPDATE users SET wallet_funding_failed_at = NOW() WHERE id = $1 AND wallet_funded_at IS NULL`,
        [session.user_id]
      );
    }

    if (remoteStatus === 'completed' && !session.contribution_tx_hash && !session.contribution_id) {
      if (session.deposit_type === 'wallet') {
        await db.query(
          `UPDATE anchor_deposits SET status = 'completed', last_error = NULL, updated_at = NOW(), completed_at = COALESCE(completed_at, NOW()) WHERE id = $1`,
          [session.id]
        );
        await db.query(
          `UPDATE users SET wallet_funded_at = COALESCE(wallet_funded_at, NOW()), wallet_funding_failed_at = NULL WHERE id = $1`,
          [session.user_id]
        );
      } else {
        const campaign = await loadCampaignForContribution(session.campaign_id);
        if (!campaign) {
          // 4xx — permanent; the campaign is gone and no retry will revive it.
          await db.query(
            `UPDATE anchor_deposits SET status = 'failed', last_error = $1, updated_at = NOW(), completed_at = COALESCE(completed_at, NOW()) WHERE id = $2`,
            [
              'Deposit completed, but the campaign is no longer accepting contributions.',
              session.id,
            ]
          );
          return res.status(422).json({
            error: 'Deposit completed but the associated campaign is no longer active',
            code: 'CAMPAIGN_NOT_ACTIVE',
          });
        }

        // Pass the provider event ID as the idempotency key so a contribution
        // submission triggered by a redelivery that slipped through the Redis
        // check (e.g. Redis eviction) is still deduplicated at the DB layer.
        const result = await submitCustodialContribution({
          campaign,
          campaignId: session.campaign_id,
          userId: session.user_id,
          walletPublicKey: session.wallet_public_key,
          walletSecretEncrypted: session.wallet_secret_encrypted,
          amount: session.contribution_amount,
          sendAsset: session.anchor_asset,
          intentOverride: session.contribution_flow,
          idempotencyKey: `anchor:${providerEventId}`,
          anchorMetadata: {
            anchor_id: session.anchor_id,
            anchor_transaction_id: session.anchor_transaction_id,
            anchor_asset: session.anchor_asset,
            anchor_amount: session.anchor_amount,
            anchor_deposit_id: session.id,
          },
        });

        await db.query(
          `UPDATE anchor_deposits SET status = 'contribution_submitted', contribution_tx_hash = $1, contribution_stellar_transaction_id = $2, last_error = NULL, updated_at = NOW() WHERE id = $3`,
          [result.txHash, result.stellarTransactionId, session.id]
        );
      }
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    // Any unhandled error (DB connectivity, Stellar submission, etc.) is a
    // transient failure — return 5xx so the provider retries.
    logger.error('SEP-24 callback processing failed (transient)', {
      providerEventId,
      error: err.message,
    });
    // Release the Redis idempotency claim so retries are accepted.
    const redis = require('../config/redis');
    redis.del(`anchor:event:${providerEventId}`).catch(() => {});
    return res.status(500).json({ error: 'Internal error processing callback; please retry' });
  }
});

module.exports = router;
