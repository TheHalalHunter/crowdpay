const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

test('isExpiredOrInvalidToken detects registration token expiration and invalidity (#1086)', () => {
  const { isExpiredOrInvalidToken } = require('./fcmPushService');

  assert.equal(
    isExpiredOrInvalidToken({ code: 'messaging/registration-token-not-registered' }),
    true
  );
  assert.equal(isExpiredOrInvalidToken({ code: 'messaging/invalid-registration-token' }), true);
  assert.equal(isExpiredOrInvalidToken({ code: 'messaging/token-expired' }), true);
  assert.equal(isExpiredOrInvalidToken({ code: 'messaging/mismatched-credential' }), true);
  assert.equal(
    isExpiredOrInvalidToken({ message: 'The registration token is not registered' }),
    true
  );
  assert.equal(isExpiredOrInvalidToken({ message: 'Requested entity was not found.' }), true);
  assert.equal(isExpiredOrInvalidToken({ code: 'messaging/internal-error' }), false);
  assert.equal(isExpiredOrInvalidToken(null), false);
  assert.equal(isExpiredOrInvalidToken(undefined), false);
});

test('pruneExpiredSubscriptions atomically deletes expired tokens for a user (#1086)', async () => {
  const queries = [];
  const dbStub = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('DELETE FROM push_subscriptions')) {
        return {
          rows: [
            { id: 'sub-1', token: 'exp-token-1' },
            { id: 'sub-2', token: 'exp-token-2' },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const fcmService = proxyquire('./fcmPushService', {
    '../config/database': dbStub,
  });

  const count = await fcmService.pruneExpiredSubscriptions('user-1', [
    'exp-token-1',
    'exp-token-2',
  ]);
  assert.equal(count, 2);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /DELETE FROM push_subscriptions/);
  assert.deepEqual(queries[0].params, ['user-1', ['exp-token-1', 'exp-token-2']]);

  // Gracefully handles empty or invalid token list without executing query
  const zeroCount = await fcmService.pruneExpiredSubscriptions('user-1', []);
  assert.equal(zeroCount, 0);
  assert.equal(queries.length, 1);
});

test('pruneStaleSubscriptions atomically deletes subscriptions older than retention threshold (#1086)', async () => {
  const queries = [];
  const dbStub = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ id: 'sub-old-1' }] };
    },
  };

  const fcmService = proxyquire('./fcmPushService', {
    '../config/database': dbStub,
  });

  const count = await fcmService.pruneStaleSubscriptions({ maxAgeDays: 60 });
  assert.equal(count, 1);
  assert.match(queries[0].sql, /DELETE FROM push_subscriptions/);
  assert.deepEqual(queries[0].params, ['60']);
});

test('sendToUser automatically invokes atomic pruning when expired tokens are encountered (#1086)', async () => {
  const queries = [];
  const dbStub = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT token FROM push_subscriptions')) {
        return { rows: [{ token: 'valid-token' }, { token: 'expired-token' }] };
      }
      if (sql.includes('DELETE FROM push_subscriptions')) {
        return { rows: [{ id: 'sub-expired', token: 'expired-token' }] };
      }
      return { rows: [] };
    },
  };

  const adminStub = {
    apps: ['app'],
    messaging: () => ({
      sendEachForMulticast: async ({ tokens: _tokens }) => ({
        successCount: 1,
        failureCount: 1,
        responses: [
          { success: true },
          { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        ],
      }),
    }),
  };

  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'test-project' });

  const fcmService = proxyquire('./fcmPushService', {
    '../config/database': dbStub,
    'firebase-admin': adminStub,
  });

  const delivered = await fcmService.sendToUser('user-123', {
    type: 'test',
    title: 'Test Title',
    body: 'Test Body',
  });

  assert.equal(delivered, true);
  const deleteQuery = queries.find(q => q.sql.includes('DELETE FROM push_subscriptions'));
  assert.ok(deleteQuery, 'Atomic delete query was dispatched');
  assert.deepEqual(deleteQuery.params, ['user-123', ['expired-token']]);
});
