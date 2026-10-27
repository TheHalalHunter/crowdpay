const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const db = require('../config/database');
const { requireAuth } = require('../middleware/auth');
const { refreshCampaignStatus } = require('../services/campaignStatusService');
const { recordContributionFromTxHash } = require('../services/v1ContributionService');
const { getCampaignsValidation, validateRequest } = require('../middleware/validation');
const { parsePagination } = require('../utils/pagination');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();

router.use((req, res, next) => {
  const deprecationDate = Date.parse(process.env.PUBLIC_API_DEPRECATION_DATE || '');
  const sunsetDate = Date.parse(process.env.PUBLIC_API_SUNSET_DATE || '');
  if (
    Number.isFinite(deprecationDate) &&
    Number.isFinite(sunsetDate) &&
    sunsetDate > deprecationDate
  ) {
    res.set('Deprecation', `@${Math.floor(deprecationDate / 1000)}`);
    res.set('Sunset', new Date(sunsetDate).toUTCString());
    res.set('Link', `<${req.baseUrl}/changelog>; rel="deprecation"`);
  }
  next();
});

const isTest = process.env.NODE_ENV === 'test';
const apiKeyRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTest ? 100000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.auth?.apiKeyId || ipKeyGenerator(req.ip),
  skip: req => req.auth?.kind !== 'api_key' || isTest,
  message: { error: 'API key rate limit exceeded (100 requests per minute)' },
});

router.use(apiKeyRateLimiter);

router.get('/changelog', (_req, res) => {
  res.json({
    api_version: 'v1',
    entries: [
      {
        date: '2026-09-29',
        changes: ['Added the public API changelog and configurable lifecycle headers.'],
      },
    ],
  });
});

async function assertCampaignCreator(req, campaignId) {
  const { rows } = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [campaignId]);
  if (!rows.length) {
    const err = new Error('Campaign not found');
    err.statusCode = 404;
    throw err;
  }
  if (rows[0].creator_id !== req.user.userId) {
    const err = new Error('Only the campaign creator can access this resource');
    err.statusCode = 403;
    throw err;
  }
}

/**
 * @openapi
 * tags:
 *   - name: Public API v1
 *     description: Versioned public API for third-party integrations
 */

/**
 * @openapi
 * /campaigns:
 *   get:
 *     tags: [Public API v1]
 *     summary: List public campaigns
 *     parameters:
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Paginated campaign list
 */
router.get(
  '/campaigns',
  getCampaignsValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { search, status, asset, sort = 'newest' } = req.query;
    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });
    const filters = ['c.deleted_at IS NULL'];
    const params = [];

    if (status) {
      params.push(status);
      filters.push(`c.status = $${params.length}`);
    } else {
      filters.push(`c.status = 'active'`);
    }
    if (asset) {
      params.push(asset);
      filters.push(`c.asset_type = $${params.length}`);
    }
    let searchParamIdx = null;
    if (search) {
      params.push(search);
      searchParamIdx = params.length;
      filters.push(`c.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
    }

    const whereClause = `WHERE ${filters.join(' AND ')}`;
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM campaigns c ${whereClause}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const sortExpressions = {
      newest: 'c.created_at DESC',
      ending_soon: 'c.deadline ASC NULLS LAST',
      most_funded: 'c.raised_amount DESC',
      most_backed: 'COALESCE(con.total_contributions, 0) DESC',
    };
    if (searchParamIdx !== null) {
      sortExpressions.relevance = `ts_rank(c.search_vector, websearch_to_tsquery('english', $${searchParamIdx})) DESC, c.created_at DESC`;
    }
    // A search without an explicit sort ranks by relevance; explicit sorts always win.
    const effectiveSort =
      searchParamIdx !== null && req.query.sort === undefined ? 'relevance' : sort;
    const orderBy = sortExpressions[effectiveSort] || sortExpressions.newest;

    const { rows } = await db.query(
      `SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
            c.asset_type, c.status, c.deadline, c.created_at,
            COALESCE(con.contributor_count, 0)::int AS contributor_count
     FROM campaigns c
     LEFT JOIN (
       SELECT campaign_id,
              COUNT(DISTINCT sender_public_key)::int AS contributor_count,
              COUNT(*)::int AS total_contributions
       FROM contributions
       GROUP BY campaign_id
     ) con ON con.campaign_id = c.id
     ${whereClause}
     ORDER BY ${orderBy}
     LIMIT $${params.length + 1}
     OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    res.json({ total, limit, offset, campaigns: rows });
  })
);

