const logger = require('./config/logger');
const db = require('./config/database');
const featureFlags = require('./services/featureFlags');

// Imported workers that have their own start/stop functions
const { startLedgerMonitor } = require('./services/ledgerMonitor');
const { startWebhookRetryPoller } = require('./services/webhookDispatcher');
const {
  startRecurringContributionsCron,
  stopRecurringContributionsCron,
} = require('./services/recurringContributionsService');
const {
  startSubscriptionClaimWorker,
  stopSubscriptionClaimWorker,
} = require('./services/recurring');
const { startHealthCollector, stopHealthCollector } = require('./services/ops/healthCollector');

// Imported services that need scheduled wrappers
const { refreshActiveCampaignStatuses } = require('./services/campaignStatusService');
const { reconcileCampaignBalances } = require('./services/reconciliation');
const { publishDraftCampaign } = require('./services/campaignPublishing');
const { retryFailedContractDeployments } = require('./services/contractDeploymentRetryService');
const { sendWeeklyContributorDigests } = require('./services/weeklyDigestService');
const { sendDeadlineReminders } = require('./services/deadlineReminderService');
const { publishDueCampaignUpdates } = require('./services/campaignUpdatesPublishing');
const { processDuePayoutSchedules } = require('./services/payoutScheduleService');
const { processAutoReleases } = require('./services/milestoneAutoRelease');
const { runAllPurges } = require('./services/retentionPurge');
const { runRestoreVerification } = require('./services/restoreVerification');

let intervals = [];
let isShuttingDown = false;

const SCHEDULED_PROCESSOR_FLAGS = [
  'campaign-status-cron',
  'reconciliation-cron',
  'scheduled-publish-cron',
  'contract-deployment-retry-cron',
  'weekly-digest-cron',
  'deadline-reminder-cron',
  'scheduled-campaign-updates-cron',
  'recurring-payout-schedules-cron',
  'milestone-auto-release-cron',
  'retention-purge-cron',
  'restore-verification-cron',
];

function hasEnabledProcessor() {
  const directProcessors = [
    'ENABLE_LEDGER_MONITOR',
    'ENABLE_WEBHOOK_POLLER',
    'ENABLE_RECURRING_CONTRIBUTIONS_WORKER',
    'ENABLE_SUBSCRIPTION_CLAIM_WORKER',
    'ENABLE_HEALTH_COLLECTOR',
  ];
  return (
    directProcessors.some(name => process.env[name] !== 'false') ||
    SCHEDULED_PROCESSOR_FLAGS.some(flag => featureFlags.isEnabled(flag))
  );
}

async function runScheduledPublishing() {
  if (isShuttingDown) return;
  try {
    const { rows } = await db.query(
      `SELECT id FROM campaigns WHERE status = 'draft' AND scheduled_publish_at <= NOW()`
    );
    for (const { id } of rows) {
      if (isShuttingDown) break;
      try {
        await publishDraftCampaign(id);
      } catch (err) {
        logger.error('worker: Scheduled publish failed', { campaignId: id, error: err.message });
      }
    }
  } catch (err) {
    logger.error('worker: Scheduled publish query failed', { error: err.message });
  }
}

function startInterval(name, fn, intervalMs, featureFlagKey = null) {
  if (featureFlagKey && !featureFlags.isEnabled(featureFlagKey)) {
    logger.info(`worker: skipped ${name} (feature flag ${featureFlagKey} disabled)`);
    return;
  }

  logger.info(`worker: starting ${name} (interval ${intervalMs}ms)`);

  // Run immediately then schedule
  Promise.resolve(fn()).catch(err => {
    logger.error(`worker: ${name} failed on initial run`, { error: err.message });
  });

  const timer = setInterval(async () => {
    if (isShuttingDown) return;
    try {
      await fn();
    } catch (err) {
      logger.error(`worker: ${name} failed`, { error: err.message });
    }
  }, intervalMs);

  intervals.push(timer);
}

