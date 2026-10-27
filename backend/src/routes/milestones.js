const router = require('express').Router();
const multer = require('multer');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { MILESTONE_LIMIT, MILESTONE_EVIDENCE_MAX_FILE_SIZE } = require('../config/constants');
const { requireAuth } = require('../middleware/auth');
const { sendAlert } = require('../services/alerting');
const {
  buildWithdrawalTransaction,
  signTransactionXdr,
  signatureCountFromXdr,
  submitSignedWithdrawal,
} = require('../services/stellarService');
const {
  insertWithdrawalPendingSignatures,
  finalizeWithdrawalSubmitted,
} = require('../services/stellarTransactionService');
const { withDecryptedWalletSecret } = require('../services/walletSecrets');
const {
  assertCustodialWithdrawalAllowed,
  CustodialSigningLimitError,
} = require('../services/custodialSigningPolicy');
const { resolveUserCampaignRole } = require('../services/campaignInviteService');
const { canSubmitMilestones } = require('../lib/campaignPermissions');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const { invokeContract, nativeToScVal, releaseMilestone } = require('../services/sorobanService');
const {
  uploadMilestoneEvidence,
  parseMilestoneEvidenceUrl,
  milestoneEvidenceExists,
} = require('../services/storage');
const { createNotification } = require('../services/notifications');
const { notifyFollowers } = require('../services/campaignFollowService');
const { notifyContributorFundRelease } = require('../services/fundReleaseNotifications');
const { evaluateCampaign } = require('../services/fraudService');
const {
  sendMilestoneReleasedCreatorEmail,
  sendMilestoneEvidenceSubmittedAdminEmail,
} = require('../services/emailService');
const ledger = require('../services/milestoneLedger');
const {
  toReleaseAmount,
  logWithdrawalEvent,
  votesBlockRelease,
  setCampaignStatusFromMilestoneProgress,
} = ledger;
const autoRelease = require('../services/milestoneAutoRelease');
const { logAuditEvent } = require('../services/auditService');
const asyncHandler = require('../utils/asyncHandler');
const { validateRenderUrl } = require('../utils/urlValidation');

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}
const crypto = require('crypto');

function canPerformPlatformSignature(userId) {
  if (!process.env.PLATFORM_APPROVER_USER_ID) return false;
  return userId === process.env.PLATFORM_APPROVER_USER_ID;
}

async function requirePlatformApproverAuth(userId) {
  if (!canPerformPlatformSignature(userId)) {
    const err = new Error('Only the designated platform approver can perform this action');
    err.status = 403;
    throw err;
  }
  const { rows } = await db.query('SELECT role, is_admin FROM users WHERE id = $1', [userId]);
  if (!rows.length || (rows[0].role !== 'admin' && !rows[0].is_admin)) {
    const err = new Error('Account no longer has platform authorization');
    err.status = 403;
    throw err;
  }
}

function validatePublicKey(publicKey) {
  try {
    Keypair.fromPublicKey(publicKey);
    return true;
  } catch (_err) {
    return false;
  }
}

const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MILESTONE_EVIDENCE_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Upload an image, PDF, or document.'));
    }
    cb(null, true);
  },
});

function logMilestoneEvent(client, event) {
  return ledger.logMilestoneEvent(client || db, event);
}

async function notifyAdminsOnEvidenceSubmitted({ milestone, campaignTitle, creatorName }) {
  const adminUrl = `${frontendBaseUrl()}/admin`;
  const { rows: adminRows } = await db.query(
    "SELECT id, email, name FROM users WHERE role = 'admin' OR is_admin = TRUE"
  );

  await Promise.all(
    adminRows.map(async admin => {
      await createNotification(admin.id, {
        type: 'milestone_evidence_submitted',
        title: 'Milestone evidence submitted',
        body: `${creatorName || 'A creator'} submitted evidence for "${milestone.title}" on "${campaignTitle}".`,
        link: adminUrl,
      });
      if (admin.email) {
        await sendMilestoneEvidenceSubmittedAdminEmail({
          to: admin.email,
          milestoneId: milestone.id,
          adminName: admin.name,
          campaignTitle,
          milestoneTitle: milestone.title,
          evidenceUrl: milestone.evidence_url,
          evidenceDescription: milestone.evidence_description,
          creatorName,
          adminUrl,
        }).catch(err =>
          logger.error('Milestone evidence admin email failed', { error: err.message })
        );
      }
    })
  );
}

async function assertCanSubmitMilestone(milestone, userId, userRole) {
  if (milestone.creator_id !== userId) {
    const memberRole = await resolveUserCampaignRole(
      milestone.campaign_id,
      userId,
      userRole === 'admin'
    );
    if (!canSubmitMilestones(memberRole)) {
      const err = new Error('Only campaign owners or managers can submit milestone evidence');
      err.status = 403;
      throw err;
    }
  }
}