/**
 * @openapi
 * /campaigns/{id}:
 *   get:
 *     tags: [Public API v1]
 *     summary: Campaign detail with milestones
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Campaign detail
 *       404:
 *         description: Not found
 */
router.get(
  '/campaigns/:id',
  asyncHandler(async (req, res) => {
    await refreshCampaignStatus(req.params.id);
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
            c.asset_type, c.status, c.deadline, c.created_at, c.wallet_public_key,
            COALESCE(con.contributor_count, 0)::int AS contributor_count
     FROM campaigns c
     LEFT JOIN (
       SELECT campaign_id, COUNT(DISTINCT sender_public_key)::int AS contributor_count
       FROM contributions
       WHERE campaign_id = $1
       GROUP BY campaign_id
     ) con ON con.campaign_id = c.id
     WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

    const { rows: milestones } = await db.query(
      `SELECT id, title, description, release_percentage, status, sort_order, created_at
     FROM milestones
     WHERE campaign_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
      [req.params.id]
    );

    res.json({ ...rows[0], milestones });
  })
);

/**
 * @openapi
 * /campaigns/{id}/contributions:
 *   get:
 *     tags: [Public API v1]
 *     summary: List contributions (campaign creator only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Contribution list
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/campaigns/:id/contributions',
  requireAuth,
  asyncHandler(async (req, res) => {
    await assertCampaignCreator(req, req.params.id);
    const { limit, offset } = parsePagination(req.query, { limit: 50, max: 200 });

    const { rows } = await db.query(
      `SELECT id, campaign_id, sender_public_key, amount, asset, payment_type,
            source_amount, source_asset, tx_hash, display_name, created_at
     FROM contributions
     WHERE campaign_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );

    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS total FROM contributions WHERE campaign_id = $1',
      [req.params.id]
    );

    res.json({
      total: countRows[0]?.total || 0,
      limit,
      offset,
      contributions: rows,
    });
  })
);

/**
 * @openapi
 * /campaigns/{id}/contributions:
 *   post:
 *     tags: [Public API v1]
 *     summary: Record a contribution from a Stellar transaction hash
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tx_hash]
 *             properties:
 *               tx_hash: { type: string }
 *     responses:
 *       201:
 *         description: Contribution created
 *       401:
 *         description: Unauthorized
 */
router.post(
  '/campaigns/:id/contributions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { tx_hash: txHash, amount, sender_public_key: senderPublicKey } = req.body || {};
    if (!txHash) return res.status(400).json({ error: 'tx_hash is required' });

    const contribution = await recordContributionFromTxHash({
      campaignId: req.params.id,
      txHash: String(txHash).trim(),
    });

    res.status(201).json({
      contribution,
      message: 'Contribution recorded from Stellar transaction',
      ...(amount || senderPublicKey
        ? {
            note: 'amount and sender_public_key are derived from the on-chain transaction',
          }
        : {}),
    });
  })
);

/**
 * @openapi
 * /users/me:
 *   get:
 *     tags: [Public API v1]
 *     summary: Authenticated user profile and stats
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: User profile
 *       401:
 *         description: Unauthorized
 */
router.get(
  '/users/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.name, u.role, u.wallet_public_key, u.created_at,
            (SELECT COUNT(*)::int FROM campaigns c WHERE c.creator_id = u.id AND c.deleted_at IS NULL) AS campaigns_created,
            (SELECT COUNT(*)::int FROM contributions ctr
             JOIN users u2 ON u2.wallet_public_key = ctr.sender_public_key
             WHERE u2.id = u.id) AS contributions_made
     FROM users u
     WHERE u.id = $1`,
      [req.user.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  })
);

module.exports = router;
