const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('fraudService extracts features and scores contributions', async () => {
  let inserted = false;
  const dbStub = {
    query: async (sql, _params) => {
      if (sql.includes('INSERT INTO contribution_fraud_scores')) {
        inserted = true;
        return { rows: [] };
      }
      if (sql.includes('SELECT COUNT(*)')) {
        return { rows: [{ cnt: '0' }] };
      }
      if (sql.includes('SELECT created_at FROM users')) {
        return { rows: [{ created_at: new Date() }] };
      }
      return { rows: [] };
    },
  };

  const fraudService = proxyquire('./fraudService', {
    '../config/database': dbStub,
  });

  const result = await fraudService.scoreContribution({
    contributionId: 'contrib-1',
    campaignId: 'camp-1',
    userId: 'user-1',
    amount: '15000',
    ipAddress: '192.0.2.1',
    deviceFingerprint: 'suspicious-device',
  });

  assert.equal(typeof result.score, 'number');
  assert.ok(result.score > 0);
  assert.equal(inserted, true);
  assert.equal(result.breakdown.amount.score, 40);
  assert.equal(result.breakdown.amount.detail, 'Amount: 15000.0000000');
});

test('fraudService uses decimal-safe contribution amounts for exact boundary checks (#1085)', async () => {
  const dbStub = {
    query: async () => ({ rows: [] }),
  };

  const fraudService = proxyquire('./fraudService', {
    '../config/database': dbStub,
  });

  // Exactly 10000.0000000 should score 20 (not > 10000)
  const at10k = await fraudService.extractFeatures({
    userId: 'user-1',
    amount: '10000.0000000',
  });
  assert.equal(at10k.breakdown.amount.score, 20);
  assert.equal(at10k.breakdown.amount.detail, 'Amount: 10000.0000000');

  // Exactly 10000.0000001 (one stroop above 10k) should score 40
  const above10k = await fraudService.extractFeatures({
    userId: 'user-1',
    amount: '10000.0000001',
  });
  assert.equal(above10k.breakdown.amount.score, 40);
  assert.equal(above10k.breakdown.amount.detail, 'Amount: 10000.0000001');

  // Exactly 5000.0000000 should score 0 (not > 5000)
  const at5k = await fraudService.extractFeatures({
    userId: 'user-1',
    amount: '5000.0000000',
  });
  assert.equal(at5k.breakdown.amount.score, 0);

  // Exactly 5000.0000001 (one stroop above 5k) should score 20
  const above5k = await fraudService.extractFeatures({
    userId: 'user-1',
    amount: '5000.0000001',
  });
  assert.equal(above5k.breakdown.amount.score, 20);

  // Malformed amount handles safely without throw
  const malformed = await fraudService.extractFeatures({
    userId: 'user-1',
    amount: 'not-a-number',
  });
  assert.equal(malformed.breakdown.amount.score, 0);
  assert.equal(malformed.breakdown.amount.detail, 'Amount: 0.0000000');

  // Null/undefined amount handles safely
  const nullAmount = await fraudService.extractFeatures({
    userId: 'user-1',
    amount: null,
  });
  assert.equal(nullAmount.breakdown.amount.score, 0);
  assert.equal(nullAmount.breakdown.amount.detail, 'Amount: 0.0000000');
});
