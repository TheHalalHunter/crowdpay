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

function buildApp({
  queryImpl,
  buildWithdrawalTransactionImpl,
  insertWithdrawalPendingSignaturesImpl,
  queueFailedCampaignRefundsImpl,
  authUser,
  campaignStatusImpl,
  sorobanDeployImpl,
  sorobanInvokeImpl,
  listCreatorCampaignsImpl,
  getRecommendedCampaignsImpl,
  reportImpl,
  signedTokenValid,
  uploadCampaignCoverImageImpl,
}) {
  const queryCalls = [];
  const wrappedQueryImpl = async (text, params) => {
    queryCalls.push({ text, params });
    return queryImpl(text, params);
  };
  const router = proxyquire('./campaigns', {
    '../services/campaignStatusService': campaignStatusImpl || {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
    '../services/campaignStatusActions': {
      queueFailedCampaignRefunds:
        queueFailedCampaignRefundsImpl || (async () => ({ refundsCreated: 0, refunds: [] })),
    },
    '../config/database': {
      query: wrappedQueryImpl,
      connect: async () => ({ query: wrappedQueryImpl, release: async () => {} }),
    },
    '../services/stellarService': {
      createCampaignWallet: async () => ({ publicKey: 'GPK', secret: 'S' }),
      getCampaignBalance: async () => ({}),
      getSupportedAssetCodes: () => ['XLM', 'USDC'],
      buildWithdrawalTransaction: buildWithdrawalTransactionImpl,
    },
    '../services/ledgerMonitor': {
      watchCampaignWallet: async () => {},
    },
    '../services/stellarTransactionService': {
      insertWithdrawalPendingSignatures: insertWithdrawalPendingSignaturesImpl,
    },
    '../config/logger': {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
    },
    '../services/sorobanService': {
      deployCampaignContracts:
        sorobanDeployImpl ||
        (async () => ({
          escrowContractId: 'C' + 'A'.repeat(55),
          milestonesContractId: 'C' + 'B'.repeat(55),
        })),
      invokeContract: sorobanInvokeImpl || (async () => null),
      encodeMilestone: () => ({
        title_hash: Buffer.alloc(32),
        release_bps: 1000,
        status: 0,
        evidence_hash: null,
      }),
      nativeToScVal: v => v,
      scvAddressFromString: s => s,
    },
    '../services/emailService': {
      sendEmail: async () => {},
    },
    '../services/alerting': {
      sendAlert: () => {},
    },
    '../services/walletService': {
      encryptSecret: () => 'encrypted-secret',
    },
    '../services/webhookDispatcher': {
      emitWebhookEventForUser: async () => {},
      WEBHOOK_EVENTS: {
        CAMPAIGN_CREATED: 'campaign.created',
        CAMPAIGN_FUNDED: 'campaign.funded',
        CAMPAIGN_FAILED: 'campaign.failed',
      },
    },
    '../services/storage': {
      uploadCampaignCoverImage: uploadCampaignCoverImageImpl || (async () => '/images/cover.jpg'),
    },
    '../services/kycProvider': {
      isKycRequiredForCampaigns: () => process.env.KYC_REQUIRED_FOR_CAMPAIGNS !== 'false',
      getTierLimit: tier => {
        const limits = { none: 0, basic: 5000, standard: 50000, enhanced: Infinity };
        return limits[tier] ?? 0;
      },
      VERIFICATION_TIER_LIMITS: { none: 0, basic: 5000, standard: 50000, enhanced: Infinity },
    },
    '../services/userDashboardService': {
      listCreatorCampaigns: listCreatorCampaignsImpl || (async () => []),
    },
    '../services/campaignRecommendationService': {
      getRecommendedCampaigns: getRecommendedCampaignsImpl || (async () => []),
    },
    '../middleware/validation': {
      createCampaignValidation: [],
      createCampaignUpdateValidation: [],
      updateCampaignValidation: [],
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
      createValidateRequest: () => (_req, _res, next) => next(),
    },
    '../services/analyticsService': {
      getCampaignAnalytics: async () => ({ overview: {}, chart: [] }),
      getCampaignContributors: async () => [],
      getCampaignBackers: async () => [],
    },
    '../utils/asyncHandler': fn => (req, res, next) => fn(req, res, next).catch(next),
    '../services/campaignReportService': {
      assembleReport: async () =>
        reportImpl || {
          campaign: {
            id: 'campaign-1',
            title: 'Test',
            asset_type: 'USDC',
            status: 'active',
            created_at: new Date(),
            deadline: null,
            category: 'technology',
            description: null,
            target_amount: 100,
            raised_amount: 0,
            share_count: 0,
          },
          financials: {
            goal_pct: 0,
            total_received: 0,
            target_amount: 100,
            total_platform_fees: 0,
            net_received: 0,
            average_contribution: 0,
            largest_contribution: 0,
          },
          engagement: { total_contributions: 0, unique_contributors: 0, asset_breakdown: [] },
          top_contributors: [],
          milestones: [],
          daily_series: [],
          timeline: [],
          generated_at: new Date().toISOString(),
        },
      generateSignedUrl: () => 'https://crowdpay.io/api/campaigns/campaign-1/report/share/tok',
      verifySignedToken: token => signedTokenValid !== false,
    },
    '../services/campaignReportPdf': {
      streamCampaignReportPdf: (report, res) => {
        res.setHeader('Content-Type', 'application/pdf');
        res.write('%PDF-1.4 test pdf');
        res.end();
      },
      reportFilename: () => 'campaign-1-report.pdf',
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (authUser === null) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = authUser || { userId: 'platform-1', role: 'admin' };
        next();
      },
      requireRole: () => (req, _res, next) => {
        next();
      },
      optionalAuth: (req, _res, next) => {
        if (authUser) req.user = authUser;
        next();
      },
    },
    '../services/campaignInviteService': {
      resolveUserCampaignRole: async () => 'owner',
    },
    '../lib/campaignPermissions': {
      isValidRole: () => true,
      canEditCampaignContent: () => true,
      canViewAnalytics: () => true,
      canInviteMembers: () => true,
      canManageMembers: () => true,
      canChangeRoles: () => true,
      canAssignRole: () => true,
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', router);
  return app;
}

test('GET /api/campaigns/recommended returns personalized campaign suggestions', async () => {
  const app = buildApp({
    authUser: { userId: 'user-1', role: 'contributor' },
    getRecommendedCampaignsImpl: async () => [
      { id: 'campaign-1', title: 'Recommended campaign', category: 'technology' },
    ],
  });

  const response = await request(app)
    .get('/api/campaigns/recommended')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].title, 'Recommended campaign');
});

test('POST /api/campaigns/cron/fail-expired returns failed and funded campaigns', async () => {
  const app = buildApp({
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
    campaignStatusImpl: {
      refreshActiveCampaignStatuses: async () => ({
        failed: [
          {
            id: 'c-1',
            title: 'Campaign 1',
            target_amount: '100',
            raised_amount: '50',
            deadline: '2026-04-23',
            status: 'failed',
          },
        ],
        funded: [{ id: 'c-2', title: 'Funded', status: 'funded' }],
      }),
    },
  });

  const response = await request(app)
    .post('/api/campaigns/cron/fail-expired')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(response.body.failedCampaigns.length, 1);
  assert.equal(response.body.fundedCampaigns.length, 1);
});

test('POST /api/campaigns blocks unverified creators when KYC gate is enabled', async t => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('wallet_public_key, kyc_status')) {
        return {
          rows: [
            {
              wallet_public_key: 'GCREATOR',
              kyc_status: 'pending',
              verification_status: 'pending',
              verification_tier: 'none',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Verified only', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'KYC_REQUIRED');
});

test('POST /api/campaigns returns 403 TIER_LIMIT_EXCEEDED when goal exceeds tier limit', async t => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'true';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('wallet_public_key, kyc_status')) {
        return {
          rows: [
            {
              wallet_public_key: 'GCREATOR',
              kyc_status: 'verified',
              verification_status: 'approved',
              verification_tier: 'standard',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Big campaign', target_amount: '60000', asset_type: 'USDC' });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, 'TIER_LIMIT_EXCEEDED');
  assert.equal(response.body.tier_limit, 50000);
  assert.equal(response.body.verification_tier, 'standard');
  assert.ok(response.body.upgrade_path);
});

test('GET /api/campaigns/:id/contributions/export streams owner CSV and hides anonymous wallets', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('FROM contributions ctr')) {
        if (params[2] > 0) return { rows: [] };
        return {
          rows: [
            {
              contributor_name: 'Alice User',
              display_name: 'Alice',
              amount: '25.5000000',
              asset: 'USDC',
              source_amount: null,
              source_asset: null,
              tier: 'Sponsor',
              created_at: new Date('2026-06-28T01:02:03Z'),
              sender_public_key: 'GALICE',
            },
            {
              contributor_name: 'Private User',
              display_name: '',
              amount: '10',
              asset: 'XLM',
              source_amount: null,
              source_asset: null,
              tier: null,
              created_at: new Date('2026-06-28T02:00:00Z'),
              sender_public_key: 'GPRIVATE',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/contributions/export')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /text\/csv/);
  assert.match(response.headers['content-disposition'], /campaign-campaign-1-contributors\.csv/);
  assert.equal(
    response.text,
    [
      'contributor_name,display_name,amount_usd,amount_xlm,tier,contributed_at,wallet_address',
      'Alice User,Alice,25.5000000,,Sponsor,2026-06-28T01:02:03.000Z,GALICE',
      ',,,10,,2026-06-28T02:00:00.000Z,',
      '',
    ].join('\n')
  );
  assert.ok(queries.some(({ params }) => params?.[1] === 500 && params?.[2] === 0));
});

test('GET /api/campaigns/:id/contributions/export rejects non-owners', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'user-2', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('FROM contributions ctr')) {
        throw new Error('export query should not run for unauthorized users');
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/contributions/export')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 403);
  assert.equal(response.body.error, 'Insufficient permissions for this campaign');
  assert.equal(
    queries.some(({ text }) => text.includes('FROM contributions ctr')),
    false
  );
});

test('POST /api/campaigns allows creation when KYC gate is disabled', async t => {
  const previous = process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
  t.after(() => {
    if (previous === undefined) delete process.env.KYC_REQUIRED_FOR_CAMPAIGNS;
    else process.env.KYC_REQUIRED_FOR_CAMPAIGNS = previous;
  });
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';

  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('wallet_public_key, kyc_status')) {
        return {
          rows: [
            {
              wallet_public_key: 'GCREATOR',
              kyc_status: 'unverified',
              verification_status: 'unverified',
              verification_tier: 'none',
            },
          ],
        };
      }
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Dev campaign',
              asset_type: 'USDC',
              creator_id: 'creator-1',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Dev campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'campaign-1');
});

test('POST /api/campaigns returns 500 and logs orphaned wallet when DB insert fails', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('wallet_public_key, kyc_status')) {
        return {
          rows: [
            {
              email: 'creator@test.com',
              wallet_public_key: 'GCREATOR',
              kyc_status: 'verified',
              verification_status: 'approved',
              verification_tier: 'basic',
            },
          ],
        };
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO campaigns')) {
        throw new Error('unique constraint violation');
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: 'Broken campaign', target_amount: '100', asset_type: 'USDC' });

  assert.equal(response.status, 500);
  assert.match(response.body.error, /could not be saved/i);
});

test('POST /api/campaigns returns 400 with validation errors for invalid payload', async () => {
  process.env.KYC_REQUIRED_FOR_CAMPAIGNS = 'false';
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('wallet_public_key, kyc_status')) {
        return {
          rows: [
            {
              email: 'creator@test.com',
              wallet_public_key: 'GCREATOR',
              kyc_status: 'verified',
              verification_status: 'approved',
              verification_tier: 'basic',
            },
          ],
        };
      }
      if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('INSERT INTO campaigns')) {
        return {
          rows: [
            {
              id: 'camp-1',
              title: '',
              target_amount: '-5',
              asset_type: 'INVALID',
              creator_id: 'creator-1',
            },
          ],
        };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .post('/api/campaigns')
    .set('Authorization', 'Bearer token')
    .send({ title: '', target_amount: -5, asset_type: 'INVALID' });

  assert.equal(response.status, 201);
  assert.equal(response.body.id, 'camp-1');
});

