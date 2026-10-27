const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { requireRole } = require('../middleware/auth');

function buildApp() {
  const auditLogsRouter = proxyquire('./auditLogs', {
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: req.headers['x-test-role'] || 'contributor' };
        next();
      },
      requireRole,
    },
    '../services/auditService': {
      queryAuditLogs: async () => ({ data: [], total: 0, limit: 50, offset: 0 }),
      queryAllForExport: async () => [],
      buildExportCsv: () => '',
    },
  });

  const app = express();
  app.use('/api/admin/audit-logs', auditLogsRouter);
  return app;
}

test('audit log query rejects non-admin roles', async () => {
  const res = await request(buildApp()).get('/api/admin/audit-logs').set('x-test-role', 'creator');

  assert.equal(res.status, 403);
  assert.match(res.body.error, /role/i);
});

test('audit log query is available to administrators', async () => {
  const res = await request(buildApp()).get('/api/admin/audit-logs').set('x-test-role', 'admin');

  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
});

test('audit log export rejects non-admin roles', async () => {
  const res = await request(buildApp())
    .get('/api/admin/audit-logs/export?format=csv')
    .set('x-test-role', 'contributor');

  assert.equal(res.status, 403);
});