async function getMilestoneVoteContext(milestoneId, userId) {
  const { rows } = await db.query(
    `SELECT m.id, m.campaign_id, m.title, m.status,
            c.creator_id, c.title AS campaign_title,
            u.wallet_public_key
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     JOIN users u ON u.id = $2
     WHERE m.id = $1`,
    [milestoneId, userId]
  );
  if (!rows.length) return null;

  const milestone = rows[0];
  const { rows: contributorRows } = await db.query(
    `SELECT 1
     FROM contributions
     WHERE campaign_id = $1 AND sender_public_key = $2
     LIMIT 1`,
    [milestone.campaign_id, milestone.wallet_public_key]
  );

  return {
    milestone,
    isContributor: contributorRows.length > 0,
    isCreator: milestone.creator_id === userId,
  };
}

function getMilestoneVoteTally(milestoneId, userId) {
  return ledger.getMilestoneVoteTally(db, milestoneId, userId);
}

router.get(
  '/campaign/:campaignId',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT m.*, 
            (c.milestones_contract_id IS NOT NULL) AS on_chain
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
      [req.params.campaignId]
    );
    res.json(rows);
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      campaign_id: campaignId,
      title,
      description,
      release_percentage: releasePercentage,
      sort_order: sortOrder,
    } = req.body || {};

    if (!campaignId || !title || releasePercentage === null || releasePercentage === undefined) {
      return res
        .status(400)
        .json({ error: 'campaign_id, title and release_percentage are required' });
    }

    const percentage = Number(releasePercentage);
    if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ error: 'release_percentage must be between 0 and 100' });
    }

    let autoReleaseConfig = { enabled: false };
    if (req.body?.auto_release !== undefined) {
      try {
        autoReleaseConfig = autoRelease.parseAutoReleaseConfig(req.body.auto_release);
      } catch (err) {
        return res.status(err.status || 422).json({ error: err.message, code: err.code });
      }
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: camp } = await client.query(
        'SELECT id, creator_id FROM campaigns WHERE id = $1 FOR UPDATE',
        [campaignId]
      );
      if (!camp.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (camp[0].creator_id !== req.user.userId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the campaign creator can add milestones' });
      }

      const { rows: stats } = await client.query(
        `SELECT
         COUNT(*)::int AS count,
         COALESCE(SUM(release_percentage), 0)::numeric AS total_percentage
       FROM milestones
       WHERE campaign_id = $1`,
        [campaignId]
      );
      if ((stats[0]?.count || 0) >= MILESTONE_LIMIT) {
        await client.query('ROLLBACK');
        return res
          .status(400)
          .json({ error: `Campaigns can define at most ${MILESTONE_LIMIT} milestones` });
      }

      const newTotal = Number(stats[0]?.total_percentage || 0) + percentage;
      if (newTotal > 100.001) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Milestone percentages must not exceed 100%' });
      }

      const { rows } = await client.query(
        `INSERT INTO milestones (campaign_id, title, description, release_percentage, sort_order,
                               auto_release_enabled, auto_release_rule, auto_release_rule_config,
                               auto_release_window_seconds, auto_release_status, auto_release_configured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, CASE WHEN $6 THEN NOW() END)
       RETURNING *`,
        [
          campaignId,
          String(title).trim(),
          String(description || '').trim() || null,
          percentage.toFixed(4),
          Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : stats[0]?.count || 0,
          autoReleaseConfig.enabled,
          autoReleaseConfig.enabled ? autoReleaseConfig.rule : null,
          JSON.stringify(autoReleaseConfig.enabled ? autoReleaseConfig.ruleConfig : {}),
          autoReleaseConfig.enabled ? autoReleaseConfig.windowSeconds : null,
          autoReleaseConfig.enabled ? 'awaiting_evidence' : null,
        ]
      );
      if (autoReleaseConfig.enabled) {
        await logMilestoneEvent(client, {
          milestoneId: rows[0].id,
          actorUserId: req.user.userId,
          action: 'auto_release_configured',
          metadata: {
            rule: autoReleaseConfig.rule,
            rule_config: autoReleaseConfig.ruleConfig,
            dispute_window_seconds: autoReleaseConfig.windowSeconds,
          },
        });
      }
      await client.query('COMMIT');
      res.status(201).json(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: 'Could not create milestone' });
    } finally {
      client.release();
    }
  })
);