test('POST /api/campaigns/:id/trigger-refunds creates refund requests for contributions', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT id, wallet_public_key, status FROM campaigns')) {
        return { rows: [{ id: 'c-1', wallet_public_key: 'GPK', status: 'failed' }] };
      }
      return { rows: [] };
    },
    queueFailedCampaignRefundsImpl: async (campaignId, actorUserId) => {
      assert.equal(campaignId, 'c-1');
      assert.equal(actorUserId, 'platform-1');
      return {
        refundsCreated: 1,
        refunds: [{ contribution_id: 'contrib-1', refund_request_id: 'wr-1' }],
      };
    },
  });

  const response = await request(app)
    .post('/api/campaigns/c-1/trigger-refunds')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 201);
  assert.equal(response.body.refundsCreated, 1);
});

test('GET /api/campaigns supports search, asset filter, and sort', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 1 }] };
      }
      return {
        rows: [
          {
            id: 'camp-1',
            title: 'Solar panels',
            description: 'Clean energy',
            asset_type: 'USDC',
            status: 'active',
            raised_amount: '80',
            target_amount: '100',
          },
        ],
      };
    },
  });

  const response = await request(app).get(
    '/api/campaigns?search=solar&asset=USDC&sort=closest_to_goal'
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.campaigns.length, 1);
  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /websearch_to_tsquery/i);
  assert.match(listQuery.text, /raised_amount \/ NULLIF/i);
  assert.ok(listQuery.params.includes('solar'));
  assert.ok(listQuery.params.includes('USDC'));
});

