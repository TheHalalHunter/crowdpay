const router = require('express').Router();
const db = require('../config/database');
const logger = require('../config/logger');
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const { sendAlert } = require('../services/alerting');
const { withdrawalValidation, validateRequest } = require('../middleware/validation');
const {
  buildWithdrawalTransaction,
  getAccountMultisigConfig,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
  isXdrExpired,
  getPlatformPublicKey,
  validateSubmittedWithdrawalXdr,
  validateWithdrawalForPlatformSigning,
  WithdrawalValidationError,
} = require('../services/stellarService');
const { calculateCreatorShare } = require('../services/feeRegistry');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
} = require('../services/stellarTransactionService');
const {
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
} = require('../services/emailService');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const {
  assertCustodialWithdrawalAllowed,
  CustodialSigningLimitError,
} = require('../services/custodialSigningPolicy');
const { createNotification } = require('../services/notifications');
const { notifyContributorFundRelease } = require('../services/fundReleaseNotifications');
const { calculateCommissions, settleCommissions } = require('../services/referral');
const { parsePagination } = require('../utils/pagination');
const asyncHandler = require('../utils/asyncHandler');
const withTransaction = require('../utils/withTransaction');
const { toStroops, fromStroops } = require('../utils/stroops');
const { logAuditEvent } = require('../services/auditService');

async function recordPayoutAudit(payload) {
  try {
    return await logAuditEvent(payload);
  } catch (err) {
    logger.error('Payout audit event failed', {
      action: payload.action,
      resource_id: payload.resourceId,
      error: err.message,
    });
    return null;
  }
}

const ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST = ['active', 'funded'];

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function emitWithdrawalUpdated(creatorId, withdrawalRow) {
  if (!creatorId) return;
  emitWebhookEventForUser(creatorId, WEBHOOK_EVENTS.WITHDRAWAL_UPDATED, {
    withdrawal: withdrawalRow,
  }).catch(err => logger.error('Withdrawal updated webhook emit failed', { error: err.message }));
}

/** Fail closed when PLATFORM_APPROVER_USER_ID is unset. */
function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

async function requirePlatformApprover(req, res, next) {
  if (!canPerformPlatformSignature(req.user.userId)) {
    return res
      .status(403)
      .json({ error: 'Only the designated platform approver can perform this action' });
  }

  const { rows } = await db.query('SELECT role, is_admin FROM users WHERE id = $1', [
    req.user.userId,
  ]);
  if (!rows.length || (rows[0].role !== 'admin' && !rows[0].is_admin)) {
    return res.status(403).json({ error: 'Account no longer has platform authorization' });
  }

  next();
}

/**
 * @openapi
 * tags:
 *   - name: Withdrawals
 *     description: Withdrawal requests and audit timeline
 */

function hasSigner(signers, publicKey) {
  return signers.some(s => s.key === publicKey && s.weight >= 1);
}

