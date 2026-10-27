const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const proxyquire = require('proxyquire').noCallThru();

const originalThreshold = process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD;

let queryLog = [];
let sentryMessages = [];
let connectClient;

function buildReconciliation(overrides = {}) {
  queryLog = [];
  sentryMessages = [];

  connectClient = {
    query: async (text, params) => {
      queryLog.push({ text, params, via: 'client' });
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('UPDATE campaigns SET raised_amount')) {
        return { rows: [{ id: params[1] }] };
      }
      if (text.includes('INSERT INTO contributions')) {
        return { rows: [{ id: 'contribution-adj-1' }] };
      }
      if (text.includes('INSERT INTO stellar_transactions')) {
        return { rows: [{ id: 'stellar-tx-1' }] };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const campaignRow = {
    id: 'camp-1',
    wallet_public_key: 'GWALLET',
    asset_type: 'USDC',
    raised_amount: '100',
    target_amount: '1000',
    status: 'active',
    escrow_contract_id: null,
    ...(overrides.campaign || {}),
  };

  const mockDb = {
    query: async (text, params) => {
      queryLog.push({ text, params, via: 'pool' });
      if (text.includes('FROM withdrawal_requests') && text.includes('pending')) {
        return { rows: overrides.pendingWithdrawal ? [{ id: 'w-1' }] : [] };
      }
      if (text.includes('FROM quarantined_payments')) {
        return {
          rows: [
            {
              total:
                overrides.quarantinedAmount !== undefined
                  ? String(overrides.quarantinedAmount)
                  : '0',
            },
          ],
        };
      }
      if (text.includes('FROM campaigns WHERE id = $1')) {
        return { rows: [campaignRow] };
      }
      if (text.includes('FROM campaigns') && text.includes("status IN ('active', 'funded')")) {
        return { rows: overrides.noCampaigns ? [] : [campaignRow] };
      }
      return { rows: [] };
    },
    connect: async () => connectClient,
  };

  const mockSentry = {
    withScope: fn => {
      const scope = {
        setLevel: () => {},
        setTag: () => {},
        setContext: () => {},
      };
      fn(scope);
    },
    captureMessage: message => {
      sentryMessages.push(message);
    },
  };

  return proxyquire('./reconciliation', {
    '../config/database': mockDb,
    '../config/logger': {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    '../utils/cache': {
      invalidate: () => {},
      invalidatePrefix: () => {},
    },
    './stellarService': {
      getCampaignBalance:
        overrides.getCampaignBalanceImpl ||
        (async () => overrides.onChainBalance || { USDC: '150' }),
    },
    './sorobanService': {
      getEscrowTotalRaised:
        overrides.getEscrowTotalRaised ||
        (async () =>
          overrides.onChainContractStroops === undefined ? 0n : overrides.onChainContractStroops),
    },
    './stellarTransactionService': {
      insertContributionAdjustment: async (client, row) => {
        queryLog.push({ text: 'insertContributionAdjustment', row, via: 'service' });
        const result = await client.query(
          `INSERT INTO contributions (campaign_id, sender_public_key, amount, asset, payment_type, tx_hash, created_at) VALUES ($1, 'system', $2, $3, 'reconciliation_adjustment', NULL, $4)`,
          [row.campaignId, row.amount, row.assetType, row.adjustedAt || new Date()]
        );
        return result.rows[0]?.id || 'contribution-adj-1';
      },
      insertReconciliationAdjustment: async (client, row) => {
        queryLog.push({ text: 'insertReconciliationAdjustment', row, via: 'service' });
        const result = await client.query(
          `INSERT INTO stellar_transactions (kind, status, campaign_id, metadata) VALUES ('contribution', 'indexed', $1, $2)`,
          [row.campaignId, JSON.stringify(row)]
        );
        return result.rows[0]?.id || 'stellar-tx-1';
      },
    },
    '@sentry/node': mockSentry,
    ...overrides.proxyquire,
  });
}

beforeEach(() => {
  process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD = '10';
});

afterEach(() => {
  if (originalThreshold === undefined) {
    delete process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD;
  } else {
    process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD = originalThreshold;
  }
});

test('hasDiscrepancy detects balance drift above epsilon', () => {
  const { hasDiscrepancy, DISCREPANCY_EPSILON } = buildReconciliation();
  assert.strictEqual(hasDiscrepancy(100, 100), false);
  assert.strictEqual(hasDiscrepancy(100, 100 + DISCREPANCY_EPSILON * 2), true);
});

test('reconcileCampaign updates raised_amount and records stellar_transactions on drift', async () => {
  const reconciliation = buildReconciliation();
  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.dbBalance, 100);
  assert.strictEqual(result.liveBalance, 150);
  assert.strictEqual(result.diff, 50);
  assert.strictEqual(result.stellar_transaction_id, 'stellar-tx-1');

  assert.ok(
    queryLog.some(q => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount'))
  );
  assert.ok(
    queryLog.some(
      q =>
        q.text.includes('INSERT INTO stellar_transactions') ||
        q.text === 'insertReconciliationAdjustment'
    )
  );
});

test('reconcileCampaign skips campaigns with pending withdrawals', async () => {
  const reconciliation = buildReconciliation({ pendingWithdrawal: true });
  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'pending_withdrawal');
  assert.ok(
    !queryLog.some(q => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount'))
  );
});

test('reconcileCampaign fires Sentry when diff exceeds threshold', async () => {
  const reconciliation = buildReconciliation({ onChainBalance: { USDC: '200' } });
  await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(sentryMessages.length, 1);
  assert.match(sentryMessages[0], /reconciliation discrepancy/i);
});

test('reconcileCampaign does not fire Sentry when diff is below threshold', async () => {
  process.env.RECONCILIATION_DISCREPANCY_ALERT_THRESHOLD = '100';
  const reconciliation = buildReconciliation({ onChainBalance: { USDC: '150' } });
  await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(sentryMessages.length, 0);
});

test('reconcileCampaignBalances returns batch summary', async () => {
  const reconciliation = buildReconciliation();
  const summary = await reconciliation.reconcileCampaignBalances();

  assert.strictEqual(summary.campaigns_checked, 1);
  assert.strictEqual(summary.updated, 1);
  assert.strictEqual(summary.results[0].diff, 50);
});

test('applyReconciliationCorrection inserts a reconciliation_adjustment contribution row', async () => {
  const reconciliation = buildReconciliation();
  await reconciliation.reconcileSingleCampaign('camp-1');

  const contributionInsert = queryLog.find(q => q.text === 'insertContributionAdjustment');
  assert.ok(contributionInsert, 'insertContributionAdjustment should be called');
  assert.strictEqual(contributionInsert.row.campaignId, 'camp-1');
  assert.strictEqual(contributionInsert.row.amount, 50); // liveBalance - dbBalance = 150 - 100
  assert.strictEqual(contributionInsert.row.assetType, 'USDC');
  assert.ok(contributionInsert.row.adjustedAt instanceof Date, 'adjustedAt should be a Date');
});

test('contribution adjustment INSERT uses reconciliation_adjustment payment_type', async () => {
  const reconciliation = buildReconciliation();
  await reconciliation.reconcileSingleCampaign('camp-1');

  const rawInsert = queryLog.find(
    q => q.via === 'client' && q.text.includes('INSERT INTO contributions')
  );
  assert.ok(rawInsert, 'contributions INSERT should be executed via client');
  assert.ok(
    rawInsert.text.includes("'reconciliation_adjustment'"),
    'payment_type must be reconciliation_adjustment'
  );
  assert.ok(
    rawInsert.text.includes('NULL'),
    'tx_hash must be NULL for system-generated adjustments'
  );
});

test('contribution adjustment and campaign UPDATE run in the same transaction', async () => {
  const reconciliation = buildReconciliation();
  await reconciliation.reconcileSingleCampaign('camp-1');

  const txEvents = queryLog
    .filter(q => q.via === 'client')
    .map(q => {
      if (q.text === 'BEGIN') return 'BEGIN';
      if (q.text === 'COMMIT') return 'COMMIT';
      if (q.text.includes('UPDATE campaigns')) return 'UPDATE_CAMPAIGN';
      if (q.text.includes('INSERT INTO contributions')) return 'INSERT_CONTRIBUTION';
      if (q.text.includes('INSERT INTO stellar_transactions')) return 'INSERT_STELLAR';
      return null;
    })
    .filter(Boolean);

  const beginIdx = txEvents.indexOf('BEGIN');
  const commitIdx = txEvents.indexOf('COMMIT');
  const campaignIdx = txEvents.indexOf('UPDATE_CAMPAIGN');
  const contribIdx = txEvents.indexOf('INSERT_CONTRIBUTION');

  assert.ok(beginIdx < campaignIdx, 'UPDATE_CAMPAIGN must come after BEGIN');
  assert.ok(beginIdx < contribIdx, 'INSERT_CONTRIBUTION must come after BEGIN');
  assert.ok(campaignIdx < commitIdx, 'UPDATE_CAMPAIGN must come before COMMIT');
  assert.ok(contribIdx < commitIdx, 'INSERT_CONTRIBUTION must come before COMMIT');
});

test('negative diff (on-chain < db) is recorded as a negative adjustment amount', async () => {
  // Simulate on-chain balance lower than DB (e.g. a ledger revert)
  const reconciliation = buildReconciliation({ onChainBalance: { USDC: '80' } });
  await reconciliation.reconcileSingleCampaign('camp-1');

  const contributionInsert = queryLog.find(q => q.text === 'insertContributionAdjustment');
  assert.ok(contributionInsert, 'insertContributionAdjustment should be called');
  // diff = 80 - 100 = -20
  assert.strictEqual(contributionInsert.row.amount, -20);
});

test('no contribution adjustment is inserted when there is no discrepancy', async () => {
  // on-chain balance matches the DB exactly
  const reconciliation = buildReconciliation({ onChainBalance: { USDC: '100' } });
  await reconciliation.reconcileSingleCampaign('camp-1');

  const contributionInsert = queryLog.find(q => q.text === 'insertContributionAdjustment');
  assert.strictEqual(
    contributionInsert,
    undefined,
    'no adjustment should be inserted when balances match'
  );
});

test('no contribution adjustment is inserted when campaign has a pending withdrawal', async () => {
  const reconciliation = buildReconciliation({ pendingWithdrawal: true });
  await reconciliation.reconcileSingleCampaign('camp-1');

  const contributionInsert = queryLog.find(q => q.text === 'insertContributionAdjustment');
  assert.strictEqual(
    contributionInsert,
    undefined,
    'no adjustment should be inserted for skipped campaigns'
  );
});

// ── #901: contract-mode campaigns and rotated wallets ────────────────────────

const CONTRACT_ID = `C${'A'.repeat(55)}`;

test('contract-mode campaigns are reconciled from escrow get_total_raised, not the empty account', async () => {
  let queriedContractId = null;
  const reconciliation = buildReconciliation({
    // The classic multisig account is empty for contract-mode campaigns.
    onChainBalance: { USDC: '0' },
    campaign: { escrow_contract_id: CONTRACT_ID },
    getEscrowTotalRaised: async contractId => {
      queriedContractId = contractId;
      return 1500000000n; // 150.0000000 in stroops
    },
  });

  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(queriedContractId, CONTRACT_ID, 'the escrow contract must be queried');
  assert.strictEqual(result.liveBalance, 150, 'the contract total is authoritative');
  assert.strictEqual(result.dbBalance, 100);
  assert.strictEqual(result.diff, 50);
});

test('contract-mode campaigns are never zeroed from the classic account balance', async () => {
  const reconciliation = buildReconciliation({
    onChainBalance: { USDC: '0' },
    campaign: { escrow_contract_id: CONTRACT_ID },
    getEscrowTotalRaised: async () => 1000000000n, // exactly matches raised_amount
  });

  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.liveBalance, 100);
  assert.ok(
    !queryLog.some(q => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount')),
    'a contract campaign must not be rewritten from the empty classic account'
  );
});

test('the batch scan only covers live classic-wallet campaigns', async () => {
  const reconciliation = buildReconciliation();
  await reconciliation.reconcileCampaignBalances();

  const scan = queryLog.find(
    q => q.via === 'pool' && q.text.includes("status IN ('active', 'funded')")
  );
  assert.ok(scan, 'the reconciliation scan should have been issued');
  assert.match(scan.text, /deleted_at IS NULL/);
  assert.match(scan.text, /escrow_contract_id IS NULL/);
  assert.match(scan.text, /escrow_contract_id/);
});

test('an unreachable wallet is skipped as wallet_unavailable instead of erroring', async () => {
  const reconciliation = buildReconciliation({
    getCampaignBalanceImpl: async () => {
      throw new Error('account not found');
    },
  });

  const result = await reconciliation.reconcileSingleCampaign('camp-1');

  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'wallet_unavailable');
  assert.ok(
    !queryLog.some(q => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount')),
    'an unreachable wallet must not rewrite raised_amount'
  );
});

test('the batch summary counts an unreachable wallet as skipped, not an error', async () => {
  const reconciliation = buildReconciliation({
    getCampaignBalanceImpl: async () => {
      throw new Error('account not found');
    },
  });

  const summary = await reconciliation.reconcileCampaignBalances();

  assert.strictEqual(summary.errors, 0);
  assert.strictEqual(summary.skipped, 1);
  assert.strictEqual(summary.updated, 0);
  assert.strictEqual(summary.results[0].reason, 'wallet_unavailable');
});

test('reconciliation deducts quarantined payments from live on-chain balance to prevent crediting them', async () => {
  // DB raised_amount = 100
  // On-chain wallet balance = 150 (includes 50 from a quarantined invalid payment)
  // Quarantined payments total = 50
  // Expected effective live balance = 150 - 50 = 100. Diff = 0. No update!
  const reconciliation = buildReconciliation({
    campaign: { raised_amount: '100' },
    onChainBalance: { USDC: '150' },
    quarantinedAmount: 50,
  });

  const result = await reconciliation.reconcileSingleCampaign('camp-1');
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.dbBalance, 100);
  assert.strictEqual(result.liveBalance, 100);
  assert.strictEqual(result.diff, 0);

  // Must not apply any correction or insert reconciliation adjustment
  assert.ok(
    !queryLog.some(q => q.text.includes('UPDATE campaigns SET raised_amount')),
    'reconciliation must not credit quarantined payments into raised_amount'
  );
  assert.ok(
    !queryLog.some(q => q.text === 'insertReconciliationAdjustment'),
    'reconciliation must not book an adjustment for quarantined payments'
  );
});

test('reconciliation updates raised_amount based on legitimate on-chain balance after deducting quarantined amount', async () => {
  // DB raised_amount = 100
  // On-chain wallet balance = 200 (includes 30 quarantined, so legitimate balance is 170)
  // Quarantined payments total = 30
  // Effective live balance = 170. Diff = +70. Update applies for 170!
  const reconciliation = buildReconciliation({
    campaign: { raised_amount: '100' },
    onChainBalance: { USDC: '200' },
    quarantinedAmount: 30,
  });

  const result = await reconciliation.reconcileSingleCampaign('camp-1');
  assert.strictEqual(result.updated, true);
  assert.strictEqual(result.dbBalance, 100);
  assert.strictEqual(result.liveBalance, 170);
  assert.strictEqual(result.diff, 70);

  const update = queryLog.find(
    q => q.text.includes('UPDATE campaigns') && q.text.includes('raised_amount')
  );
  assert.ok(update, 'must apply update for legitimate balance');
  assert.deepEqual(update.params, [170, 'camp-1']);
});

test('reconciliation clamps live balance to 0 if quarantined payments exceed on-chain balance', async () => {
  const reconciliation = buildReconciliation({
    campaign: { raised_amount: '0' },
    onChainBalance: { USDC: '10' },
    quarantinedAmount: 20,
  });

  const result = await reconciliation.reconcileSingleCampaign('camp-1');
  assert.strictEqual(result.updated, false);
  assert.strictEqual(result.liveBalance, 0);
  assert.strictEqual(result.diff, 0);
});