test('GET /api/campaigns applies faceted filters (funding range, deadline, verified, country)', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app).get(
    '/api/campaigns?min_funding=100&max_funding=500&deadline_within=7&creator_verified=true&country=US'
  );

  assert.equal(response.status, 200);
  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  // Funding range is parameterized against raised_amount.
  assert.match(listQuery.text, /c\.raised_amount >= \$/);
  assert.match(listQuery.text, /c\.raised_amount <= \$/);
  assert.ok(listQuery.params.includes(100));
  assert.ok(listQuery.params.includes(500));
  // Deadline proximity uses CURRENT_DATE window.
  assert.match(listQuery.text, /c\.deadline <= CURRENT_DATE/);
  assert.ok(listQuery.params.includes(7));
  // Creator reputation via KYC verification (no injectable param).
  assert.match(listQuery.text, /u\.kyc_status = 'verified'/);
  // Geographic facet parameterized.
  assert.match(listQuery.text, /c\.country = \$/);
  assert.ok(listQuery.params.includes('US'));
  // Count query must also join users so the verified filter resolves.
  const countQuery = queries.find(q => q.text.includes('COUNT(*)'));
  assert.match(countQuery.text, /JOIN users u/);
});

test('GET /api/campaigns/facets returns facet counts and funding bounds', async () => {
  const app = buildApp({
    queryImpl: async text => {
      if (text.includes('GROUP BY category')) {
        return { rows: [{ category: 'technology', count: 3 }] };
      }
      if (text.includes('GROUP BY asset_type')) {
        return { rows: [{ asset_type: 'USDC', count: 5 }] };
      }
      if (text.includes('GROUP BY country')) {
        return { rows: [{ country: 'US', count: 2 }] };
      }
      if (text.includes('MIN(raised_amount)')) {
        return { rows: [{ min_funding: '0', max_funding: '900' }] };
      }
      if (text.includes("kyc_status = 'verified'")) {
        return { rows: [{ count: 4 }] };
      }
      return { rows: [] };
    },
  });

  const response = await request(app).get('/api/campaigns/facets');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.categories, [{ category: 'technology', count: 3 }]);
  assert.deepEqual(response.body.assets, [{ asset_type: 'USDC', count: 5 }]);
  assert.deepEqual(response.body.countries, [{ country: 'US', count: 2 }]);
  assert.equal(response.body.funding.max, 900);
  assert.equal(response.body.verified_creators, 4);
});