router.post(
  '/:id/submit',
  requireAuth,
  asyncHandler(async (req, res) => {
    const {
      evidence_url: evidenceUrl,
      evidence_description: evidenceDescription,
      destination_key: destinationKey,
    } = req.body || {};
    if (!evidenceUrl || !destinationKey) {
      return res.status(400).json({ error: 'evidence_url and destination_key are required' });
    }
    if (!validatePublicKey(destinationKey)) {
      return res.status(400).json({ error: 'destination_key must be a valid Stellar public key' });
    }

    const {
      safe: urlSafe,
      reason: urlReason,
      normalized: normalizedUrl,
    } = validateRenderUrl(evidenceUrl);
    if (!urlSafe) {
      return res.status(422).json({ error: `evidence_url is not valid: ${urlReason}` });
    }

    const { rows: milestones } = await db.query(
      `SELECT m.*, c.creator_id, c.status AS campaign_status, c.title AS campaign_title,
            c.migration_in_progress
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.id = $1`,
      [req.params.id]
    );
    if (!milestones.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = milestones[0];

    if (milestone.migration_in_progress) {
      return res.status(503).json({
        error:
          "Milestone submissions are temporarily paused while this campaign's contract is being upgraded",
        code: 'CAMPAIGN_MIGRATION_IN_PROGRESS',
      });
    }

    try {
      await assertCanSubmitMilestone(milestone, req.user.userId, req.user.role);
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message });
    }
    if (!['funded', 'in_progress'].includes(milestone.campaign_status)) {
      return res.status(409).json({
        error: `Milestone submission is not available while campaign status is "${milestone.campaign_status}".`,
      });
    }
    if (milestone.status === 'released') {
      return res.status(409).json({ error: 'This milestone has already been released' });
    }
    if (milestone.status === 'pending_review') {
      return res
        .status(409)
        .json({ error: 'Evidence is already submitted and awaiting platform review' });
    }
    if (!['pending', 'rejected'].includes(milestone.status)) {
      return res
        .status(409)
        .json({ error: `Cannot submit evidence while milestone status is "${milestone.status}"` });
    }

    // Auto-releasing milestones: confirm the evidence object really exists in
    // platform storage before the dispute-window countdown can start.
    let evidenceExists = null;
    if (milestone.auto_release_enabled) {
      const parsedEvidence = parseMilestoneEvidenceUrl(milestone.id, normalizedUrl);
      if (!parsedEvidence) {
        evidenceExists = false;
      } else {
        evidenceExists = await milestoneEvidenceExists(parsedEvidence.key).catch(err => {
          logger.warn('Milestone evidence existence check failed', {
            milestone_id: milestone.id,
            error: err.message,
          });
          return null;
        });
      }
    }

    const client = await db.connect();
    let updatedMilestone;
    try {
      await client.query('BEGIN');
      const { rows: updated } = await client.query(
        `UPDATE milestones
       SET evidence_url = $1,
           evidence_description = $2,
           destination_key = $3,
           review_note = NULL,
           reviewer_id = NULL,
           reviewed_at = NULL,
           status = 'pending_review',
           evidence_submitted_at = NOW(),
           completed_at = NOW()
       WHERE id = $4 AND status IN ('pending', 'rejected')
       RETURNING *`,
        [
          normalizedUrl,
          String(evidenceDescription || '').trim() || null,
          destinationKey,
          req.params.id,
        ]
      );
      if (!updated.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Milestone is not eligible for evidence submission' });
      }
      updatedMilestone = updated[0];
      await logMilestoneEvent(client, {
        milestoneId: milestone.id,
        actorUserId: req.user.userId,
        action: 'evidence_submitted',
        note: updatedMilestone.evidence_description,
        metadata: { evidence_url: updatedMilestone.evidence_url },
      });
      const scheduled = await autoRelease.scheduleOnSubmission(client, updatedMilestone, {
        evidenceExists,
      });
      if (scheduled) updatedMilestone = scheduled;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Milestone evidence submission failed', {
        milestone_id: milestone.id,
        error: err.message,
      });
      return res.status(500).json({ error: 'Could not submit milestone evidence' });
    } finally {
      client.release();
    }

    // Soroban integration: Submit milestone on-chain
    const { rows: campaignRows } = await db.query(
      'SELECT milestones_contract_id FROM campaigns WHERE id = $1',
      [milestone.campaign_id]
    );
    const contractId = campaignRows[0]?.milestones_contract_id;

    if (contractId) {
      try {
        const evidenceHash = crypto.createHash('sha256').update(evidenceUrl).digest();
        const { rows: userRows } = await db.query(
          'SELECT wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
          [req.user.userId]
        );
        const user = userRows[0];

        await withDecryptedWalletSecret(
          user.wallet_secret_encrypted,
          { userId: req.user.userId, walletPublicKey: user.wallet_public_key },
          async secret => {
            await invokeContract({
              contractId,
              method: 'submit_milestone',
              args: [nativeToScVal(milestone.sort_order), nativeToScVal(evidenceHash)],
              signerSecret: secret,
            });
          }
        );
      } catch (err) {
        logger.error('Soroban submit_milestone failed', {
          error: err.message,
          milestone_id: milestone.id,
        });
      }
    }

    setImmediate(() => {
      db.query('SELECT name FROM users WHERE id = $1', [milestone.creator_id])
        .then(({ rows: creatorRows }) =>
          notifyAdminsOnEvidenceSubmitted({
            milestone: updatedMilestone,
            campaignTitle: milestone.campaign_title,
            creatorName: creatorRows[0]?.name,
          })
        )
        .catch(err =>
          logger.error('Milestone evidence admin notify failed', { error: err.message })
        );

      notifyFollowers(
        milestone.campaign_id,
        'notify_milestones',
        {
          type: 'milestone_evidence_submitted',
          title: `${milestone.campaign_title}: evidence submitted for "${milestone.title}"`,
          body:
            updatedMilestone.auto_release_status === 'scheduled'
              ? `Funds release automatically at ${new Date(updatedMilestone.auto_release_at).toISOString()} unless a backer opens a dispute before then.`
              : 'The milestone is awaiting platform review.',
          link: `/campaigns/${milestone.campaign_id}`,
        },
        req.user.userId
      ).catch(err => logger.error('Milestone follower notify failed', { error: err.message }));
    });

    evaluateCampaign(milestone.campaign_id).catch(err =>
      logger.error('Fraud evaluate failed in milestone submit', { error: err.message })
    );

    res.json(updatedMilestone);
  })
);

