'use strict';

/**
 * recurring.js
 *
 * Recurring pledge engine. Stellar has no native recurring payment primitive, so a
 * subscription is a claimable balance schedule: when a contributor pledges, the full
 * commitment leaves their wallet immediately as one claimable balance per period.
 * The claim worker releases each balance to the campaign wallet on its scheduled date.
 */

const db = require('../config/database');
const logger = require('../config/logger');
const withTransaction = require('../utils/withTransaction');
const {
  createSubscriptionClaimableBalances,
  claimSubscriptionBalanceToCampaign,
  getClaimableBalance,
  isClaimableBalanceGoneError,
  getCampaignBalance,
  ensureCustodialAccountFundedAndTrusted,
  getSupportedAssetCodes,
  buildUnsignedSubscriptionTransaction,
  submitPreparedSubscriptionTransaction,
} = require('./stellarService');
const { withDecryptedWalletSecret } = require('./walletSecrets');
const { buildContributionMemo } = require('./contributionService');
const { createNotification } = require('./notifications');
const { Keypair, TransactionBuilder } = require('@stellar/stellar-sdk');
const { networkPassphrase } = require('../config/stellar');

const PERIOD_DAYS = 30;
const ALLOWED_PERIOD_MONTHS = [1, 3, 6];
const MIN_PERIODS = 2;
const MAX_PERIODS = 24;

/** How long after its scheduled date a balance stays reclaimable only by the platform. */
const CONTRIBUTOR_RECLAIM_AFTER_DAYS = 30;

/** A balance due sooner than this can no longer be cancelled — the worker is about to claim it. */
const CANCELLATION_NOTICE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER_INTERVAL_MS = 24 * 60 * 60 * 1000;

let _workerTimer = null;

/**
 * SQL predicate (over campaign `c` and balance `sb`) for "this campaign still
 * accepts this installment" (#837): the campaign is active, not soft-deleted,
 * and the installment falls on or before the deadline date. Every claim path
 * checks it, so nothing is claimed once a campaign is funded, failed,
 * suspended, deleted or past its deadline.
 */
const CAMPAIGN_ACCEPTS_INSTALLMENT_SQL = `(
  c.status = 'active'
  AND c.deleted_at IS NULL
  AND (c.deadline IS NULL OR sb.scheduled_date < (c.deadline + INTERVAL '1 day'))
)`;

/** Why an installment stopped being collectable; stored as closure_reason. */
const CLOSURE_REASON_SQL = `CASE
  WHEN c.deleted_at IS NOT NULL THEN 'campaign_deleted'
  WHEN c.status = 'funded' THEN 'campaign_funded'
  WHEN c.status = 'failed' THEN 'campaign_failed'
  WHEN c.status = 'suspended' THEN 'campaign_suspended'
  WHEN c.status <> 'active' THEN 'campaign_closed'
  ELSE 'campaign_deadline_passed'
END`;

const CLOSURE_REASON_TEXT = {
  campaign_deleted: 'the campaign was removed',
  campaign_funded: 'the campaign reached its goal',
  campaign_failed: 'the campaign did not reach its goal',
  campaign_suspended: 'the campaign was suspended',
  campaign_closed: 'the campaign is no longer accepting contributions',
  campaign_deadline_passed: "these installments fall after the campaign's deadline",
};

function httpError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
}

function toAmount(value) {
  return Number(parseFloat(value).toFixed(7));
}

/** Scheduled date of period N (1-based): now + N * periodMonths * 30 days. */
function scheduleDateForPeriod(startedAt, period, periodMonths) {
  return new Date(startedAt.getTime() + period * periodMonths * PERIOD_DAYS * DAY_MS);
}

function validateSubscriptionInput({ amountPerPeriod, asset, periodMonths, totalPeriods }) {
  const amount = parseFloat(amountPerPeriod);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw httpError('amountPerPeriod must be greater than zero', 400, 'INVALID_SUBSCRIPTION');
  }
  if (!getSupportedAssetCodes().includes(asset)) {
    throw httpError(`Unsupported asset: ${asset}`, 400, 'INVALID_SUBSCRIPTION');
  }
  if (!ALLOWED_PERIOD_MONTHS.includes(Number(periodMonths))) {
    throw httpError(
      `periodMonths must be one of: ${ALLOWED_PERIOD_MONTHS.join(', ')}`,
      400,
      'INVALID_SUBSCRIPTION'
    );
  }
  const periods = Number(totalPeriods);
  if (!Number.isInteger(periods) || periods < MIN_PERIODS || periods > MAX_PERIODS) {
    throw httpError(
      `totalPeriods must be an integer between ${MIN_PERIODS} and ${MAX_PERIODS}`,
      400,
      'INVALID_SUBSCRIPTION'
    );
  }
  return { amount: toAmount(amount), periodMonths: Number(periodMonths), totalPeriods: periods };
}