async function logWithdrawalEvent(
  client,
  { withdrawalRequestId, actorUserId, action, note, metadata }
) {
  const runner = client || db;
  await runner.query(
    `INSERT INTO withdrawal_approval_events
       (withdrawal_request_id, actor_user_id, action, note, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      withdrawalRequestId,
      actorUserId || null,
      action,
      note || null,
      metadata ? JSON.stringify(metadata) : null,
    ]
  );
}

async function checkOwnerAccess(req, campaignId) {
  if (req.user.role === 'admin' || req.user.is_admin) return true;

  const { rows: campaignRows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
    campaignId,
  ]);
  if (campaignRows.length && campaignRows[0].creator_id === req.user.userId) {
    return true;
  }

  const { rows: memberRows } = await db.query(
    "SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND role = 'owner'",
    [campaignId, req.user.userId]
  );
  if (memberRows.length && memberRows[0].accepted_at) {
    return true;
  }

  return false;
}

async function assertWithdrawalAccess(req, campaignId) {
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) return { error: 'Campaign not found', status: 404 };

  const isOwner = await checkOwnerAccess(req, campaignId);
  if (!isOwner) {
    return { error: 'Not authorized to view or manage withdrawals for this campaign', status: 403 };
  }
  return { creatorId: rows[0].creator_id, isCreator: true, isAdmin: req.user.role === 'admin' };
}

router.get('/capabilities', requireAuth, (req, res) => {
  res.json({ can_approve_platform: canPerformPlatformSignature(req.user.userId) });
});

router.post(
  '/request',
  requireAuth,
  withdrawalValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/withdrawals/request:
     *   post:
     *     tags: [Withdrawals]
     *     summary: Create a pending withdrawal request
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [campaign_id, destination_key, amount]
     *             properties:
     *               campaign_id: { type: string }
     *               destination_key: { type: string }
     *               amount: { type: string }
     *     responses:
     *       201:
     *         description: Created
     *       401:
     *         description: Unauthorized
     *       403:
     *         description: Forbidden
     *       404:
     *         description: Campaign not found
     */
    const { campaign_id, destination_key, amount, evidence } = req.body;

    if (!evidence || !Array.isArray(evidence) || evidence.length === 0) {
      return res.status(400).json({
        error: 'Evidence array (receipts, invoices, or links) is required for withdrawals',
      });
    }

    const { rows: campaigns } = await db.query(
      `SELECT id, creator_id, wallet_public_key, asset_type, status,
            (SELECT COUNT(*)::int FROM milestones m WHERE m.campaign_id = campaigns.id) AS milestone_count
     FROM campaigns WHERE id = $1`,
      [campaign_id]
    );
    if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = campaigns[0];

    const isOwner = await checkOwnerAccess(req, campaign_id);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only campaign owners can request withdrawals' });
    }
    if (campaign.milestone_count > 0) {
      return res.status(409).json({
        error:
          'This campaign uses milestone releases. Funds are released through approved milestones instead of manual withdrawals.',
      });
    }
    if (campaign.status === 'failed') {
      return res.status(400).json({
        error:
          'This campaign has failed. Contributors are eligible for refunds — withdrawals are not permitted.',
      });
    }
    if (!ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(campaign.status)) {
      return res.status(409).json({
        error: `Withdrawals cannot be requested while campaign status is "${campaign.status}".`,
      });
    }

    // Block withdrawals while a dispute is open or under review
    const { rows: activeDisputes } = await db.query(
      `SELECT id FROM disputes
     WHERE campaign_id = $1 AND status IN ('open', 'under_review') LIMIT 1`,
      [campaign_id]
    );
    if (activeDisputes.length) {
      return res.status(403).json({
        error: 'Withdrawals are blocked while an active dispute is open for this campaign.',
        dispute_id: activeDisputes[0].id,
      });
    }

    const { rows: pending } = await db.query(
      `SELECT id FROM withdrawal_requests
     WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
      [campaign_id]
    );
    if (pending.length) {
      return res.status(409).json({
        error:
          'A pending withdrawal already exists for this campaign. Cancel it or wait for completion before opening another.',
      });
    }

    const { rows: creatorRows } = await db.query(
      'SELECT wallet_public_key FROM users WHERE id = $1',
      [req.user.userId]
    );
    const creatorPublicKey = creatorRows[0]?.wallet_public_key || null;

    const multisig = await getAccountMultisigConfig(campaign.wallet_public_key);
    if (
      multisig.thresholds.med_threshold < 2 ||
      !hasSigner(multisig.signers, creatorPublicKey) ||
      !hasSigner(multisig.signers, getPlatformPublicKey())
    ) {
      return res.status(422).json({
        error:
          'Campaign wallet multisig config invalid: creator + platform signatures are required',
      });
    }

    // Calculate collected platform fees for this campaign
    const { rows: feeRows } = await db.query(
      `SELECT COALESCE(SUM(platform_fee_amount), 0) as total_fees
     FROM contributions
     WHERE campaign_id = $1 AND refunded = FALSE`,
      [campaign_id]
    );
    const collectedFees = Number(feeRows?.[0]?.total_fees) || 0;

    // Referral commissions are settled out of the campaign balance in the same
    // transaction as the creator payout (#675).
    const { commissions, totalCommission } = await calculateCommissions(campaign_id);
    const payableCommissions = commissions.filter(
      commission =>
        commission.destination_public_key &&
        toStroops(commission.commission_owed, { allowZero: true }) > 0n
    );
    const commissionTotal = payableCommissions.reduce(
      (sum, commission) => sum + toStroops(commission.commission_owed, { allowZero: true }),
      0n
    );
    const creatorAmountStroops = toStroops(amount) - commissionTotal;
    const creatorAmount = fromStroops(creatorAmountStroops);

    if (creatorAmountStroops <= 0n) {
      return res.status(422).json({
        error: `Referral commissions of ${totalCommission} ${campaign.asset_type} exceed the requested withdrawal amount. Withdraw a larger amount.`,
        code: 'COMMISSIONS_EXCEED_WITHDRAWAL',
        total_commission: totalCommission,
      });
    }

    let creatorShare = 0;
    if (collectedFees > 0 && creatorPublicKey) {
      creatorShare = await calculateCreatorShare(collectedFees);
    }

    const xdr = await buildWithdrawalTransaction({
      campaignWalletPublicKey: campaign.wallet_public_key,
      destinationPublicKey: destination_key,
      amount: creatorAmount,
      asset: campaign.asset_type,
      collectedFees,
      creatorPublicKey,
      commissions: payableCommissions.map(commission => ({
        destinationPublicKey: commission.destination_public_key,
        amount: commission.commission_owed,
      })),
    });

    try {
      const withdrawal = await withTransaction(async client => {
        const { rows } = await client.query(
          `INSERT INTO withdrawal_requests
         (campaign_id, requested_by, amount, destination_key, unsigned_xdr, creator_signed, platform_signed, evidence)
       VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6)
       RETURNING *`,
          [campaign_id, req.user.userId, amount, destination_key, xdr, JSON.stringify(evidence)]
        );
        await logWithdrawalEvent(client, {
          withdrawalRequestId: rows[0].id,
          actorUserId: req.user.userId,
          action: 'requested',
          note: null,
          metadata: {
            amount,
            destination_key,
            asset_type: campaign.asset_type,
            collected_fees: collectedFees,
            creator_share: creatorShare,
          },
        });
        await insertWithdrawalPendingSignatures(client, {
          campaignId: campaign_id,
          withdrawalRequestId: rows[0].id,
          userId: req.user.userId,
          unsignedXdr: xdr,
          metadata: {
            amount,
            destination_key,
            asset_type: campaign.asset_type,
            creator_amount: creatorAmount,
            collected_fees: collectedFees,
            creator_share: creatorShare,
            creator_public_key: creatorPublicKey,
            referral_commissions: payableCommissions.map(commission => ({
              referral_link_id: commission.referral_link_id,
              code: commission.code,
              destination_public_key: commission.destination_public_key,
              commission_owed: commission.commission_owed,
            })),
          },
        });
        return rows[0];
      }, db);
      res.status(201).json({
        ...withdrawal,
        creator_amount: creatorAmount,
        collected_fees: collectedFees,
        creator_share: creatorShare,
        referral_commissions: payableCommissions,
      });
    } catch (err) {
      logger.error('Withdrawal request creation failed', { error: err.message, campaign_id });
      res.status(500).json({ error: 'Could not create withdrawal request' });
    }
  })
);