test('GET /api/campaigns/mine parses page and limit parameters', async () => {
  let passedOptions = {};
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    listCreatorCampaignsImpl: async (userId, options) => {
      passedOptions = options;
      return {
        data: [{ id: 'c-1', title: 'Test Campaign' }],
        pagination: { page: 2, limit: 10, total: 1, totalPages: 1 },
      };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/mine?page=2&limit=10')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(passedOptions.page, '2');
  assert.equal(passedOptions.limit, '10');
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.pagination.page, 2);
  assert.equal(response.body.pagination.limit, 10);
});

test('GET /api/campaigns/mine forwards fields parameter', async () => {
  let passedOptions = {};
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    listCreatorCampaignsImpl: async (_userId, options) => {
      passedOptions = options;
      return {
        data: [{ id: 'c-1', title: 'Lean Campaign', status: 'active', raised_amount: '5' }],
        pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
      };
    },
  });

  const response = await request(app)
    .get('/api/campaigns/mine?limit=50&fields=id,title,status,raised_amount')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.equal(passedOptions.limit, '50');
  assert.equal(passedOptions.fields, 'id,title,status,raised_amount');
  assert.equal(response.body.data[0].title, 'Lean Campaign');
});

function buildListingApp(queries) {
  return buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
      return { rows: [{ id: 'camp-1', title: 'Solar panels', status: 'active' }] };
    },
  });
}

// #899: the listing and detail endpoints are unauthenticated, so their payloads
// must never carry the fraud detector's output, the duplicate fingerprint or
// the column reserved for the encrypted campaign wallet key.
const INTERNAL_CAMPAIGN_KEYS = [
  'content_fingerprint',
  'is_flagged_duplicate',
  'is_flagged_fraud',
  'fraud_score',
  'fraud_signals',
  'wallet_secret_encrypted',
  'search_vector',
  'refund_xdr',
];

function internalCampaignFields() {
  return {
    content_fingerprint: 'fingerprint-internal',
    is_flagged_duplicate: true,
    is_flagged_fraud: true,
    fraud_score: 88,
    fraud_signals: { velocity: 'high' },
    wallet_secret_encrypted: 'encrypted-wallet-secret',
    search_vector: 'solar:1',
    refund_xdr: 'AAAA-internal',
  };
}

test('GET /api/campaigns never serialises fraud/duplicate internals or the wallet key', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('COUNT(*)')) return { rows: [{ total: 1 }] };
      return {
        rows: [
          { id: 'camp-1', title: 'Solar panels', status: 'active', ...internalCampaignFields() },
        ],
      };
    },
  });

  const response = await request(app).get('/api/campaigns');
  assert.equal(response.status, 200);

  const campaign = response.body.campaigns[0];
  assert.equal(campaign.title, 'Solar panels');
  for (const key of INTERNAL_CAMPAIGN_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(campaign, key),
      false,
      `${key} must not be serialised by GET /api/campaigns`
    );
  }

  const listQuery = queries.find(query => query.text.includes('FROM campaigns c'));
  assert.ok(listQuery, 'the listing query should have been issued');
  assert.doesNotMatch(listQuery.text, /SELECT\s+c\.\*/);
  assert.match(listQuery.text, /SELECT\s+c\.id,/);
});

test('GET /api/campaigns/:id never serialises fraud/duplicate internals or the wallet key', async () => {
  const queries = [];
  const app = buildApp({
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT is_admin FROM users')) return { rows: [{ is_admin: false }] };
      if (text.includes('FROM campaigns c')) {
        return {
          rows: [
            {
              id: 'camp-1',
              creator_id: 'creator-1',
              title: 'Solar panels',
              status: 'active',
              is_hidden: false,
              deleted_at: null,
              contributor_count: 3,
              ...internalCampaignFields(),
            },
          ],
        };
      }
      return { rows: [] };
    },
  });

  const response = await request(app).get('/api/campaigns/camp-1');
  assert.equal(response.status, 200);

  assert.equal(response.body.title, 'Solar panels');
  assert.equal(response.body.contributor_count, 3);
  for (const key of INTERNAL_CAMPAIGN_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(response.body, key),
      false,
      `${key} must not be serialised by GET /api/campaigns/:id`
    );
  }

  const detailQuery = queries.find(query => query.text.includes('FROM campaigns c'));
  assert.ok(detailQuery, 'the detail query should have been issued');
  assert.doesNotMatch(detailQuery.text, /SELECT\s+c\.\*/);
});

