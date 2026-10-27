const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp(queryImpl, overrides = {}) {
  const calls = { generated: [], audits: [] };
  const router = proxyquire('./users', {
    '../config/database': { query: queryImpl },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'user-1', role: 'contributor' };
        next();
      },
    },
    '../services/kycProvider': { isKycRequiredForCampaigns: () => false },
    '../services/kycService': { startKycForUser: async () => ({ status: 'verified' }) },
    '../services/userDashboardService': {
      listCreatorCampaigns: async () => [],
      listUserContributions: async () => [],
    },
    '../services/stellarService': { getCampaignBalance: async () => '0' },
    '../services/analyticsService': { getUserDashboardAnalytics: async () => ({}) },
    '../services/exportService': {
      EXPORT_SCOPES: { profile: [], contributions: [] },
      generateUserExport: (userId, exportId) => calls.generated.push({ userId, exportId }),
      getExportDownloadUrl: overrides.getExportDownloadUrl || (async key => `https://files/${key}`),
    },
    '../services/auditService': {
      logAuditEvent: async event => calls.audits.push(event),
      getCredentialActivity: async () => [],
    },
    './apiKeys': express.Router(),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/users', router);
  return { app, calls };
}

test('POST /api/users/me/exports queues an export and audit event', async () => {
  const { app, calls } = buildApp(async text => {
    if (text.includes('SELECT id, status, created_at FROM user_data_exports')) return { rows: [] };
    if (text.includes('INSERT INTO user_data_exports')) {
      return { rows: [{ id: 'export-1', status: 'pending', created_at: '2026-01-01T00:00:00Z' }] };
    }
    return { rows: [] };
  });

  const response = await request(app).post('/api/users/me/exports');

  assert.equal(response.status, 202);
  assert.equal(response.body.id, 'export-1');
  assert.deepEqual(calls.generated, [{ userId: 'user-1', exportId: 'export-1' }]);
  assert.equal(calls.audits[0].action, 'user_data_export_requested');
  assert.equal(calls.audits[0].actorId, 'user-1');
});

test('download is scoped to the authenticated user', async () => {
  const callsSeen = [];
  const { app } = buildApp(async (text, params) => {
    callsSeen.push({ text, params });
    return { rows: [] };
  });

  const response = await request(app).get('/api/users/me/exports/export-other/download');

  assert.equal(response.status, 404);
  const lookup = callsSeen.find(call => call.text.includes('FROM user_data_exports'));
  assert.deepEqual(lookup.params, ['export-other', 'user-1']);
});

test('completed export download is time-limited and audit logged', async () => {
  const { app, calls } = buildApp(
    async (text, params) => {
      if (text.includes('FROM user_data_exports')) {
        return {
          rows: [
            {
              id: params[0],
              status: 'completed',
              file_url: 'exports/user-1/file.json',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    },
    { getExportDownloadUrl: async key => `https://files.example.test/${key}` }
  );

  const response = await request(app).get('/api/users/me/exports/export-1/download');

  assert.equal(response.status, 200);
  assert.equal(response.body.downloadUrl, 'https://files.example.test/exports/user-1/file.json');
  assert.equal(calls.audits[0].action, 'user_data_export_downloaded');
  assert.equal(calls.audits[0].resourceId, 'export-1');
});

test('expired export download returns 410 without producing a URL', async () => {
  let generatedUrl = false;
  const { app } = buildApp(
    async (text, params) => {
      if (text.includes('FROM user_data_exports')) {
        return {
          rows: [
            {
              id: params[0],
              status: 'completed',
              file_url: 'exports/user-1/file.json',
              expires_at: new Date(Date.now() - 60_000).toISOString(),
            },
          ],
        };
      }
      return { rows: [] };
    },
    {
      getExportDownloadUrl: async () => {
        generatedUrl = true;
        return 'https://files.example.test/expired';
      },
    }
  );

  const response = await request(app).get('/api/users/me/exports/export-1/download');

  assert.equal(response.status, 410);
  assert.equal(generatedUrl, false);
});