router.post(
  '/:id/approve/creator',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: requests } = await db.query(
      `SELECT wr.*, c.creator_id, c.wallet_public_key AS campaign_wallet_public_key, c.asset_type, c.status AS campaign_status
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
      [req.params.id]
    );
    if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
    const requestRow = requests[0];

    const isOwner = await checkOwnerAccess(req, requestRow.campaign_id);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only campaign owners can approve withdrawals' });
    }
    if (
      !requestRow.is_refund &&
      !ALLOWED_CAMPAIGN_STATUS_FOR_REQUEST.includes(requestRow.campaign_status)
    ) {
      return res.status(409).json({
        error: `Campaign status is "${requestRow.campaign_status}". Creator approval is not allowed.`,
      });
    }
    if (requestRow.status !== 'pending') {
      return res.status(409).json({ error: 'Withdrawal request is no longer pending' });
    }
    if (requestRow.creator_signed) {
      return res.status(409).json({ error: 'Creator already approved this withdrawal' });
    }

    const { rows: users } = await db.query(
      'SELECT wallet_secret_encrypted, wallet_public_key, wallet_type FROM users WHERE id = $1',
      [req.user.userId]
    );
    let signedXdr;
    const userRow = users[0];
    try {
      if (userRow.wallet_type === 'freighter') {
        // Expect frontend to submit signed_xdr for freighter users
        const { signed_xdr } = req.body || {};
        if (!signed_xdr)
          return res.status(400).json({ error: 'signed_xdr is required for freighter users' });

        // Validate the signed_xdr matches server-generated unsigned_xdr and approved parameters
        validateSubmittedWithdrawalXdr({
          signedXdr: signed_xdr,
          unsignedXdr: requestRow.unsigned_xdr,
          creatorPublicKey: userRow.wallet_public_key,
          campaignWalletPublicKey: requestRow.campaign_wallet_public_key,
          expectedDestination: requestRow.destination_key,
          expectedAsset: requestRow.asset_type,
          expectedAmount: requestRow.amount,
        });

        signedXdr = signed_xdr;
      } else {
        // Custodial key: the server would hold both multisig signatures, so
        // only sign up to the custodial limit (refunds to contributors exempt).
        assertCustodialWithdrawalAllowed({
          walletType: userRow.wallet_type,
          amount: requestRow.amount,
          isRefund: !!requestRow.is_refund,
        });
        signedXdr = await withDecryptedWalletSecret(
          userRow.wallet_secret_encrypted,
          {
            userId: req.user.userId,
            walletPublicKey: userRow.wallet_public_key,
          },
          async creatorSecret =>
            signTransactionXdr({
              xdr: requestRow.unsigned_xdr,
              signerSecret: creatorSecret,
            })
        );
      }
    } catch (err) {
      if (err instanceof CustodialSigningLimitError) {
        return res
          .status(err.statusCode)
          .json({ error: err.message, code: err.code, limit: err.limit });
      }
      logger.error('Creator withdrawal signing failed', {
        withdrawal_id: req.params.id,
        error: err.message,
      });
      if (
        err.name === 'WithdrawalValidationError' ||
        err.isValidationError ||
        err.statusCode === 422 ||
        err.message?.includes('signed_xdr') ||
        err.message?.includes('unsigned_xdr') ||
        err.message?.includes('Signed transaction') ||
        err.message?.includes('Transaction') ||
        err.message?.includes('destination') ||
        err.message?.includes('does not match')
      ) {
        return res.status(422).json({ error: err.message });
      }
      return res
        .status(503)
        .json({ error: 'Creator wallet signing is unavailable; retry shortly.' });
    }

    try {
      const updatedWithdrawal = await withTransaction(async client => {
        const { rows: updated } = await client.query(
          `UPDATE withdrawal_requests
       SET unsigned_xdr = $1, creator_signed = TRUE
       WHERE id = $2 AND status = 'pending' AND creator_signed = FALSE
       RETURNING *`,
          [signedXdr, req.params.id]
        );
        if (!updated.length) {
          return null;
        }
        await logWithdrawalEvent(client, {
          withdrawalRequestId: req.params.id,
          actorUserId: req.user.userId,
          action: 'creator_signed',
          note: null,
          metadata: {},
        });
        return updated[0];
      }, db);
      if (!updatedWithdrawal) {
        return res
          .status(409)
          .json({ error: 'Withdrawal request changed; refresh and try again.' });
      }
      res.json(updatedWithdrawal);
    } catch (err) {
      logger.error('Creator approval recording failed', {
        withdrawal_id: req.params.id,
        error: err.message,
      });
      res.status(500).json({ error: 'Could not record creator approval' });
    }
  })
);

const platformApproveHandler = asyncHandler(async (req, res) => {
  const client = await (db.pool ? db.pool.connect() : db.connect());
  let fullySignedXdr;

  try {
    await client.query('BEGIN');

    const { rows: requests } = await client.query(
      `SELECT wr.*, c.status AS campaign_status, c.wallet_public_key AS campaign_wallet_public_key, c.asset_type, c.creator_id
       FROM withdrawal_requests wr
       JOIN campaigns c ON c.id = wr.campaign_id
       WHERE wr.id = $1
       FOR UPDATE`,
      [req.params.id]
    );

    if (!requests || requests.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Withdrawal request not found' });
    }

    const requestRow = requests[0];

    if (requestRow.status !== 'pending') {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'Conflict: Withdrawal request is already being processed or completed' });
    }

    if (!requestRow.creator_signed) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'Creator approval is required before platform approval' });
    }

    if (requestRow.platform_signed) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Platform has already approved this withdrawal' });
    }

    const now = new Date();
    if (
      (requestRow.expires_at && new Date(requestRow.expires_at) < now) ||
      (isXdrExpired && isXdrExpired(requestRow.unsigned_xdr))
    ) {
      await client.query(
        `UPDATE withdrawal_requests SET status = 'expired', updated_at = NOW() WHERE id = $1`,
        [req.params.id]
      );
      await client.query('COMMIT');
      return res.status(410).json({ error: 'Withdrawal XDR has expired' });
    }

    // Fetch creator's public key for signature validation
    const { rows: creatorUserRows } = await client.query(
      'SELECT wallet_public_key FROM users WHERE id = $1',
      [requestRow.requested_by]
    );
    const creatorPublicKey = creatorUserRows[0]?.wallet_public_key;

    // Validate source, destination, asset, amount, sequence, network, and operation set before platform signing
    try {
      validateWithdrawalForPlatformSigning({
        xdr: requestRow.unsigned_xdr,
        creatorPublicKey,
        campaignWalletPublicKey: requestRow.campaign_wallet_public_key,
        expectedDestination: requestRow.destination_key,
        expectedAsset: requestRow.asset_type,
        expectedAmount: requestRow.amount,
      });
    } catch (valErr) {
      await client.query('ROLLBACK');
      logger.error('Withdrawal validation failed before platform signing', {
        withdrawal_id: req.params.id,
        error: valErr.message,
      });
      return res.status(422).json({ error: valErr.message });
    }

    fullySignedXdr = signTransactionXdr({
      xdr: requestRow.unsigned_xdr,
      signerSecret: process.env.PLATFORM_SECRET_KEY,
    });

    if (signatureCountFromXdr(fullySignedXdr) < 2) {
      await client.query('ROLLBACK');
      return res
        .status(422)
        .json({ error: 'Withdrawal approval requires both creator and platform signatures' });
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE withdrawal_requests
       SET unsigned_xdr = $1,
           platform_signed = TRUE,
           status = 'approved',
           updated_at = NOW()
       WHERE id = $2
         AND status = 'pending'
         AND creator_signed = TRUE
         AND platform_signed = FALSE
       RETURNING *`,
      [fullySignedXdr, req.params.id]
    );

    if (!updatedRows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Withdrawal request changed; refresh and try again.' });
    }

    await logWithdrawalEvent(client, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: null,
      metadata: {},
    });

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Platform approval failed', { withdrawal_id: req.params.id, error: err.message });
    return res.status(500).json({ error: 'Failed to process withdrawal approval' });
  } finally {
    client.release();
  }

  let txHash;
  try {
    txHash = await submitSignedWithdrawal({ xdr: fullySignedXdr });
  } catch (err) {
    const failureClient = await db.connect();
    try {
      await failureClient.query('BEGIN');
      await failureClient.query(
        `UPDATE withdrawal_requests
         SET status = 'failed', updated_at = NOW()
         WHERE id = $1`,
        [req.params.id]
      );
      await markWithdrawalFailed(failureClient, {
        withdrawalRequestId: req.params.id,
        reason: err.message,
      });
      await logWithdrawalEvent(failureClient, {
        withdrawalRequestId: req.params.id,
        actorUserId: req.user.userId,
        action: 'submit_failed',
        note: err.message,
        metadata: {},
      });
      await failureClient.query('COMMIT');
    } catch (failureErr) {
      await failureClient.query('ROLLBACK');
      logger.error('Failed to record withdrawal submission failure', {
        withdrawal_id: req.params.id,
        error: failureErr.message,
      });
    } finally {
      failureClient.release();
    }

    logger.error('Withdrawal submission failed', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    return res.status(502).json({
      error: 'Stellar network rejected the withdrawal transaction',
      detail: err.message || String(err),
    });
  }

  const finalizeClient = await db.connect();
  let updatedWithdrawalRow;
  try {
    await finalizeClient.query('BEGIN');
    const { rows: updated } = await finalizeClient.query(
      `UPDATE withdrawal_requests
       SET status = 'submitted', tx_hash = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [txHash, req.params.id]
    );
    updatedWithdrawalRow = updated[0];

    // Calculate and process creator revenue share
    const { rows: feeRows } = await finalizeClient.query(
      `SELECT COALESCE(SUM(platform_fee_amount), 0) as total_fees
       FROM contributions
       WHERE campaign_id = $1 AND refunded = FALSE`,
      [updatedWithdrawalRow.campaign_id]
    );
    const collectedFees = Number(feeRows?.[0]?.total_fees) || 0;

    if (collectedFees > 0) {
      const creatorShare = await calculateCreatorShare(collectedFees);

      if (creatorShare > 0) {
        // Get creator's wallet public key
        const { rows: creatorRows } = await finalizeClient.query(
          `SELECT u.wallet_public_key 
           FROM users u
           JOIN campaigns c ON c.creator_id = u.id
           WHERE c.id = $1`,
          [updatedWithdrawalRow.campaign_id]
        );

        if (creatorRows.length > 0) {
          const creatorPublicKey = creatorRows[0].wallet_public_key;

          logger.info('Creator revenue share calculated and recorded for withdrawal', {
            withdrawal_id: req.params.id,
            campaign_id: updatedWithdrawalRow.campaign_id,
            collected_fees: collectedFees,
            creator_share: creatorShare,
            creator_public_key: creatorPublicKey,
          });

          // Store creator share in withdrawal metadata for audit
          await logWithdrawalEvent(finalizeClient, {
            withdrawalRequestId: req.params.id,
            actorUserId: req.user.userId,
            action: 'creator_share_calculated',
            note: `Creator revenue share: ${creatorShare} (${((creatorShare / collectedFees) * 100).toFixed(2)}% of collected fees)`,
            metadata: {
              collected_fees: collectedFees,
              creator_share: creatorShare,
              creator_public_key: creatorPublicKey,
            },
          });
        }
      }
    }

    // Record the commissions now settled on-chain so a later withdrawal for the
    // same campaign does not pay the same referrers twice (#675).
    const { rows: withdrawalTxRows } = await finalizeClient.query(
      `SELECT metadata FROM stellar_transactions
       WHERE withdrawal_request_id = $1 AND kind = 'withdrawal'
       LIMIT 1`,
      [req.params.id]
    );
    await settleCommissions(
      finalizeClient,
      withdrawalTxRows?.[0]?.metadata?.referral_commissions || []
    );

    await finalizeWithdrawalSubmitted(finalizeClient, {
      withdrawalRequestId: req.params.id,
      txHash,
      signedXdr: fullySignedXdr,
    });
    await logWithdrawalEvent(finalizeClient, {
      withdrawalRequestId: req.params.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: 'Transaction submitted to Stellar network',
      metadata: { tx_hash: txHash },
    });
    await finalizeClient.query('COMMIT');

    // Notify creator
    if (updatedWithdrawalRow) {
      const { rows: cRows } = await db.query(
        `SELECT u.email, u.name, c.creator_id, c.title, c.asset_type
         FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
        [updatedWithdrawalRow.campaign_id]
      );
      if (cRows.length) {
        sendWithdrawalApprovedEmail({
          to: cRows[0].email,
          withdrawalId: req.params.id,
          creatorName: cRows[0].name,
          amount: updatedWithdrawalRow.amount,
          asset: cRows[0].asset_type,
          campaignTitle: cRows[0].title,
          campaignUrl: `${frontendBaseUrl()}/campaigns/${updatedWithdrawalRow.campaign_id}`,
          txHash,
        }).catch(err => logger.error('Withdrawal approved email failed', { error: err.message }));
        createNotification(cRows[0].creator_id, {
          type: 'withdrawal_approved',
          title: 'Withdrawal approved',
          body: `Your withdrawal of ${updatedWithdrawalRow.amount} was approved and submitted on-chain.`,
          link: `/campaigns/${updatedWithdrawalRow.campaign_id}`,
        }).catch(err =>
          logger.warn('Withdrawal approved notification failed', {
            withdrawal_id: req.params.id,
            error: err.message,
          })
        );

        notifyContributorFundRelease({
          campaignId: updatedWithdrawalRow.campaign_id,
          campaignTitle: cRows[0].title,
          amount: updatedWithdrawalRow.amount,
          asset: cRows[0].asset_type,
          txHash,
          usage: 'Creator withdrawal approved by the platform and submitted on-chain.',
          recipient: updatedWithdrawalRow.destination_key,
          excludeUserIds: [cRows[0].creator_id],
        }).catch(err =>
          logger.error('Contributor withdrawal release notification failed', { error: err.message })
        );
      }

      setImmediate(() => {
        db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
          updatedWithdrawalRow.campaign_id,
        ])
          .then(({ rows: cr }) => {
            if (!cr.length) return;
            return emitWebhookEventForUser(cr[0].creator_id, WEBHOOK_EVENTS.WITHDRAWAL_COMPLETED, {
              withdrawal: { ...updatedWithdrawalRow, tx_hash: txHash },
            });
          })
          .catch(e => logger.error('Withdrawal webhook emit failed', { error: e.message }));
      });
    }
  } catch (err) {
    await finalizeClient.query('ROLLBACK');
    logger.error('Failed to finalize withdrawal after Stellar submission', {
      withdrawal_id: req.params.id,
      error: err.message,
    });
    return res.status(500).json({ error: 'Could not finalize withdrawal submission' });
  } finally {
    finalizeClient.release();
  }

  if (updatedWithdrawalRow) {
    await recordPayoutAudit({
      actorId: req.user.userId,
      action: 'payout.approved',
      resourceType: 'withdrawal',
      resourceId: req.params.id,
      before: { status: 'pending', platform_signed: false },
      after: {
        status: updatedWithdrawalRow.status,
        platform_signed: updatedWithdrawalRow.platform_signed,
        tx_hash: txHash,
      },
      metadata: {
        campaign_id: updatedWithdrawalRow.campaign_id,
        amount: updatedWithdrawalRow.amount,
        asset_type: updatedWithdrawalRow.asset_type,
        destination_key: updatedWithdrawalRow.destination_key,
        is_refund: Boolean(updatedWithdrawalRow.is_refund),
      },
      req,
    });
  }

  return res.status(200).json(updatedWithdrawalRow || { status: 'submitted', tx_hash: txHash });
});