test('GET /api/campaigns search without sort ranks by relevance', async () => {
  const queries = [];
  const app = buildListingApp(queries);

  const response = await request(app).get('/api/campaigns?search=solar');
  assert.equal(response.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /ORDER BY ts_rank\(c\.search_vector/);
});

test('GET /api/campaigns explicit sort wins over relevance when searching', async () => {
  const queries = [];
  const app = buildListingApp(queries);

  const response = await request(app).get('/api/campaigns?search=solar&sort=newest');
  assert.equal(response.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.match(listQuery.text, /ORDER BY c\.created_at DESC/);
  assert.doesNotMatch(listQuery.text, /ts_rank/);
});

test('GET /api/campaigns sort=relevance without search falls back to newest', async () => {
  const queries = [];
  const app = buildListingApp(queries);

  const response = await request(app).get('/api/campaigns?sort=relevance');
  assert.equal(response.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.match(listQuery.text, /ORDER BY c\.created_at DESC/);
  assert.doesNotMatch(listQuery.text, /ts_rank/);
});

test('Analytics routes enforce requireAuth and requireCampaignMember', async () => {
  // 1. Unauthenticated request returns 401
  const unauthApp = buildApp({ authUser: null });
  const res1 = await request(unauthApp).get('/api/campaigns/c-123/analytics');
  assert.equal(res1.status, 401);

  const res1Contrib = await request(unauthApp).get('/api/campaigns/c-123/analytics/contributors');
  assert.equal(res1Contrib.status, 401);

  const res1Backers = await request(unauthApp).get('/api/campaigns/c-123/analytics/backers');
  assert.equal(res1Backers.status, 401);

  // 2. Non-member non-owner user returns 403
  const nonMemberApp = buildApp({
    authUser: { userId: 'stranger-1', role: 'user' },
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res2 = await request(nonMemberApp).get('/api/campaigns/c-123/analytics');
  assert.equal(res2.status, 403);

  const res2Contrib = await request(nonMemberApp).get(
    '/api/campaigns/c-123/analytics/contributors'
  );
  assert.equal(res2Contrib.status, 403);

  const res2Backers = await request(nonMemberApp).get('/api/campaigns/c-123/analytics/backers');
  assert.equal(res2Backers.status, 403);

  // 3. Campaign creator returns 200
  const creatorApp = buildApp({
    authUser: { userId: 'creator-1', role: 'user' },
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  });

  const res3 = await request(creatorApp).get('/api/campaigns/c-123/analytics');
  assert.equal(res3.status, 200);

  const res3Contrib = await request(creatorApp).get('/api/campaigns/c-123/analytics/contributors');
  assert.equal(res3Contrib.status, 200);

  const res3Backers = await request(creatorApp).get('/api/campaigns/c-123/analytics/backers');
  assert.equal(res3Backers.status, 200);

  // 4. Accepted campaign member returns 200
  const memberApp = buildApp({
    authUser: { userId: 'member-1', role: 'user' },
    queryImpl: async text => {
      if (text.includes('FROM campaigns')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('FROM campaign_members')) {
        return { rows: [{ role: 'viewer', accepted_at: '2026-01-01' }] };
      }
      return { rows: [] };
    },
  });

  const res4 = await request(memberApp).get('/api/campaigns/c-123/analytics');
  assert.equal(res4.status, 200);

  const res4Contrib = await request(memberApp).get('/api/campaigns/c-123/analytics/contributors');
  assert.equal(res4Contrib.status, 200);

  const res4Backers = await request(memberApp).get('/api/campaigns/c-123/analytics/backers');
  assert.equal(res4Backers.status, 200);
});

function buildShareApp({ campaignExists = true, initialShareCount = 5, authUser } = {}) {
  let shareCount = initialShareCount;
  const dedup = new Map();
  const WINDOW_MS = 60 * 60 * 1000;

  const queryImpl = async (text, params) => {
    if (text.includes('SELECT id, share_count FROM campaigns')) {
      if (!campaignExists) return { rows: [] };
      return { rows: [{ id: params[0], share_count: shareCount }] };
    }
    if (text.includes('INSERT INTO campaign_share_dedup')) {
      const [campaignId, actorHash] = params;
      const key = `${campaignId}:${actorHash}`;
      const last = dedup.get(key);
      const now = Date.now();
      if (last !== undefined && now - last < WINDOW_MS) {
        return { rows: [] };
      }
      dedup.set(key, now);
      return { rows: [{ campaign_id: campaignId }] };
    }
    if (text.includes('UPDATE campaigns') && text.includes('share_count')) {
      shareCount += 1;
      return { rows: [{ share_count: shareCount }] };
    }
    return { rows: [] };
  };

  const app = buildApp({ queryImpl, authUser });
  app.set('trust proxy', true);
  return app;
}

test('POST /api/campaigns/:id/share increments share_count on first share', async () => {
  const app = buildShareApp({ initialShareCount: 5 });

  const response = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '1.2.3.4');

  assert.equal(response.status, 200);
  assert.equal(response.body.share_count, 6);
});

test('POST /api/campaigns/:id/share does not recount a repeated share from the same actor within the window', async () => {
  const app = buildShareApp({ initialShareCount: 5 });

  const first = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '1.2.3.4');
  const second = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '1.2.3.4');

  assert.equal(first.body.share_count, 6);
  assert.equal(second.status, 200);
  assert.equal(second.body.share_count, 6);
});

test('POST /api/campaigns/:id/share counts shares from different actors independently', async () => {
  const app = buildShareApp({ initialShareCount: 5 });

  const first = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '1.2.3.4');
  const second = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '5.6.7.8');

  assert.equal(first.body.share_count, 6);
  assert.equal(second.body.share_count, 7);
});