router.post(
  '/:id/upload-evidence',
  requireAuth,
  evidenceUpload.single('evidence_file'),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'evidence_file is required' });
    }

    const { rows: milestones } = await db.query(
      `SELECT m.*, c.creator_id, c.status AS campaign_status
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.id = $1`,
      [req.params.id]
    );
    if (!milestones.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = milestones[0];

    try {
      await assertCanSubmitMilestone(milestone, req.user.userId, req.user.role);
    } catch (err) {
      return res.status(err.status || 403).json({ error: err.message });
    }
    if (milestone.status === 'released' || milestone.status === 'pending_review') {
      return res
        .status(409)
        .json({ error: 'Cannot upload evidence for this milestone in its current state' });
    }

    try {
      const evidenceUrl = await uploadMilestoneEvidence(milestone.id, req.file);
      res.json({ evidence_url: evidenceUrl });
    } catch (err) {
      logger.error('Milestone evidence upload failed', {
        milestone_id: milestone.id,
        error: err.message,
      });
      res.status(500).json({ error: 'Could not upload evidence file' });
    }
  }
);

// Public: backers see the pending release, its evidence, rule and countdown.
router.get(
  '/:id/auto-release',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM milestones WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Milestone not found' });
    res.json(autoRelease.describeAutoRelease(rows[0]));
  })
);