router.post(
  '/:id/approve/platform',
  requireAuth,
  requirePlatformApprover,
  idempotency('wallet:withdrawal-submit'),
  platformApproveHandler
);
// Alias for docs + issue acceptance criteria
router.post(
  '/:id/approve',
  requireAuth,
  requirePlatformApprover,
  idempotency('wallet:withdrawal-submit'),
  platformApproveHandler
);

router.post(
  '/:id/cancel',
  requireAuth,
  asyncHandler(async (req, res) => {
    const reason = (req.body && req.body.reason) || 'Cancelled by creator';

    const { rows: requests } = await db.query(
      `SELECT wr.*, c.creator_id
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     WHERE wr.id = $1`,
      [req.params.id]
    );
    if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
    const requestRow = requests[0];

    const isOwner = await checkOwnerAccess(req, requestRow.campaign_id);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only campaign owners can cancel this request' });
    }
    if (requestRow.status !== 'pending') {
      return res.status(409).json({ error: 'Only pending requests can be cancelled' });
    }
    if (requestRow.creator_signed) {
      return res.status(409).json({
        error: 'Creator signature is already attached. Use platform reject flow instead of cancel.',
      });
    }

    try {
      const updatedWithdrawal = await withTransaction(async client => {
        const { rows: updated } = await client.query(
          `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = FALSE
       RETURNING *`,
          [reason, req.params.id]
        );
        if (!updated.length) {
          return null;
        }
        await logWithdrawalEvent(client, {
          withdrawalRequestId: req.params.id,
          actorUserId: req.user.userId,
          action: 'creator_cancelled',
          note: reason,
          metadata: {},
        });
        await logAuditEvent({
          actorId: req.user.userId,
          action: 'payout.cancelled',
          resourceType: 'withdrawal',
          resourceId: req.params.id,
          before: { status: requestRow.status },
          after: { status: updated[0].status, denial_reason: updated[0].denial_reason || null },
          metadata: {
            campaign_id: requestRow.campaign_id,
            amount: requestRow.amount,
            reason,
          },
          client,
          req,
        });
        return updated[0];
      }, db);
      if (!updatedWithdrawal) {
        return res
          .status(409)
          .json({ error: 'Withdrawal request changed; refresh and try again.' });
      }
      setImmediate(() => emitWithdrawalUpdated(requestRow.creator_id, updatedWithdrawal));
      res.json(updatedWithdrawal);
    } catch (err) {
      logger.error('Withdrawal cancellation failed', {
        withdrawal_id: req.params.id,
        error: err.message,
      });
      res.status(500).json({ error: 'Could not cancel withdrawal request' });
    }
  })
);