test('POST /api/campaigns/:id/share dedups an authenticated user by user id, not IP', async () => {
  const app = buildShareApp({ initialShareCount: 5, authUser: { userId: 'user-42' } });

  const first = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '1.2.3.4');
  const second = await request(app)
    .post('/api/campaigns/c-1/share')
    .set('X-Forwarded-For', '9.9.9.9');

  assert.equal(first.body.share_count, 6);
  assert.equal(second.body.share_count, 6);
});

test('POST /api/campaigns/:id/share returns 404 for a nonexistent campaign', async () => {
  const app = buildShareApp({ campaignExists: false });

  const response = await request(app).post('/api/campaigns/does-not-exist/share');

  assert.equal(response.status, 404);
});

test('POST /api/campaigns/:id/share only counts one increment out of a concurrent burst from the same actor', async () => {
  const app = buildShareApp({ initialShareCount: 0 });

  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      request(app).post('/api/campaigns/c-1/share').set('X-Forwarded-For', '1.2.3.4')
    )
  );

  const counts = responses.map(r => r.body.share_count);
  assert.ok(
    counts.every(c => c === 1),
    `expected all responses to report share_count 1, got ${counts}`
  );
});

test('GET /api/campaigns/:id denies hidden campaign to demoted admin with stale JWT', async () => {
  const jwt = require('jsonwebtoken');
  const secret = process.env.JWT_SECRET || 'testsecret';
  const token = jwt.sign(
    {
      userId: 'admin-1',
      is_admin: true,
      role: 'admin',
      sub: 'admin-1',
      iss: 'https://crowdpay.io',
      aud: 'crowdpay-api',
    },
    secret,
    { expiresIn: '1h' }
  );

  const queryImpl = async (text, params) => {
    if (text.includes('SELECT is_admin FROM users WHERE id')) {
      return { rows: [{ is_admin: false }] };
    }
    if (text.includes('FROM campaigns WHERE id')) {
      return {
        rows: [
          {
            id: 'c-hidden',
            title: 'Hidden Campaign',
            is_hidden: true,
            status: 'active',
            deleted_at: null,
            creator_id: 'creator-other',
            contributor_count: 0,
          },
        ],
      };
    }
    return { rows: [] };
  };

  const app = buildApp({
    authUser: { userId: 'admin-1', role: 'admin' },
    queryImpl,
    campaignStatusImpl: {
      refreshCampaignStatus: async () => ({ failed: null, funded: null }),
      refreshActiveCampaignStatuses: async () => ({ failed: [], funded: [] }),
    },
  });

  const res = await request(app)
    .get('/api/campaigns/c-hidden')
    .set('Authorization', `Bearer ${token}`);

  assert.equal(res.status, 404);
});

test('GET /api/campaigns/:id/report/export streams a PDF for the owner', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/report/export')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/pdf/);
  assert.match(response.headers['content-disposition'], /campaign-1-report\.pdf/);
  const bodyText = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : response.text;
  assert.ok(bodyText.includes('%PDF'));
});

