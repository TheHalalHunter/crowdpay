const router = require('express').Router();
const db = require('../config/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  sendDisputeOpenedCreatorEmail,
  sendDisputeOpenedAdminEmail,
  sendDisputeResolvedCreatorEmail,
  sendDisputeResolvedContributorEmail,
} = require('../services/emailService');
const logger = require('../config/logger');
const {
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  WEBHOOK_EVENTS,
} = require('../services/webhookDispatcher');
const { parsePagination } = require('../utils/pagination');
const asyncHandler = require('../utils/asyncHandler');
const stellarService = require('../services/stellarService');
const { ERROR_CODES, allocateProportionalRefunds } = require('../services/dispute');
const { validateRenderUrl } = require('../utils/urlValidation');
const { haltScheduledReleases } = require('../services/milestoneAutoRelease');
const { logAuditEvent } = require('../services/auditService');

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

async function logDisputeEvent(client, { disputeId, actorId, action, note }) {
  await client.query(
    `INSERT INTO dispute_events (dispute_id, actor_id, action, note)
     VALUES ($1, $2, $3, $4)`,
    [disputeId, actorId || null, action, note || null]
  );
}

// POST /campaigns/:id/disputes — contributor raises a dispute
router.post('/campaigns/:id/disputes', requireAuth, async (req, res) => {
  const { reason, description, evidence_url, milestone_id: milestoneId } = req.body;

  const VALID_REASONS = ['non_delivery', 'misrepresentation', 'abandoned', 'other'];
  if (!VALID_REASONS.includes(reason)) {
    return res.status(422).json({ error: `reason must be one of: ${VALID_REASONS.join(', ')}` });
  }
  if (!description || !description.trim()) {
    return res.status(422).json({ error: 'description is required' });
  }
  if (evidence_url !== undefined && evidence_url !== null && evidence_url !== '') {
    const { safe } = validateRenderUrl(evidence_url);
    if (!safe) {
      return res.status(422).json({ error: 'evidence_url must be a valid http(s) URL' });
    }
  }

  const { rows: campaigns } = await db.query(
    'SELECT id, creator_id, title, wallet_public_key FROM campaigns WHERE id = $1',
    [req.params.id]
  );
  if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
  const campaign = campaigns[0];

  // Must have contributed
  const { rows: contributions } = await db.query(
    `SELECT id FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = (
       SELECT wallet_public_key FROM users WHERE id = $2
     ) LIMIT 1`,
    [campaign.id, req.user.userId]
  );
  if (!contributions.length) {
    return res.status(403).json({
      error: 'Only contributors who have backed this campaign can raise a dispute',
      code: ERROR_CODES.NOT_A_CONTRIBUTOR,
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // A dispute may target a specific pending automatic milestone release.
    if (milestoneId) {
      const { rows: milestoneRows } = await client.query(
        'SELECT id FROM milestones WHERE id = $1 AND campaign_id = $2',
        [milestoneId, campaign.id]
      );
      if (!milestoneRows.length) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'milestone_id does not belong to this campaign' });
      }
    }

    const { rows } = await client.query(
      `INSERT INTO disputes (campaign_id, raised_by, reason, description, evidence_url, milestone_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        campaign.id,
        req.user.userId,
        reason,
        description.trim(),
        evidence_url || null,
        milestoneId || null,
      ]
    );
    const dispute = rows[0];

    await logDisputeEvent(client, {
      disputeId: dispute.id,
      actorId: req.user.userId,
      action: 'raised',
      note: reason,
    });

    // Freeze any pending withdrawal requests for this campaign
    await client.query(
      `UPDATE withdrawal_requests
       SET status = 'on_hold', dispute_id = $1
       WHERE campaign_id = $2 AND status = 'pending'`,
      [dispute.id, campaign.id]
    );

    // Halt every automatic milestone release still waiting on its dispute
    // window. This commits with the dispute itself, so the worker can never
    // fire one of these afterwards; a halted release does not resume on its own.
    const haltedMilestoneIds = await haltScheduledReleases(client, {
      campaignId: campaign.id,
      disputeId: dispute.id,
      milestoneId: milestoneId || null,
    });

    // Block new contributions immediately (see routes/contributions.js CAMPAIGN_DISPUTED check)
    await client.query(`UPDATE campaigns SET status = 'disputed' WHERE id = $1`, [campaign.id]);

    await client.query('COMMIT');

    // On-chain escrow freeze: adds the platform arbitrator as a third signer
    // and raises the threshold to 3. This is best-effort here — the app
    // already blocks new contributions and holds pending withdrawals above,
    // so a transient Horizon failure doesn't leave funds movable; the freeze
    // is retried by re-fetching the dispute if arbitrator_signer_added stays
    // false.
    let frozenAt = null;
    try {
      await stellarService.freezeCampaignEscrow({
        campaignWalletPublicKey: campaign.wallet_public_key,
        creatorId: campaign.creator_id,
      });
      frozenAt = new Date().toISOString();
      await db.query(
        `UPDATE disputes SET frozen_at = $2, arbitrator_signer_added = TRUE WHERE id = $1`,
        [dispute.id, frozenAt]
      );
    } catch (err) {
      logger.error('Escrow freeze failed', { dispute_id: dispute.id, error: err.message });
    }

    // Notify creator
    const { rows: creatorRows } = await db.query('SELECT email, name FROM users WHERE id = $1', [
      campaign.creator_id,
    ]);
    if (creatorRows.length) {
      sendDisputeOpenedCreatorEmail({
        to: creatorRows[0].email,
        disputeId: dispute.id,
        creatorName: creatorRows[0].name,
        campaignTitle: campaign.title,
        reason,
      }).catch(err => logger.error('Dispute opened creator email failed', { error: err.message }));
    }

    // Notify admins
    const { rows: adminRows } = await db.query(
      "SELECT email, name FROM users WHERE role = 'admin' OR is_admin = TRUE"
    );
    const { rows: raisedByRows } = await db.query('SELECT name FROM users WHERE id = $1', [
      req.user.userId,
    ]);
    await Promise.all(
      adminRows.map(admin =>
        sendDisputeOpenedAdminEmail({
          to: admin.email,
          disputeId: dispute.id,
          campaignTitle: campaign.title,
          campaignId: campaign.id,
          raisedByName: raisedByRows[0]?.name || 'A contributor',
          reason,
          description: description.trim(),
          adminUrl: `${frontendBaseUrl()}/admin/disputes/${dispute.id}`,
        }).catch(err => logger.error('Dispute opened admin email failed', { error: err.message }))
      )
    );

    logger.info('Dispute raised', { dispute_id: dispute.id, campaign_id: campaign.id });

    setImmediate(() => {
      const payload = { dispute, campaign_id: campaign.id };
      emitWebhookEventForUser(campaign.creator_id, WEBHOOK_EVENTS.DISPUTE_OPENED, payload).catch(
        err => logger.error('Dispute opened webhook emit failed', { error: err.message })
      );
      emitWebhookEventForCampaign(campaign.id, WEBHOOK_EVENTS.DISPUTE_OPENED, payload).catch(err =>
        logger.error('Dispute opened webhook emit failed', { error: err.message })
      );
    });

    res.status(201).json({
      ...dispute,
      disputeId: dispute.id,
      frozenAt,
      halted_milestone_ids: haltedMilestoneIds,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'You already have an open dispute for this campaign' });
    }
    logger.error('Dispute creation failed', { error: err.message });
    res.status(500).json({ error: 'Could not raise dispute' });
  } finally {
    client.release();
  }
});

// GET /campaigns/:id/disputes — admin only
router.get(
  '/campaigns/:id/disputes',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

    const countResult = await db.query(
      'SELECT COUNT(*)::int AS total FROM disputes WHERE campaign_id = $1',
      [req.params.id]
    );
    const total = countResult.rows[0].total;

    const { rows } = await db.query(
      `SELECT d.*, u.name AS raised_by_name, u.email AS raised_by_email
     FROM disputes d
     JOIN users u ON u.id = d.raised_by
     WHERE d.campaign_id = $1
     ORDER BY d.created_at DESC
     LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ data: rows, total, limit, offset });
  })
);

