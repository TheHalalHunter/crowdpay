const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function loadAuditService({ queryImpl }) {
  return proxyquire('./auditService', {
    '../config/database': { query: queryImpl },
    '../config/logger': { info: () => {}, warn: () => {}, error: () => {} },
    '../config/requestContext': { getRequestContext: () => ({}) },
  });
}

test('logAuditEvent records actor, target, correlation, source, and safe before/after state', async () => {
  let captured;
  const service = loadAuditService({
    queryImpl: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ id: 'audit-1' }] };
    },
  });

  const event = await service.logAuditEvent({
    actorId: 'admin-1',
    action: 'campaign.suspended',
    resourceType: 'campaign',
    resourceId: 'campaign-1',
    before: { status: 'active', apiToken: 'super-secret' },
    after: { status: 'suspended', reason: 'policy violation' },
    metadata: {
      password: 'hunter2',
      apiKey: 'cpk_live_secret',
      signed_xdr: 'AAAA-secret-xdr',
      nested: { authorization: 'Bearer secret', note: 'visible' },
    },
    correlationId: 'corr-123',
    source: 'PATCH /api/admin/campaigns/:id/suspend',
  });

  assert.equal(event.id, 'audit-1');
  assert.match(captured.sql, /INSERT INTO audit_logs/);
  assert.ok(captured.sql.includes('correlation_id'));
  assert.ok(captured.sql.includes('source'));
  assert.ok(captured.sql.includes('before_state'));
  assert.ok(captured.sql.includes('after_state'));

  const [
    actorId,
    action,
    resourceType,
    resourceId,
    ip,
    userAgent,
    metadata,
    correlationId,
    source,
    before,
    after,
  ] = captured.params;

  assert.equal(actorId, 'admin-1');
  assert.equal(action, 'campaign.suspended');
  assert.equal(resourceType, 'campaign');
  assert.equal(resourceId, 'campaign-1');
  assert.equal(ip, null);
  assert.equal(userAgent, null);
  assert.equal(correlationId, 'corr-123');
  assert.equal(source, 'PATCH /api/admin/campaigns/:id/suspend');

  const safeMetadata = JSON.parse(metadata);
  assert.equal(safeMetadata.password, '[REDACTED]');
  assert.equal(safeMetadata.apiKey, '[REDACTED]');
  assert.equal(safeMetadata.signed_xdr, '[REDACTED]');
  assert.equal(safeMetadata.nested.authorization, '[REDACTED]');
  assert.equal(safeMetadata.nested.note, 'visible');

  const safeBefore = JSON.parse(before);
  assert.equal(safeBefore.status, 'active');
  assert.equal(safeBefore.apiToken, '[REDACTED]');
  assert.deepEqual(JSON.parse(after), { status: 'suspended', reason: 'policy violation' });
});

test('logAuditEvent derives correlation and source from the request context', async () => {
  let captured;
  const service = loadAuditService({
    queryImpl: async (_sql, params) => {
      captured = params;
      return { rows: [{ id: 'audit-2' }] };
    },
  });

  await service.logAuditEvent({
    actorId: 'admin-1',
    action: 'payout.approved',
    resourceType: 'withdrawal',
    resourceId: 'withdrawal-1',
    req: {
      id: 'request-42',
      method: 'POST',
      originalUrl: '/api/withdrawals/withdrawal-1/approve?token=hidden',
      ip: '203.0.113.4',
      headers: { 'user-agent': 'test-agent' },
    },
  });

  assert.equal(captured[7], 'request-42');
  assert.equal(captured[8], 'POST /api/withdrawals/withdrawal-1/approve');
  assert.equal(captured[4], '203.0.113.4');
  assert.equal(captured[5], 'test-agent');
});

test('queryAuditLogs redacts sensitive values from legacy rows on read', async () => {
  let call = 0;
  const service = loadAuditService({
    queryImpl: async () => {
      call += 1;
      if (call === 1) return { rows: [{ total: 1 }] };
      return {
        rows: [
          {
            id: 'audit-1',
            action: 'login',
            metadata: { token: 'leaked-token', note: 'ok' },
            before_state: { secret: 'leaked-secret' },
            after_state: { status: 'ok' },
          },
        ],
      };
    },
  });

  const result = await service.queryAuditLogs({ action: 'login' });
  assert.equal(result.total, 1);
  assert.equal(result.data[0].metadata.token, '[REDACTED]');
  assert.equal(result.data[0].metadata.note, 'ok');
  assert.equal(result.data[0].before_state.secret, '[REDACTED]');
  assert.deepEqual(result.data[0].after_state, { status: 'ok' });
});

test('sanitizeMetadata removes Stellar secret seeds and handles cycles', () => {
  const service = loadAuditService({ queryImpl: async () => ({ rows: [] }) });
  const cyclic = { note: 'ok' };
  cyclic.self = cyclic;

  const sanitized = service.sanitizeMetadata({
    note: 'SCVMQUS5EMTHWBLJTE5XCSCMHB2ZOVKRR4ATVTRPUNRCOGKRENIL3LHR',
    seed: 'another-secret',
    cyclic,
  });

  assert.equal(sanitized.note, '[REDACTED]');
  assert.equal(sanitized.seed, '[REDACTED]');
  assert.equal(sanitized.cyclic.self, '[Circular]');
});
