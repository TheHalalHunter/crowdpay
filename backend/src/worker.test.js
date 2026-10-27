const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function noop() {}
async function asyncNoop() {}

function buildWorker({ featureEnabled = () => true } = {}) {
  return proxyquire('./worker', {
    './config/logger': { info: noop, error: noop, warn: noop, debug: noop },
    './config/database': { query: async () => ({ rows: [] }) },
    './services/featureFlags': { isEnabled: featureEnabled },
    './services/ledgerMonitor': { startLedgerMonitor: asyncNoop },
    './services/webhookDispatcher': { startWebhookRetryPoller: noop },
    './services/recurringContributionsService': {
      startRecurringContributionsCron: noop,
      stopRecurringContributionsCron: noop,
    },
    './services/recurring': {
      startSubscriptionClaimWorker: noop,
      stopSubscriptionClaimWorker: noop,
    },
    './services/ops/healthCollector': {
      startHealthCollector: noop,
      stopHealthCollector: noop,
    },
    './services/campaignStatusService': { refreshActiveCampaignStatuses: asyncNoop },
    './services/reconciliation': { reconcileCampaignBalances: asyncNoop },
    './services/campaignPublishing': { publishDraftCampaign: asyncNoop },
    './services/contractDeploymentRetryService': { retryFailedContractDeployments: asyncNoop },
    './services/weeklyDigestService': { sendWeeklyContributorDigests: asyncNoop },
    './services/deadlineReminderService': { sendDeadlineReminders: asyncNoop },
    './services/campaignUpdatesPublishing': { publishDueCampaignUpdates: asyncNoop },
    './services/payoutScheduleService': { processDuePayoutSchedules: asyncNoop },
    './services/milestoneAutoRelease': { processAutoReleases: asyncNoop },
    './services/retentionPurge': { runAllPurges: asyncNoop },
    './services/restoreVerification': { runRestoreVerification: asyncNoop },
  });
}

test('Background Worker Bootstrap', async t => {
  let originalEnv;

  t.beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  t.afterEach(() => {
    process.env = originalEnv;
  });

  await t.test('does not start in test environment', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.NODE_ENV = 'test';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('does not start when WORKER_ENABLED is false', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.WORKER_ENABLED = 'false';
    process.env.NODE_ENV = 'development';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('fails startup when every processor is disabled', async () => {
    const { startBackgroundWorkers } = buildWorker({ featureEnabled: () => false });
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    for (const name of [
      'ENABLE_LEDGER_MONITOR',
      'ENABLE_WEBHOOK_POLLER',
      'ENABLE_RECURRING_CONTRIBUTIONS_WORKER',
      'ENABLE_SUBSCRIPTION_CLAIM_WORKER',
      'ENABLE_HEALTH_COLLECTOR',
    ]) {
      process.env[name] = 'false';
    }

    await assert.rejects(startBackgroundWorkers(), /All background processors are disabled/);
  });

  await t.test('starts when at least one direct processor remains enabled', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker({
      featureEnabled: () => false,
    });
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_LEDGER_MONITOR = 'false';
    process.env.ENABLE_WEBHOOK_POLLER = 'false';
    process.env.ENABLE_RECURRING_CONTRIBUTIONS_WORKER = 'false';
    process.env.ENABLE_SUBSCRIPTION_CLAIM_WORKER = 'false';
    process.env.ENABLE_HEALTH_COLLECTOR = 'false';

    await assert.rejects(startBackgroundWorkers(), /All background processors are disabled/);
    process.env.ENABLE_WEBHOOK_POLLER = 'true';
    await startBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
    await stopBackgroundWorkers();
  });

  await t.test('starts workers when enabled', async () => {
    const { startBackgroundWorkers, stopBackgroundWorkers, isWorkerRunning } = buildWorker();
    process.env.WORKER_ENABLED = 'true';
    process.env.NODE_ENV = 'production';

    await startBackgroundWorkers();

    assert.equal(isWorkerRunning(), true);

    await stopBackgroundWorkers();
    assert.equal(isWorkerRunning(), false);
  });
});