// GET /campaigns/:id/dispute — the campaign's current active dispute, scoped
// to the disputing contributor or the campaign creator (not admin-only, so
// the frontend can locate the dispute to render the evidence form).
router.get(
  '/campaigns/:id/dispute',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT d.*, c.creator_id
     FROM disputes d
     JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.campaign_id = $1 AND d.status IN ('open', 'under_review')
     ORDER BY d.created_at DESC
     LIMIT 1`,
      [req.params.id]
    );
    if (!rows.length) return res.json({ dispute: null });

    const dispute = rows[0];
    if (req.user.userId !== dispute.raised_by && req.user.userId !== dispute.creator_id) {
      return res.json({ dispute: null });
    }
    res.json({ dispute });
  })
);

// POST /disputes/:id/evidence — either party (creator or contributor) submits evidence
router.post(
  '/disputes/:id/evidence',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { text, attachmentUrls } = req.body;

    if (!text || !text.trim()) {
      return res.status(422).json({ error: 'text is required' });
    }
    const urls = Array.isArray(attachmentUrls) ? attachmentUrls : [];
    for (const url of urls) {
      const { safe } = validateRenderUrl(url);
      if (!safe) {
        return res.status(422).json({ error: `attachmentUrls contains an invalid URL: ${url}` });
      }
    }

    const { rows: disputes } = await db.query(
      `SELECT d.*, c.creator_id
     FROM disputes d JOIN campaigns c ON c.id = d.campaign_id
     WHERE d.id = $1`,
      [req.params.id]
    );
    if (!disputes.length) return res.status(404).json({ error: 'Dispute not found' });
    const dispute = disputes[0];

    let role;
    if (req.user.userId === dispute.raised_by) {
      role = 'contributor';
    } else if (req.user.userId === dispute.creator_id) {
      role = 'creator';
    } else {
      return res.status(403).json({
        error: 'Only the disputing contributor or the campaign creator can submit evidence',
      });
    }

    const { rows } = await db.query(
      `INSERT INTO dispute_evidence (dispute_id, submitted_by, role, text, attachment_urls)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
      [dispute.id, req.user.userId, role, text.trim(), JSON.stringify(urls)]
    );

    await logDisputeEvent(db, {
      disputeId: dispute.id,
      actorId: req.user.userId,
      action: 'evidence_submitted',
      note: role,
    }).catch(err => logger.error('Dispute evidence log failed', { error: err.message }));

    res.status(201).json(rows[0]);
  })
);

