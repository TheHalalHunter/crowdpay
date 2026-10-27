const Sentry = require('@sentry/node');
const db = require('../config/database');
const logger = require('../config/logger');
const cache = require('../utils/cache');
const withTransaction = require('../utils/withTransaction');
const { getCampaignBalance } = require('./stellarService');
const { getEscrowTotalRaised } = require('./sorobanService');
const { fromStroops } = require('../utils/stroops');
const {
  insertContributionAdjustment,
  insertReconciliationAdjustment,
} = require('./stellarTransactionService');

const DISCREPANCY_EPSILON = 0.0000001;

/**
 * Resolve the authoritative on-chain total for a campaign.
 *
 * Contract-mode campaigns hold their funds in the Soroban escrow, so the
 * classic multisig account is empty: reading it would overwrite
 * `raised_amount` with `0` and book a full-size negative adjustment once an
 * hour (#901). The contract's own `get_total_raised` is the source of truth
 * there, exactly as `campaignStatusActions.syncSorobanStatus` already assumes.
 */
async function getQuarantinedAmount(campaignId, assetType, dbClient = db) {
  try {
    const { rows } = await dbClient.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM quarantined_payments
       WHERE campaign_id = $1 AND asset_code = $2`,
      [campaignId, assetType]
    );
    return parseFloat(rows[0]?.total || '0');
  } catch (err) {
    if (err.code === '42P01') return 0;
    throw err;
  }
}

async function readLiveCampaignBalance(campaign, dbClient = db) {
  if (campaign.escrow_contract_id) {
    const totalRaisedStroops = await getEscrowTotalRaised(campaign.escrow_contract_id);
    return parseFloat(fromStroops(totalRaisedStroops || 0));
  }

  const onChain = await getCampaignBalance(campaign.wallet_public_key);
  const rawBalance = parseFloat(onChain[campaign.asset_type] || '0');

  // Prevent reconciliation jobs from processing quarantined payments (#1092).
  // Quarantined payments sit on-chain in the wallet account but must never be credited.
  const quarantinedAmount = await getQuarantinedAmount(campaign.id, campaign.asset_type, dbClient);
  if (quarantinedAmount > 0) {
    logger.info('[reconcile] Deducted quarantined payments from campaign live balance', {
      campaign_id: campaign.id,
      asset_type: campaign.asset_type,
      raw_balance: rawBalance,
      quarantined_amount: quarantinedAmount,
    });
  }

  return Math.max(0, rawBalance - quarantinedAmount);
}

function getReconciliationAlertThreshold() {
  const raw = process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD;
  if (raw === undefined || raw === '') return 1;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
}

function hasDiscrepancy(dbBalance, liveBalance) {
  return Math.abs(liveBalance - dbBalance) > DISCREPANCY_EPSILON;
}

function alertDiscrepancyIfNeeded(campaignId, audit) {
  const threshold = getReconciliationAlertThreshold();
  if (Math.abs(audit.diff) < threshold) return;

  Sentry.withScope(scope => {
    scope.setLevel('warning');
    scope.setTag('campaign_id', campaignId);
    scope.setContext('reconciliation', audit);
    Sentry.captureMessage('Campaign raised_amount reconciliation discrepancy');
  });
}

async function applyReconciliationCorrection(campaign, dbBalance, liveBalance) {
  const diff = liveBalance - dbBalance;
  const audit = {
    campaign_id: campaign.id,
    db_amount: dbBalance,
    on_chain_amount: liveBalance,
    diff,
    asset_type: campaign.asset_type,
  };

  logger.warn('[reconcile] raised_amount corrected to match on-chain balance', audit);

  const stellarTxId = await withTransaction(async client => {
    await client.query(
      `UPDATE campaigns
       SET raised_amount = $1,
           status = CASE
             WHEN $1 >= target_amount AND status IN ('active', 'funded') THEN 'funded'
             ELSE status
           END
       WHERE id = $2`,
      [liveBalance, campaign.id]
    );
    const adjustedAt = new Date();
    await insertContributionAdjustment(client, {
      campaignId: campaign.id,
      amount: diff,
      assetType: campaign.asset_type,
      adjustedAt,
    });
    return insertReconciliationAdjustment(client, {
      campaignId: campaign.id,
      dbBalance,
      liveBalance,
      diff,
      assetType: campaign.asset_type,
    });
  }, db);

  cache.invalidate(`campaigns:id:${campaign.id}`);
  cache.invalidatePrefix('campaigns:list:');
  cache.invalidatePrefix('stats:');

  alertDiscrepancyIfNeeded(campaign.id, audit);

  return {
    updated: true,
    dbBalance,
    liveBalance,
    diff,
    stellar_transaction_id: stellarTxId,
  };
}

const MAX_STORED_RUNS = 20;
const recentRuns = [];

function recordReconciliationRun(summary) {
  recentRuns.unshift(summary);
  if (recentRuns.length > MAX_STORED_RUNS) recentRuns.length = MAX_STORED_RUNS;
}

function getRecentReconciliationRuns() {
  return [...recentRuns];
}

async function reconcileCampaign(campaign) {
  try {
    const { rows: pendingRows } = await db.query(
      `SELECT id FROM withdrawal_requests WHERE campaign_id = $1 AND status = 'pending' LIMIT 1`,
      [campaign.id]
    );
    if (pendingRows.length > 0) {
      logger.info('[reconcile] Skipping campaign due to pending withdrawal', {
        campaign_id: campaign.id,
      });
      return { skipped: true, reason: 'pending_withdrawal' };
    }

    let liveBalance;
    try {
      liveBalance = await readLiveCampaignBalance(campaign);
    } catch (err) {
      // A rotated/closed wallet (or an unreachable escrow contract) throws on
      // every run. Skip it instead of counting an error forever so a single
      // dead account stops generating permanent false alarms (#901).
      logger.warn('[reconcile] Skipping campaign — wallet balance unavailable', {
        campaign_id: campaign.id,
        escrow_contract_id: campaign.escrow_contract_id || null,
        error: err.message,
      });
      return { skipped: true, reason: 'wallet_unavailable' };
    }

    const dbBalance = parseFloat(campaign.raised_amount);

    if (!hasDiscrepancy(dbBalance, liveBalance)) {
      return { updated: false, dbBalance, liveBalance, diff: 0 };
    }

    return await applyReconciliationCorrection(campaign, dbBalance, liveBalance);
  } catch (err) {
    logger.error('[reconcile] Failed for campaign', {
      campaign_id: campaign.id,
      error: err.message,
    });
    throw err;
  }
}

async function reconcileCampaignBalances() {
  const startedAt = new Date().toISOString();
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount, target_amount, status,
            escrow_contract_id
     FROM campaigns
     WHERE status IN ('active', 'funded')
       AND deleted_at IS NULL
       AND escrow_contract_id IS NULL`
  );

  const summary = {
    started_at: startedAt,
    finished_at: null,
    campaigns_checked: rows.length,
    updated: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };

  for (const campaign of rows) {
    try {
      const result = await reconcileCampaign(campaign);
      if (result.skipped) {
        summary.skipped += 1;
        summary.results.push({
          campaign_id: campaign.id,
          skipped: true,
          reason: result.reason,
        });
      } else if (result.updated) {
        summary.updated += 1;
        summary.results.push({
          campaign_id: campaign.id,
          updated: true,
          db_amount: result.dbBalance,
          on_chain_amount: result.liveBalance,
          diff: result.diff,
          stellar_transaction_id: result.stellar_transaction_id,
        });
      }
    } catch (err) {
      summary.errors += 1;
      summary.results.push({ campaign_id: campaign.id, error: err.message });
    }
  }

  if (summary.updated > 0 || summary.errors > 0) {
    logger.info('[reconcile] Batch reconciliation finished', summary);
  }

  summary.finished_at = new Date().toISOString();
  recordReconciliationRun(summary);
  return summary;
}

async function reconcileSingleCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, raised_amount, target_amount, status,
            escrow_contract_id
     FROM campaigns WHERE id = $1`,
    [campaignId]
  );
  if (!rows.length) {
    throw new Error('Campaign not found');
  }
  return await reconcileCampaign(rows[0]);
}

module.exports = {
  reconcileCampaignBalances,
  reconcileSingleCampaign,
  getReconciliationAlertThreshold,
  hasDiscrepancy,
  DISCREPANCY_EPSILON,
  getRecentReconciliationRuns,
  recordReconciliationRun,
  readLiveCampaignBalance,
  getQuarantinedAmount,
};
