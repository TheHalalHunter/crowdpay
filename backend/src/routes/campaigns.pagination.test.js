const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();
const { Keypair } = require('@stellar/stellar-sdk');

if (!process.env.PLATFORM_SECRET_KEY) {
  process.env.PLATFORM_SECRET_KEY = Keypair.random().secret();
}
if (!process.env.USDC_ISSUER) {
  process.env.USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/crowdpay_test';
}

function buildApp(queryImpl) {
  const queryCalls = [];
  const wrappedQuery = async (text, params) => {
    queryCalls.push({ text, params });
    if (queryImpl) return queryImpl(text, params);
    if (/SELECT\s+COUNT\(\*\)/i.test(text)) {
      return { rows: [{ total: '1' }] };
    }
    return { rows: [] };
  };

  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds: async () => ({ refundsCreated: 0, refunds: [] }),
    },
    '../config/database': {
      query: wrappedQuery,
      connect: async () => ({ query: wrappedQuery, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: async () => '',
    },
    '../services/ledgerMonitor': { watchCampaignWallet: async () => {} },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: async () => 'tx-row',
    },
    '../config/logger': { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} },
    '../services/sorobanService': {
      deployCampaignContracts: async () => ({
        escrowContractId: 'C' + 'A'.repeat(55),
        milestonesContractId: 'C' + 'B'.repeat(55),
      }),
      invokeContract: async () => null,
      encodeMilestone: () => ({
        title_hash: Buffer.alloc(32),
        release_bps: 1000,
        status: 0,
        evidence_hash: null,
      }),
      nativeToScVal: v => v,
      scvAddressFromString: s => s,
    },
    '../services/emailService': { sendEmail: async () => {} },
    '../services/alerting': { sendAlert: () => {} },
    '../services/walletService': { encryptSecret: () => 'encrypted-secret' },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      WEBHOOK_EVENTS: {
        CAMPAIGN_CREATED: 'campaign.created',
        CAMPAIGN_FUNDED: 'campaign.funded',
        CAMPAIGN_FAILED: 'campaign.failed',
      },
    },
    '../services/storage': { uploadCampaignCoverImage: async () => '/images/cover.jpg' },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => false,
      getTierLimit: () => 50000,
      VERIFICATION_TIER_LIMITS: { none: 0, basic: 5000, standard: 50000, enhanced: Infinity },
    },
    '../services/userDashboardService': { listCreatorCampaigns: async () => [] },
    '../services/trendingService': {
      getTrendingCampaigns: async ({ limit }) => {
        wrappedQuery('TRENDING', [limit]);
        return [];
      },
    },
    '../services/campaignRecommendationService': {
      getRecommendedCampaigns: async (userId, { limit }) => {
        wrappedQuery('RECOMMENDED', [userId, limit]);
        return [];
      },
    },
    '../middleware/validation': {
      createCampaignValidation: [],
      createCampaignUpdateValidation: [],
      updateCampaignValidation: [],
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
      createValidateRequest: () => (_req, _res, next) => next(),
    },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: 'test-user', role: 'creator' };
        next();
      },
      requireRole: () => (_req, _res, next) => next(),
      requireCampaignMember: () => (_req, _res, next) => next(),
      optionalAuth: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);

  return { app, queryCalls };
}

test('GET /api/campaigns uses default limit (20) and offset (0) when parameters are missing', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.offset, 0);

  const mainQuery = queryCalls.find(c => c.text.includes('LIMIT') && c.text.includes('OFFSET'));
  assert.ok(mainQuery, 'Main query was executed');
  const params = mainQuery.params;
  assert.equal(params[params.length - 2], 20);
  assert.equal(params[params.length - 1], 0);
});