// PATCH /disputes/:id — admin updates status + resolution note
router.patch(
  '/disputes/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { status, resolution_note } = req.body;

    const VALID_STATUSES = [
      'open',
      'under_review',
      'resolved_creator',
      'resolved_contributor',
      'closed',
    ];
    if (!VALID_STATUSES.includes(status)) {
      return res.status(422).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    const { rows: disputes } = await db.query('SELECT * FROM disputes WHERE id = $1', [
      req.params.id,
    ]);
    if (!disputes.length) return res.status(404).json({ error: 'Dispute not found' });
    const dispute = disputes[0];

    const { rows: disputeCampaigns } = await db.query(
      `SELECT c.id, c.creator_id, c.wallet_public_key, c.escrow_contract_id, c.raised_amount, c.title, c.status AS campaign_status,
            u.wallet_public_key AS creator_wallet_public_key
     FROM campaigns c
     JOIN users u ON u.id = c.creator_id
     WHERE c.id = $1`,
      [dispute.campaign_id]
    );
    if (!disputeCampaigns.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = disputeCampaigns[0];
    const campaignCreatorId = campaign.creator_id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const resolvedAt = ['resolved_creator', 'resolved_contributor', 'closed'].includes(status)
        ? 'NOW()'
        : 'NULL';

      const { rows: updated } = await client.query(
        `UPDATE disputes
       SET status = $1, resolution_note = $2, resolved_at = ${resolvedAt}
       WHERE id = $3
       RETURNING *`,
        [status, resolution_note || null, dispute.id]
      );

      await logDisputeEvent(client, {
        disputeId: dispute.id,
        actorId: req.user.userId,
        action: `status_changed_to_${status}`,
        note: resolution_note || null,
      });

      await logAuditEvent({
        actorId: req.user.userId,
        action: 'dispute.status_changed',
        resourceType: 'dispute',
        resourceId: dispute.id,
        before: { status: dispute.status },
        after: { status: updated[0].status, decision: updated[0].decision || null },
        metadata: {
          campaign_id: dispute.campaign_id,
          raised_by: dispute.raised_by,
          resolution_note: resolution_note || null,
        },
        client,
        req,
      });

      if (status === 'resolved_contributor') {
        // Trigger refund for the disputing contributor
        const { rows: campaigns } = await client.query(
          'SELECT wallet_public_key FROM campaigns WHERE id = $1',
          [dispute.campaign_id]
        );
        const { rows: contributorRows } = await client.query(
          'SELECT wallet_public_key FROM users WHERE id = $1',
          [dispute.raised_by]
        );
        const { rows: contributions } = await client.query(
          `SELECT id, amount, asset FROM contributions
         WHERE campaign_id = $1 AND sender_public_key = $2
         AND NOT EXISTS (
           SELECT 1 FROM withdrawal_requests wr WHERE wr.contribution_id = contributions.id
         )`,
          [dispute.campaign_id, contributorRows[0].wallet_public_key]
        );

        const { buildWithdrawalTransaction } = require('../services/stellarService');
        const {
          insertWithdrawalPendingSignatures,
        } = require('../services/stellarTransactionService');

        for (const contribution of contributions) {
          const unsignedXdr = await buildWithdrawalTransaction({
            campaignWalletPublicKey: campaigns[0].wallet_public_key,
            destinationPublicKey: contributorRows[0].wallet_public_key,
            amount: contribution.amount,
            asset: contribution.asset,
          });
          const { rows: refundRows } = await client.query(
            `INSERT INTO withdrawal_requests
             (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
              creator_signed, platform_signed, contribution_id, is_refund, dispute_id)
           VALUES ($1, $2, $3, $4, $5, FALSE, FALSE, $6, TRUE, $7)
           RETURNING id`,
            [
              dispute.campaign_id,
              req.user.userId,
              contribution.amount,
              contributorRows[0].wallet_public_key,
              unsignedXdr,
              contribution.id,
              dispute.id,
            ]
          );
          await insertWithdrawalPendingSignatures(client, {
            campaignId: dispute.campaign_id,
            withdrawalRequestId: refundRows[0].id,
            userId: req.user.userId,
            unsignedXdr,
            metadata: { dispute_id: dispute.id, contribution_id: contribution.id },
          });
        }

        // Notify contributor
        const { rows: userRows } = await db.query('SELECT email, name FROM users WHERE id = $1', [
          dispute.raised_by,
        ]);
        const { rows: disputeCampaignRows } = await db.query(
          'SELECT title FROM campaigns WHERE id = $1',
          [dispute.campaign_id]
        );
        if (userRows.length) {
          sendDisputeResolvedContributorEmail({
            to: userRows[0].email,
            disputeId: dispute.id,
            outcome: 'resolved in your favor — a refund has been initiated',
            contributorName: userRows[0].name,
            campaignTitle: disputeCampaignRows[0]?.title,
            resolutionNote: resolution_note,
            campaignUrl: `${frontendBaseUrl()}/campaigns/${dispute.campaign_id}`,
          }).catch(err =>
            logger.error('Dispute resolved contributor email failed', { error: err.message })
          );
        }
      }

      if (status === 'resolved_creator') {
        // Unfreeze pending on_hold withdrawals for this campaign
        const { rows: unfrozen } = await client.query(
          `UPDATE withdrawal_requests
         SET status = 'pending', dispute_id = NULL
         WHERE campaign_id = $1 AND status = 'on_hold' AND dispute_id = $2
         RETURNING *`,
          [dispute.campaign_id, dispute.id]
        );
        for (const withdrawal of unfrozen) {
          setImmediate(() =>
            emitWebhookEventForUser(campaignCreatorId, WEBHOOK_EVENTS.WITHDRAWAL_UPDATED, {
              withdrawal,
            }).catch(err =>
              logger.error('Withdrawal updated webhook emit failed', { error: err.message })
            )
          );
        }

        // Release the multisig freeze (remove arbitrator signer, lower thresholds back to 2)
        // This is required when arbitrator_signer_added is true from the dispute raise
        let freezeReleaseTxHash = null;
        if (dispute.arbitrator_signer_added && campaign.wallet_public_key) {
          try {
            const result = await stellarService.releaseEscrowFreeze({
              campaignWalletPublicKey: campaign.wallet_public_key,
              creatorId: campaign.creator_id,
            });
            freezeReleaseTxHash = result?.hash || null;
            logger.info('Multisig escrow freeze released', {
              dispute_id: dispute.id,
              campaign_id: dispute.campaign_id,
              tx_hash: freezeReleaseTxHash,
            });

            await logDisputeEvent(client, {
              disputeId: dispute.id,
              actorId: req.user.userId,
              action: 'freeze_released',
              note: `Multisig freeze released. TX: ${freezeReleaseTxHash || 'N/A'}`,
            });
          } catch (freezeErr) {
            logger.error('Failed to release multisig freeze', {
              dispute_id: dispute.id,
              campaign_id: dispute.campaign_id,
              error: freezeErr.message,
            });
            await client.query('ROLLBACK');
            return res.status(500).json({
              error: 'Failed to release multisig escrow freeze',
              detail: freezeErr.message,
            });
          }
        }

        // ALSO release Soroban escrow funds if a REAL contract is deployed
        // (not a mock ID generated when SOROBAN_ENABLED=false)
        let sorobanReleaseTxHash = null;
        const {
          isRealSorobanContract,
          releaseEscrowToCreator,
        } = require('../services/sorobanService');
        if (
          isRealSorobanContract(campaign.escrow_contract_id) &&
          campaign.creator_wallet_public_key
        ) {
          try {
            const releaseAmount = Math.floor(parseFloat(campaign.raised_amount || 0) * 10000000);
            if (releaseAmount > 0) {
              sorobanReleaseTxHash = await releaseEscrowToCreator({
                escrowContractId: campaign.escrow_contract_id,
                creatorAddress: campaign.creator_wallet_public_key,
                releaseAmount,
              });
              logger.info('Soroban escrow released to creator', {
                dispute_id: dispute.id,
                campaign_id: dispute.campaign_id,
                release_amount: releaseAmount,
                tx_hash: sorobanReleaseTxHash,
              });

              await logDisputeEvent(client, {
                disputeId: dispute.id,
                actorId: req.user.userId,
                action: 'soroban_escrow_released',
                note: `Soroban escrow released to creator. TX: ${sorobanReleaseTxHash || 'N/A'}`,
              });
            }
          } catch (escrowErr) {
            logger.error('Failed to release Soroban escrow to creator', {
              dispute_id: dispute.id,
              campaign_id: dispute.campaign_id,
              error: escrowErr.message,
            });
            await client.query('ROLLBACK');
            return res.status(500).json({
              error: 'Failed to release Soroban escrow funds',
              detail: escrowErr.message,
            });
          }
        }

        // Restore campaign status to pre-dispute state
        // Look up the previous status from campaign_status_events, default to 'active'
        if (campaign.campaign_status === 'disputed') {
          const { rows: statusEvents } = await client.query(
            `SELECT previous_status FROM campaign_status_events
           WHERE campaign_id = $1 AND new_status = 'disputed'
           ORDER BY created_at DESC LIMIT 1`,
            [dispute.campaign_id]
          );
          const restoredStatus = statusEvents[0]?.previous_status || 'active';
          await client.query(`UPDATE campaigns SET status = $1 WHERE id = $2`, [
            restoredStatus,
            dispute.campaign_id,
          ]);
          logger.info('Campaign status restored from disputed', {
            campaign_id: dispute.campaign_id,
            restored_status: restoredStatus,
          });
        }

        const { rows: creatorRows } = await db.query(
          `SELECT u.email, u.name, c.title
         FROM campaigns c JOIN users u ON u.id = c.creator_id
         WHERE c.id = $1`,
          [dispute.campaign_id]
        );
        const txInfo = [freezeReleaseTxHash, sorobanReleaseTxHash].filter(Boolean).join(', ');
        if (creatorRows.length) {
          sendDisputeResolvedCreatorEmail({
            to: creatorRows[0].email,
            disputeId: dispute.id,
            outcome:
              'resolved in your favor — the dispute is closed' + (txInfo ? ` (TX: ${txInfo})` : ''),
            creatorName: creatorRows[0].name,
            campaignTitle: creatorRows[0].title,
            resolutionNote: resolution_note,
            campaignUrl: `${frontendBaseUrl()}/campaigns/${dispute.campaign_id}`,
          }).catch(err =>
            logger.error('Dispute resolved creator email failed', { error: err.message })
          );
        }
      }

      await client.query('COMMIT');

      if (['resolved_creator', 'resolved_contributor', 'closed'].includes(status)) {
        setImmediate(() => {
          const payload = { dispute: updated[0], campaign_id: dispute.campaign_id };
          emitWebhookEventForUser(
            campaignCreatorId,
            WEBHOOK_EVENTS.DISPUTE_RESOLVED,
            payload
          ).catch(err =>
            logger.error('Dispute resolved webhook emit failed', { error: err.message })
          );
          emitWebhookEventForCampaign(
            dispute.campaign_id,
            WEBHOOK_EVENTS.DISPUTE_RESOLVED,
            payload
          ).catch(err =>
            logger.error('Dispute resolved webhook emit failed', { error: err.message })
          );
        });
      }

      res.json(updated[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Dispute update failed', { dispute_id: dispute.id, error: err.message });
      res.status(500).json({ error: 'Could not update dispute' });
    } finally {
      client.release();
    }
  })
);

// POST /admin/disputes/:id/decide — platform arbitrator decides the dispute outcome
router.post(
  '/admin/disputes/:id/decide',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { decision, reason } = req.body;

    const VALID_DECISIONS = ['release_to_creator', 'refund_contributors'];
    if (!VALID_DECISIONS.includes(decision)) {
      return res
        .status(422)
        .json({ error: `decision must be one of: ${VALID_DECISIONS.join(', ')}` });
    }

    const { rows: disputes } = await db.query(
      `SELECT d.*, c.creator_id, c.wallet_public_key, c.escrow_contract_id, c.raised_amount, c.title AS campaign_title,
            u.wallet_public_key AS creator_wallet_public_key
     FROM disputes d
     JOIN campaigns c ON c.id = d.campaign_id
     JOIN users u ON u.id = c.creator_id
     WHERE d.id = $1`,
      [req.params.id]
    );
    if (!disputes.length) return res.status(404).json({ error: 'Dispute not found' });
    const dispute = disputes[0];
    if (
      ['resolved', 'resolved_creator', 'resolved_contributor', 'closed'].includes(dispute.status)
    ) {
      return res.status(409).json({ error: 'Dispute is already resolved' });
    }

    let refunds = [];
    let assetCode = null;
    let freezeReleaseTxHash = null;
    let sorobanReleaseTxHash = null;
    try {
      if (decision === 'release_to_creator') {
        // Release the multisig freeze
        const result = await stellarService.releaseEscrowFreeze({
          campaignWalletPublicKey: dispute.wallet_public_key,
          creatorId: dispute.creator_id,
        });
        freezeReleaseTxHash = result?.hash || null;

        // ALSO release Soroban escrow if a REAL contract is deployed
        const {
          isRealSorobanContract,
          releaseEscrowToCreator,
        } = require('../services/sorobanService');
        if (
          isRealSorobanContract(dispute.escrow_contract_id) &&
          dispute.creator_wallet_public_key
        ) {
          const releaseAmount = Math.floor(parseFloat(dispute.raised_amount || 0) * 10000000);
          if (releaseAmount > 0) {
            sorobanReleaseTxHash = await releaseEscrowToCreator({
              escrowContractId: dispute.escrow_contract_id,
              creatorAddress: dispute.creator_wallet_public_key,
              releaseAmount,
            });
            logger.info('Soroban escrow released via /decide', {
              dispute_id: dispute.id,
              tx_hash: sorobanReleaseTxHash,
            });
          }
        }
      } else {
        const { rows: contributorRows } = await db.query(
          `SELECT u.id AS contributor_id, u.wallet_public_key, SUM(c.amount) AS contributed
         FROM contributions c
         JOIN users u ON u.wallet_public_key = c.sender_public_key
         WHERE c.campaign_id = $1 AND c.refunded = FALSE
         GROUP BY u.id, u.wallet_public_key`,
          [dispute.campaign_id]
        );

        const balances = await stellarService.getCampaignBalance(dispute.wallet_public_key);
        assetCode = Object.keys(balances).find(code => parseFloat(balances[code]) > 0) || 'XLM';
        const balance = balances[assetCode] || '0';

        refunds = allocateProportionalRefunds(
          contributorRows.map(r => ({
            contributorId: r.contributor_id,
            walletPublicKey: r.wallet_public_key,
            contributed: r.contributed,
          })),
          balance
        );

        if (refunds.length) {
          const { hash, xdr } = await stellarService.submitDisputeRefund({
            campaignWalletPublicKey: dispute.wallet_public_key,
            creatorId: dispute.creator_id,
            refunds: refunds.map(r => ({
              destinationPublicKey: r.walletPublicKey,
              amount: r.amount,
              asset: assetCode,
            })),
          });
          refunds = refunds.map(r => ({ ...r, txHash: hash, xdr }));
        }
      }
    } catch (err) {
      logger.error('Dispute decision escrow action failed', {
        dispute_id: dispute.id,
        decision,
        error: err.message,
      });
      return res
        .status(503)
        .json({ error: 'Could not execute the decision on-chain; try again shortly' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const { rows: updated } = await client.query(
        `UPDATE disputes
       SET status = 'resolved', decision = $1, resolution_note = $2, resolved_at = NOW()
       WHERE id = $3
       RETURNING *`,
        [decision, reason || null, dispute.id]
      );

      await logDisputeEvent(client, {
        disputeId: dispute.id,
        actorId: req.user.userId,
        action: `decision_${decision}`,
        note: reason || null,
      });

      await logAuditEvent({
        actorId: req.user.userId,
        action: 'dispute.resolved',
        resourceType: 'dispute',
        resourceId: dispute.id,
        before: { status: dispute.status },
        after: { status: updated[0].status, decision },
        metadata: {
          campaign_id: dispute.campaign_id,
          raised_by: dispute.raised_by,
          reason: reason || null,
          refund_count: refunds.length,
          release_tx_hash: freezeReleaseTxHash || sorobanReleaseTxHash || null,
        },
        client,
        req,
      });

      let unfrozenWithdrawals = [];
      if (decision === 'release_to_creator') {
        // Restore campaign to pre-dispute status (lookup from campaign_status_events)
        const { rows: statusEvents } = await client.query(
          `SELECT previous_status FROM campaign_status_events
         WHERE campaign_id = $1 AND new_status = 'disputed'
         ORDER BY created_at DESC LIMIT 1`,
          [dispute.campaign_id]
        );
        const restoredStatus = statusEvents[0]?.previous_status || 'active';
        await client.query(
          `UPDATE campaigns SET status = $1 WHERE id = $2 AND status = 'disputed'`,
          [restoredStatus, dispute.campaign_id]
        );
        const { rows } = await client.query(
          `UPDATE withdrawal_requests
         SET status = 'pending', dispute_id = NULL
         WHERE campaign_id = $1 AND status = 'on_hold' AND dispute_id = $2
         RETURNING *`,
          [dispute.campaign_id, dispute.id]
        );
        unfrozenWithdrawals = rows;
      } else {
        await client.query(`UPDATE campaigns SET status = 'refunded' WHERE id = $1`, [
          dispute.campaign_id,
        ]);
        for (const refund of refunds) {
          await client.query(
            `INSERT INTO withdrawal_requests
             (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
              creator_signed, platform_signed, status, tx_hash, is_refund, dispute_id)
           VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'submitted', $6, TRUE, $7)`,
            [
              dispute.campaign_id,
              req.user.userId,
              refund.amount,
              refund.walletPublicKey,
              refund.xdr,
              refund.txHash,
              dispute.id,
            ]
          );
        }
      }

      await client.query('COMMIT');

      for (const withdrawal of unfrozenWithdrawals) {
        setImmediate(() =>
          emitWebhookEventForUser(dispute.creator_id, WEBHOOK_EVENTS.WITHDRAWAL_UPDATED, {
            withdrawal,
          }).catch(err =>
            logger.error('Withdrawal updated webhook emit failed', { error: err.message })
          )
        );
      }

      if (decision === 'release_to_creator') {
        const { rows: creatorRows } = await db.query(
          'SELECT email, name FROM users WHERE id = $1',
          [dispute.creator_id]
        );
        if (creatorRows.length) {
          sendDisputeResolvedCreatorEmail({
            to: creatorRows[0].email,
            disputeId: dispute.id,
            outcome: 'resolved in your favor — the dispute is closed',
            creatorName: creatorRows[0].name,
            campaignTitle: dispute.campaign_title,
            resolutionNote: reason,
            campaignUrl: `${frontendBaseUrl()}/campaigns/${dispute.campaign_id}`,
          }).catch(err =>
            logger.error('Dispute resolved creator email failed', { error: err.message })
          );
        }
      } else if (refunds.length) {
        const { rows: contributorUsers } = await db.query(
          'SELECT id, email, name FROM users WHERE id = ANY($1::uuid[])',
          [refunds.map(r => r.contributorId)]
        );
        for (const user of contributorUsers) {
          sendDisputeResolvedContributorEmail({
            to: user.email,
            disputeId: dispute.id,
            outcome: 'resolved in your favor — a refund has been issued',
            contributorName: user.name,
            campaignTitle: dispute.campaign_title,
            resolutionNote: reason,
            campaignUrl: `${frontendBaseUrl()}/campaigns/${dispute.campaign_id}`,
          }).catch(err =>
            logger.error('Dispute resolved contributor email failed', { error: err.message })
          );
        }
      }

      setImmediate(() => {
        const payload = { dispute: updated[0], campaign_id: dispute.campaign_id };
        emitWebhookEventForUser(dispute.creator_id, WEBHOOK_EVENTS.DISPUTE_RESOLVED, payload).catch(
          err => logger.error('Dispute resolved webhook emit failed', { error: err.message })
        );
        emitWebhookEventForCampaign(
          dispute.campaign_id,
          WEBHOOK_EVENTS.DISPUTE_RESOLVED,
          payload
        ).catch(err =>
          logger.error('Dispute resolved webhook emit failed', { error: err.message })
        );
      });

      res.json({
        ...updated[0],
        refunds:
          decision === 'refund_contributors'
            ? refunds.map(r => ({
                contributorId: r.contributorId,
                walletPublicKey: r.walletPublicKey,
                amount: r.amount,
                asset: assetCode,
              }))
            : undefined,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Dispute decision recording failed', {
        dispute_id: dispute.id,
        error: err.message,
      });
      res.status(500).json({ error: 'Could not record dispute decision' });
    } finally {
      client.release();
    }
  })
);

// GET /disputes/:id/events — audit log (admin only)
router.get(
  '/disputes/:id/events',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT de.*, u.name AS actor_name
     FROM dispute_events de
     LEFT JOIN users u ON u.id = de.actor_id
     WHERE de.dispute_id = $1
     ORDER BY de.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  })
);

module.exports = router;