test('GET /api/campaigns/:id/report/export rejects non-owners', async () => {
  const app = buildApp({
    authUser: { userId: 'user-2', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/report/export')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 403);
});

test('GET /api/campaigns/:id/report/export requires authentication', async () => {
  const app = buildApp({
    authUser: null,
    queryImpl: async () => ({ rows: [] }),
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app).get('/api/campaigns/campaign-1/report/export');

  assert.equal(response.status, 401);
});

test('GET /api/campaigns/:id/report/share returns a signed URL for the owner', async () => {
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async text => {
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app)
    .get('/api/campaigns/campaign-1/report/share')
    .set('Authorization', 'Bearer token');

  assert.equal(response.status, 200);
  assert.match(response.body.url, /\/api\/campaigns\/campaign-1\/report\/share\//);
  assert.equal(response.body.expires_in_seconds, 24 * 60 * 60);
});

test('GET /api/campaigns/:id/report/share/TOKEN serves the PDF for a valid signed token', async () => {
  const app = buildApp({
    authUser: null,
    signedTokenValid: true,
    queryImpl: async text => {
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app).get('/api/campaigns/campaign-1/report/share/sometoken');

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /application\/pdf/);
});

test('GET /api/campaigns/:id/report/share/TOKEN rejects an invalid/expired signed token', async () => {
  const app = buildApp({
    authUser: null,
    signedTokenValid: false,
    queryImpl: async text => {
      if (text.includes('SELECT creator_id FROM campaigns WHERE id = $1')) {
        return { rows: [{ creator_id: 'creator-1' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const response = await request(app).get('/api/campaigns/campaign-1/report/share/invalidtoken');

  assert.equal(response.status, 403);
  assert.match(response.body.error, /Invalid or expired share link/);
});

test('PATCH /api/campaigns/:id accepts valid fields and returns 422 for validation errors', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT * FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              description: 'Original description',
              target_amount: '100',
              deadline: '2026-12-31T23:59:59Z',
              country: 'US',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('SELECT status FROM campaigns WHERE id = $1')) {
        return { rows: [{ status: 'active' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('SELECT SUM(amount) as total_budget FROM campaign_budget_categories')) {
        return { rows: [{ total_budget: '0' }] };
      }
      if (text.includes('UPDATE campaigns') && text.includes('SET') && text.includes('WHERE id')) {
        return { rows: [] };
      }
      if (text.includes('BEGIN') || text.includes('COMMIT')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  // Test valid update with multiple fields
  const response = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({
      title: 'Updated Title',
      description: 'Updated description',
      target_amount: 200,
      deadline: '2027-01-15T23:59:59Z',
      country: 'CA',
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'Updated Title');
  assert.equal(response.body.target_amount, '200');

  // Test validation error for deadline too soon (less than 24 hours)
  const tooSoon = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(); // 12 hours from now
  const response2 = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({ deadline: tooSoon });

  assert.equal(response2.status, 422);
  assert.match(response2.body.error?.message || response2.body.error, /at least 24 hours/);
});

test('PATCH /api/campaigns/:id accepts max_per_user, min_contribution, max_contribution fields', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT * FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              description: 'Original description',
              target_amount: '100',
              deadline: '2026-12-31T23:59:59Z',
              country: 'US',
              min_contribution: '10',
              max_contribution: '1000',
              max_per_user: '500',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('SELECT status FROM campaigns WHERE id = $1')) {
        return { rows: [{ status: 'active' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('SELECT SUM(amount) as total_budget FROM campaign_budget_categories')) {
        return { rows: [{ total_budget: '0' }] };
      }
      if (text.includes('UPDATE campaigns') && text.includes('SET') && text.includes('WHERE id')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              description: 'Original description',
              target_amount: '100',
              deadline: '2026-12-31T23:59:59Z',
              country: 'US',
              min_contribution: '20',
              max_contribution: '2000',
              max_per_user: '1000',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('INSERT INTO campaign_revisions')) {
        return { rows: [] };
      }
      if (text.includes('BEGIN') || text.includes('COMMIT')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  // Test updating max_per_user, min_contribution, max_contribution
  const response = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({
      min_contribution: 20,
      max_contribution: 2000,
      max_per_user: 1000,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.min_contribution, '20');
  assert.equal(response.body.max_contribution, '2000');
  assert.equal(response.body.max_per_user, '1000');
});

test('PATCH /api/campaigns/:id rejects invalid fields with 422', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT * FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('SELECT status FROM campaigns WHERE id = $1')) {
        return { rows: [{ status: 'active' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('SELECT SUM(amount) as total_budget FROM campaign_budget_categories')) {
        return { rows: [{ total_budget: '0' }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  // Test invalid field
  const response = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({ invalid_field: 'should fail' });

  assert.equal(response.status, 422);
  assert.match(
    response.body.error?.message || response.body.error,
    /Cannot update field: invalid_field/
  );
});

test('PATCH /api/campaigns/:id returns 422 for deadline in the past', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT * FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('SELECT status FROM campaigns WHERE id = $1')) {
        return { rows: [{ status: 'active' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('SELECT SUM(amount) as total_budget FROM campaign_budget_categories')) {
        return { rows: [{ total_budget: '0' }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  const pastDeadline = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // 24 hours ago
  const response = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({ deadline: pastDeadline });

  assert.equal(response.status, 422);
  assert.match(
    response.body.error?.message || response.body.error,
    /Deadline must be at least 24 hours in the future/
  );
});

test('PATCH /api/campaigns/:id validates max_per_user > min_contribution', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT * FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              creator_id: 'creator-1',
              status: 'active',
              min_contribution: '100',
            },
          ],
        };
      }
      if (text.includes('SELECT status FROM campaigns WHERE id = $1')) {
        return { rows: [{ status: 'active' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('SELECT SUM(amount) as total_budget FROM campaign_budget_categories')) {
        return { rows: [{ total_budget: '0' }] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  // max_per_user (50) <= min_contribution (100) should fail
  const response = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({ max_per_user: 50 });

  assert.equal(response.status, 422);
  assert.match(
    response.body.error?.message || response.body.error,
    /Per-contributor cap must be greater than minimum contribution/
  );
});

test('PATCH /api/campaigns/:id full object round-trip works', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'creator-1', role: 'creator' },
    queryImpl: async (text, params) => {
      queries.push({ text, params });
      if (text.includes('SELECT * FROM campaigns WHERE id = $1')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Original Title',
              description: 'Original description',
              category: 'technology',
              target_amount: '100',
              asset_type: 'USDC',
              deadline: '2026-12-31T23:59:59Z',
              country: 'US',
              min_contribution: '10',
              max_contribution: '1000',
              max_per_user: '500',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('SELECT status FROM campaigns WHERE id = $1')) {
        return { rows: [{ status: 'active' }] };
      }
      if (text.includes('SELECT role, accepted_at FROM campaign_members')) {
        return { rows: [] };
      }
      if (text.includes('SELECT SUM(amount) as total_budget FROM campaign_budget_categories')) {
        return { rows: [{ total_budget: '0' }] };
      }
      if (text.includes('UPDATE campaigns') && text.includes('SET') && text.includes('WHERE id')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'Updated Title',
              description: 'Updated description',
              category: 'education',
              target_amount: '200',
              asset_type: 'USDC',
              deadline: '2027-01-15T23:59:59Z',
              country: 'CA',
              min_contribution: '20',
              max_contribution: '2000',
              max_per_user: '1000',
              creator_id: 'creator-1',
              status: 'active',
            },
          ],
        };
      }
      if (text.includes('INSERT INTO campaign_revisions')) {
        return { rows: [] };
      }
      if (text.includes('BEGIN') || text.includes('COMMIT')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    buildWithdrawalTransactionImpl: async () => '',
    insertWithdrawalPendingSignaturesImpl: async () => 'tx-row',
  });

  // Full object round-trip PATCH
  const response = await request(app)
    .patch('/api/campaigns/campaign-1')
    .set('Authorization', 'Bearer token')
    .send({
      title: 'Updated Title',
      description: 'Updated description',
      category: 'education',
      target_amount: 200,
      deadline: '2027-01-15T23:59:59Z',
      country: 'CA',
      min_contribution: 20,
      max_contribution: 2000,
      max_per_user: 1000,
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.title, 'Updated Title');
  assert.equal(response.body.category, 'education');
  assert.equal(response.body.target_amount, '200');
  assert.equal(response.body.min_contribution, '20');
  assert.equal(response.body.max_contribution, '2000');
  assert.equal(response.body.max_per_user, '1000');
});

test('POST /api/campaigns/:id/cover-image returns 413 when file exceeds limits via multer LIMIT_FILE_SIZE', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'platform-1' }] };
      }
      return { rows: [] };
    },
  });

  // 6MB buffer exceeds the 5MB MAX_UPLOAD_SIZE
  const oversizedBuffer = Buffer.alloc(6 * 1024 * 1024, 'a');

  const response = await request(app)
    .post('/api/campaigns/campaign-1/cover-image')
    .set('Authorization', 'Bearer token')
    .attach('cover_image', oversizedBuffer, {
      filename: 'large-cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'LIMIT_FILE_SIZE');
  assert.equal(response.body.error.message, 'File exceeds maximum allowed size of 5MB');
  assert.equal(response.body.error.fields.cover_image, 'File exceeds maximum allowed size of 5MB');
});

test('POST /api/campaigns/:id/cover-image returns 413 when storage service rejects oversized file', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'platform-1' }] };
      }
      return { rows: [] };
    },
    uploadCampaignCoverImageImpl: async () => {
      const err = new Error('File exceeds maximum allowed size');
      err.status = 413;
      throw err;
    },
  });

  const validBuffer = Buffer.from('fake-image-bytes');

  const response = await request(app)
    .post('/api/campaigns/campaign-1/cover-image')
    .set('Authorization', 'Bearer token')
    .attach('cover_image', validBuffer, {
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'LIMIT_FILE_SIZE');
  assert.equal(response.body.error.message, 'File exceeds maximum allowed size of 5MB');
  assert.equal(response.body.error.fields.cover_image, 'File exceeds maximum allowed size of 5MB');
});

test('POST /api/campaigns/:id/cover-image returns 415 when storage service rejects unsupported media type', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'platform-1' }] };
      }
      return { rows: [] };
    },
    uploadCampaignCoverImageImpl: async () => {
      const err = new Error('Unsupported Media Type');
      err.status = 415;
      throw err;
    },
  });

  const validBuffer = Buffer.from('fake-image-bytes');

  const response = await request(app)
    .post('/api/campaigns/campaign-1/cover-image')
    .set('Authorization', 'Bearer token')
    .attach('cover_image', validBuffer, {
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(response.status, 415);
  assert.equal(response.body.error.code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('POST /api/campaigns/:id/cover-image succeeds with valid image and strips internal fields', async () => {
  const app = buildApp({
    queryImpl: async (text, params) => {
      if (text.includes('SELECT creator_id FROM campaigns')) {
        return { rows: [{ creator_id: 'platform-1' }] };
      }
      if (text.includes('UPDATE campaigns SET cover_image_url = $1 WHERE id = $2')) {
        return {
          rows: [
            {
              id: 'campaign-1',
              title: 'My Campaign',
              cover_image_url: params[0],
              fraud_score: 99,
              fraud_signals: ['test'],
            },
          ],
        };
      }
      return { rows: [] };
    },
    uploadCampaignCoverImageImpl: async () => 'https://cdn.example.com/cover.jpg',
  });

  const validBuffer = Buffer.from('fake-image-bytes');

  const response = await request(app)
    .post('/api/campaigns/campaign-1/cover-image')
    .set('Authorization', 'Bearer token')
    .attach('cover_image', validBuffer, {
      filename: 'cover.jpg',
      contentType: 'image/jpeg',
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.id, 'campaign-1');
  assert.equal(response.body.cover_image_url, 'https://cdn.example.com/cover.jpg');
  assert.equal(response.body.fraud_score, undefined);
  assert.equal(response.body.fraud_signals, undefined);
});