test('GET /api/campaigns handles non-numeric query parameters without 500', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns?limit=abc&offset=xyz');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.offset, 0);

  const mainQuery = queryCalls.find(c => c.text.includes('LIMIT') && c.text.includes('OFFSET'));
  assert.ok(mainQuery);
  const params = mainQuery.params;
  assert.equal(params[params.length - 2], 20);
  assert.equal(params[params.length - 1], 0);
});

test('GET /api/campaigns safely clamps negative limit and offset to valid non-negative values', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns?limit=-5&offset=-10');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 1);
  assert.equal(res.body.offset, 0);

  const mainQuery = queryCalls.find(c => c.text.includes('LIMIT') && c.text.includes('OFFSET'));
  assert.ok(mainQuery);
  const params = mainQuery.params;
  assert.equal(params[params.length - 2], 1);
  assert.equal(params[params.length - 1], 0);
});

test('GET /api/campaigns handles zero and empty string query parameters', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns?limit=0&offset=0');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 20);
  assert.equal(res.body.offset, 0);

  const emptyRes = await request(app).get('/api/campaigns?limit=&offset=');
  assert.equal(emptyRes.status, 200);
  assert.equal(emptyRes.body.limit, 20);
  assert.equal(emptyRes.body.offset, 0);
});

test('GET /api/campaigns truncates decimals to integers to prevent PostgreSQL fraction errors', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns?limit=15.9&offset=5.2');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 15);
  assert.equal(res.body.offset, 5);

  const mainQuery = queryCalls.find(c => c.text.includes('LIMIT') && c.text.includes('OFFSET'));
  const params = mainQuery.params;
  assert.equal(params[params.length - 2], 15);
  assert.equal(params[params.length - 1], 5);
});

test('GET /api/campaigns caps excessively large limit to max (100)', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns?limit=9999&offset=500');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 100);
  assert.equal(res.body.offset, 500);

  const mainQuery = queryCalls.find(c => c.text.includes('LIMIT') && c.text.includes('OFFSET'));
  const params = mainQuery.params;
  assert.equal(params[params.length - 2], 100);
  assert.equal(params[params.length - 1], 500);
});

test('GET /api/campaigns preserves valid limit and offset', async () => {
  const { app, queryCalls } = buildApp();
  const res = await request(app).get('/api/campaigns?limit=30&offset=15');
  assert.equal(res.status, 200);
  assert.equal(res.body.limit, 30);
  assert.equal(res.body.offset, 15);

  const mainQuery = queryCalls.find(c => c.text.includes('LIMIT') && c.text.includes('OFFSET'));
  const params = mainQuery.params;
  assert.equal(params[params.length - 2], 30);
  assert.equal(params[params.length - 1], 15);
});

test('GET /api/campaigns/recommended safely validates limit parameter', async () => {
  const { app, queryCalls } = buildApp();

  // Missing parameter -> default 6
  await request(app).get('/api/campaigns/recommended').expect(200);
  let recCall = queryCalls.find(c => c.text === 'RECOMMENDED');
  assert.equal(recCall.params[1], 6);

  // Non-numeric -> default 6
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/recommended?limit=abc').expect(200);
  recCall = queryCalls.find(c => c.text === 'RECOMMENDED');
  assert.equal(recCall.params[1], 6);

  // Negative -> clamped to 1
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/recommended?limit=-5').expect(200);
  recCall = queryCalls.find(c => c.text === 'RECOMMENDED');
  assert.equal(recCall.params[1], 1);

  // Excessively large -> capped to 12
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/recommended?limit=999').expect(200);
  recCall = queryCalls.find(c => c.text === 'RECOMMENDED');
  assert.equal(recCall.params[1], 12);
});