async function startBackgroundWorkers() {
  if (process.env.WORKER_ENABLED === 'false' || process.env.NODE_ENV === 'test') {
    logger.info('worker: disabled via configuration or test environment');
    return;
  }

  if (!hasEnabledProcessor()) {
    throw new Error('All background processors are disabled');
  }

  isShuttingDown = false;
  logger.info('worker: bootstrapping background lifecycle');

  // Ledger monitoring (has own start/stop logic and intervals, usually doesn't need feature flag check here as it checks it internally if needed, but we start it anyway)
  if (process.env.ENABLE_LEDGER_MONITOR !== 'false') {
    try {
      await startLedgerMonitor();
    } catch (err) {
      logger.error('worker: ledger monitor failed to start', { error: err.message });
    }
  }

  // Webhooks
  if (process.env.ENABLE_WEBHOOK_POLLER !== 'false') {
    startWebhookRetryPoller();
  }

  // Recurring Contributions & Subscriptions
  if (process.env.ENABLE_RECURRING_CONTRIBUTIONS_WORKER !== 'false') {
    startRecurringContributionsCron();
  }
  if (process.env.ENABLE_SUBSCRIPTION_CLAIM_WORKER !== 'false') {
    startSubscriptionClaimWorker();
  }

  // Health collector
  if (process.env.ENABLE_HEALTH_COLLECTOR !== 'false') {
    startHealthCollector();
  }

  // Wrapped workers (checking specific feature flags)
  // Campaign status: Hourly
  startInterval(
    'campaign-status-cron',
    refreshActiveCampaignStatuses,
    60 * 60 * 1000,
    'campaign-status-cron'
  );

  // Reconciliation: 15 minutes
  startInterval(
    'reconciliation-cron',
    reconcileCampaignBalances,
    15 * 60 * 1000,
    'reconciliation-cron'
  );

  // Scheduled publishing: 5 minutes
  startInterval(
    'scheduled-publish-cron',
    runScheduledPublishing,
    5 * 60 * 1000,
    'scheduled-publish-cron'
  );

  // Contract deployment retry: 15 minutes
  startInterval(
    'contract-deployment-retry-cron',
    retryFailedContractDeployments,
    15 * 60 * 1000,
    'contract-deployment-retry-cron'
  );

  // Weekly digests: 1 hour (evaluates if digest is needed internally)
  startInterval(
    'weekly-digest-cron',
    sendWeeklyContributorDigests,
    60 * 60 * 1000,
    'weekly-digest-cron'
  );

  // Deadline reminders: 1 hour
  startInterval(
    'deadline-reminder-cron',
    sendDeadlineReminders,
    60 * 60 * 1000,
    'deadline-reminder-cron'
  );

  // Scheduled campaign updates: 1 minute
  startInterval(
    'scheduled-campaign-updates-cron',
    publishDueCampaignUpdates,
    60 * 1000,
    'scheduled-campaign-updates-cron'
  );

  // Recurring payout schedules: 5 minutes
  startInterval(
    'recurring-payout-schedules-cron',
    processDuePayoutSchedules,
    5 * 60 * 1000,
    'recurring-payout-schedules-cron'
  );

  // Automatic milestone releases: 1 minute. Schedules live in the database and
  // the first run happens at startup, so a restart never misses a window.
  startInterval(
    'milestone-auto-release-cron',
    () => processAutoReleases(),
    60 * 1000,
    'milestone-auto-release-cron'
  );

  // Retention purge: daily at midnight
  startInterval(
    'retention-purge-cron',
    () => runAllPurges(),
    24 * 60 * 60 * 1000,
    'retention-purge-cron'
  );

  // Scheduled restore verification: weekly
  startInterval(
    'restore-verification-cron',
    () => runRestoreVerification(),
    7 * 24 * 60 * 60 * 1000,
    'restore-verification-cron'
  );
}

async function stopBackgroundWorkers() {
  logger.info('worker: stopping background lifecycle');
  isShuttingDown = true;

  // Clear managed intervals
  for (const timer of intervals) {
    clearInterval(timer);
  }
  intervals = [];

  // Call exposed stop functions
  try {
    if (typeof stopRecurringContributionsCron === 'function') stopRecurringContributionsCron();
    if (typeof stopSubscriptionClaimWorker === 'function') stopSubscriptionClaimWorker();
    if (typeof stopHealthCollector === 'function') stopHealthCollector();
    // (Ledger monitor and webhook poller might need stop functions if they exist, but we do best-effort)
  } catch (err) {
    logger.error('worker: error stopping sub-workers', { error: err.message });
  }
}

function isWorkerRunning() {
  return !isShuttingDown && intervals.length > 0;
}

module.exports = {
  startBackgroundWorkers,
  stopBackgroundWorkers,
  isWorkerRunning,
};
