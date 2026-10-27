const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, authUser, authError, recordContributionImpl }) {
  const router = proxyquire('./v1', {
    '../config/database': { query: queryImpl },
    '../services/campaignStatusService': {
      refreshCampaignStatus: async () => ({}),
    },
    '../services/v1ContributionService': {
      recordContributionFromTxHash:
        recordContributionImpl ||
        (async () => ({
          id: 'contrib-1',
          campaign_id: 'camp-1',
          tx_hash: 'abc123',
          amount: 10,
        })),
    },
    '../middleware/auth': {
      requireAuth: (req, res, next) => {
        if (authError) {
          return res.status(401).json({ error: authError });
        }
        req.user = authUser || { userId: 'user-1', role: 'creator' };
        req.auth = { kind: 'jwt' };
        next();
      },
    },
    '../middleware/validation': {
      getCampaignsValidation: [],
      validateRequest: (_req, _res, next) => next(),
    },
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1', router);
  return app;
}

test('GET /api/v1/campaigns is public', async () => {
  const app = buildApp({
    queryImpl: async sql => {
      if (sql.includes('COUNT')) return { rows: [{ total: 1 }] };
      return {
        rows: [
          {
            id: 'camp-1',
            title: 'Test',
            target_amount: '100',
            raised_amount: '0',
            status: 'active',
          },
        ],
      };
    },
    authError: 'Missing token',
  });

  const res = await request(app).get('/api/v1/campaigns');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.campaigns.length, 1);
});

test('GET /api/v1/changelog is public', async () => {
  const app = buildApp({ authError: 'Missing token', queryImpl: async () => ({ rows: [] }) });
  const res = await request(app).get('/api/v1/changelog');

  assert.equal(res.status, 200);
  assert.equal(res.body.api_version, 'v1');
  assert.ok(res.body.entries.length > 0);
});

test('public API deprecation headers require a valid deprecation and sunset date', async () => {
  const previousDeprecation = process.env.PUBLIC_API_DEPRECATION_DATE;
  const previousSunset = process.env.PUBLIC_API_SUNSET_DATE;
  process.env.PUBLIC_API_DEPRECATION_DATE = '2027-01-01T00:00:00.000Z';
  process.env.PUBLIC_API_SUNSET_DATE = '2027-07-01T00:00:00.000Z';

  try {
    const app = buildApp({ authError: 'Missing token', queryImpl: async () => ({ rows: [] }) });
    const res = await request(app).get('/api/v1/changelog');

    assert.equal(res.headers.deprecation, '@1798761600');
    assert.equal(res.headers.sunset, 'Thu, 01 Jul 2027 00:00:00 GMT');
    assert.match(res.headers.link, /\/api\/v1\/changelog>; rel="deprecation"/);
  } finally {
    if (previousDeprecation === undefined) delete process.env.PUBLIC_API_DEPRECATION_DATE;
    else process.env.PUBLIC_API_DEPRECATION_DATE = previousDeprecation;
    if (previousSunset === undefined) delete process.env.PUBLIC_API_SUNSET_DATE;
    else process.env.PUBLIC_API_SUNSET_DATE = previousSunset;
  }
});

test('GET /api/v1/users/me returns 401 without auth', async () => {
  const app = buildApp({ authError: 'Missing token', queryImpl: async () => ({ rows: [] }) });
  const res = await request(app).get('/api/v1/users/me');
  assert.equal(res.status, 401);
});

test('GET /api/v1/users/me returns profile when authenticated', async () => {
  const app = buildApp({
    authUser: { userId: 'user-1' },
    queryImpl: async () => ({
      rows: [
        {
          id: 'user-1',
          email: 'dev@example.com',
          name: 'Dev',
          role: 'creator',
          campaigns_created: 2,
          contributions_made: 5,
        },
      ],
    }),
  });

  const res = await request(app)
    .get('/api/v1/users/me')
    .set('Authorization', 'Bearer cp_live_test');
  assert.equal(res.status, 200);
  assert.equal(res.body.email, 'dev@example.com');
});

test('POST /api/v1/campaigns/:id/contributions records contribution from tx hash', async () => {
  let recorded;
  const app = buildApp({
    authUser: { userId: 'user-1' },
    queryImpl: async () => ({ rows: [] }),
    recordContributionImpl: async args => {
      recorded = args;
      return { id: 'c-1', tx_hash: args.txHash, amount: 25 };
    },
  });

  const res = await request(app)
    .post('/api/v1/campaigns/camp-1/contributions')
    .set('Authorization', 'Bearer cp_live_test')
    .send({ tx_hash: 'stellar-tx-hash' });

  assert.equal(res.status, 201);
  assert.equal(recorded.campaignId, 'camp-1');
  assert.equal(recorded.txHash, 'stellar-tx-hash');
});

function buildSearchApp(queries) {
  return buildApp({
    queryImpl: async (sql, params) => {
      queries.push({ text: sql, params });
      if (sql.includes('COUNT')) return { rows: [{ total: 1 }] };
      return { rows: [{ id: 'camp-1', title: 'Solar panels', status: 'active' }] };
    },
    authError: 'Missing token',
  });
}

test('GET /api/v1/campaigns search uses full-text search, not ILIKE', async () => {
  const queries = [];
  const app = buildSearchApp(queries);

  const res = await request(app).get('/api/v1/campaigns?search=solar%20panels');
  assert.equal(res.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.ok(listQuery);
  assert.match(listQuery.text, /websearch_to_tsquery/);
  assert.doesNotMatch(listQuery.text, /ILIKE/);
  // The raw search term is bound, not a %-wrapped pattern
  assert.ok(listQuery.params.includes('solar panels'));
  // Count query filters identically
  const countQuery = queries.find(q => q.text.includes('COUNT'));
  assert.match(countQuery.text, /websearch_to_tsquery/);
});

test('GET /api/v1/campaigns search without sort ranks by relevance', async () => {
  const queries = [];
  const app = buildSearchApp(queries);

  const res = await request(app).get('/api/v1/campaigns?search=solar');
  assert.equal(res.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.match(listQuery.text, /ORDER BY ts_rank\(c\.search_vector/);
});

test('GET /api/v1/campaigns explicit sort wins over relevance', async () => {
  const queries = [];
  const app = buildSearchApp(queries);

  const res = await request(app).get('/api/v1/campaigns?search=solar&sort=newest');
  assert.equal(res.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.match(listQuery.text, /ORDER BY c\.created_at DESC/);
  assert.doesNotMatch(listQuery.text, /ts_rank/);
});

test('GET /api/v1/campaigns sort=relevance without search falls back to newest', async () => {
  const queries = [];
  const app = buildSearchApp(queries);

  const res = await request(app).get('/api/v1/campaigns?sort=relevance');
  assert.equal(res.status, 200);

  const listQuery = queries.find(q => q.text.includes('ORDER BY'));
  assert.match(listQuery.text, /ORDER BY c\.created_at DESC/);
  assert.doesNotMatch(listQuery.text, /ts_rank/);
});

test('GET /api/v1/campaigns validates and clamps pagination query parameters', async () => {
  const queries = [];
  const app = buildSearchApp(queries);

  // Missing -> default 20 and 0
  const defaultRes = await request(app).get('/api/v1/campaigns');
  assert.equal(defaultRes.status, 200);
  assert.equal(defaultRes.body.limit, 20);
  assert.equal(defaultRes.body.offset, 0);

  // Non-numeric -> default 20 and 0
  const nanRes = await request(app).get('/api/v1/campaigns?limit=abc&offset=xyz');
  assert.equal(nanRes.status, 200);
  assert.equal(nanRes.body.limit, 20);
  assert.equal(nanRes.body.offset, 0);

  // Negative -> clamped to 1 and 0
  queries.length = 0;
  const negRes = await request(app).get('/api/v1/campaigns?limit=-5&offset=-10');
  assert.equal(negRes.status, 200);
  assert.equal(negRes.body.limit, 1);
  assert.equal(negRes.body.offset, 0);
  const negQuery = queries.find(q => q.text.includes('LIMIT'));
  assert.equal(negQuery.params[negQuery.params.length - 2], 1);
  assert.equal(negQuery.params[negQuery.params.length - 1], 0);

  // Decimals -> truncated to integers
  const decRes = await request(app).get('/api/v1/campaigns?limit=12.9&offset=3.5');
  assert.equal(decRes.status, 200);
  assert.equal(decRes.body.limit, 12);
  assert.equal(decRes.body.offset, 3);

  // Excessively large -> capped to 100
  const largeRes = await request(app).get('/api/v1/campaigns?limit=9999&offset=100');
  assert.equal(largeRes.status, 200);
  assert.equal(largeRes.body.limit, 100);
  assert.equal(largeRes.body.offset, 100);
});

test('GET /api/v1/campaigns/:id/contributions validates and clamps pagination parameters', async () => {
  const queries = [];
  const app = buildApp({
    authUser: { userId: 'user-1', role: 'creator' },
    queryImpl: async (sql, params) => {
      queries.push({ text: sql, params });
      if (sql.includes('SELECT creator_id')) {
        return { rows: [{ creator_id: 'user-1' }] };
      }
      if (sql.includes('COUNT')) {
        return { rows: [{ total: 0 }] };
      }
      return { rows: [] };
    },
  });

  // Negative limit and offset -> clamped to 1 and 0
  const negRes = await request(app)
    .get('/api/v1/campaigns/camp-1/contributions?limit=-5&offset=-20')
    .set('Authorization', 'Bearer token');
  assert.equal(negRes.status, 200);
  assert.equal(negRes.body.limit, 1);
  assert.equal(negRes.body.offset, 0);
  const dataQuery = queries.find(q => q.text.includes('LIMIT $2 OFFSET $3'));
  assert.ok(dataQuery);
  assert.equal(dataQuery.params[1], 1);
  assert.equal(dataQuery.params[2], 0);

  // Over max 200 -> capped to 200
  queries.length = 0;
  const maxRes = await request(app)
    .get('/api/v1/campaigns/camp-1/contributions?limit=500&offset=10')
    .set('Authorization', 'Bearer token');
  assert.equal(maxRes.status, 200);
  assert.equal(maxRes.body.limit, 200);
  assert.equal(maxRes.body.offset, 10);
});