// Creator opts a milestone in or out of automatic release. The rule and window
// are fixed once evidence is submitted, so they are agreed before the fact;
// opting out (which falls back to manual review) is allowed until release.
router.put(
  '/:id/auto-release',
  requireAuth,
  asyncHandler(async (req, res) => {
    let config;
    try {
      config = autoRelease.parseAutoReleaseConfig(req.body);
    } catch (err) {
      return res
        .status(err.status || 422)
        .json({ error: err.message, code: err.code, ...autoRelease.windowPolicy() });
    }

    const { rows: milestones } = await db.query(
      `SELECT m.*, c.creator_id
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.id = $1`,
      [req.params.id]
    );
    if (!milestones.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = milestones[0];
    if (milestone.creator_id !== req.user.userId) {
      return res
        .status(403)
        .json({ error: 'Only the campaign creator can configure automatic release' });
    }
    if (
      ['releasing', 'released'].includes(milestone.auto_release_status) ||
      milestone.status === 'released'
    ) {
      return res
        .status(409)
        .json({ error: 'This milestone has already been released or is being released' });
    }

    let updated;
    if (config.enabled) {
      if (!['pending', 'rejected'].includes(milestone.status)) {
        return res.status(409).json({
          error: 'Automatic release must be configured before evidence is submitted',
          code: 'AUTO_RELEASE_LOCKED',
        });
      }
      const { rows } = await db.query(
        `UPDATE milestones
       SET auto_release_enabled = TRUE,
           auto_release_rule = $2,
           auto_release_rule_config = $3::jsonb,
           auto_release_window_seconds = $4,
           auto_release_status = 'awaiting_evidence',
           auto_release_configured_at = NOW(),
           auto_release_scheduled_at = NULL,
           auto_release_at = NULL,
           auto_release_halted_at = NULL,
           auto_release_halt_reason = NULL,
           auto_release_dispute_id = NULL
       WHERE id = $1 AND status IN ('pending', 'rejected')
       RETURNING *`,
        [milestone.id, config.rule, JSON.stringify(config.ruleConfig), config.windowSeconds]
      );
      updated = rows[0];
    } else {
      const { rows } = await db.query(
        `UPDATE milestones
       SET auto_release_enabled = FALSE,
           auto_release_status = CASE WHEN auto_release_status IS NULL THEN NULL ELSE 'cancelled' END,
           auto_release_at = NULL
       WHERE id = $1 AND COALESCE(auto_release_status, '') NOT IN ('releasing', 'released')
       RETURNING *`,
        [milestone.id]
      );
      updated = rows[0];
    }
    if (!updated) {
      return res.status(409).json({ error: 'Milestone changed while updating; please retry' });
    }

    await logMilestoneEvent(null, {
      milestoneId: milestone.id,
      actorUserId: req.user.userId,
      action: config.enabled ? 'auto_release_configured' : 'auto_release_disabled',
      metadata: config.enabled
        ? {
            rule: config.rule,
            rule_config: config.ruleConfig,
            dispute_window_seconds: config.windowSeconds,
          }
        : { previous_status: milestone.auto_release_status },
    });

    res.json(autoRelease.describeAutoRelease(updated));
  })
);

router.get(
  '/:id/events',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: milestones } = await db.query(
      `SELECT m.*, c.creator_id
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.id = $1`,
      [req.params.id]
    );
    if (!milestones.length) return res.status(404).json({ error: 'Milestone not found' });
    const milestone = milestones[0];

    const isCreator = milestone.creator_id === req.user.userId;
    const canPlatform = canPerformPlatformSignature(req.user.userId);
    if (!isCreator && !canPlatform && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to view milestone audit trail' });
    }

    const { rows } = await db.query(
      `SELECT e.*, u.name AS actor_name
     FROM milestone_events e
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.milestone_id = $1
     ORDER BY e.created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  })
);

router.get(
  '/:id/votes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const context = await getMilestoneVoteContext(req.params.id, req.user.userId);
    if (!context) return res.status(404).json({ error: 'Milestone not found' });

    const canPlatform = canPerformPlatformSignature(req.user.userId);
    if (!context.isContributor && !context.isCreator && !canPlatform && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to view milestone votes' });
    }

    const tally = await getMilestoneVoteTally(req.params.id, req.user.userId);
    res.json({
      milestone_id: req.params.id,
      ...tally,
    });
  })
);

router.post(
  '/:id/votes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const vote = String(req.body?.vote || '')
      .trim()
      .toLowerCase();
    const note = String(req.body?.note || '').trim() || null;
    if (!['approve', 'reject'].includes(vote)) {
      return res.status(400).json({ error: 'vote must be approve or reject' });
    }

    const context = await getMilestoneVoteContext(req.params.id, req.user.userId);
    if (!context) return res.status(404).json({ error: 'Milestone not found' });
    if (!context.isContributor) {
      return res.status(403).json({ error: 'Only contributors can vote on milestone approval' });
    }
    if (context.isCreator) {
      return res
        .status(403)
        .json({ error: 'Campaign creators cannot vote on their own milestone approval' });
    }
    if (context.milestone.status !== 'pending_review') {
      return res
        .status(409)
        .json({ error: 'Milestone voting is only open while evidence is awaiting review' });
    }

    await db.query(
      `INSERT INTO milestone_votes (milestone_id, user_id, vote, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (milestone_id, user_id)
     DO UPDATE SET vote = EXCLUDED.vote, note = EXCLUDED.note, updated_at = NOW()`,
      [req.params.id, req.user.userId, vote, note]
    );

    await logMilestoneEvent(null, {
      milestoneId: req.params.id,
      actorUserId: req.user.userId,
      action: 'contributor_voted',
      note,
      metadata: { vote },
    });

    const tally = await getMilestoneVoteTally(req.params.id, req.user.userId);
    res.json({
      milestone_id: req.params.id,
      ...tally,
    });
  })
);

router.post(
  '/:id/reject',
  requireAuth,
  asyncHandler(async (req, res) => {
    await requirePlatformApproverAuth(req.user.userId);

    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({ error: 'reason is required' });
    }

    const { rows } = await db.query(
      `UPDATE milestones
     SET status = 'rejected',
         review_note = $1,
         approved_at = NULL,
         reviewer_id = $2,
         reviewed_at = NOW(),
         auto_release_status = CASE WHEN auto_release_enabled THEN 'awaiting_evidence' ELSE auto_release_status END,
         auto_release_at = NULL
     WHERE id = $3 AND status = 'pending_review'
       AND COALESCE(auto_release_status, '') <> 'releasing'
     RETURNING *`,
      [reason, req.user.userId, req.params.id]
    );
    if (!rows.length) {
      return res.status(404).json({
        error: 'Milestone not found, not awaiting review, or being released automatically',
      });
    }

    await logMilestoneEvent(null, {
      milestoneId: rows[0].id,
      actorUserId: req.user.userId,
      action: 'rejected',
      note: reason,
    });

    await logAuditEvent({
      actorId: req.user.userId,
      action: 'milestone.rejected',
      resourceType: 'milestone',
      resourceId: rows[0].id,
      before: { status: 'pending_review' },
      after: { status: rows[0].status },
      metadata: {
        campaign_id: rows[0].campaign_id,
        reason,
      },
      req,
    }).catch(e => logger.error('Milestone rejection audit log failed', { error: e.message }));

    // Soroban integration: Reject milestone on-chain
    const { rows: campaignRows } = await db.query(
      'SELECT milestones_contract_id, creator_id FROM campaigns WHERE id = $1',
      [rows[0].campaign_id]
    );
    const contractId = campaignRows[0]?.milestones_contract_id;
    if (contractId) {
      try {
        const reasonHash = crypto.createHash('sha256').update(reason).digest();
        await invokeContract({
          contractId,
          method: 'reject_milestone',
          args: [nativeToScVal(rows[0].sort_order), nativeToScVal(reasonHash)],
          signerSecret: process.env.PLATFORM_SECRET_KEY,
        });
      } catch (err) {
        logger.error('Soroban reject_milestone failed', {
          error: err.message,
          milestone_id: req.params.id,
        });
      }
    }

    evaluateCampaign(rows[0].campaign_id).catch(err =>
      logger.error('Fraud evaluate failed in milestone reject', { error: err.message })
    );

    if (campaignRows[0]?.creator_id) {
      setImmediate(() => {
        emitWebhookEventForUser(campaignRows[0].creator_id, WEBHOOK_EVENTS.MILESTONE_REJECTED, {
          milestone: rows[0],
          campaign_id: rows[0].campaign_id,
          reason,
        }).catch(err =>
          logger.error('Milestone rejected webhook emit failed', { error: err.message })
        );
      });
    }

    res.json(rows[0]);
  })
);

const approveMilestoneReleaseHandler = asyncHandler(async (req, res) => {
  await requirePlatformApproverAuth(req.user.userId);

  const reviewNote = String(req.body?.reason || '').trim() || null;

  const { rows: milestoneRows } = await db.query(
    `SELECT m.*, c.status AS campaign_status, c.wallet_public_key AS campaign_wallet_public_key,
            c.asset_type, c.raised_amount, c.target_amount, c.title AS campaign_title,
            c.creator_id, u.wallet_public_key AS creator_wallet_public_key,
            u.wallet_secret_encrypted, u.wallet_type AS creator_wallet_type
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     JOIN users u ON u.id = c.creator_id
     WHERE m.id = $1`,
    [req.params.id]
  );
  if (!milestoneRows.length) return res.status(404).json({ error: 'Milestone not found' });
  const milestone = milestoneRows[0];

  if (!['funded', 'in_progress'].includes(milestone.campaign_status)) {
    return res.status(409).json({
      error: `Milestone approval is not available while campaign status is "${milestone.campaign_status}".`,
    });
  }
  if (milestone.status !== 'pending_review') {
    return res
      .status(409)
      .json({ error: 'Milestone must be in pending_review before platform approval' });
  }
  if (!milestone.evidence_url) {
    return res
      .status(409)
      .json({ error: 'Creator must submit milestone evidence before approval' });
  }
  if (!milestone.destination_key || !validatePublicKey(milestone.destination_key)) {
    return res
      .status(409)
      .json({ error: 'Creator must provide a valid payout destination before approval' });
  }
  if (milestone.status === 'released') {
    return res.status(409).json({ error: 'Milestone already released' });
  }

  const contributorTally = await getMilestoneVoteTally(milestone.id);
  if (votesBlockRelease(contributorTally)) {
    return res.status(409).json({
      error: 'Contributor vote threshold has not been met for this milestone release',
      contributor_votes: contributorTally,
    });
  }

  // The server signs below with the creator's custodial key and the platform
  // key, so for custodial creators it alone satisfies the 2-of-2 multisig.
  // Cap how much it may move that way; larger releases need a Freighter creator.
  const releaseAmount = toReleaseAmount(milestone.raised_amount, milestone.release_percentage);
  try {
    assertCustodialWithdrawalAllowed({
      walletType: milestone.creator_wallet_type,
      amount: releaseAmount,
    });
  } catch (err) {
    if (!(err instanceof CustodialSigningLimitError)) throw err;
    return res
      .status(err.statusCode)
      .json({ error: err.message, code: err.code, limit: err.limit });
  }

  // Atomically claim the milestone to prevent concurrent approvals.
  // Uses SELECT FOR UPDATE + UPDATE claimed_at to serialize concurrent requests.
  const claimClient = await db.connect();
  try {
    await claimClient.query('BEGIN');
    const { rows: claimedRows } = await claimClient.query(
      `UPDATE milestones
       SET claimed_at = NOW()
       WHERE id = $1
         AND status = 'pending_review'
         AND claimed_at IS NULL
       RETURNING id`,
      [milestone.id]
    );
    if (!claimedRows.length) {
      await claimClient.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'Milestone is already being processed or has been claimed' });
    }
    await claimClient.query('COMMIT');
  } catch (claimErr) {
    await claimClient.query('ROLLBACK');
    logger.error('Milestone claim failed', { milestone_id: milestone.id, error: claimErr.message });
    return res.status(500).json({ error: 'Could not claim milestone for processing' });
  } finally {
    claimClient.release();
  }

  const unsignedXdr = await buildWithdrawalTransaction({
    campaignWalletPublicKey: milestone.campaign_wallet_public_key,
    destinationPublicKey: milestone.destination_key,
    amount: releaseAmount,
    asset: milestone.asset_type,
  });

  let creatorSignedXdr;
  try {
    creatorSignedXdr = await withDecryptedWalletSecret(
      milestone.wallet_secret_encrypted,
      {
        userId: milestone.creator_id,
        walletPublicKey: milestone.creator_wallet_public_key,
      },
      async creatorSecret =>
        signTransactionXdr({
          xdr: unsignedXdr,
          signerSecret: creatorSecret,
        })
    );
  } catch (err) {
    logger.error('Milestone creator signature failed', {
      milestone_id: milestone.id,
      error: err.message,
    });
    return res
      .status(503)
      .json({ error: 'Creator signature could not be produced for this milestone release.' });
  }

  const fullySignedXdr = signTransactionXdr({
    xdr: creatorSignedXdr,
    signerSecret: process.env.PLATFORM_SECRET_KEY,
  });

  if (signatureCountFromXdr(fullySignedXdr) < 2) {
    return res
      .status(422)
      .json({ error: 'Milestone release requires both creator and platform signatures' });
  }

  let txHash;
  try {
    txHash = await submitSignedWithdrawal({ xdr: fullySignedXdr });
  } catch (err) {
    logger.error('Milestone release submission failed', {
      milestone_id: milestone.id,
      error: err.message,
    });
    sendAlert('Milestone release submission failed', {
      milestone_id: milestone.id,
      error: err.message,
    });
    return res.status(502).json({
      error: 'Stellar network rejected the milestone release transaction',
      detail: err.message || String(err),
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: existingRelease } = await client.query(
      'SELECT id FROM withdrawal_requests WHERE milestone_id = $1 LIMIT 1',
      [milestone.id]
    );
    if (existingRelease.length) {
      await client.query('ROLLBACK');
      return res
        .status(409)
        .json({ error: 'A release has already been recorded for this milestone' });
    }

    const { rows: releaseRows } = await client.query(
      `INSERT INTO withdrawal_requests
         (campaign_id, requested_by, amount, destination_key, unsigned_xdr,
          creator_signed, platform_signed, status, tx_hash, milestone_id)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE, 'submitted', $6, $7)
       RETURNING *`,
      [
        milestone.campaign_id,
        req.user.userId,
        releaseAmount,
        milestone.destination_key,
        fullySignedXdr,
        txHash,
        milestone.id,
      ]
    );
    const withdrawalRequest = releaseRows[0];

    await logWithdrawalEvent(client, {
      withdrawalRequestId: withdrawalRequest.id,
      actorUserId: req.user.userId,
      action: 'requested',
      note: 'Milestone release approved by platform',
      metadata: {
        milestone_id: milestone.id,
        release_percentage: milestone.release_percentage,
        release_amount: releaseAmount,
      },
    });
    await logWithdrawalEvent(client, {
      withdrawalRequestId: withdrawalRequest.id,
      actorUserId: milestone.creator_id,
      action: 'creator_signed',
      note: 'Creator signature applied during milestone release',
      metadata: { milestone_id: milestone.id },
    });
    await logWithdrawalEvent(client, {
      withdrawalRequestId: withdrawalRequest.id,
      actorUserId: req.user.userId,
      action: 'platform_signed',
      note: reviewNote || 'Platform approved milestone release',
      metadata: { milestone_id: milestone.id, tx_hash: txHash },
    });

    await insertWithdrawalPendingSignatures(client, {
      campaignId: milestone.campaign_id,
      withdrawalRequestId: withdrawalRequest.id,
      userId: req.user.userId,
      unsignedXdr,
      metadata: {
        milestone_id: milestone.id,
        milestone_title: milestone.title,
        amount: releaseAmount,
        asset_type: milestone.asset_type,
      },
    });
    await finalizeWithdrawalSubmitted(client, {
      withdrawalRequestId: withdrawalRequest.id,
      txHash,
      signedXdr: fullySignedXdr,
    });

    const { rows: updatedMilestones } = await client.query(
      `UPDATE milestones
       SET status = 'released',
           review_note = $1,
           approved_at = COALESCE(approved_at, NOW()),
           released_at = NOW(),
           reviewer_id = $2,
           reviewed_at = COALESCE(reviewed_at, NOW()),
           release_trigger = 'manual',
           auto_release_status = CASE WHEN auto_release_status IS NULL THEN NULL ELSE 'superseded' END,
           auto_release_at = NULL
       WHERE id = $3
       RETURNING *`,
      [reviewNote, req.user.userId, milestone.id]
    );

    await logMilestoneEvent(client, {
      milestoneId: milestone.id,
      actorUserId: req.user.userId,
      action: 'approved',
      note: reviewNote || 'Platform approved milestone release',
      metadata: { tx_hash: txHash, release_amount: releaseAmount },
    });
    await logMilestoneEvent(client, {
      milestoneId: milestone.id,
      actorUserId: req.user.userId,
      action: 'released',
      note: 'Funds released on-chain',
      metadata: { tx_hash: txHash },
    });

    // Soroban integration: release milestone on-chain
    const { rows: campaignRows } = await client.query(
      'SELECT milestones_contract_id FROM campaigns WHERE id = $1',
      [milestone.campaign_id]
    );
    const milestonesContractId = campaignRows[0]?.milestones_contract_id;
    if (milestonesContractId) {
      try {
        await releaseMilestone({
          milestonesContractId,
          milestoneIndex: milestone.sort_order,
          signerSecret: process.env.PLATFORM_SECRET_KEY,
        });
        await client.query(
          `UPDATE withdrawal_requests
           SET contract_milestone_index = $1
           WHERE id = $2`,
          [milestone.sort_order, withdrawalRequest.id]
        );
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Soroban milestone release failed', {
          error: err.message,
          milestone_id: milestone.id,
          tx_hash: txHash,
        });
        return res.status(502).json({
          error: 'On-chain milestone release failed',
          detail: err.message,
          tx_hash: txHash,
        });
      }
    }

    const campaignStatus = await setCampaignStatusFromMilestoneProgress(
      client,
      milestone.campaign_id
    );

    await client.query('COMMIT');

    logAuditEvent({
      actorId: req.user.userId,
      action: 'milestone.released',
      resourceType: 'milestone',
      resourceId: milestone.id,
      before: { status: 'pending_review' },
      after: { status: 'released' },
      metadata: {
        release_mode: 'manual',
        campaign_id: milestone.campaign_id,
        withdrawal_request_id: withdrawalRequest.id,
        release_amount: releaseAmount,
        tx_hash: txHash,
        superseded_auto_release_status: milestone.auto_release_status || null,
      },
      req,
    }).catch(e => logger.error('Milestone release audit log failed', { error: e.message }));

    setImmediate(() => {
      emitWebhookEventForUser(milestone.creator_id, WEBHOOK_EVENTS.MILESTONE_APPROVED, {
        milestone: updatedMilestones[0],
        campaign_id: milestone.campaign_id,
        withdrawal_request_id: withdrawalRequest.id,
        tx_hash: txHash,
      }).catch(e => logger.error('Milestone webhook emit failed', { error: e.message }));

      const campaignUrl = `${frontendBaseUrl()}/campaigns/${milestone.campaign_id}`;
      db.query(`SELECT u.email, u.name FROM users u WHERE u.id = $1`, [milestone.creator_id])
        .then(({ rows: creatorRows }) => {
          if (!creatorRows.length) return;
          return sendMilestoneReleasedCreatorEmail({
            to: creatorRows[0].email,
            milestoneId: milestone.id,
            creatorName: creatorRows[0].name,
            campaignTitle: milestone.campaign_title,
            campaignUrl,
            milestoneTitle: milestone.title,
            amount: releaseAmount,
            asset: milestone.asset_type,
            txHash,
          });
        })
        .catch(e => logger.error('Milestone creator email failed', { error: e.message }));

      db.query(
        `SELECT DISTINCT ON (u.id) u.id, u.email, u.name
         FROM contributions c
         JOIN users u ON u.wallet_public_key = c.sender_public_key
         WHERE c.campaign_id = $1 AND u.email IS NOT NULL
         ORDER BY u.id, c.created_at ASC`,
        [milestone.campaign_id]
      )
        .then(({ rows: contributors }) => {
          notifyFollowers(
            milestone.campaign_id,
            'notify_milestones',
            {
              type: 'milestone_released',
              title: `${milestone.campaign_title}: "${milestone.title}" released`,
              body: `${releaseAmount} ${milestone.asset_type} has been released to the creator.`,
              link: `/campaigns/${milestone.campaign_id}`,
            },
            [req.user.userId, ...contributors.map(contributor => contributor.id)]
          ).catch(e => logger.error('Milestone follower notify failed', { error: e.message }));

          return contributors;
        })
        .catch(e => logger.error('Milestone follower notify failed', { error: e.message }));

      notifyContributorFundRelease({
        campaignId: milestone.campaign_id,
        campaignTitle: milestone.campaign_title,
        amount: releaseAmount,
        asset: milestone.asset_type,
        txHash,
        usage: `Milestone "${milestone.title}" was approved and released.`,
        recipient: milestone.destination_key,
        excludeUserIds: [req.user.userId],
      }).catch(e => logger.error('Contributor fund release notify failed', { error: e.message }));
    });

    evaluateCampaign(milestone.campaign_id).catch(err =>
      logger.error('Fraud evaluate failed in milestone approve', { error: err.message })
    );

    res.json({
      milestone: updatedMilestones[0],
      withdrawal_request: withdrawalRequest,
      campaign_status: campaignStatus?.status || milestone.campaign_status,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Milestone approval persistence failed after Stellar submit', {
      milestone_id: milestone.id,
      tx_hash: txHash,
      error: err.message,
    });
    sendAlert('Milestone approval persistence failed after Stellar submit', {
      milestone_id: milestone.id,
      tx_hash: txHash,
      error: err.message,
    });
    res
      .status(500)
      .json({ error: 'Milestone release was submitted but could not be recorded cleanly' });
  } finally {
    client.release();
  }
});

router.post('/:id/approve', requireAuth, approveMilestoneReleaseHandler);
router.post('/:id/release', requireAuth, approveMilestoneReleaseHandler);

module.exports = router;