router.post(
  '/:id/reject',
  requireAuth,
  requirePlatformApprover,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/withdrawals/{id}/reject:
     *   post:
     *     tags: [Withdrawals]
     *     summary: Platform rejection
     *     security:
     *       - bearerAuth: []
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     requestBody:
     *       required: false
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             properties:
     *               reason: { type: string }
     *     responses:
     *       200:
     *         description: OK
     *       401:
     *         description: Unauthorized
     *       403:
     *         description: Forbidden
     */
    const reason = (req.body && req.body.reason) || 'Rejected by platform';

    const { rows: requests } = await db.query('SELECT * FROM withdrawal_requests WHERE id = $1', [
      req.params.id,
    ]);
    if (!requests.length) return res.status(404).json({ error: 'Withdrawal request not found' });
    const requestRow = requests[0];

    if (requestRow.status !== 'pending') {
      return res.status(409).json({ error: 'Only pending requests can be rejected' });
    }
    if (!requestRow.creator_signed) {
      return res
        .status(409)
        .json({ error: 'Creator must sign before platform can reject this release' });
    }
    if (requestRow.platform_signed) {
      return res.status(409).json({ error: 'Platform has already signed; cannot reject' });
    }

    try {
      const updatedWithdrawal = await withTransaction(async client => {
        const { rows: updated } = await client.query(
          `UPDATE withdrawal_requests
       SET status = 'denied', denial_reason = $1
       WHERE id = $2 AND status = 'pending' AND creator_signed = TRUE AND platform_signed = FALSE
       RETURNING *`,
          [reason, req.params.id]
        );
        if (!updated.length) {
          return null;
        }
        await logWithdrawalEvent(client, {
          withdrawalRequestId: req.params.id,
          actorUserId: req.user.userId,
          action: 'platform_rejected',
          note: reason,
          metadata: {},
        });
        await logAuditEvent({
          actorId: req.user.userId,
          action: 'payout.rejected',
          resourceType: 'withdrawal',
          resourceId: req.params.id,
          before: { status: requestRow.status },
          after: { status: updated[0].status, denial_reason: updated[0].denial_reason || null },
          metadata: {
            campaign_id: requestRow.campaign_id,
            amount: requestRow.amount,
            asset_type: requestRow.asset_type,
            destination_key: requestRow.destination_key,
            is_refund: Boolean(requestRow.is_refund),
            reason,
          },
          client,
          req,
        });
        return updated[0];
      }, db);
      if (!updatedWithdrawal) {
        return res
          .status(409)
          .json({ error: 'Withdrawal request changed; refresh and try again.' });
      }

      const { rows: cRows } = await db.query(
        `SELECT u.email, u.name, c.creator_id, c.title, c.asset_type
       FROM users u JOIN campaigns c ON c.creator_id = u.id WHERE c.id = $1`,
        [requestRow.campaign_id]
      );
      if (cRows.length) {
        sendWithdrawalRejectedEmail({
          to: cRows[0].email,
          withdrawalId: req.params.id,
          creatorName: cRows[0].name,
          amount: requestRow.amount,
          asset: cRows[0].asset_type,
          campaignTitle: cRows[0].title,
          reason,
        }).catch(err => logger.error('Withdrawal rejected email failed', { error: err.message }));
        createNotification(cRows[0].creator_id, {
          type: 'withdrawal_rejected',
          title: 'Withdrawal rejected',
          body: `Your withdrawal request was rejected. Reason: ${reason}`,
          link: `/campaigns/${requestRow.campaign_id}`,
        }).catch(err =>
          logger.warn('Withdrawal rejected notification failed', {
            withdrawal_id: req.params.id,
            error: err.message,
          })
        );
        emitWithdrawalUpdated(cRows[0].creator_id, updatedWithdrawal);
      }

      res.json(updatedWithdrawal);
    } catch (err) {
      logger.error('Withdrawal rejection failed', {
        withdrawal_id: req.params.id,
        error: err.message,
      });
      res.status(500).json({ error: 'Could not reject withdrawal request' });
    }
  })
);