/**
 * Prepare a subscription for Freighter wallets.
 * Returns unsigned XDR bound to the contributor, campaign, asset, amount, and schedule.
 */
async function prepareSubscription({
  campaignId,
  userId,
  amountPerPeriod,
  asset,
  periodMonths,
  totalPeriods,
}) {
  const input = validateSubscriptionInput({ amountPerPeriod, asset, periodMonths, totalPeriods });

  const { rows: campaignRows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, deadline FROM campaigns
     WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw httpError('Campaign not found', 404);

  if (asset !== campaign.asset_type) {
    throw httpError(
      `This campaign only accepts ${campaign.asset_type} pledges`,
      400,
      'INVALID_SUBSCRIPTION'
    );
  }

  const { rows: userRows } = await db.query(
    'SELECT id, wallet_public_key, wallet_type FROM users WHERE id = $1',
    [userId]
  );
  const contributor = userRows[0];
  if (!contributor) throw httpError('User not found', 404);
  if (contributor.wallet_type !== 'freighter') {
    throw httpError(
      'Prepare endpoint is only available for Freighter wallets',
      400,
      'UNSUPPORTED_WALLET_TYPE'
    );
  }

  const startedAt = new Date();
  const schedule = [];
  for (let period = 1; period <= input.totalPeriods; period += 1) {
    const scheduledDate = scheduleDateForPeriod(startedAt, period, input.periodMonths);
    schedule.push({
      scheduledDate,
      amount: input.amount,
      reclaimAfterUnix: Math.floor(
        (scheduledDate.getTime() + CONTRIBUTOR_RECLAIM_AFTER_DAYS * DAY_MS) / 1000
      ),
    });
  }

  const { unsignedXdr, balanceEntries } = await buildUnsignedSubscriptionTransaction({
    sourcePublicKey: contributor.wallet_public_key,
    asset,
    entries: schedule.map(entry => ({
      amount: entry.amount,
      reclaimAfterUnix: entry.reclaimAfterUnix,
    })),
  });

  return {
    unsignedXdr,
    campaignId,
    userId,
    walletPublicKey: contributor.wallet_public_key,
    asset,
    amountPerPeriod: input.amount,
    periodMonths,
    totalPeriods: input.totalPeriods,
    schedule: schedule.map(s => ({
      scheduledDate: s.scheduledDate.toISOString(),
      amount: s.amount,
    })),
    totalCommitment: toAmount(input.amount * input.totalPeriods),
  };
}

/**
 * Submit a signed subscription transaction from a Freighter wallet.
 * Persists balance IDs only after the signed transaction is confirmed on Horizon.
 */
async function submitSubscription({
  campaignId,
  userId,
  unsignedXdr,
  signedXdr,
  asset,
  amountPerPeriod,
  periodMonths,
  totalPeriods,
  idempotencyKey = null,
}) {
  const input = validateSubscriptionInput({
    amountPerPeriod: amountPerPeriod,
    asset,
    periodMonths,
    totalPeriods,
  });

  const { rows: campaignRows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, deadline FROM campaigns
     WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw httpError('Campaign not found', 404);

  if (asset !== campaign.asset_type) {
    throw httpError(
      `This campaign only accepts ${campaign.asset_type} pledges`,
      400,
      'INVALID_SUBSCRIPTION'
    );
  }

  const { rows: userRows } = await db.query(
    'SELECT id, wallet_public_key, wallet_type FROM users WHERE id = $1',
    [userId]
  );
  const contributor = userRows[0];
  if (!contributor) throw httpError('User not found', 404);
  if (contributor.wallet_type !== 'freighter') {
    throw httpError(
      'Submit endpoint is only available for Freighter wallets',
      400,
      'UNSUPPORTED_WALLET_TYPE'
    );
  }

  if (idempotencyKey) {
    const { rows: existingRows } = await db.query(
      `SELECT id FROM subscriptions
        WHERE idempotency_actor_id = $1 AND idempotency_key = $2`,
      [userId, idempotencyKey]
    );
    if (existingRows.length) {
      const { rows: balanceRows } = await db.query(
        `SELECT stellar_balance_id FROM subscription_balances
          WHERE subscription_id = $1 ORDER BY scheduled_date ASC`,
        [existingRows[0].id]
      );
      return {
        subscriptionId: existingRows[0].id,
        balanceIds: balanceRows.map(row => row.stellar_balance_id),
        replayed: true,
      };
    }
  }

  const tx = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  if (signedTx.hash().toString('hex') !== tx.hash().toString('hex')) {
    throw httpError(
      'Signed transaction does not match the prepared transaction',
      400,
      'XDR_MISMATCH'
    );
  }

  const startedAt = new Date();
  const schedule = [];
  for (let period = 1; period <= input.totalPeriods; period += 1) {
    const scheduledDate = scheduleDateForPeriod(startedAt, period, input.periodMonths);
    schedule.push({
      scheduledDate,
      amount: input.amount,
      reclaimAfterUnix: Math.floor(
        (scheduledDate.getTime() + CONTRIBUTOR_RECLAIM_AFTER_DAYS * DAY_MS) / 1000
      ),
    });
  }

  const { txHash, balanceIds } = await submitPreparedSubscriptionTransaction({
    signedXdr,
    sourcePublicKey: contributor.wallet_public_key,
    asset,
    entries: schedule.map(entry => ({
      amount: entry.amount,
      reclaimAfterUnix: entry.reclaimAfterUnix,
    })),
  });

  let subscriptionId;
  try {
    subscriptionId = await withTransaction(async client => {
      const { rows: inserted } = await client.query(
        `INSERT INTO subscriptions
        (campaign_id, contributor_user_id, amount_per_period, asset, period_months, total_periods,
         idempotency_actor_id, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id`,
        [
          campaignId,
          userId,
          input.amount,
          asset,
          input.periodMonths,
          input.totalPeriods,
          userId,
          idempotencyKey,
        ]
      );
      const createdSubscriptionId = inserted[0].id;

      for (let i = 0; i < schedule.length; i += 1) {
        await client.query(
          `INSERT INTO subscription_balances
          (subscription_id, stellar_balance_id, scheduled_date, amount)
        VALUES ($1, $2, $3, $4)`,
          [
            createdSubscriptionId,
            balanceIds[i],
            schedule[i].scheduledDate.toISOString(),
            schedule[i].amount,
          ]
        );
      }
      return createdSubscriptionId;
    }, db);
  } catch (err) {
    logger.error('subscriptions: failed to persist Freighter schedule after signing', {
      campaign_id: campaignId,
      user_id: userId,
      balance_ids: balanceIds,
      error: err.message,
    });
    throw err;
  }

  logger.info('subscriptions: created via Freighter', {
    subscription_id: subscriptionId,
    campaign_id: campaignId,
    periods: input.totalPeriods,
  });

  return {
    subscriptionId,
    balanceIds,
    totalCommitment: toAmount(input.amount * input.totalPeriods),
    totalPeriods: input.totalPeriods,
    firstPaymentDate: schedule[0].scheduledDate.toISOString(),
    lastPaymentDate: schedule[schedule.length - 1].scheduledDate.toISOString(),
  };
}

/**
 * Enable a recurring pledge: lock the full commitment into one claimable balance per period.
 */
/** Last instant (exclusive) an installment may be scheduled for: the end of the deadline day. */
function fundingWindowEnd(deadline) {
  if (!deadline) return null;
  const day =
    deadline instanceof Date ? deadline.toISOString().slice(0, 10) : String(deadline).slice(0, 10);
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS);
}

/**
 * Number of periods whose scheduled date falls inside the campaign's funding
 * window (all of them when the campaign has no deadline).
 */
function periodsWithinFundingWindow(startedAt, periodMonths, totalPeriods, deadline) {
  const windowEnd = fundingWindowEnd(deadline);
  if (!windowEnd) return totalPeriods;
  let fits = 0;
  for (let period = 1; period <= totalPeriods; period += 1) {
    if (scheduleDateForPeriod(startedAt, period, periodMonths) < windowEnd) fits = period;
  }
  return fits;
}

async function createSubscription({
  campaignId,
  userId,
  amountPerPeriod,
  asset,
  periodMonths,
  totalPeriods,
  truncateToDeadline = false,
}) {
  const input = validateSubscriptionInput({ amountPerPeriod, asset, periodMonths, totalPeriods });

  const { rows: campaignRows } = await db.query(
    `SELECT id, wallet_public_key, asset_type, deadline FROM campaigns
     WHERE id = $1 AND status = 'active' AND deleted_at IS NULL`,
    [campaignId]
  );
  const campaign = campaignRows[0];
  if (!campaign) throw httpError('Campaign not found', 404);

  // A schedule may not lock funds for installments the campaign can never
  // accept (#837). Past the deadline is rejected unless the caller explicitly
  // asks for the schedule to be truncated to the funding window.
  const startedAt = new Date();
  const requestedPeriods = input.totalPeriods;
  const fittingPeriods = periodsWithinFundingWindow(
    startedAt,
    input.periodMonths,
    requestedPeriods,
    campaign.deadline
  );
  if (fittingPeriods < requestedPeriods) {
    if (!truncateToDeadline) {
      throw httpError(
        `This schedule runs past the campaign deadline; at most ${fittingPeriods} ` +
          `period(s) of ${input.periodMonths} month(s) fit. Reduce totalPeriods or set ` +
          'truncateToDeadline to shorten it.',
        400,
        'SUBSCRIPTION_EXCEEDS_DEADLINE'
      );
    }
    if (fittingPeriods < MIN_PERIODS) {
      throw httpError(
        `Only ${fittingPeriods} period(s) fit before the campaign deadline; a recurring pledge needs at least ${MIN_PERIODS}.`,
        400,
        'SUBSCRIPTION_EXCEEDS_DEADLINE'
      );
    }
    input.totalPeriods = fittingPeriods;
  }

  if (asset !== campaign.asset_type) {
    throw httpError(
      `This campaign only accepts ${campaign.asset_type} pledges`,
      400,
      'INVALID_SUBSCRIPTION'
    );
  }

  const { rows: userRows } = await db.query(
    'SELECT id, wallet_public_key, wallet_secret_encrypted FROM users WHERE id = $1',
    [userId]
  );
  const contributor = userRows[0];
  if (!contributor) throw httpError('User not found', 404);

  const totalCommitment = toAmount(input.amount * input.totalPeriods);
  const balances = await getCampaignBalance(contributor.wallet_public_key);
  const available = parseFloat(balances[asset] || '0');
  if (available < totalCommitment) {
    throw httpError(
      `Your wallet holds ${available} ${asset} but this pledge commits ${totalCommitment} ${asset}`,
      400,
      'INSUFFICIENT_BALANCE_FOR_SUBSCRIPTION'
    );
  }

  const schedule = [];
  for (let period = 1; period <= input.totalPeriods; period += 1) {
    const scheduledDate = scheduleDateForPeriod(startedAt, period, input.periodMonths);
    schedule.push({
      scheduledDate,
      amount: input.amount,
      reclaimAfterUnix: Math.floor(
        (scheduledDate.getTime() + CONTRIBUTOR_RECLAIM_AFTER_DAYS * DAY_MS) / 1000
      ),
    });
  }

  const { balanceIds } = await withDecryptedWalletSecret(
    contributor.wallet_secret_encrypted,
    { userId, walletPublicKey: contributor.wallet_public_key },
    async walletSecret => {
      await ensureCustodialAccountFundedAndTrusted({
        publicKey: contributor.wallet_public_key,
        secret: walletSecret,
      });
      return createSubscriptionClaimableBalances({
        sourceSecret: walletSecret,
        asset,
        entries: schedule.map(entry => ({
          amount: entry.amount,
          reclaimAfterUnix: entry.reclaimAfterUnix,
        })),
      });
    }
  );

  let subscriptionId;
  try {
    subscriptionId = await withTransaction(async client => {
      const { rows: inserted } = await client.query(
        `INSERT INTO subscriptions
         (campaign_id, contributor_user_id, amount_per_period, asset, period_months, total_periods)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
        [campaignId, userId, input.amount, asset, input.periodMonths, input.totalPeriods]
      );
      const createdSubscriptionId = inserted[0].id;

      for (let i = 0; i < schedule.length; i += 1) {
        await client.query(
          `INSERT INTO subscription_balances
           (subscription_id, stellar_balance_id, scheduled_date, amount)
         VALUES ($1, $2, $3, $4)`,
          [
            createdSubscriptionId,
            balanceIds[i],
            schedule[i].scheduledDate.toISOString(),
            schedule[i].amount,
          ]
        );
      }
      return createdSubscriptionId;
    }, db);
  } catch (err) {
    logger.error('subscriptions: failed to persist schedule after locking funds', {
      campaign_id: campaignId,
      user_id: userId,
      balance_ids: balanceIds,
      error: err.message,
    });
    throw err;
  }

  logger.info('subscriptions: created', {
    subscription_id: subscriptionId,
    campaign_id: campaignId,
    periods: input.totalPeriods,
  });

  return {
    subscriptionId,
    balanceIds,
    totalCommitment,
    totalPeriods: input.totalPeriods,
    requestedPeriods,
    truncatedToDeadline: input.totalPeriods < requestedPeriods,
    firstPaymentDate: schedule[0].scheduledDate.toISOString(),
    lastPaymentDate: schedule[schedule.length - 1].scheduledDate.toISOString(),
  };
}

/**
 * Cancel a subscription. Balances more than the notice period away stop being claimed and
 * become the contributor's to reclaim; anything closer (or already claimed) is returned as
 * non-cancellable.
 */
async function cancelSubscription({ campaignId, subscriptionId, userId }) {
  const { rows: subscriptionRows } = await db.query(
    `SELECT id, status FROM subscriptions
     WHERE id = $1 AND campaign_id = $2 AND contributor_user_id = $3`,
    [subscriptionId, campaignId, userId]
  );
  const subscription = subscriptionRows[0];
  if (!subscription) throw httpError('Subscription not found', 404);
  if (subscription.status === 'completed') {
    throw httpError('This subscription has already completed', 409, 'SUBSCRIPTION_COMPLETED');
  }

  const noticeCutoff = new Date(Date.now() + CANCELLATION_NOTICE_DAYS * DAY_MS);

  const { cancelled, nonCancellable } = await withTransaction(async client => {
    const { rows: cancelled } = await client.query(
      `UPDATE subscription_balances
       SET status = 'cancellation_requested'
       WHERE subscription_id = $1
         AND status = 'pending'
         AND scheduled_date > $2
       RETURNING id, stellar_balance_id, scheduled_date, amount`,
      [subscriptionId, noticeCutoff.toISOString()]
    );

    const { rows: nonCancellable } = await client.query(
      `SELECT id, stellar_balance_id, scheduled_date, amount, status
       FROM subscription_balances
       WHERE subscription_id = $1
         AND status IN ('pending', 'claimed')
       ORDER BY scheduled_date`,
      [subscriptionId]
    );

    await client.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [
      subscriptionId,
    ]);
    return { cancelled, nonCancellable };
  }, db);

  // The earliest date the contributor's reclaim predicate opens on a cancelled balance.
  const earliestCancelled = cancelled
    .map(row => new Date(row.scheduled_date).getTime())
    .sort((a, b) => a - b)[0];
  const estimatedRefundDate = earliestCancelled
    ? new Date(earliestCancelled + CONTRIBUTOR_RECLAIM_AFTER_DAYS * DAY_MS).toISOString()
    : null;

  logger.info('subscriptions: cancelled', {
    subscription_id: subscriptionId,
    cancelled: cancelled.length,
    non_cancellable: nonCancellable.length,
  });

  return {
    cancelled: cancelled.length,
    nonCancellable: nonCancellable.length,
    non_cancellable_balances: nonCancellable.map(row => ({
      id: row.id,
      stellar_balance_id: row.stellar_balance_id,
      scheduled_date: row.scheduled_date,
      amount: row.amount,
      status: row.status,
      reason: row.status === 'claimed' ? 'already_claimed' : 'within_notice_period',
    })),
    estimatedRefundDate,
  };
}

/** Active and past subscriptions for the contributor dashboard. */
async function listSubscriptionsForUser(userId) {
  const { rows } = await db.query(
    `SELECT s.id, s.campaign_id, c.title AS campaign_title, s.amount_per_period, s.asset,
            s.period_months, s.total_periods, s.status, s.created_at,
            s.closure_reason, s.closed_at,
            COUNT(sb.id) FILTER (WHERE sb.status = 'claimed')::int AS periods_claimed,
            COUNT(sb.id) FILTER (WHERE sb.status = 'closed')::int AS periods_closed,
            COALESCE(SUM(sb.amount) FILTER (WHERE sb.status = 'closed'), 0)::text AS closed_amount,
            MIN(sb.reclaimable_at) FILTER (WHERE sb.status = 'closed') AS reclaimable_from,
            MAX(sb.reclaimable_at) FILTER (WHERE sb.status = 'closed') AS reclaimable_until_all,
            MIN(sb.scheduled_date) FILTER (WHERE sb.status = 'pending') AS next_payment_date
     FROM subscriptions s
     JOIN campaigns c ON c.id = s.campaign_id
     LEFT JOIN subscription_balances sb ON sb.subscription_id = s.id
     WHERE s.contributor_user_id = $1
     GROUP BY s.id, c.title
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Close out a subscription whose balances are all resolved: completed when every period was
 * claimed, cancelled when the contributor took any of them back.
 */
async function settleSubscriptionStatus(client, subscriptionId) {
  const { rows } = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'contributor_reclaimed')::int AS reclaimed,
       COUNT(*) FILTER (WHERE status = 'closed')::int AS closed,
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed
     FROM subscription_balances
     WHERE subscription_id = $1`,
    [subscriptionId]
  );
  const counts = rows[0];
  if (counts.pending > 0) return null;

  // Closed by the campaign (#837) takes precedence over a plain cancellation
  // only when the contributor did not cancel themselves.
  let status = 'cancelled';
  if (counts.claimed === counts.total) status = 'completed';
  else if (counts.closed > 0 && counts.claimed + counts.closed === counts.total) status = 'closed';
  await client.query(`UPDATE subscriptions SET status = $2 WHERE id = $1 AND status <> $2`, [
    subscriptionId,
    status,
  ]);
  return status;
}

async function markBalanceReclaimed(subscriptionId, balanceRowId) {
  await withTransaction(async client => {
    await client.query(
      `UPDATE subscription_balances SET status = 'contributor_reclaimed' WHERE id = $1`,
      [balanceRowId]
    );
    await client.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [
      subscriptionId,
    ]);
  }, db);
}

async function recordClaimedBalance({ balance, txHash }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: updated } = await client.query(
      `UPDATE subscription_balances
       SET status = 'claimed', claimed_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id`,
      [balance.id]
    );
    if (!updated.length) {
      await client.query('ROLLBACK');
      return null;
    }

    // The ledger monitor also sees the claim's payment leg, so whichever writer gets there
    // first records the contribution and moves raised_amount — never both.
    const { rows: contributionRows } = await client.query(
      `INSERT INTO contributions
         (campaign_id, sender_public_key, amount, asset, payment_type, tx_hash)
       VALUES ($1, $2, $3, $4, 'subscription_claim', $5)
       ON CONFLICT (tx_hash) DO NOTHING
       RETURNING id`,
      [balance.campaign_id, balance.contributor_public_key, balance.amount, balance.asset, txHash]
    );

    if (contributionRows.length) {
      await client.query(
        // Only an active campaign may transition to funded; a claim must never
        // move a failed/suspended/closed campaign back to funded (#837).
        `UPDATE campaigns
         SET raised_amount = raised_amount + $1,
             status = CASE
               WHEN status = 'active' AND raised_amount + $1 >= target_amount THEN 'funded'
               ELSE status
             END
         WHERE id = $2`,
        [balance.amount, balance.campaign_id]
      );
    }

    const subscriptionStatus = await settleSubscriptionStatus(client, balance.subscription_id);
    await client.query('COMMIT');
    return { subscriptionStatus };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function notifySubscriptionClosures(closedRows) {
  const bySubscription = new Map();
  for (const row of closedRows) {
    const group = bySubscription.get(row.subscription_id) || [];
    group.push(row);
    bySubscription.set(row.subscription_id, group);
  }

  for (const rows of bySubscription.values()) {
    const first = rows[0];
    const reclaimDates = rows.map(r => new Date(r.reclaimable_at).getTime()).sort((a, b) => a - b);
    const from = new Date(reclaimDates[0]).toISOString().slice(0, 10);
    const until = new Date(reclaimDates[reclaimDates.length - 1]).toISOString().slice(0, 10);
    const total = rows.reduce((sum, r) => sum + Number(r.amount), 0);
    const reason = CLOSURE_REASON_TEXT[first.closure_reason] || CLOSURE_REASON_TEXT.campaign_closed;
    const window = from === until ? `on ${from}` : `between ${from} and ${until}`;
    try {
      await createNotification(first.contributor_user_id, {
        type: 'subscription_closed',
        title: 'Recurring pledge closed',
        body:
          `${rows.length} remaining installment(s) of your recurring pledge to "${first.campaign_title}" ` +
          `(${Number(total.toFixed(7))} ${first.asset}) will not be collected because ${reason}. ` +
          `The funds stay in their claimable balances and become reclaimable to your wallet ${window}.`,
        link: `/campaigns/${first.campaign_id}`,
      });
    } catch (err) {
      logger.error('subscription-claim-worker: closure notification failed', {
        subscription_id: first.subscription_id,
        error: err.message,
      });
    }
  }
}

/**
 * Move every unclaimed installment its campaign no longer accepts into the
 * explicit 'closed' state (#837). The ledger balance ID is kept so the
 * contributor's on-ledger reclaim path stays traceable. Returns the closed rows.
 * Optionally scoped to one balance (used right before a claim).
 */
async function closeIneligibleInstallments({ balanceId = null } = {}) {
  const { rows } = await db.query(
    `WITH closable AS (
       SELECT sb.id, ${CLOSURE_REASON_SQL} AS reason
       FROM subscription_balances sb
       JOIN subscriptions s ON s.id = sb.subscription_id
       JOIN campaigns c ON c.id = s.campaign_id
       WHERE sb.status = 'pending'
         AND NOT ${CAMPAIGN_ACCEPTS_INSTALLMENT_SQL}
         AND ($1::uuid IS NULL OR sb.id = $1::uuid)
       FOR UPDATE OF sb
     )
     UPDATE subscription_balances sb
     SET status = 'closed', closed_at = NOW(), closure_reason = closable.reason,
         reclaimable_at = sb.scheduled_date + ($2::int * INTERVAL '1 day')
     FROM closable, subscriptions s, campaigns c
     WHERE sb.id = closable.id AND s.id = sb.subscription_id AND c.id = s.campaign_id
       AND sb.status = 'pending'
     RETURNING sb.id, sb.subscription_id, sb.stellar_balance_id, sb.amount, sb.reclaimable_at,
               sb.closure_reason, s.contributor_user_id, s.campaign_id, s.asset,
               c.title AS campaign_title`,
    [balanceId, CONTRIBUTOR_RECLAIM_AFTER_DAYS]
  );
  if (!rows.length) return [];

  const subscriptionIds = [...new Set(rows.map(r => r.subscription_id))];
  for (const subscriptionId of subscriptionIds) {
    const reason = rows.find(r => r.subscription_id === subscriptionId).closure_reason;
    await withTransaction(async client => {
      const status = await settleSubscriptionStatus(client, subscriptionId);
      if (status === 'closed') {
        await client.query(
          `UPDATE subscriptions SET closure_reason = $2, closed_at = COALESCE(closed_at, NOW())
           WHERE id = $1`,
          [subscriptionId, reason]
        );
      }
    }, db);
  }

  logger.info('subscription-claim-worker: closed installments', {
    installments: rows.length,
    subscriptions: subscriptionIds.length,
  });
  await notifySubscriptionClosures(rows);
  return rows;
}

/**
 * SubscriptionClaimWorker — claims every subscription balance whose scheduled date has passed
 * and whose campaign still accepts it. Installments of campaigns that are funded, failed,
 * suspended, deleted or past their deadline are closed instead of claimed. Balances the
 * contributor already reclaimed are recorded as such and end the subscription.
 */
async function processDueSubscriptionBalances() {
  const closedRows = await closeIneligibleInstallments();

  let due = [];
  await withTransaction(async client => {
    const res = await client.query(
      `SELECT sb.id, sb.subscription_id, sb.stellar_balance_id, sb.amount, sb.scheduled_date,
            s.asset, s.campaign_id, c.wallet_public_key AS campaign_public_key,
            u.wallet_public_key AS contributor_public_key
     FROM subscription_balances sb
     JOIN subscriptions s ON s.id = sb.subscription_id
     JOIN campaigns c ON c.id = s.campaign_id
     JOIN users u ON u.id = s.contributor_user_id
     WHERE sb.status = 'pending'
       AND sb.scheduled_date <= NOW()
       AND ${CAMPAIGN_ACCEPTS_INSTALLMENT_SQL}
     ORDER BY sb.scheduled_date
       LIMIT 200
       FOR UPDATE OF sb SKIP LOCKED`
    );
    due = res.rows;
    if (due.length > 0) {
      const dueIds = due.map(r => r.id);
      await client.query(
        `UPDATE subscription_balances SET status = 'processing' WHERE id = ANY($1::uuid[])`,
        [dueIds]
      );
    }
  }, db);

  let claimed = 0;
  let reclaimed = 0;
  let failed = 0;
  let closed = closedRows.length;

  if (!due.length) {
    logger.debug('subscription-claim-worker: nothing due');
    return { claimed, reclaimed, failed, closed };
  }

  for (const balance of due) {
    try {
      // Re-check right before submitting: an earlier claim in this batch (or
      // any other writer) may have funded or closed the campaign since the
      // batch was selected. No claim is submitted once it stops accepting.
      const closedNow = await closeIneligibleInstallments({ balanceId: balance.id });
      if (closedNow.length) {
        closed += closedNow.length;
        continue;
      }
      if (!(await installmentStillClaimable(balance.id))) continue;

      const onLedger = await getClaimableBalance(balance.stellar_balance_id);
      if (!onLedger) {
        await markBalanceReclaimed(balance.subscription_id, balance.id);
        reclaimed += 1;
        continue;
      }

      const txHash = await claimSubscriptionBalanceToCampaign({
        balanceId: balance.stellar_balance_id,
        asset: balance.asset,
        amount: balance.amount,
        destinationPublicKey: balance.campaign_public_key,
        memo: buildContributionMemo(balance.campaign_id),
      });

      await recordClaimedBalance({ balance, txHash });
      claimed += 1;
    } catch (err) {
      if (isClaimableBalanceGoneError(err)) {
        await markBalanceReclaimed(balance.subscription_id, balance.id);
        reclaimed += 1;
        continue;
      }
      failed += 1;
      logger.error('subscription-claim-worker: claim failed', {
        subscription_balance_id: balance.id,
        error: err.message,
      });
    }
  }

  logger.info('subscription-claim-worker: done', { claimed, reclaimed, failed, closed });
  return { claimed, reclaimed, failed, closed };
}

async function installmentStillClaimable(balanceId) {
  const { rows } = await db.query(
    `SELECT 1
     FROM subscription_balances sb
     JOIN subscriptions s ON s.id = sb.subscription_id
     JOIN campaigns c ON c.id = s.campaign_id
     WHERE sb.id = $1 AND sb.status IN ('pending', 'processing') AND ${CAMPAIGN_ACCEPTS_INSTALLMENT_SQL}`,
    [balanceId]
  );
  return rows.length > 0;
}

function startSubscriptionClaimWorker() {
  processDueSubscriptionBalances().catch(err =>
    logger.error('subscription-claim-worker: initial run failed', { error: err.message })
  );
  _workerTimer = setInterval(() => {
    processDueSubscriptionBalances().catch(err =>
      logger.error('subscription-claim-worker: run failed', { error: err.message })
    );
  }, WORKER_INTERVAL_MS);
  logger.info('subscription-claim-worker: started', { interval_ms: WORKER_INTERVAL_MS });
}

function stopSubscriptionClaimWorker() {
  if (_workerTimer) {
    clearInterval(_workerTimer);
    _workerTimer = null;
  }
}

module.exports = {
  createSubscription,
  cancelSubscription,
  listSubscriptionsForUser,
  closeIneligibleInstallments,
  processDueSubscriptionBalances,
  periodsWithinFundingWindow,
  startSubscriptionClaimWorker,
  stopSubscriptionClaimWorker,
  prepareSubscription,
  submitSubscription,
  ALLOWED_PERIOD_MONTHS,
  MIN_PERIODS,
  MAX_PERIODS,
  CANCELLATION_NOTICE_DAYS,
  CONTRIBUTOR_RECLAIM_AFTER_DAYS,
};