test('GET /api/campaigns/trending safely validates limit parameter', async () => {
  const { app, queryCalls } = buildApp();

  // Missing -> default 20
  await request(app).get('/api/campaigns/trending').expect(200);
  let trendCall = queryCalls.find(c => c.text === 'TRENDING');
  assert.equal(trendCall.params[0], 20);

  // Non-numeric -> default 20
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/trending?limit=invalid').expect(200);
  trendCall = queryCalls.find(c => c.text === 'TRENDING');
  assert.equal(trendCall.params[0], 20);

  // Negative -> clamped to 1
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/trending?limit=-10').expect(200);
  trendCall = queryCalls.find(c => c.text === 'TRENDING');
  assert.equal(trendCall.params[0], 1);

  // Over max -> capped to 20
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/trending?limit=500').expect(200);
  trendCall = queryCalls.find(c => c.text === 'TRENDING');
  assert.equal(trendCall.params[0], 20);
});

test('GET /api/campaigns/:id/updates safely validates limit and offset', async () => {
  const { app, queryCalls } = buildApp();

  // Missing -> limit 10, offset 0
  await request(app).get('/api/campaigns/c1/updates').expect(200);
  let updateCall = queryCalls.find(c => c.text.includes('FROM campaign_updates'));
  assert.equal(updateCall.params[1], 10);
  assert.equal(updateCall.params[2], 0);

  // Non-numeric -> default limit 10, offset 0
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/c1/updates?limit=foo&offset=bar').expect(200);
  updateCall = queryCalls.find(c => c.text.includes('FROM campaign_updates'));
  assert.equal(updateCall.params[1], 10);
  assert.equal(updateCall.params[2], 0);

  // Negative -> clamped to 1 and 0
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/c1/updates?limit=-5&offset=-20').expect(200);
  updateCall = queryCalls.find(c => c.text.includes('FROM campaign_updates'));
  assert.equal(updateCall.params[1], 1);
  assert.equal(updateCall.params[2], 0);

  // Large limit -> capped to 50
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/c1/updates?limit=200&offset=15').expect(200);
  updateCall = queryCalls.find(c => c.text.includes('FROM campaign_updates'));
  assert.equal(updateCall.params[1], 50);
  assert.equal(updateCall.params[2], 15);
});

test('GET /api/campaigns/:id/backers safely validates limit and offset', async () => {
  const { app, queryCalls } = buildApp(async (text, _params) => {
    if (text.includes('SELECT show_backer_amounts')) {
      return { rows: [{ show_backer_amounts: true }] };
    }
    if (text.includes('SELECT COUNT')) {
      return { rows: [{ total: 0 }] };
    }
    return { rows: [] };
  });

  // Non-numeric limit and offset -> default limit 20, offset 0
  await request(app).get('/api/campaigns/c1/backers?limit=invalid&offset=invalid').expect(200);
  let backerCall = queryCalls.find(c => c.text.includes('LIMIT $2 OFFSET $3'));
  assert.ok(backerCall);
  assert.equal(backerCall.params[1], 20);
  assert.equal(backerCall.params[2], 0);

  // Negative limit and offset -> clamped to 1 and 0
  queryCalls.length = 0;
  await request(app).get('/api/campaigns/c1/backers?limit=-5&offset=-10').expect(200);
  backerCall = queryCalls.find(c => c.text.includes('LIMIT $2 OFFSET $3'));
  assert.equal(backerCall.params[1], 1);
  assert.equal(backerCall.params[2], 0);
});

test('GET /api/campaigns/:id/members safely validates limit and offset', async () => {
  const { app, queryCalls } = buildApp(async (text, _params) => {
    if (text.includes('SELECT creator_id')) {
      return { rows: [{ creator_id: 'test-user' }] };
    }
    if (text.includes('SELECT COUNT')) {
      return { rows: [{ total: 0 }] };
    }
    return { rows: [] };
  });

  // Negative limit and offset -> clamped to 1 and 0
  await request(app).get('/api/campaigns/c1/members?limit=-5&offset=-10').expect(200);
  const memberCall = queryCalls.find(c => c.text.includes('LIMIT $2 OFFSET $3'));
  assert.ok(memberCall);
  assert.equal(memberCall.params[1], 1);
  assert.equal(memberCall.params[2], 0);
});
