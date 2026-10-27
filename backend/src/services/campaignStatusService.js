const db = require('../config/database');
const logger = require('../config/logger');
const { triggerCampaignStatusActions } = require('./campaignStatusActions');
const { logAuditEvent } = require('./auditService');

/** Postgres advisory lock id — serializes batch status refresh across cron instances. */
const CAMPAIGN_STATUS_REFRESH_LOCK_KEY = 323001;

const RETURNING_COLUMNS =
  'id, title, creator_id, target_amount, raised_amount, deadline, status, escrow_contract_id, ' +
  '(SELECT COUNT(*) FROM contributions WHERE contributions.campaign_id = campaigns.id) AS backer_count';

const ATOMIC_TRANSITION_SQL = `
  SET status = CASE
    WHEN raised_amount >= target_amount THEN 'funded'
    WHEN deadline IS NOT NULL
      AND deadline < CURRENT_DATE
      AND raised_amount < target_amount THEN 'failed'
    ELSE status
  END`;

const ACTIVE_TRANSITION_PREDICATE = `
  status = 'active'
  AND (
    raised_amount >= target_amount
    OR (
      deadline IS NOT NULL
      AND deadline < CURRENT_DATE
      AND raised_amount < target_amount
    )
  )`;

function splitTransitionResults(rows) {
  const funded = [];
  const failed = [];
  for (const row of rows) {
    if (row.status === 'funded') funded.push(row);
    else if (row.status === 'failed') failed.push(row);
  }
  return { funded, failed };
}

/**
 * Emit a structured log line for a single campaign status transition.
 * All numeric fields are cast to Number so log queries can apply arithmetic
 * (e.g. alert when funded_count > threshold).
 */
function logTransition(campaign, oldStatus) {
  logger.info('Campaign status transition', {
    campaignId: campaign.id,
    creatorId: campaign.creator_id,
    oldStatus,
    newStatus: campaign.status,
    raisedAmount: Number(campaign.raised_amount),
    goalAmount: Number(campaign.target_amount),
    backerCount: Number(campaign.backer_count),
    deadline: campaign.deadline,
  });
}

async function auditCampaignTransition(campaign, oldStatus, source, client) {
  try {
    await logAuditEvent({
      actorId: null,
      action: 'campaign.status_changed',
      resourceType: 'campaign',
      resourceId: campaign.id,
      before: { status: oldStatus },
      after: { status: campaign.status },
      metadata: {
        creator_id: campaign.creator_id,
        raised_amount: String(campaign.raised_amount),
        target_amount: String(campaign.target_amount),
        backer_count: Number(campaign.backer_count),
        deadline: campaign.deadline,
        transition_source: source,
      },
      source,
      client,
    });
  } catch (err) {
    logger.error('Campaign status audit event failed', {
      campaign_id: campaign.id,
      old_status: oldStatus,
      new_status: campaign.status,
      error: err.message,
    });
  }
}

/**
 * Reconcile status for one campaign (active → funded or failed based on goal/deadline).
 * Uses a single atomic UPDATE so concurrent callers cannot both observe and transition active rows.
 */
async function refreshCampaignStatus(campaignId, client) {
  const runner = client || db;
  const { rows } = await runner.query(
    `UPDATE campaigns
     ${ATOMIC_TRANSITION_SQL}
     WHERE id = $1
       AND ${ACTIVE_TRANSITION_PREDICATE}
     RETURNING ${RETURNING_COLUMNS}`,
    [campaignId]
  );

  const transitioned = rows[0] || null;
  if (transitioned) {
    logTransition(transitioned, 'active');
    await auditCampaignTransition(transitioned, 'active', 'system:campaign_status_refresh', client);
    await triggerCampaignStatusActions(transitioned, 'active');
  }

  return {
    failed: transitioned?.status === 'failed' ? transitioned : null,
    funded: transitioned?.status === 'funded' ? transitioned : null,
  };
}

/**
 * Batch refresh for all still-active campaigns (hourly cron).
 * Guarded by a Postgres advisory lock so overlapping cron ticks do not run in parallel.
 */
async function refreshActiveCampaignStatuses() {
  const client = await db.connect();
  let lockAcquired = false;

  try {
    const { rows: lockRows } = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [
      CAMPAIGN_STATUS_REFRESH_LOCK_KEY,
    ]);
    lockAcquired = lockRows[0]?.acquired === true;
    if (!lockAcquired) {
      logger.info('Campaign status refresh skipped — another instance holds the advisory lock');
      return { funded: [], failed: [], skipped: true };
    }

    const { rows } = await client.query(
      `UPDATE campaigns
       ${ATOMIC_TRANSITION_SQL}
       WHERE ${ACTIVE_TRANSITION_PREDICATE}
       RETURNING ${RETURNING_COLUMNS}`
    );

    const { funded, failed } = splitTransitionResults(rows);

    if (funded.length || failed.length) {
      for (const campaign of funded) {
        logTransition(campaign, 'active');
        await auditCampaignTransition(campaign, 'active', 'system:campaign_status_batch', client);
        await triggerCampaignStatusActions(campaign, 'active');
      }
      for (const campaign of failed) {
        logTransition(campaign, 'active');
        await auditCampaignTransition(campaign, 'active', 'system:campaign_status_batch', client);
        await triggerCampaignStatusActions(campaign, 'active');
      }

      logger.info('Campaign status refresh completed', {
        funded_count: funded.length,
        failed_count: failed.length,
      });
    }

    return { funded, failed, skipped: false };
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock($1)', [CAMPAIGN_STATUS_REFRESH_LOCK_KEY]);
    }
    client.release();
  }
}

module.exports = {
  refreshCampaignStatus,
  refreshActiveCampaignStatuses,
  CAMPAIGN_STATUS_REFRESH_LOCK_KEY,
};