router.get(
  '/campaign/:campaignId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const access = await assertWithdrawalAccess(req, req.params.campaignId);
    if (access.error) return res.status(access.status).json({ error: access.error });

    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

    const countResult = await db.query(
      'SELECT COUNT(*)::int AS total FROM withdrawal_requests WHERE campaign_id = $1',
      [req.params.campaignId]
    );
    const total = countResult.rows[0].total;

    const { rows } = await db.query(
      `SELECT id, campaign_id, requested_by, amount, destination_key, creator_signed,
            platform_signed, status, denial_reason, tx_hash, created_at, evidence
     FROM withdrawal_requests
     WHERE campaign_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
      [req.params.campaignId, limit, offset]
    );
    res.json({ data: rows, total, limit, offset });
  })
);

router.get(
  '/campaign/:campaignId/contributor-history',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = String(req.query.status || 'all').toLowerCase();
    const sort = String(req.query.sort || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const { limit, offset } = parsePagination(req.query, { limit: 50, max: 100 });

    const { rows: backed } = await db.query(
      `SELECT 1
     FROM contributions c
     JOIN users u ON u.wallet_public_key = c.sender_public_key
     WHERE c.campaign_id = $1 AND u.id = $2
     LIMIT 1`,
      [req.params.campaignId, req.user.userId]
    );
    const ownerAccess = await checkOwnerAccess(req, req.params.campaignId);
    if (!backed.length && !ownerAccess && req.user.role !== 'admin') {
      return res
        .status(403)
        .json({ error: 'Only contributors can view withdrawal history for this campaign' });
    }

    const filters = ['wr.campaign_id = $1'];
    const params = [req.params.campaignId];
    if (status !== 'all') {
      params.push(status);
      filters.push(`wr.status = $${params.length}`);
    }

    const count = await db.query(
      `SELECT COUNT(*)::int AS total
     FROM withdrawal_requests wr
     WHERE ${filters.join(' AND ')}`,
      params
    );

    params.push(limit, offset);
    const { rows } = await db.query(
      `SELECT wr.id, wr.campaign_id, wr.amount, wr.destination_key, wr.status,
            wr.tx_hash, wr.created_at, wr.updated_at, wr.milestone_id,
            c.asset_type, m.title AS milestone_title
     FROM withdrawal_requests wr
     JOIN campaigns c ON c.id = wr.campaign_id
     LEFT JOIN milestones m ON m.id = wr.milestone_id
     WHERE ${filters.join(' AND ')}
     ORDER BY wr.created_at ${sort}
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows, total: count.rows[0]?.total || 0, limit, offset });
  })
);

// Get a single withdrawal request (including unsigned_xdr) for authorized users
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM withdrawal_requests WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Withdrawal request not found' });
    const row = rows[0];
    const access = await assertWithdrawalAccess(req, row.campaign_id);
    if (access.error) return res.status(access.status).json({ error: access.error });

    // Only return unsigned_xdr to owners/admins
    res.json(row);
  })
);

const withdrawalAuditHandler = asyncHandler(async (req, res) => {
  /**
   * @openapi
   * /api/withdrawals/{id}/audit:
   *   get:
   *     tags: [Withdrawals]
   *     summary: Withdrawal audit timeline (alias of /events)
   *     security:
   *       - bearerAuth: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: OK
   *       401:
   *         description: Unauthorized
   *       403:
   *         description: Forbidden
   *       404:
   *         description: Not found
   */
  const { rows: wr } = await db.query(
    `SELECT wr.campaign_id FROM withdrawal_requests wr WHERE wr.id = $1`,
    [req.params.id]
  );
  if (!wr.length) return res.status(404).json({ error: 'Withdrawal request not found' });

  const access = await assertWithdrawalAccess(req, wr[0].campaign_id);
  if (access.error) return res.status(access.status).json({ error: access.error });

  const { rows } = await db.query(
    `SELECT e.id, e.withdrawal_request_id, e.actor_user_id, e.action, e.note, e.metadata, e.created_at
     FROM withdrawal_approval_events e
     WHERE e.withdrawal_request_id = $1
     ORDER BY e.created_at ASC`,
    [req.params.id]
  );
  res.json(rows);
});

router.get('/:id/events', requireAuth, withdrawalAuditHandler);
// Alias for docs + issue acceptance criteria
router.get('/:id/audit', requireAuth, withdrawalAuditHandler);

module.exports = router;
