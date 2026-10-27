const router = require('express').Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { impactStatsLimiter } = require('../middleware/rateLimiter');
const Sentry = require('@sentry/node');
const db = require('../config/database');
const logger = require('../config/logger');
const {
  MILESTONE_LIMIT,
  MAX_UPLOAD_SIZE,
  ALLOWED_UPLOAD_MIME_TYPES,
} = require('../config/constants');
const { requireAuth, requireRole, optionalAuth } = require('../middleware/auth');
const {
  createCampaignWallet,
  getCampaignBalance,
  getSupportedAssetCodes,
  revokeAndCloseCampaignWallet,
} = require('../services/stellarService');
const { sendAlert } = require('../services/alerting');
const cache = require('../utils/cache');
const withTransaction = require('../utils/withTransaction');
const { resolveCampaignLanguage } = require('../utils/campaignLocale');
const { Keypair } = require('@stellar/stellar-sdk');
const { encryptSecret } = require('../services/walletService');
const {
  PUBLIC_CAMPAIGN_SELECT,
  publicCampaignColumnList,
  stripInternalCampaignFields,
} = require('../lib/publicCampaignColumns');
const {
  watchCampaignWallet,
  addSSEClient,
  removeSSEClient,
  cleanupStreamForWallet,
} = require('../services/ledgerMonitor');
const { emitWebhookEventForUser, WEBHOOK_EVENTS } = require('../services/webhookDispatcher');
const draftVersionService = require('../services/campaignDraftVersionService');
const {
  refreshCampaignStatus,
  refreshActiveCampaignStatuses,
} = require('../services/campaignStatusService');
const { queueFailedCampaignRefunds } = require('../services/campaignStatusActions');
const {
  invokeContract,
  encodeMilestone,
  nativeToScVal,
  deployCampaignContracts,
  getContractStatus,
} = require('../services/sorobanService');
const { sendEmail, sendTeamMemberInvitedEmail } = require('../services/emailService');
const { uploadCampaignCoverImage } = require('../services/storage');
const {
  isKycRequiredForCampaigns,
  getTierLimit,
  VERIFICATION_TIER_LIMITS,
} = require('../services/kycProvider');
const { listCreatorCampaigns } = require('../services/userDashboardService');
const { getTrendingCampaigns } = require('../services/trendingService');
const { getRecommendedCampaigns } = require('../services/campaignRecommendationService');
const {
  publishDraftCampaign,
  CampaignNotPublishableError,
} = require('../services/campaignPublishing');
const {
  MAX_TIERS_PER_CAMPAIGN,
  validateTiersInput,
  insertTiers,
  listTiersWithAvailability,
} = require('../services/rewardTierService');
const { streamCampaignContributionExport } = require('../services/contributionExportService');
const {
  createCampaignValidation,
  createCampaignUpdateValidation,
  updateCampaignValidation,
  getCampaignsValidation,
  validateRequest,
  createValidateRequest,
} = require('../middleware/validation');
const { TtlCache } = require('../utils/TtlCache');

// Shared cache for the static-ish discovery endpoints
const campaignsCache = new TtlCache(60_000);
const asyncHandler = require('../utils/asyncHandler');
const {
  createCampaignInvite,
  resendCampaignInvite,
  cancelCampaignInvite,
  acceptCampaignInvite,
  countAcceptedOwners,
  resolveUserCampaignRole,
} = require('../services/campaignInviteService');
const {
  isValidRole,
  canEditCampaignContent,
  canViewAnalytics,
  canInviteMembers,
  canManageMembers,
  canChangeRoles,
  canAssignRole,
} = require('../lib/campaignPermissions');
const {
  createReferralProgram,
  createReferralLink,
  getReferralProgram,
  listCampaignReferrers,
} = require('../services/referral');
const { stripHtml } = require('../lib/sanitize');
const { getSimhash, simhashSimilarity } = require('../utils/simhash');
const { toStroops } = require('../utils/stroops');
const { parsePagination } = require('../utils/pagination');
const {
  assembleReport,
  generateSignedUrl,
  verifySignedToken,
} = require('../services/campaignReportService');
const { streamCampaignReportPdf, reportFilename } = require('../services/campaignReportPdf');
const { generateCampaignOgImage } = require('../services/ogImageService');

const crypto = require('crypto');

const IMPACT_CACHE_TTL_MS = 60_000;

async function computeCampaignImpact(campaignId) {
  const { rows } = await db.query(
    `SELECT
       camp.asset_type AS currency,
       COALESCE(SUM(c.amount), 0)::numeric AS total_raised,
       COUNT(c.id)::int AS contribution_count,
       COALESCE(AVG(c.amount), 0)::numeric AS average_contribution,
       COALESCE(MAX(c.amount), 0)::numeric AS largest_contribution,
       COUNT(DISTINCT c.sender_public_key)::int AS unique_contributor_count
     FROM campaigns camp
     LEFT JOIN contributions c ON c.campaign_id = camp.id
     WHERE camp.id = $1 AND camp.deleted_at IS NULL AND camp.is_hidden = FALSE
     GROUP BY camp.asset_type`,
    [campaignId]
  );

  if (!rows.length) return null;

  const row = rows[0];
  return {
    total_raised: Number(row.total_raised),
    contribution_count: row.contribution_count,
    average_contribution: Number(row.average_contribution),
    largest_contribution: Number(row.largest_contribution),
    unique_contributor_count: row.unique_contributor_count,
    currency: row.currency,
  };
}

function signImpactStats(stats) {
  const signedPayload = JSON.stringify(stats);
  const keypair = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
  return {
    signed_payload: signedPayload,
    signature: keypair.sign(Buffer.from(signedPayload)).toString('base64'),
    public_key: keypair.publicKey(),
  };
}

async function generateUniqueReferralCode(runner = db) {
  for (let i = 0; i < 10; i++) {
    const code = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const { rows } = await runner.query(
      'SELECT 1 FROM campaign_referrals WHERE referral_code = $1',
      [code]
    );
    if (!rows.length) return code;
  }
  throw new Error('Could not generate unique referral code');
}

/**
 * @openapi
 * tags:
 *   - name: Campaigns
 *     description: Campaign discovery and management
 */

const requireCampaignMember = (...allowedRoles) => {
  return asyncHandler(async (req, res, next) => {
    const campaignId = req.params.id || req.params.campaign_id || req.body.campaign_id;
    if (!campaignId) return res.status(400).json({ error: 'Campaign ID is required' });

    if (!req.user || !req.user.userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { rows: campaignRows } = await db.query(
      'SELECT creator_id FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRows[0];

    if (req.user.role === 'admin') {
      req.campaignRole = 'owner';
      return next();
    }

    const { rows: memberRows } = await db.query(
      'SELECT role, accepted_at FROM campaign_members WHERE campaign_id = $1 AND user_id = $2',
      [campaignId, req.user.userId]
    );

    let role = null;
    if (memberRows.length && memberRows[0].accepted_at) {
      role = memberRows[0].role;
    } else if (campaign.creator_id === req.user.userId) {
      role = 'owner';
    }

    if (!role || (allowedRoles.length && !allowedRoles.includes(role))) {
      return res.status(403).json({ error: 'Insufficient permissions for this campaign' });
    }

    req.campaignRole = role;
    next();
  });
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_UPLOAD_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error('Invalid image type. Only JPG, PNG and WEBP are allowed.'));
    }
    cb(null, true);
  },
});

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const MILESTONE_PERCENT_SCALE = 10000;

function normalizeMilestonesInput(input) {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error('milestones must be an array');
  }
  if (input.length === 0) return [];
  if (input.length > MILESTONE_LIMIT) {
    throw new Error(`Campaigns can define at most ${MILESTONE_LIMIT} milestones`);
  }

  const normalized = input.map((milestone, index) => {
    const title = stripHtml(milestone?.title || '');
    const description = stripHtml(milestone?.description || '');
    if (!title) {
      throw new Error(`Milestone ${index + 1} title is required`);
    }
    if (!description) {
      throw new Error(`Milestone ${index + 1} description is required`);
    }

    const releasePercentage = Number(milestone?.release_percentage);
    if (!Number.isFinite(releasePercentage) || releasePercentage <= 0) {
      throw new Error(`Milestone ${index + 1} release_percentage must be greater than zero`);
    }

    return {
      title,
      description,
      release_percentage: releasePercentage.toFixed(4),
      release_percentage_units: Math.round(releasePercentage * MILESTONE_PERCENT_SCALE),
      sort_order: index,
    };
  });

  const totalUnits = normalized.reduce(
    (sum, milestone) => sum + milestone.release_percentage_units,
    0
  );
  const expectedUnits = 100 * MILESTONE_PERCENT_SCALE;
  if (totalUnits > expectedUnits) {
    throw new Error('Milestone percentages must not exceed 100%');
  }
  if (totalUnits < expectedUnits) {
    throw new Error('Milestone percentages must sum to at least 100%');
  }

  return normalized;
}

// List campaigns with optional search, filtering, sorting, and pagination

/**
 * GET /api/campaigns/featured
 * Returns up to 6 active campaigns ranked by contribution count.
 * Cached for 60 s with Cache-Control header so CDNs / proxies can also cache.
 */
router.get(
  '/featured',
  asyncHandler(async (req, res) => {
    const rows = await campaignsCache.wrap('featured', async () => {
      const { rows: featured } = await db.query(
        `SELECT
           c.id, c.title, c.description, c.target_amount, c.raised_amount,
           c.asset_type, c.deadline, c.created_at, c.cover_image_url,
           u.name AS creator_name,
           u.verification_status AS creator_verification_status,
           u.verification_tier AS creator_verification_tier,
           (
             SELECT COUNT(DISTINCT sender_public_key)
             FROM contributions
             WHERE campaign_id = c.id
           )::int AS backer_count,
           ROUND(
             (c.raised_amount / NULLIF(c.target_amount, 0)) * 100, 1
           ) AS progress_pct
         FROM campaigns c
         JOIN users u ON u.id = c.creator_id
         WHERE c.status = 'active'
           AND c.deleted_at IS NULL
           AND c.deadline > NOW()
         ORDER BY backer_count DESC, c.raised_amount DESC
         LIMIT 6`
      );
      return featured;
    });

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');
    res.json(rows);
  })
);

/**
 * GET /api/campaigns/categories
 * Returns campaigns grouped by asset_type with counts.
 * This data rarely changes — cached for 5 minutes.
 */
router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const rows = await campaignsCache.wrap(
      'categories',
      async () => {
        const { rows: cats } = await db.query(
          `SELECT
           asset_type                       AS category,
           COUNT(*)::int                    AS total_campaigns,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_campaigns,
           COALESCE(SUM(raised_amount), 0)  AS total_raised
         FROM campaigns
         WHERE deleted_at IS NULL
         GROUP BY asset_type
         ORDER BY active_campaigns DESC`,
          [],
          { ttlMs: 5 * 60_000 }
        );
        return cats;
      },
      5 * 60_000
    );

    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    res.json(rows);
  })
);

router.get(
  '/recommended',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { limit } = parsePagination(req.query, { limit: 6, max: 12 });
    const rows = await getRecommendedCampaigns(req.user.userId, { limit });
    res.json(rows);
  })
);

router.get(
  '/',
  getCampaignsValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/campaigns:
     *   get:
     *     tags: [Campaigns]
     *     summary: List campaigns
     *     parameters:
     *       - in: query
     *         name: status
     *         schema: { type: string }
     *       - in: query
     *         name: asset
     *         schema: { type: string }
     *       - in: query
     *         name: search
     *         schema: { type: string }
     *       - in: query
     *         name: sort
     *         schema: { type: string }
     *       - in: query
     *         name: limit
     *         schema: { type: integer, minimum: 1, maximum: 50 }
     *       - in: query
     *         name: offset
     *         schema: { type: integer, minimum: 0 }
     *     responses:
     *       200:
     *         description: OK
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 total: { type: integer }
     *                 limit: { type: integer }
     *                 offset: { type: integer }
     *                 campaigns:
     *                   type: array
     *                   items:
     *                     type: object
     */
    const { search, status, asset, category, min_progress, sort = 'newest' } = req.query;
    const { min_funding, max_funding, deadline_within, creator_verified, country } = req.query;
    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });
    const filters = [];
    const params = [];

    // Exclude deleted and hidden campaigns from public listing
    filters.push(`c.deleted_at IS NULL`);
    filters.push(`c.is_flagged_duplicate = FALSE`);
    filters.push(`c.is_hidden = FALSE`);

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
    if (category) {
      params.push(category);
      filters.push(`c.category = $${params.length}`);
    }
    if (min_progress) {
      params.push(Number(min_progress));
      // Progress is (raised_amount / target_amount) * 100
      filters.push(`(c.raised_amount / NULLIF(c.target_amount, 0)) * 100 >= $${params.length}`);
    }
    // Funding range facet — filter on amount raised so far.
    if (min_funding !== undefined && min_funding !== '' && Number.isFinite(Number(min_funding))) {
      params.push(Number(min_funding));
      filters.push(`c.raised_amount >= $${params.length}`);
    }
    if (max_funding !== undefined && max_funding !== '' && Number.isFinite(Number(max_funding))) {
      params.push(Number(max_funding));
      filters.push(`c.raised_amount <= $${params.length}`);
    }
    // Deadline proximity facet — campaigns ending within N days from now.
    if (
      deadline_within !== undefined &&
      deadline_within !== '' &&
      Number.isFinite(Number(deadline_within))
    ) {
      params.push(Number(deadline_within));
      filters.push(
        `c.deadline IS NOT NULL AND c.deadline >= CURRENT_DATE AND c.deadline <= CURRENT_DATE + ($${params.length}::int) * INTERVAL '1 day'`
      );
    }
    // Creator reputation facet — currently backed by KYC verification status.
    if (creator_verified === 'true' || creator_verified === '1') {
      filters.push(`u.kyc_status = 'verified'`);
    }
    // Geographic location facet.
    if (country) {
      params.push(country);
      filters.push(`c.country = $${params.length}`);
    }
    let searchParamIdx = null;
    if (search) {
      params.push(search);
      searchParamIdx = params.length;
      filters.push(`c.search_vector @@ websearch_to_tsquery('english', $${params.length})`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const countQuery = `SELECT COUNT(*)::int AS total FROM campaigns c JOIN users u ON u.id = c.creator_id ${whereClause}`;
    const countResult = await db.query(countQuery, params);
    const total = countResult.rows[0]?.total || 0;

    const sortExpressions = {
      newest: 'c.created_at DESC',
      trending: 'COALESCE(ctr_trending.recent_count, 0) DESC, c.created_at DESC',
      ending_soon: 'c.deadline ASC NULLS LAST',
      most_funded: 'c.raised_amount DESC',
      most_backed: 'COALESCE(con.total_contributions, 0) DESC',
      closest_to_goal:
        '(c.raised_amount / NULLIF(c.target_amount, 0)) DESC NULLS LAST, c.raised_amount DESC',
    };
    if (searchParamIdx !== null) {
      sortExpressions.relevance = `ts_rank(c.search_vector, websearch_to_tsquery('english', $${searchParamIdx})) DESC, c.created_at DESC`;
    }
    // A search without an explicit sort ranks by relevance; explicit sorts always win.
    const effectiveSort =
      searchParamIdx !== null && req.query.sort === undefined ? 'relevance' : sort;
    const orderBy = sortExpressions[effectiveSort] || sortExpressions.newest;

    const query = `
    SELECT ${PUBLIC_CAMPAIGN_SELECT},
           u.name AS creator_name,
           u.kyc_status AS creator_kyc_status,
           u.verification_status AS creator_verification_status,
           u.verification_tier AS creator_verification_tier,
           COALESCE(cu.updates_count, 0)::int AS updates_count,
           COALESCE(con.contributor_count, 0)::int AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    LEFT JOIN (
      SELECT campaign_id, COUNT(*)::int AS updates_count
      FROM campaign_updates
      GROUP BY campaign_id
    ) cu ON cu.campaign_id = c.id
    LEFT JOIN (
      SELECT campaign_id,
             COUNT(DISTINCT sender_public_key)::int AS contributor_count,
             COUNT(*)::int AS total_contributions
      FROM contributions
      GROUP BY campaign_id
    ) con ON con.campaign_id = c.id
    LEFT JOIN (
      SELECT campaign_id, COUNT(*)::int AS recent_count
      FROM contributions
      WHERE created_at >= NOW() - INTERVAL '48 hours'
      GROUP BY campaign_id
    ) ctr_trending ON ctr_trending.campaign_id = c.id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT $${params.length + 1}
    OFFSET $${params.length + 2}
  `;
    const result = await db.query(query, [...params, limit, offset]);

    // The listing endpoint is public: strip any internal column a widened query
    // might have selected (fraud_*, content_fingerprint, wallet_secret_encrypted).
    res.json({
      total,
      limit,
      offset,
      campaigns: result.rows.map(stripInternalCampaignFields),
    });
  })
);

// GET /campaigns/facets — available filter facets with counts for the discovery UI.
// Computed over the publicly listable, active campaign set so the UI can render
// faceted controls (categories, assets, countries) and sensible funding bounds.
router.get(
  '/facets',
  asyncHandler(async (req, res) => {
    const baseWhere = `
    c.deleted_at IS NULL
    AND c.is_flagged_duplicate = FALSE
    AND c.is_hidden = FALSE
    AND c.status = 'active'
  `;

    const [categories, assets, countries, funding, verified] = await Promise.all([
      db.query(
        `SELECT category, COUNT(*)::int AS count
       FROM campaigns c
       WHERE ${baseWhere} AND category IS NOT NULL
       GROUP BY category ORDER BY count DESC`
      ),
      db.query(
        `SELECT asset_type, COUNT(*)::int AS count
       FROM campaigns c
       WHERE ${baseWhere}
       GROUP BY asset_type ORDER BY count DESC`
      ),
      db.query(
        `SELECT country, COUNT(*)::int AS count
       FROM campaigns c
       WHERE ${baseWhere} AND country IS NOT NULL
       GROUP BY country ORDER BY count DESC`
      ),
      db.query(
        `SELECT COALESCE(MIN(raised_amount), 0)::numeric AS min_funding,
              COALESCE(MAX(raised_amount), 0)::numeric AS max_funding
       FROM campaigns c
       WHERE ${baseWhere}`
      ),
      db.query(
        `SELECT COUNT(*)::int AS count
       FROM campaigns c
       JOIN users u ON u.id = c.creator_id
       WHERE ${baseWhere} AND u.kyc_status = 'verified'`
      ),
    ]);

    res.json({
      categories: categories.rows,
      assets: assets.rows,
      countries: countries.rows,
      funding: {
        min: Number(funding.rows[0]?.min_funding || 0),
        max: Number(funding.rows[0]?.max_funding || 0),
      },
      verified_creators: verified.rows[0]?.count || 0,
    });
  })
);

router.get(
  '/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { page, limit, fields } = req.query;
    const result = await listCreatorCampaigns(req.user.userId, { page, limit, fields });
    res.json(result);
  })
);

// ── Campaign draft auto-save ──────────────────────────────────────────────

router.post(
  '/drafts',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    const { form_data, step } = req.body;

    if (!form_data || typeof form_data !== 'object') {
      return res.status(400).json({ error: 'form_data is required' });
    }

    const { rows } = await db.query(
      `INSERT INTO campaign_drafts (creator_id, form_data, step, saved_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (creator_id)
     DO UPDATE SET form_data = EXCLUDED.form_data,
                   step = EXCLUDED.step,
                   saved_at = NOW()
     RETURNING id, saved_at`,
      [req.user.userId, JSON.stringify(form_data), step ?? 1]
    );

    res.json(rows[0]);
  })
);

router.get(
  '/drafts/my',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, form_data, step, saved_at
     FROM campaign_drafts
     WHERE creator_id = $1
     ORDER BY saved_at DESC
     LIMIT 1`,
      [req.user.userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'No draft found' });

    res.json(rows[0]);
  })
);

router.delete(
  '/drafts/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `DELETE FROM campaign_drafts
     WHERE id = $1 AND creator_id = $2
     RETURNING id`,
      [req.params.id, req.user.userId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Draft not found' });

    res.json({ message: 'Draft deleted' });
  })
);

router.get(
  '/:id/milestones',
  asyncHandler(async (req, res) => {
    const rawLocale = req.query.locale || req.query.lang;
    const requestedLocale = rawLocale ? resolveCampaignLanguage(rawLocale) : null;
    if (rawLocale && !requestedLocale) {
      return res.status(400).json({ error: 'Unsupported campaign locale' });
    }

    const { rows } = await db.query(
      `SELECT m.*, (c.milestones_contract_id IS NOT NULL) AS on_chain
     FROM milestones m
     JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.campaign_id = $1
     ORDER BY m.sort_order ASC, m.created_at ASC`,
      [req.params.id]
    );

    if (requestedLocale && rows.length > 0) {
      try {
        const { rows: transRows } = await db.query(
          `SELECT milestone_titles
         FROM campaign_translations
         WHERE campaign_id = $1 AND (locale = $2 OR language = $2)
         LIMIT 1`,
          [req.params.id, requestedLocale]
        );
        if (transRows.length > 0 && transRows[0].milestone_titles) {
          let mt = transRows[0].milestone_titles;
          if (typeof mt === 'string') {
            try {
              mt = JSON.parse(mt);
            } catch {
              mt = [];
            }
          }
          rows.forEach((milestone, idx) => {
            if (Array.isArray(mt)) {
              if (mt[idx]) milestone.title = mt[idx];
            } else if (typeof mt === 'object' && mt !== null) {
              if (mt[milestone.id]) milestone.title = mt[milestone.id];
              else if (mt[idx]) milestone.title = mt[idx];
            }
          });
        }
      } catch (err) {
        logger.warn('Failed to load milestone translations', {
          campaign_id: req.params.id,
          locale: requestedLocale,
          error: err.message,
        });
      }
    }

    res.json(rows);
  })
);

router.post(
  '/:id/milestones',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    let normalizedMilestones;
    try {
      normalizedMilestones = normalizeMilestonesInput(req.body?.milestones);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!normalizedMilestones.length) {
      return res.status(400).json({ error: 'At least one milestone is required' });
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows: campaignRows } = await client.query(
        'SELECT id, creator_id, status FROM campaigns WHERE id = $1 FOR UPDATE',
        [req.params.id]
      );
      if (!campaignRows.length) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Campaign not found' });
      }
      const campaign = campaignRows[0];
      if (campaign.creator_id !== req.user.userId) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'Only the campaign creator can define milestones' });
      }
      if (!['active', 'funded', 'in_progress'].includes(campaign.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Milestones cannot be edited while campaign status is "${campaign.status}".`,
        });
      }

      const { rows: existingRows } = await client.query(
        'SELECT status FROM milestones WHERE campaign_id = $1',
        [campaign.id]
      );
      if (existingRows.some(row => row.status !== 'pending')) {
        await client.query('ROLLBACK');
        return res
          .status(409)
          .json({ error: 'Milestone plan cannot be changed after approvals or releases begin' });
      }

      await client.query('DELETE FROM milestones WHERE campaign_id = $1', [campaign.id]);
      const inserted = [];
      for (const milestone of normalizedMilestones) {
        const { rows } = await client.query(
          `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
          [
            campaign.id,
            milestone.title,
            milestone.description,
            milestone.release_percentage,
            milestone.sort_order,
          ]
        );
        inserted.push(rows[0]);
      }
      await client.query('COMMIT');
      res.status(201).json(inserted);
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('Campaign milestone plan update failed', {
        campaign_id: req.params.id,
        error: err.message,
      });
      res.status(500).json({ error: 'Could not save campaign milestones' });
    } finally {
      client.release();
    }
  })
);

router.get(
  '/:id/budgets',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT * FROM campaign_budget_categories WHERE campaign_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  })
);

router.post(
  '/:id/budgets',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { budgets } = req.body;

    if (!Array.isArray(budgets)) {
      return res.status(400).json({ error: 'budgets must be an array' });
    }

    try {
      const inserted = await withTransaction(async client => {
        const { rows: campaignRows } = await client.query(
          `SELECT target_amount FROM campaigns WHERE id = $1 FOR UPDATE`,
          [req.params.id]
        );
        if (!campaignRows.length) throw new Error('Campaign not found');

        const totalBudget = budgets.reduce((sum, b) => sum + Number(b.amount), 0);
        if (
          budgets.length > 0 &&
          Math.abs(totalBudget - Number(campaignRows[0].target_amount)) > 0.0001
        ) {
          throw new Error(
            `Total budget (${totalBudget}) must match campaign target amount (${campaignRows[0].target_amount})`
          );
        }

        await client.query(`DELETE FROM campaign_budget_categories WHERE campaign_id = $1`, [
          req.params.id,
        ]);

        const inserted = [];
        if (budgets.length > 0) {
          for (const b of budgets) {
            if (!b.title || !b.amount || Number(b.amount) <= 0) {
              throw new Error('Invalid budget item');
            }
            const { rows } = await client.query(
              `INSERT INTO campaign_budget_categories (campaign_id, title, amount, description) VALUES ($1, $2, $3, $4) RETURNING *`,
              [req.params.id, b.title, Number(b.amount), b.description || null]
            );
            inserted.push(rows[0]);
          }
        }
        return inserted;
      }, db);
      res.status(201).json(inserted);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);
router.get(
  '/trending',
  asyncHandler(async (req, res) => {
    const { limit } = parsePagination(req.query, { limit: 20, max: 20 });
    const campaigns = await getTrendingCampaigns({ limit });
    res.json({ campaigns });
  })
);

router.get(
  '/:id/clone-data',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;

    const { rows: campaignRows } = await db.query(
      `SELECT title, description, target_amount, asset_type, category, min_contribution, max_contribution, max_per_user, show_backer_amounts
     FROM campaigns 
     WHERE id = $1`,
      [campaignId]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    const { rows: milestones } = await db.query(
      `SELECT title, description, release_percentage
     FROM milestones 
     WHERE campaign_id = $1 
     ORDER BY sort_order ASC`,
      [campaignId]
    );

    const { rows: reward_tiers } = await db.query(
      `SELECT title, description, min_amount, "limit", estimated_delivery
     FROM reward_tiers 
     WHERE campaign_id = $1
     ORDER BY min_amount ASC`,
      [campaignId]
    );

    res.json({
      title: `Copy of ${campaign.title}`,
      description: campaign.description,
      target_amount: campaign.target_amount,
      asset_type: campaign.asset_type,
      category: campaign.category,
      min_contribution: campaign.min_contribution,
      max_contribution: campaign.max_contribution,
      max_per_user: campaign.max_per_user,
      show_backer_amounts: campaign.show_backer_amounts,
      milestones: milestones,
      reward_tiers: reward_tiers,
    });
  })
);

// One-click clone: copies fields, milestones, and reward tiers into a new
// draft campaign with no on-chain wallet/contracts yet (instant, no gas cost).
router.post(
  '/:id/clone',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const sourceId = req.params.id;

    const { rows: campaignRows } = await db.query(
      `SELECT title, description, target_amount, asset_type, category,
            min_contribution, max_contribution, max_per_user, show_backer_amounts
     FROM campaigns WHERE id = $1`,
      [sourceId]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
    const source = campaignRows[0];

    const { rows: milestoneRows } = await db.query(
      'SELECT title, description, release_percentage, sort_order FROM milestones WHERE campaign_id = $1 ORDER BY sort_order ASC',
      [sourceId]
    );
    const { rows: tierRows } = await db.query(
      'SELECT title, description, min_amount, asset_type, tier_limit, estimated_delivery FROM reward_tiers WHERE campaign_id = $1 ORDER BY min_amount ASC',
      [sourceId]
    );

    const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [
      req.user.userId,
    ]);
    const creatorEmail = userRows[0]?.email;

    let clone;
    try {
      clone = await withTransaction(async client => {
        const { rows } = await client.query(
          `INSERT INTO campaigns
           (title, description, target_amount, asset_type, creator_id, status,
            category, min_contribution, max_contribution, max_per_user, show_backer_amounts,
            raised_amount, cloned_from)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, 0, $11)
         RETURNING *`,
          [
            `${source.title} (Copy)`,
            source.description,
            source.target_amount,
            source.asset_type,
            req.user.userId,
            source.category,
            source.min_contribution,
            source.max_contribution,
            source.max_per_user,
            source.show_backer_amounts,
            sourceId,
          ]
        );
        const createdClone = rows[0];

        await client.query(
          `INSERT INTO campaign_members (campaign_id, user_id, email, role, accepted_at)
           VALUES ($1, $2, $3, 'owner', NOW())`,
          [createdClone.id, req.user.userId, creatorEmail]
        );

        for (const milestone of milestoneRows) {
          await client.query(
            `INSERT INTO milestones (campaign_id, title, description, release_percentage, sort_order)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              createdClone.id,
              milestone.title,
              milestone.description,
              milestone.release_percentage,
              milestone.sort_order,
            ]
          );
        }

        if (tierRows.length) {
          await insertTiers(
            client,
            createdClone.id,
            tierRows.map(t => ({
              title: t.title,
              description: t.description,
              min_amount: t.min_amount,
              asset_type: t.asset_type,
              tier_limit: t.tier_limit,
              estimated_delivery: t.estimated_delivery,
            }))
          );
        }

        return createdClone;
      }, db);
    } catch (err) {
      logger.error('[campaigns] clone failed', {
        source_campaign_id: sourceId,
        error: err.message,
      });
      return res.status(500).json({ error: 'Could not clone campaign' });
    }

    res.status(201).json(clone);
  })
);

// Schedule (or clear) auto-publish for a draft campaign.
router.post(
  '/:id/schedule-publish',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { scheduled_publish_at } = req.body || {};

    const { rows: campaignRows } = await db.query('SELECT status FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
    if (campaignRows[0].status !== 'draft') {
      return res
        .status(409)
        .json({ error: 'Only draft campaigns can be scheduled for publishing' });
    }

    let value = null;
    if (scheduled_publish_at) {
      const date = new Date(scheduled_publish_at);
      if (isNaN(date.getTime())) {
        return res
          .status(422)
          .json({ error: 'scheduled_publish_at must be a valid ISO 8601 date' });
      }
      if (date.getTime() <= Date.now()) {
        return res.status(422).json({ error: 'scheduled_publish_at must be in the future' });
      }
      value = date.toISOString();
    }

    const { rows } = await db.query(
      'UPDATE campaigns SET scheduled_publish_at = $1 WHERE id = $2 RETURNING *',
      [value, req.params.id]
    );
    res.json(rows[0]);
  })
);

// Deploy the on-chain wallet + contracts for a draft campaign and make it active.
router.post(
  '/:id/publish',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    try {
      const campaign = await publishDraftCampaign(req.params.id);
      res.json(campaign);
    } catch (err) {
      if (err instanceof CampaignNotPublishableError) {
        return res.status(409).json({ error: err.message });
      }
      logger.error('[campaigns] publish failed', {
        campaign_id: req.params.id,
        error: err.message,
      });
      res.status(502).json({ error: 'Could not publish campaign', detail: err.message });
    }
  })
);

// Get single Campaign
// Get featured campaigns
router.get(
  '/featured',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(`
    SELECT c.id, c.title, c.description, c.target_amount, c.raised_amount,
           c.asset_type, c.status, c.deadline, c.featured_note,
           u.name AS creator_name,
           COALESCE(con.contributor_count, 0)::int AS contributor_count
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    LEFT JOIN (
      SELECT campaign_id, COUNT(*)::int AS contributor_count
      FROM contributions
      GROUP BY campaign_id
    ) con ON con.campaign_id = c.id
    WHERE c.featured = TRUE AND c.status = 'active' AND c.deleted_at IS NULL AND c.is_flagged_duplicate = FALSE AND c.is_hidden = FALSE
    ORDER BY c.featured_at DESC
    LIMIT 3
  `);
    res.json(rows);
  })
);

// Add campaign to the current user's favorites/wishlist
router.post(
  '/:id/favorite',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: campaigns } = await db.query('SELECT id FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });

    await db.query(
      `INSERT INTO contributor_favorites (user_id, campaign_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, campaign_id) DO NOTHING`,
      [req.user.userId, req.params.id]
    );
    res.status(204).send();
  })
);

// DELETE /campaigns/:id — Soft-delete campaign (owner only) and revoke/close Stellar wallet
router.delete(
  '/:id',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const { rows: campaignRows } = await db.query(
      'SELECT id, title, creator_id, wallet_public_key, wallet_secret_encrypted FROM campaigns WHERE id = $1 AND deleted_at IS NULL',
      [id]
    );

    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];

    // Revoke platform multisig, sweep non-zero funds to platform, and close Stellar account
    try {
      await revokeAndCloseCampaignWallet(campaign);
    } catch (stellarErr) {
      logger.error(
        'Failed to revoke platform multisig / close Stellar account for deleted campaign',
        {
          campaignId: id,
          error: stellarErr.message,
        }
      );
      await sendAlert('Campaign wallet cleanup failed on deletion', {
        campaignId: id,
        walletPublicKey: campaign.wallet_public_key,
        error: stellarErr.message,
      });
      return res.status(502).json({
        error: 'Failed to revoke Stellar wallet multisig and close account',
        details: stellarErr.message,
      });
    }

    // Cleanup ledger stream registry and reconnect attempts for this wallet
    cleanupStreamForWallet(campaign.wallet_public_key);

    const { rows: updated } = await db.query(
      `UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 RETURNING id, title, deleted_at`,
      [id]
    );

    logger.info('Campaign deleted by owner', { campaignId: id, userId: req.user.userId });
    cache.invalidate(`campaigns:id:${id}`);
    cache.invalidatePrefix('campaigns:list:');
    res.json({ message: 'Campaign deleted', campaign: updated[0] });
  })
);

// Remove campaign from the current user's favorites/wishlist
router.delete(
  '/:id/favorite',
  requireAuth,
  asyncHandler(async (req, res) => {
    await db.query('DELETE FROM contributor_favorites WHERE user_id = $1 AND campaign_id = $2', [
      req.user.userId,
      req.params.id,
    ]);
    res.status(204).send();
  })
);

router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(`
    SELECT category, COUNT(*)::int AS count
    FROM campaigns
    WHERE status = 'active' AND deleted_at IS NULL AND is_flagged_duplicate = FALSE AND is_hidden = FALSE
    GROUP BY category
    ORDER BY category ASC
  `);
    res.json(rows);
  })
);

router.get(
  '/:id/contract-status',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, contract_address, escrow_contract_id, milestones_contract_id,
            target_amount, deadline, status,
            contract_deployment_status, contract_deployment_error
     FROM campaigns
     WHERE id = $1`,
      [req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = rows[0];
    const escrowContractId = campaign.escrow_contract_id || campaign.contract_address;

    if (!escrowContractId && !campaign.milestones_contract_id) {
      return res.json({
        has_contract: false,
        contract_deployment_status: campaign.contract_deployment_status,
        contract_deployment_error: campaign.contract_deployment_error,
        status: campaign.status,
        totalRaised: 0,
        milestones: [],
      });
    }

    try {
      const deadlineUnix = campaign.deadline
        ? Math.floor(new Date(campaign.deadline).getTime() / 1000)
        : 0;
      const targetAmount = toStroops(campaign.target_amount);

      const onChain = await getContractStatus({
        escrowContractId,
        milestonesContractId: campaign.milestones_contract_id,
        deadlineUnix,
        targetAmount,
      });

      res.json({
        has_contract: true,
        contract_address: campaign.contract_address || escrowContractId,
        escrow_contract_id: escrowContractId,
        milestones_contract_id: campaign.milestones_contract_id,
        contract_deployment_status: campaign.contract_deployment_status,
        ...onChain,
      });
    } catch (err) {
      logger.error('Failed to read on-chain contract status', {
        campaign_id: req.params.id,
        error: err.message,
      });
      res.status(502).json({
        error: 'Could not read on-chain contract status',
        detail: err.message,
      });
    }
  })
);

router.get(
  '/:id/impact',
  impactStatsLimiter,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const impact = await campaignsCache.wrap(
      `impact:${campaignId}`,
      () => computeCampaignImpact(campaignId),
      IMPACT_CACHE_TTL_MS
    );

    if (!impact) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=30');

    if (req.query.sign === '1' || req.query.signed === 'true') {
      if (!process.env.PLATFORM_SECRET_KEY) {
        return res.status(503).json({ error: 'Impact signing is not configured' });
      }
      const { signed_payload, signature, public_key } = signImpactStats(impact);
      return res.json({ ...impact, signed_payload, signature, public_key });
    }

    res.json(impact);
  })
);

const serveOgImage = asyncHandler(async (req, res) => {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.target_amount, c.raised_amount, c.asset_type, c.status, c.deleted_at,
            u.full_name AS creator_name, u.email AS creator_email
     FROM campaigns c
     LEFT JOIN users u ON u.id = c.creator_id
     WHERE c.id = $1`,
    [req.params.id]
  );
  if (!rows.length || rows[0].deleted_at) {
    return res.status(404).json({ error: 'Campaign not found' });
  }
  const campaign = rows[0];
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const campaignUrl = `${frontendUrl}/campaigns/${campaign.id}`;
  const creatorName =
    campaign.creator_name ||
    (campaign.creator_email ? campaign.creator_email.split('@')[0] : 'Creator');

  const pngBuffer = await generateCampaignOgImage({
    title: campaign.title,
    creatorName,
    raisedAmount: campaign.raised_amount,
    targetAmount: campaign.target_amount,
    assetType: campaign.asset_type,
    campaignUrl,
  });

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  return res.send(pngBuffer);
});

router.get('/:id/og-image.png', serveOgImage);
router.get('/:id/og-image', serveOgImage);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const rawLocale = req.query.locale || req.query.lang;
    const requestedLocale = rawLocale ? resolveCampaignLanguage(rawLocale) : null;
    if (rawLocale && !requestedLocale) {
      return res.status(400).json({ error: 'Unsupported campaign locale' });
    }

    /**
     * @openapi
     * /api/campaigns/{id}:
     *   get:
     *     tags: [Campaigns]
     *     summary: Get campaign by id
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: OK
     *       404:
     *         description: Not found
     */
    const refCode = req.query.ref;
    if (refCode) {
      try {
        const { rows: referralRows } = await db.query(
          'SELECT id, campaign_id FROM campaign_referrals WHERE referral_code = $1 AND campaign_id = $2',
          [refCode, req.params.id]
        );
        if (referralRows.length) {
          await db.query(
            'UPDATE campaign_referrals SET click_count = click_count + 1 WHERE id = $1',
            [referralRows[0].id]
          );
          res.cookie(`cp_ref_${req.params.id}`, refCode, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60 * 1000,
            path: '/',
          });
        }
      } catch (err) {
        logger.warn('Referral click tracking failed', {
          campaign_id: req.params.id,
          ref: refCode,
          error: err.message,
        });
      }
    }

    const shareSource = req.query.source || req.query.utm_source;
    if (shareSource && typeof shareSource === 'string') {
      res.cookie(`cp_share_source_${req.params.id}`, shareSource.slice(0, 64), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/',
      });
    }

    const query = `
    SELECT ${PUBLIC_CAMPAIGN_SELECT},
           (SELECT COUNT(DISTINCT sender_public_key)::int FROM contributions WHERE campaign_id = $1) AS contributor_count,
           u.kyc_status AS creator_kyc_status,
           u.verification_status AS creator_verification_status,
           u.verification_tier AS creator_verification_tier
    FROM campaigns c
    JOIN users u ON u.id = c.creator_id
    WHERE c.id = $1
  `;
    await refreshCampaignStatus(req.params.id);
    const { rows } = await db.query(query, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

    const campaign = rows[0];

    // Handle locale translation if requested (#753)
    if (requestedLocale) {
      try {
        const { rows: translationRows } = await db.query(
          `SELECT title, description, milestone_titles, COALESCE(locale, language) AS locale
         FROM campaign_translations
         WHERE campaign_id = $1 AND (locale = $2 OR language = $2)
         LIMIT 1`,
          [req.params.id, requestedLocale]
        );
        if (translationRows.length > 0) {
          const translation = translationRows[0];
          campaign.title = translation.title || campaign.title;
          if (translation.description !== null && translation.description !== undefined) {
            campaign.description = translation.description;
          }
          if (translation.milestone_titles) {
            campaign.milestone_titles = translation.milestone_titles;
          }
          campaign.locale = translation.locale;
          campaign.is_translated = true;
        }
      } catch (err) {
        logger.warn('Failed to load campaign translation', {
          campaign_id: req.params.id,
          locale: requestedLocale,
          error: err.message,
        });
      }
    }

    // Allow viewing suspended campaigns with a notice, but deleted campaigns are not accessible
    if (campaign.deleted_at) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    let userRole = null;

    const header = req.headers.authorization;
    const token =
      req.cookies?.cp_token ||
      (header && header.startsWith('Bearer ') ? header.slice(7).trim() : null);
    if (token && !token.startsWith('cpk_')) {
      try {
        const jwt = require('jsonwebtoken');
        const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
        if (payload && payload.userId) {
          const { rows: userRows } = await db.query('SELECT is_admin FROM users WHERE id = $1', [
            payload.userId,
          ]);
          const currentIsAdmin = userRows[0]?.is_admin === true;

          if (currentIsAdmin) {
            userRole = 'owner';
          } else if (campaign.creator_id === payload.userId) {
            userRole = 'owner';
          } else {
            userRole = await resolveUserCampaignRole(campaign.id, payload.userId, false);
          }
        }
      } catch (err) {
        // Ignore invalid token for public route
      }
    }

    // Hidden campaigns only accessible by owner or admin
    if (campaign.is_hidden && userRole !== 'owner') {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Add notice if campaign is suspended. `stripInternalCampaignFields` keeps
    // the public detail payload free of fraud/duplicate internals and the
    // encrypted wallet key even though the row is fetched with a wide allowlist.
    const response = { ...stripInternalCampaignFields(campaign), user_role: userRole };
    if (campaign.status === 'suspended') {
      response.suspended_notice =
        'This campaign has been suspended and cannot receive new contributions';
    }

    const baseUrl =
      process.env.BACKEND_URL ||
      (req.get('host') ? `${req.protocol}://${req.get('host')}` : 'http://localhost:3000');
    const frontendBase = process.env.FRONTEND_URL || 'http://localhost:5173';
    response.og_image_url = `${baseUrl}/api/campaigns/${campaign.id}/og-image.png`;
    response.share_url = `${frontendBase}/campaigns/${campaign.id}`;

    res.json(response);
  })
);

function daysRemaining(deadline) {
  if (!deadline) return null;
  const end = new Date(deadline);
  end.setHours(23, 59, 59, 999);
  return Math.max(0, Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
}

async function loadPublicCampaignSummary(campaignId) {
  const { rows } = await db.query(
    `SELECT id, title, description, target_amount, raised_amount, asset_type, status, deadline,
            (SELECT COUNT(*)::int FROM contributions c WHERE c.campaign_id = campaigns.id) AS backer_count
     FROM campaigns WHERE id = $1 AND deleted_at IS NULL AND is_hidden = FALSE`,
    [campaignId]
  );
  if (!rows.length) return null;

  const campaign = rows[0];
  const pct = campaign.target_amount
    ? Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100)
    : 0;

  return {
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    raised_amount: Number(campaign.raised_amount),
    target_amount: Number(campaign.target_amount),
    asset_type: campaign.asset_type,
    status: campaign.status,
    deadline: campaign.deadline,
    backer_count: campaign.backer_count,
    days_remaining: daysRemaining(campaign.deadline),
    progress_percentage: Math.round(pct * 10) / 10,
    contribution_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${campaign.id}`,
  };
}

// The embed widget speaks in four milestone states (#596). Internally a
// milestone awaiting platform review is `pending_review`, and a rejected one is
// back in the creator's hands, so both collapse to a public-facing state.
const EMBED_MILESTONE_STATUS = {
  pending: 'pending',
  rejected: 'pending',
  pending_review: 'submitted',
  approved: 'approved',
  released: 'released',
};

async function loadPublicCampaignMilestones(campaignId) {
  const { rows } = await db.query(
    `SELECT id, title, release_percentage, sort_order, status
     FROM milestones
     WHERE campaign_id = $1
     ORDER BY sort_order ASC, created_at ASC`,
    [campaignId]
  );

  return rows.map(milestone => ({
    id: milestone.id,
    title: milestone.title,
    release_percentage: Number(milestone.release_percentage),
    sort_order: milestone.sort_order,
    status: EMBED_MILESTONE_STATUS[milestone.status] || 'pending',
  }));
}

function summariseMilestones(milestones) {
  const released = milestones.filter(milestone => milestone.status === 'released');
  const releasedPercentage = released.reduce(
    (total, milestone) => total + milestone.release_percentage,
    0
  );

  return {
    total: milestones.length,
    released: released.length,
    approved: milestones.filter(milestone => milestone.status === 'approved').length,
    submitted: milestones.filter(milestone => milestone.status === 'submitted').length,
    pending: milestones.filter(milestone => milestone.status === 'pending').length,
    released_percentage: Math.round(releasedPercentage * 10) / 10,
  };
}

const WIDGET_DESCRIPTION_LENGTH = 200;
const WIDGET_RECENT_BACKER_LIMIT = 3;

function truncateWidgetDescription(description) {
  if (!description) return '';
  return description.length > WIDGET_DESCRIPTION_LENGTH
    ? `${description.slice(0, WIDGET_DESCRIPTION_LENGTH).trim()}...`
    : description;
}

/**
 * Public "recent backers" strip for the embeddable campaign progress widget.
 *
 * The widget is rendered on third-party sites, so this applies the same two
 * privacy gates as the authenticated backers list (#897): the campaign-level
 * `show_backer_amounts` flag and each contributor's `contributor_privacy`
 * preference. Anonymous contributors are never named, and `amount_only`
 * contributors never leak a display name.
 */
async function loadWidgetRecentBackers(campaignId, { limit = WIDGET_RECENT_BACKER_LIMIT } = {}) {
  const { rows: campaignRows } = await db.query(
    'SELECT show_backer_amounts FROM campaigns WHERE id = $1',
    [campaignId]
  );
  const showAmounts = campaignRows[0]?.show_backer_amounts !== false;

  const { rows } = await db.query(
    `SELECT ctr.display_name,
            ctr.amount,
            COALESCE(u.contributor_privacy, 'full') AS contributor_privacy
       FROM contributions ctr
       LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
      WHERE ctr.campaign_id = $1 AND ctr.status = 'completed'
      ORDER BY ctr.created_at DESC
      LIMIT $2`,
    [campaignId, limit]
  );

  return rows
    .map(row => {
      const privacy = row.contributor_privacy || 'full';
      const name = privacy === 'full' ? row.display_name || null : null;
      const amountVisible = showAmounts && privacy !== 'anonymous';
      const amount = amountVisible ? Number(row.amount) : null;
      if (!name && amount === null) return null;
      return { name: name || 'Anonymous', amount };
    })
    .filter(Boolean);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildFundingBadgeSvg({ leftLabel, rightLabel }) {
  const leftWidth = Math.max(72, leftLabel.length * 7 + 18);
  const rightWidth = Math.max(100, rightLabel.length * 6.5 + 18);
  const totalWidth = leftWidth + rightWidth;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(`${leftLabel}: ${rightLabel}`)}">`,
    `<linearGradient id="g" x2="0" y2="100%"><stop offset="0" stop-color="#fbfbfb"/><stop offset="1" stop-color="#f0f0f0"/></linearGradient>`,
    `<clipPath id="c"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>`,
    `<g clip-path="url(#c)">`,
    `<rect width="${leftWidth}" height="20" fill="#555"/>`,
    `<rect x="${leftWidth}" width="${rightWidth}" height="20" fill="#7c3aed"/>`,
    `<rect width="${totalWidth}" height="20" fill="url(#g)"/>`,
    `<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">`,
    `<text x="${leftWidth / 2}" y="14">${escapeXml(leftLabel)}</text>`,
    `<text x="${leftWidth + rightWidth / 2}" y="14">${escapeXml(rightLabel)}</text>`,
    `</g></g></svg>`,
  ].join('');
}

// Embeddable campaign widget data (public, with permissive CORS)
router.get(
  '/:id/embed',
  asyncHandler(async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    const campaignId = req.params.id;
    const summary = await loadPublicCampaignSummary(campaignId);
    if (!summary) return res.status(404).json({ error: 'Campaign not found' });

    const milestones = await loadPublicCampaignMilestones(campaignId);
    const impact = await computeCampaignImpact(campaignId);

    res.json({
      ...summary,
      description:
        summary.description?.slice(0, 200) + (summary.description?.length > 200 ? '...' : ''),
      milestones,
      milestone_summary: summariseMilestones(milestones),
      impact,
    });
  })
);

// Compact widget payload for lightweight iframe embeds.
//
// This is the single contract the embeddable campaign progress widget renders
// (#954). It deliberately exposes only public summary fields — no creator or
// contributor identifiers, no wallet addresses, no emails.
router.get(
  '/:id/widget',
  asyncHandler(async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'Content-Type');

    const campaignId = req.params.id;
    const summary = await loadPublicCampaignSummary(campaignId);
    if (!summary) return res.status(404).json({ error: 'Campaign not found' });

    const milestones = await loadPublicCampaignMilestones(campaignId);
    const impact = await computeCampaignImpact(campaignId);
    const recentBackers = await loadWidgetRecentBackers(campaignId);

    // Widgets poll every 30s; a matching browser/CDN cache keeps embeds from
    // turning into a request storm on popular campaign pages.
    res.header('Cache-Control', 'public, max-age=30');

    res.json({
      id: summary.id,
      title: summary.title,
      description: truncateWidgetDescription(summary.description),
      raised_amount: summary.raised_amount,
      target_amount: summary.target_amount,
      asset_type: summary.asset_type,
      status: summary.status,
      contributor_count: summary.backer_count,
      days_remaining: summary.days_remaining,
      progress_percentage: summary.progress_percentage,
      contribution_url: summary.contribution_url,
      milestones,
      milestone_summary: summariseMilestones(milestones),
      recent_backers: recentBackers,
      impact,
    });
  })
);

// SVG funding badge for README embedding (shields.io style)
router.get(
  '/:id/badge.svg',
  asyncHandler(async (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');

    const campaignId = parseInt(req.params.id, 10);
    const summary = await loadPublicCampaignSummary(campaignId);
    if (!summary) return res.status(404).send('Campaign not found');

    const raisedLabel = `${summary.raised_amount.toLocaleString()} / ${summary.target_amount.toLocaleString()} ${summary.asset_type}`;
    const rightLabel = `${summary.progress_percentage}% · ${raisedLabel}`;
    const svg = buildFundingBadgeSvg({ leftLabel: 'CrowdPay', rightLabel });

    res.type('image/svg+xml').send(svg);
  })
);

// Get backers for a campaign
router.get(
  '/:id/backers',
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const { rows: campaignRows } = await db.query(
      'SELECT show_backer_amounts FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
    const { show_backer_amounts } = campaignRows[0];

    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

    const countResult = await db.query(
      'SELECT COUNT(*)::int AS total FROM contributions WHERE campaign_id = $1',
      [campaignId]
    );
    const total = countResult.rows[0].total;

    const query = `
    SELECT 
      ctr.display_name,
      ctr.sender_public_key,
      COALESCE(u.contributor_privacy, 'full') AS contributor_privacy,
      ${show_backer_amounts ? 'ctr.amount,' : ''}
      ctr.asset,
      ctr.created_at
    FROM contributions ctr
    LEFT JOIN users u ON u.wallet_public_key = ctr.sender_public_key
    WHERE ctr.campaign_id = $1
    ORDER BY ctr.created_at DESC
    LIMIT $2 OFFSET $3
  `;
    const { rows } = await db.query(query, [campaignId, limit, offset]);

    // Apply contributor privacy settings
    const filteredRows = rows.map(row => {
      const privacy = row.contributor_privacy || 'full';
      const campaignHidesAmounts = !show_backer_amounts;

      // Apply the more restrictive setting
      if (privacy === 'anonymous' || campaignHidesAmounts) {
        return {
          display_name: null,
          sender_public_key: null,
          amount: null,
          asset: row.asset,
          created_at: row.created_at,
          contributor_privacy: privacy,
        };
      }

      if (privacy === 'amount_only') {
        return {
          display_name: null,
          sender_public_key: null,
          amount: row.amount,
          asset: row.asset,
          created_at: row.created_at,
          contributor_privacy: privacy,
        };
      }

      // full mode - show everything (subject to campaign-level show_backer_amounts)
      return {
        display_name: row.display_name,
        sender_public_key: row.sender_public_key,
        amount: row.amount,
        asset: row.asset,
        created_at: row.created_at,
        contributor_privacy: privacy,
      };
    });

    res.json({ data: filteredRows, total, limit, offset });
  })
);

// Download contributor fulfillment data for campaign owners/admins.
router.get(
  '/:id/contributions/export',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    await streamCampaignContributionExport({
      campaignId: req.params.id,
      res,
      runner: db,
    });
  })
);

// SSE stream for real-time campaign funding updates
router.get(
  '/:id/stream',
  asyncHandler(async (req, res) => {
    const campaignId = parseInt(req.params.id, 10);
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [campaignId]);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    res.write('data: {"type":"connected"}\n\n');

    addSSEClient(campaignId, res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      removeSSEClient(campaignId, res);
    });
  })
);

// Get live on-chain balance for a campaign
router.get(
  '/:id/balance',
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/campaigns/{id}/balance:
     *   get:
     *     tags: [Campaigns]
     *     summary: Get live on-chain balance for a campaign wallet
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema: { type: string }
     *     responses:
     *       200:
     *         description: OK
     *         content:
     *           application/json:
     *             schema:
     *               type: array
     *               items:
     *                 type: object
     *                 properties:
     *                   asset_type: { type: string }
     *                   balance: { type: string }
     *       404:
     *         description: Campaign not found
     */
    const { rows } = await db.query('SELECT wallet_public_key FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const balance = await getCampaignBalance(rows[0].wallet_public_key);
    res.json(balance);
  })
);

// Scheduled endpoint to fail expired campaigns and prevent further contributions
router.post(
  '/cron/fail-expired',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { failed, funded } = await refreshActiveCampaignStatuses();
    res.json({ failedCampaigns: failed, fundedCampaigns: funded });
  })
);

// Scheduled endpoint to send 48h deadline reminders
router.post(
  '/cron/reminders',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    // Find campaigns ending in exactly 2 days that are still active
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.deadline, u.email as creator_email
     FROM campaigns c
     JOIN users u ON c.creator_id = u.id
     WHERE c.status = 'active'
       AND c.deadline = CURRENT_DATE + INTERVAL '2 days'`
    );

    for (const campaign of rows) {
      sendEmail({
        to: campaign.creator_email,
        subject: `Reminder: Campaign "${campaign.title}" ends in 48 hours`,
        text: `Your campaign "${campaign.title}" is approaching its deadline on ${new Date(campaign.deadline).toDateString()}. 
If your target is reached, you can request a withdrawal. Otherwise, contributions will be refunded.`,
      });
    }

    res.json({ remindersSent: rows.length });
  })
);

// Trigger refund withdrawal requests for a failed campaign
router.post(
  '/:id/trigger-refunds',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;
    const { rows: campaigns } = await db.query(
      `SELECT id, wallet_public_key, status FROM campaigns WHERE id = $1`,
      [campaignId]
    );
    if (!campaigns.length) return res.status(404).json({ error: 'Campaign not found' });
    const campaign = campaigns[0];
    if (campaign.status !== 'failed') {
      return res.status(409).json({ error: 'Refunds may only be triggered for failed campaigns' });
    }

    try {
      const { refundsCreated, refunds } = await queueFailedCampaignRefunds(
        campaignId,
        req.user.userId
      );
      if (refundsCreated === 0) {
        return res.json({ refundsCreated: 0 });
      }
      res.status(201).json({ refundsCreated, refunds });
    } catch (err) {
      logger.error('Refund trigger failed', { campaign_id: campaignId, error: err.message });
      res.status(500).json({ error: 'Could not trigger refunds for campaign' });
    }
  })
);

// Check if draft campaign is a duplicate
router.post(
  '/check-duplicate',
  requireAuth,
  requireRole('creator', 'admin'),
  asyncHandler(async (req, res) => {
    const { title, description } = req.body;
    if (!title) return res.json({ isDuplicate: false });

    const contentFingerprint = getSimhash(`${title} ${description || ''}`);
    const { rows: existingCampaigns } = await db.query(
      'SELECT id, title, content_fingerprint FROM campaigns WHERE content_fingerprint IS NOT NULL AND status != $1',
      ['failed']
    );

    for (const c of existingCampaigns) {
      if (simhashSimilarity(contentFingerprint, c.content_fingerprint) > 0.9) {
        return res.json({ isDuplicate: true, similarTo: c.title });
      }
    }

    res.json({ isDuplicate: false });
  })
);

// Create campaign (authenticated)
router.post(
  '/',
  requireAuth,
  requireRole('creator', 'admin'),
  createCampaignValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/campaigns:
     *   post:
     *     tags: [Campaigns]
     *     summary: Create campaign
     *     security:
     *       - bearerAuth: []
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [title, target_amount, asset_type]
     *             properties:
     *               title: { type: string }
     *               description: { type: string, nullable: true }
     *               target_amount: { type: string }
     *               asset_type: { type: string }
     *               deadline: { type: string, nullable: true }
     *               milestones: { type: array, items: { type: object }, nullable: true }
     *               min_contribution: { type: string, nullable: true }
     *               max_contribution: { type: string, nullable: true }
     *               category: { type: string, nullable: true }
     *     responses:
     *       201:
     *         description: Created
     *       401:
     *         description: Unauthorized
     *       403:
     *         description: Forbidden
     */
    const {
      title,
      description,
      target_amount,
      asset_type,
      deadline,
      milestones,
      min_contribution,
      max_contribution,
      reward_tiers,
      template_id,
      category,
      country,
    } = req.body;
    const normalizedCountry =
      typeof country === 'string' && country.trim() ? country.trim().slice(0, 80) : null;

    let normalizedMilestones;
    try {
      normalizedMilestones = normalizeMilestonesInput(milestones);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Reward tiers are optional. Validate up front (asset must match the campaign).
    let normalizedTiers;
    try {
      normalizedTiers = validateTiersInput(reward_tiers, asset_type);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    if (template_id) {
      const { rows: templateRows } = await db.query(
        'SELECT id FROM campaign_templates WHERE id = $1 AND is_active = TRUE',
        [template_id]
      );
      if (!templateRows.length) {
        return res.status(400).json({ error: 'Selected campaign template is unavailable' });
      }
    }

    // Get creator's info
    const { rows: userRows } = await db.query(
      'SELECT email, wallet_public_key, kyc_status, verification_status, verification_tier FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });

    if (isKycRequiredForCampaigns() && userRows[0].kyc_status !== 'verified') {
      return res.status(403).json({
        error: 'Verify your identity before creating a campaign.',
        code: 'KYC_REQUIRED',
        kyc_status: userRows[0].kyc_status,
      });
    }

    // Tier-based campaign goal limit
    if (isKycRequiredForCampaigns()) {
      const userTier = userRows[0].verification_tier || 'none';
      const tierLimit = getTierLimit(userTier);
      const goalAmount = parseFloat(target_amount);

      if (tierLimit === 0 && userTier === 'none') {
        return res.status(403).json({
          error: 'Verify your identity before creating a campaign.',
          code: 'KYC_REQUIRED',
          verification_tier: userTier,
        });
      }

      if (goalAmount > tierLimit) {
        const upgradePath =
          userTier === 'basic'
            ? 'Upgrade to Standard verification (ID + address) to run campaigns up to $50,000.'
            : userTier === 'standard'
              ? 'Upgrade to Enhanced verification (ID + address + liveness) for unlimited campaign goals.'
              : 'Complete identity verification to create campaigns.';
        return res.status(403).json({
          error: `Campaign goal of $${goalAmount.toLocaleString()} exceeds your ${userTier} tier limit of $${tierLimit.toLocaleString()}.`,
          code: 'TIER_LIMIT_EXCEEDED',
          tier_limit: tierLimit,
          verification_tier: userTier,
          upgrade_path: upgradePath,
        });
      }
    }

    const creatorPublicKey = userRows[0].wallet_public_key;
    const creatorEmail = userRows[0].email;

    const contentFingerprint = getSimhash(`${title} ${description || ''}`);
    let isFlaggedDuplicate = false;

    const { rows: existingCampaigns } = await db.query(
      'SELECT content_fingerprint FROM campaigns WHERE content_fingerprint IS NOT NULL AND status != $1',
      ['failed']
    );

    for (const c of existingCampaigns) {
      if (simhashSimilarity(contentFingerprint, c.content_fingerprint) > 0.9) {
        isFlaggedDuplicate = true;
        break;
      }
    }

    // Generate the campaign keypair locally before any on-chain or DB writes.
    // This gives us the wallet_public_key for the DB record without a network call,
    // eliminating the risk of an orphaned Stellar wallet if the DB insert fails.
    const campaignKeypair = Keypair.random();
    const walletPublicKey = campaignKeypair.publicKey();

    // Deploy Soroban contract instances
    const platformPublicKey = Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY).publicKey();
    const platformFeeBps = parseInt(process.env.PLATFORM_FEE_BPS || '0', 10);
    const deadlineUnix = deadline ? Math.floor(new Date(deadline).getTime() / 1000) : 0;

    // Use a default asset contract address based on asset type. On testnet, the
    // USDC token contract address may differ from the issuer. We use the issuer
    // as a reasonable default for v1; production deployments should set
    // ASSET_CONTRACT_ADDRESS in env and populate it from the Stellar asset contract.
    const assetContractAddress = process.env.USDC_CONTRACT_ADDRESS || process.env.USDC_ISSUER;

    let escrowContractId = null;
    let milestonesContractId = null;
    let contractDeploymentStatus;
    let contractDeploymentError = null;
    let campaignStatus = 'active';
    try {
      ({ escrowContractId, milestonesContractId } = await deployCampaignContracts({
        creatorPublicKey,
        platformPublicKey,
        campaignId: req.body.title + Date.now(),
        targetAmount: toStroops(target_amount),
        deadlineUnix,
        assetContractAddress,
        platformFeeBps,
        milestones: normalizedMilestones,
        signerSecret: process.env.PLATFORM_SECRET_KEY,
      }));
      contractDeploymentStatus = 'deployed';
    } catch (err) {
      logger.error('Soroban contract deployment failed during campaign creation', {
        error: err.message,
        creatorUserId: req.user.userId,
      });
      contractDeploymentStatus = 'failed';
      contractDeploymentError = err.message;
      // Never activate a campaign with missing/failed contract wiring (#809).
      campaignStatus = 'draft';
      escrowContractId = null;
      milestonesContractId = null;

      Sentry.withScope(scope => {
        scope.setLevel('error');
        scope.setTag('campaign_creation', 'contract_deployment');
        scope.setContext('deployment', {
          creatorUserId: req.user.userId,
          error: err.message,
        });
        Sentry.captureMessage(
          `Contract deployment failed during campaign creation: ${err.message}`
        );
      });
    }
    const contractAddress = escrowContractId || null;

    // Insert the campaign DB record BEFORE creating the Stellar wallet so that
    // a DB failure never leaves an untracked (orphaned) on-chain wallet.
    const client = await db.connect();
    let campaign;
    try {
      await client.query('BEGIN');
      if (template_id) {
        const { rows: templateRows } = await client.query(
          'SELECT id FROM campaign_templates WHERE id = $1 AND is_active = TRUE FOR UPDATE',
          [template_id]
        );
        if (!templateRows.length) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Selected campaign template is unavailable' });
        }
      }
      const { rows } = await client.query(
        `INSERT INTO campaigns
         (title, description, target_amount, asset_type, wallet_public_key, creator_id, deadline, 
          min_contribution, max_contribution, escrow_contract_id, milestones_contract_id, platform_fee_bps,
          contract_address, contract_deployed_at, content_fingerprint, is_flagged_duplicate,
          contract_deployment_status, contract_deployment_error, last_deployment_attempt_at, template_id, category, country,
          status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       RETURNING ${publicCampaignColumnList('')}`,
        [
          title,
          description,
          target_amount,
          asset_type,
          walletPublicKey,
          req.user.userId,
          deadline,
          min_contribution || null,
          max_contribution || null,
          escrowContractId,
          milestonesContractId,
          platformFeeBps,
          contractAddress,
          contractDeploymentStatus === 'deployed' ? new Date() : null,
          contentFingerprint,
          isFlaggedDuplicate,
          contractDeploymentStatus,
          contractDeploymentError,
          new Date(),
          template_id || null,
          category || null,
          normalizedCountry,
          campaignStatus,
        ]
      );
      campaign = rows[0];

      await client.query(
        `INSERT INTO campaign_members
         (campaign_id, user_id, email, role, accepted_at)
       VALUES ($1, $2, $3, $4, NOW())`,
        [campaign.id, req.user.userId, creatorEmail, 'owner']
      );

      for (const milestone of normalizedMilestones) {
        await client.query(
          `INSERT INTO milestones
           (campaign_id, title, description, release_percentage, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
          [
            campaign.id,
            milestone.title,
            milestone.description,
            milestone.release_percentage,
            milestone.sort_order,
          ]
        );
      }

      if (normalizedTiers.length) {
        await insertTiers(client, campaign.id, normalizedTiers);
      }

      if (template_id) {
        await client.query(
          'UPDATE campaign_templates SET use_count = use_count + 1, updated_at = NOW() WHERE id = $1',
          [template_id]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error('[campaigns] DB insert failed during campaign creation', {
        creatorUserId: req.user.userId,
        error: err.message,
      });
      return res.status(500).json({ error: 'Campaign could not be saved.' });
    } finally {
      client.release();
    }

    // Now create the Stellar wallet on-chain. The DB record already exists, so
    // even if this fails we have tracked state and can retry later.
    try {
      await createCampaignWallet(creatorPublicKey, campaignKeypair);
    } catch (err) {
      logger.error(
        '[campaigns] Stellar wallet creation failed after DB insert. Campaign orphaned:',
        {
          campaign_id: campaign.id,
          publicKey: walletPublicKey,
          error: err.message,
        }
      );
      // Best-effort cleanup: mark the campaign so support can investigate
      await db
        .query(
          `UPDATE campaigns SET contract_deployment_status = 'failed', contract_deployment_error = $2 WHERE id = $1`,
          [campaign.id, `Wallet creation failed: ${err.message}`]
        )
        .catch(() => {});
      return res.status(500).json({
        error: 'Campaign saved but wallet creation failed. Please contact support.',
      });
    }

    watchCampaignWallet(campaign.id, walletPublicKey);

    // The creation response is the campaign row the creator just wrote: never
    // echo internal columns (content_fingerprint, fraud_*, wallet key) back.
    res.status(201).json(stripInternalCampaignFields(campaign));
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/tiers:
 *   get:
 *     tags: [Campaigns]
 *     summary: List a campaign's reward tiers with remaining availability
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: List of reward tiers }
 *       404: { description: Campaign not found }
 */
router.get(
  '/:id/tiers',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT id FROM campaigns WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Campaign not found' });
    const tiers = await listTiersWithAvailability(req.params.id);
    res.json(tiers);
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/tiers:
 *   post:
 *     tags: [Campaigns]
 *     summary: Add one or more reward tiers to an existing campaign (creator only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201: { description: Updated list of reward tiers }
 *       400: { description: Invalid input or tier cap exceeded }
 *       403: { description: Forbidden }
 *       404: { description: Campaign not found }
 */
router.post(
  '/:id/tiers',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;

    const { rows: campaignRows } = await db.query(
      'SELECT asset_type FROM campaigns WHERE id = $1',
      [campaignId]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });
    const assetType = campaignRows[0].asset_type;

    // Accept either a single tier object or an array of tiers.
    const input = Array.isArray(req.body) ? req.body : [req.body];
    let normalizedTiers;
    try {
      normalizedTiers = validateTiersInput(input, assetType);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!normalizedTiers.length) {
      return res.status(400).json({ error: 'At least one reward tier is required' });
    }

    const { rows: countRows } = await db.query(
      'SELECT COUNT(*)::int AS n FROM reward_tiers WHERE campaign_id = $1',
      [campaignId]
    );
    if (countRows[0].n + normalizedTiers.length > MAX_TIERS_PER_CAMPAIGN) {
      return res.status(400).json({
        error: `A campaign can have at most ${MAX_TIERS_PER_CAMPAIGN} reward tiers`,
      });
    }

    try {
      await withTransaction(client => insertTiers(client, campaignId, normalizedTiers), db);
    } catch (err) {
      logger.error('[campaigns] add reward tiers failed', { error: err.message });
      return res.status(500).json({ error: 'Could not add reward tiers' });
    }

    const tiers = await listTiersWithAvailability(campaignId);
    res.status(201).json(tiers);
  })
);

// PATCH /campaigns/:id - Update campaign (title, description, deadline, country, target_amount, min/max contribution, max_per_user)
router.patch(
  '/:id',
  requireAuth,
  updateCampaignValidation,
  createValidateRequest(422),
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;

    // Check if campaign exists and belongs to user
    const { rows: campaignRows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];
    const userRole = await resolveUserCampaignRole(
      campaignId,
      req.user.userId,
      req.user.role === 'admin'
    );
    if (!canEditCampaignContent(userRole)) {
      return res.status(403).json({ error: 'You do not have permission to edit this campaign' });
    }

    // Refresh campaign status to check current state
    await refreshCampaignStatus(campaignId);

    const { rows: updatedStatusRows } = await db.query(
      'SELECT status FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const currentStatus = updatedStatusRows[0].status;

    // Only allow editing active or funded campaigns
    if (!['active', 'funded'].includes(currentStatus)) {
      return res.status(422).json({
        error: `Cannot edit a campaign with status: ${currentStatus}`,
      });
    }

    // Prepare update object from validated body
    const updates = {};
    const updateParams = [];
    let paramIndex = 1;

    const allowedFields = [
      'title',
      'category',
      'description',
      'target_amount',
      'deadline',
      'country',
      'min_contribution',
      'max_contribution',
      'max_per_user',
    ];

    for (const field of allowedFields) {
      const value = req.body[field];
      if (value === undefined) continue;

      if (field === 'title') {
        const cleanTitle = stripHtml(value);
        if (!cleanTitle) {
          return res.status(422).json({ error: 'Title cannot be empty' });
        }
        updates.title = cleanTitle;
        updateParams.push(['title', cleanTitle, `$${paramIndex++}`]);
      } else if (field === 'category') {
        const cleanCategory = stripHtml(value);
        updates.category = cleanCategory ? cleanCategory.slice(0, 50) : null;
        updateParams.push(['category', updates.category, `$${paramIndex++}`]);
      } else if (field === 'description') {
        const cleanDesc = stripHtml(value);
        updates.description = cleanDesc;
        updateParams.push(['description', cleanDesc, `$${paramIndex++}`]);
      } else if (field === 'target_amount') {
        const newTarget = Number(value);
        // Validate budget constraints
        const { rows: budgetRows } = await db.query(
          `SELECT SUM(amount) as total_budget FROM campaign_budget_categories WHERE campaign_id = $1`,
          [campaignId]
        );
        const totalBudget = Number(budgetRows[0].total_budget || 0);

        if (totalBudget > 0 && Math.abs(totalBudget - newTarget) > 0.0001) {
          return res.status(422).json({
            error: `Cannot update target amount to ${newTarget}: existing budget breakdown total is ${totalBudget}. Clear the budget breakdown first.`,
          });
        }

        updates.target_amount = newTarget;
        updateParams.push(['target_amount', newTarget, `$${paramIndex++}`]);
      } else if (field === 'deadline') {
        updates.deadline = value === '' ? null : value;
        updateParams.push(['deadline', updates.deadline, `$${paramIndex++}`]);
      } else if (field === 'country') {
        const normalizedCountry =
          typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : null;
        updates.country = normalizedCountry;
        updateParams.push(['country', normalizedCountry, `$${paramIndex++}`]);
      } else if (['min_contribution', 'max_contribution', 'max_per_user'].includes(field)) {
        updates[field] = value === '' ? null : Number(value);
        updateParams.push([field, updates[field], `$${paramIndex++}`]);
      }
    }

    // Check if any valid updates were provided
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Check for invalid fields in request body
    for (const field of Object.keys(req.body)) {
      if (!allowedFields.includes(field)) {
        return res.status(422).json({
          error: `Cannot update field: ${field}`,
        });
      }
    }

    // Build and execute update query
    const setClause = updateParams
      .map(([field, , placeholder]) => `${field} = ${placeholder}`)
      .join(', ');
    const values = updateParams.map(([, value]) => value);
    values.push(campaignId);
    values.push(currentStatus);
    const statusParamIndex = paramIndex + 1;

    const query = `
    UPDATE campaigns
    SET ${setClause}
    WHERE id = $${paramIndex} AND status = $${statusParamIndex}
    RETURNING ${publicCampaignColumnList('')}
  `;

    const updatedRows = await withTransaction(async client => {
      // Save previous state to revisions
      await client.query(
        `INSERT INTO campaign_revisions (campaign_id, title, description, target_amount)
       VALUES ($1, $2, $3, $4)`,
        [campaign.id, campaign.title, campaign.description, campaign.target_amount]
      );

      const result = await client.query(query, values);
      return result.rows;
    }, db);

    if (!updatedRows.length) {
      const { rows: checkRows } = await db.query('SELECT status FROM campaigns WHERE id = $1', [
        campaignId,
      ]);
      if (!checkRows.length) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      return res.status(422).json({
        error: `Cannot edit a campaign with status: ${checkRows[0].status}`,
      });
    }

    // Invalidate cached campaign payloads so any downstream consumer (e.g. the
    // contribution receipt email path or embed widgets) never serves a stale
    // campaign title after a rename (#733).
    cache.invalidate(`campaigns:id:${campaignId}`);
    cache.invalidatePrefix('campaigns:list:');

    // Enumerate the public columns instead of returning the raw row so editing
    // a campaign can never hand the creator the fraud/duplicate internals.
    res.json(stripInternalCampaignFields(updatedRows[0]));
  })
);

router.post(
  '/:id/cover-image',
  requireAuth,
  requireCampaignMember('owner', 'editor'),
  (req, res, next) => {
    upload.single('cover_image')(req, res, err => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE' || err.status === 413) {
          return res.status(413).json({
            error: {
              code: 'LIMIT_FILE_SIZE',
              message: 'File exceeds maximum allowed size of 5MB',
              fields: { cover_image: 'File exceeds maximum allowed size of 5MB' },
            },
          });
        }
        return res.status(422).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: err.message || 'Invalid cover image upload',
            fields: { cover_image: err.message || 'Invalid file' },
          },
        });
      }
      next();
    });
  },
  async (req, res) => {
    if (!req.file) {
      return res.status(422).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'cover_image is required',
          fields: { cover_image: 'No image uploaded' },
        },
      });
    }

    try {
      const coverImageUrl = await uploadCampaignCoverImage(req.params.id, req.file);
      const { rows: updatedRows } = await db.query(
        'UPDATE campaigns SET cover_image_url = $1 WHERE id = $2 RETURNING *',
        [coverImageUrl, req.params.id]
      );
      cache.invalidate(`campaigns:id:${req.params.id}`);
      cache.invalidatePrefix('campaigns:list:');
      res.json(stripInternalCampaignFields(updatedRows[0]));
    } catch (err) {
      if (err.status === 413 || err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: {
            code: 'LIMIT_FILE_SIZE',
            message: 'File exceeds maximum allowed size of 5MB',
            fields: { cover_image: 'File exceeds maximum allowed size of 5MB' },
          },
        });
      }
      if (err.status === 415) {
        return res.status(415).json({
          error: {
            code: 'UNSUPPORTED_MEDIA_TYPE',
            message: err.message || 'Unsupported Media Type',
            fields: { cover_image: err.message || 'Unsupported Media Type' },
          },
        });
      }
      return res.status(500).json({ error: 'Could not upload campaign cover image' });
    }
  }
);

router.get(
  '/:id/updates',
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 10, max: 50 });
    const { rows } = await db.query(
      `SELECT cu.id, cu.campaign_id, cu.author_id, cu.title, cu.body, cu.created_at, u.name AS author_name
     FROM campaign_updates cu
     JOIN users u ON u.id = cu.author_id
     WHERE cu.campaign_id = $1
     ORDER BY cu.created_at DESC
     LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json(rows);
  })
);

router.post(
  '/:id/updates',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  createCampaignUpdateValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { title, body } = req.body;

    const { rows } = await db.query(
      `INSERT INTO campaign_updates (campaign_id, author_id, title, body)
     VALUES ($1, $2, $3, $4)
     RETURNING id, campaign_id, author_id, title, body, created_at`,
      [req.params.id, req.user.userId, title.trim(), body.trim()]
    );
    res.status(201).json(rows[0]);
  })
);

// POST /campaigns/:id/members/invite — owner/manager invites by email (7-day token)
router.post(
  '/:id/members/invite',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const { email, role } = req.body;
    if (!email || !role) return res.status(422).json({ error: 'Email and role are required' });
    if (!isValidRole(role)) {
      return res
        .status(422)
        .json({ error: 'Invalid role. Must be owner, manager, editor, or viewer' });
    }
    // Never trust the client: only owners may grant the owner role.
    if (!canAssignRole(req.campaignRole, role)) {
      return res.status(403).json({ error: 'Only an owner can assign the owner role' });
    }

    const { rows: campaignRows } = await db.query('SELECT title FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    const { member } = await createCampaignInvite({
      campaignId: req.params.id,
      email,
      role,
      invitedByUserId: req.user.userId,
      campaignTitle: campaignRows[0]?.title,
    });
    res.status(201).json(member);
  })
);

// GET /campaigns/:id/members — team list (owner/manager)
router.get(
  '/:id/members',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = parsePagination(req.query, { limit: 20, max: 100 });

    const countResult = await db.query(
      'SELECT COUNT(*)::int AS total FROM campaign_members WHERE campaign_id = $1',
      [req.params.id]
    );
    const total = countResult.rows[0].total;

    const { rows } = await db.query(
      `SELECT cm.id, cm.user_id, cm.email, cm.role, cm.accepted_at, cm.created_at,
            cm.invite_expires_at,
            u.name AS user_name
     FROM campaign_members cm
     LEFT JOIN users u ON u.id = cm.user_id
     WHERE cm.campaign_id = $1
     ORDER BY cm.created_at ASC
     LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    res.json({ data: rows, total, limit, offset });
  })
);

// PATCH /campaigns/:id/members/:userId — change role (owner only)
router.patch(
  '/:id/members/:userId',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    if (!role || !isValidRole(role)) {
      return res
        .status(422)
        .json({ error: 'Invalid role. Must be owner, manager, editor, or viewer' });
    }

    const { rows } = await db.query(
      `UPDATE campaign_members
     SET role = $1
     WHERE campaign_id = $2 AND user_id = $3 AND accepted_at IS NOT NULL
     RETURNING id, campaign_id, user_id, role, accepted_at`,
      [role, req.params.id, req.params.userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Member not found' });
    }

    res.json(rows[0]);
  })
);

// POST /campaigns/:id/members/:memberId/resend — resend pending invite
router.post(
  '/:id/members/:memberId/resend',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const { rows: campaignRows } = await db.query('SELECT title FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    const { member } = await resendCampaignInvite({
      memberId: req.params.memberId,
      campaignId: req.params.id,
      campaignTitle: campaignRows[0]?.title,
    });
    res.json(member);
  })
);

// DELETE /campaigns/:id/members/invites/:memberId — cancel pending invite
router.delete(
  '/:id/members/invites/:memberId',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    await cancelCampaignInvite({
      memberId: req.params.memberId,
      campaignId: req.params.id,
    });
    res.json({ cancelled: true });
  })
);

// DELETE /campaigns/:id/members/:userId — remove member (owner) or leave team
router.delete(
  '/:id/members/:userId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const memberUserId = req.params.userId;
    const isSelf = String(memberUserId) === String(req.user.userId);

    const actorRole = await resolveUserCampaignRole(
      req.params.id,
      req.user.userId,
      req.user.role === 'admin'
    );

    if (!isSelf && !canManageMembers(actorRole)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const { rows: targetRows } = await db.query(
      `SELECT role, accepted_at FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2`,
      [req.params.id, memberUserId]
    );

    if (!targetRows.length) {
      return res.status(404).json({ error: 'Member not found' });
    }

    if (targetRows[0].role === 'owner' && targetRows[0].accepted_at) {
      const ownerCount = await countAcceptedOwners(req.params.id);
      if (ownerCount <= 1) {
        return res
          .status(409)
          .json({ error: 'Cannot remove the last owner from the campaign team' });
      }
    }

    const { rows } = await db.query(
      `DELETE FROM campaign_members
     WHERE campaign_id = $1 AND user_id = $2
     RETURNING id`,
      [req.params.id, memberUserId]
    );

    res.json({ message: 'Member removed successfully', id: rows[0].id });
  })
);

// POST /campaigns/:id/members/accept — accept invitation (token in body, legacy)
router.post(
  '/:id/members/accept',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { token: inviteToken } = req.body;
    if (!inviteToken) return res.status(422).json({ error: 'Invitation token is required' });

    const { rows: userRows } = await db.query('SELECT email FROM users WHERE id = $1', [
      req.user.userId,
    ]);
    const member = await acceptCampaignInvite({
      inviteToken,
      userId: req.user.userId,
      userEmail: userRows[0]?.email,
    });
    res.json(member);
  })
);

const {
  getCampaignAnalytics,
  getCampaignContributors,
  getCampaignBackers,
} = require('../services/analyticsService');
// PATCH /campaigns/:id/visibility — toggle is_hidden for a campaign (owner or admin only)
router.patch(
  '/:id/visibility',
  requireAuth,
  asyncHandler(async (req, res) => {
    const campaignId = req.params.id;

    const { rows: campaignRows } = await db.query('SELECT * FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    if (!campaignRows.length) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = campaignRows[0];
    const userRole = await resolveUserCampaignRole(
      campaignId,
      req.user.userId,
      req.user.role === 'admin'
    );

    if (userRole !== 'owner') {
      return res.status(403).json({ error: 'Only the campaign owner can change visibility' });
    }

    const newHidden = req.body.is_hidden;
    if (typeof newHidden !== 'boolean') {
      return res.status(422).json({ error: 'is_hidden must be a boolean' });
    }

    const { rows: updatedRows } = await db.query(
      'UPDATE campaigns SET is_hidden = $1 WHERE id = $2 RETURNING *',
      [newHidden, campaignId]
    );

    // Log to admin_actions for audit trail
    try {
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, action_type, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          req.user.userId,
          newHidden ? 'campaign_hidden' : 'campaign_unhidden',
          'campaign',
          campaignId,
          JSON.stringify({
            campaign_title: campaign.title,
            previous_is_hidden: campaign.is_hidden,
            new_is_hidden: newHidden,
          }),
        ]
      );
    } catch (err) {
      logger.warn('Failed to log visibility change to admin_actions', {
        campaign_id: campaignId,
        error: err.message,
      });
    }

    res.json({ is_hidden: updatedRows[0].is_hidden });
  })
);

// GET /campaigns/:id/analytics — full contribution analytics
router.get(
  '/:id/analytics',
  requireAuth,
  requireCampaignMember(),
  asyncHandler(async (req, res) => {
    const data = await getCampaignAnalytics(req.params.id);
    if (!data) return res.status(404).json({ error: 'Campaign not found' });
    res.json(data);
  })
);

// GET /campaigns/:id/analytics/contributors — country breakdown, repeat vs first-time
router.get(
  '/:id/analytics/contributors',
  requireAuth,
  requireCampaignMember(),
  asyncHandler(async (req, res) => {
    const data = await getCampaignContributors(req.params.id);
    res.json(data);
  })
);

// GET /campaigns/:id/analytics/backers — backer growth, leaderboard, repeat rate
router.get(
  '/:id/analytics/backers',
  requireAuth,
  requireCampaignMember(),
  asyncHandler(async (req, res) => {
    const data = await getCampaignBackers(req.params.id);
    res.json(data);
  })
);

// GET /campaigns/:id/referral — get or create a referral code for the authenticated user
router.get(
  '/:id/referral',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows: existing } = await db.query(
      `SELECT cr.id, cr.referral_code, cr.click_count, cr.contribution_count
     FROM campaign_referrals cr
     WHERE cr.campaign_id = $1 AND cr.referrer_user_id = $2`,
      [req.params.id, req.user.userId]
    );

    if (existing.length) {
      const row = existing[0];
      return res.json({
        referral_code: row.referral_code,
        referral_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}?ref=${row.referral_code}`,
        click_count: row.click_count,
        contribution_count: row.contribution_count,
      });
    }

    const code = await generateUniqueReferralCode(db);
    const { rows: inserted } = await db.query(
      `INSERT INTO campaign_referrals (campaign_id, referrer_user_id, referral_code)
     VALUES ($1, $2, $3)
     RETURNING referral_code, click_count, contribution_count`,
      [req.params.id, req.user.userId, code]
    );
    const row = inserted[0];
    res.status(201).json({
      referral_code: row.referral_code,
      referral_url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/campaigns/${req.params.id}?ref=${row.referral_code}`,
      click_count: row.click_count,
      contribution_count: row.contribution_count,
    });
  })
);

// GET /campaigns/:id/referrals — creator only; list top referrers
router.get(
  '/:id/referrals',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT cr.referral_code, cr.click_count, cr.contribution_count, cr.created_at,
            u.name AS referrer_name, u.id AS referrer_id
     FROM campaign_referrals cr
     JOIN users u ON u.id = cr.referrer_user_id
     WHERE cr.campaign_id = $1
     ORDER BY cr.contribution_count DESC, cr.click_count DESC`,
      [req.params.id]
    );
    res.json(rows);
  })
);

// ── Referral & affiliate program (#675) ──────────────────────────────────────

/**
 * @openapi
 * /api/campaigns/{id}/referrals:
 *   post:
 *     tags: [Campaigns]
 *     summary: Enable or update the campaign's referral program (creator only)
 *     description: >
 *       Creates the referral program for a campaign, or updates the terms of an
 *       existing one. Updating the commission rate does not invalidate referral
 *       links that have already been issued.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [commissionPercentage, maxReferrers]
 *             properties:
 *               commissionPercentage:
 *                 type: number
 *                 description: Percentage of each referred contribution paid to the referrer (1-20)
 *                 example: 10
 *               maxReferrers:
 *                 type: integer
 *                 description: Maximum number of referrers that may claim a link (1-100)
 *                 example: 25
 *     responses:
 *       201: { description: Referral program created or updated }
 *       400: { description: commissionPercentage or maxReferrers outside the allowed range }
 *       403: { description: Forbidden }
 *       404: { description: Campaign not found }
 */
// POST /campaigns/:id/referrals — creator enables referrals on the campaign
router.post(
  '/:id/referrals',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { commissionPercentage, maxReferrers } = req.body || {};
    try {
      const program = await createReferralProgram(req.params.id, {
        commissionPercentage,
        maxReferrers,
      });
      res.status(201).json(program);
    } catch (err) {
      if (err.statusCode === 400) {
        return res.status(400).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/referrals/program:
 *   get:
 *     tags: [Campaigns]
 *     summary: Get the campaign's public referral program terms
 *     description: >
 *       Public endpoint used by the share page to show the commission rate and
 *       how many of the referrer slots have already been claimed.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Program terms plus the current referrer_count }
 *       404: { description: This campaign does not have a referral program }
 */
// GET /campaigns/:id/referrals/program — public program terms
router.get(
  '/:id/referrals/program',
  asyncHandler(async (req, res) => {
    const program = await getReferralProgram(req.params.id);
    if (!program)
      return res.status(404).json({ error: 'This campaign does not have a referral program' });
    const { rows } = await db.query(
      'SELECT COUNT(*)::int AS total FROM referral_links WHERE campaign_id = $1',
      [req.params.id]
    );
    res.json({ ...program, referrer_count: rows[0]?.total || 0 });
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/referrals/links:
 *   post:
 *     tags: [Campaigns]
 *     summary: Claim a trackable referral link for the authenticated user
 *     description: >
 *       Issues a unique 8-character referral code for the caller. The call is
 *       idempotent: a user who already holds a link for this campaign gets the
 *       same code back with a 200 instead of a 201. Contributions made through
 *       the returned shareUrl are attributed on-chain via the Stellar
 *       transaction memo (`ref:<code>`).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: The caller already held a link; the existing code is returned
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: string, example: "a1b2c3d4" }
 *                 shareUrl: { type: string, example: "https://crowdpay.com/c/<campaignId>?ref=a1b2c3d4" }
 *       201: { description: A new referral link was issued }
 *       404: { description: This campaign does not have a referral program }
 *       409: { description: REFERRER_LIMIT_REACHED - the maxReferrers cap is full }
 */
// POST /campaigns/:id/referrals/links — any registered user claims a referrer link
router.post(
  '/:id/referrals/links',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const { code, shareUrl, created } = await createReferralLink({
        campaignId: req.params.id,
        userId: req.user.userId,
      });
      res.status(created ? 201 : 200).json({ code, shareUrl });
    } catch (err) {
      if (err.statusCode === 409 || err.statusCode === 404) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/referrals/commissions:
 *   get:
 *     tags: [Campaigns]
 *     summary: Referrer breakdown with commission owed (creator only)
 *     description: >
 *       Powers the campaign analytics Referrals tab: every referrer with their
 *       referred contribution count, total referred amount, and the commission
 *       still owed to them at the next withdrawal.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Program terms and the per-referrer commission breakdown }
 *       403: { description: Forbidden }
 *       404: { description: This campaign does not have a referral program }
 */
// GET /campaigns/:id/referrals/commissions — creator-only referrer breakdown
router.get(
  '/:id/referrals/commissions',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const data = await listCampaignReferrers(req.params.id);
    if (!data.program)
      return res.status(404).json({ error: 'This campaign does not have a referral program' });
    res.json(data);
  })
);

const isTestEnv = process.env.NODE_ENV === 'test';
const shareLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: isTestEnv ? 100000 : 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user?.userId || ipKeyGenerator(req.ip),
  skip: () => isTestEnv,
});

const SHARE_DEDUP_WINDOW = '1 hour';

// POST /campaigns/:id/share — increment share_count, deduped per actor within
// a rolling window and rate-limited (issue #704). Stays anonymous-friendly
// (no requireAuth) since social shares come from logged-out visitors too;
// optionalAuth lets us dedup by user id when one is available, which is more
// robust than IP alone (e.g. many users behind the same NAT/office IP).
router.post(
  '/:id/share',
  shareLimiter,
  optionalAuth,
  asyncHandler(async (req, res) => {
    const { rows: campaignRows } = await db.query(
      'SELECT id, share_count FROM campaigns WHERE id = $1',
      [req.params.id]
    );
    if (!campaignRows.length) return res.status(404).json({ error: 'Campaign not found' });

    const actorHash = crypto
      .createHash('sha256')
      .update(req.user?.userId ? `user:${req.user.userId}` : `ip:${req.ip}`)
      .digest('hex');

    const { rows: dedupRows } = await db.query(
      `INSERT INTO campaign_share_dedup (campaign_id, actor_hash, last_shared_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (campaign_id, actor_hash) DO UPDATE
       SET last_shared_at = NOW()
       WHERE campaign_share_dedup.last_shared_at < NOW() - INTERVAL '${SHARE_DEDUP_WINDOW}'
     RETURNING campaign_id`,
      [req.params.id, actorHash]
    );

    if (!dedupRows.length) {
      // Duplicate share from this actor within the window — don't recount it.
      return res.json({ share_count: campaignRows[0].share_count });
    }

    const { rows } = await db.query(
      'UPDATE campaigns SET share_count = share_count + 1 WHERE id = $1 RETURNING share_count',
      [req.params.id]
    );
    res.json({ share_count: rows[0].share_count });
  })
);

// ── Stretch Goals (#585) ──────────────────────────────────────────────────────

// GET /campaigns/:id/stretch-goals — public list
router.get(
  '/:id/stretch-goals',
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, title, description, amount, sort_order, created_at
     FROM campaign_stretch_goals
     WHERE campaign_id = $1
     ORDER BY sort_order ASC, amount ASC`,
      [req.params.id]
    );
    res.json(rows);
  })
);

// POST /campaigns/:id/stretch-goals — owner only
router.post(
  '/:id/stretch-goals',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { title, description, amount, sort_order } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'title is required' });
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be a positive number' });
    }
    const { rows } = await db.query(
      `INSERT INTO campaign_stretch_goals (campaign_id, title, description, amount, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, description, amount, sort_order, created_at`,
      [req.params.id, title.trim(), description?.trim() || null, Number(amount), sort_order ?? 0]
    );
    res.status(201).json(rows[0]);
  })
);

// PATCH /campaigns/:id/stretch-goals/:goalId — owner only
router.patch(
  '/:id/stretch-goals/:goalId',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { title, description, amount, sort_order } = req.body;
    const updates = [];
    const values = [];
    let idx = 1;
    if (title !== undefined) {
      updates.push(`title = $${idx++}`);
      values.push(title.trim());
    }
    if (description !== undefined) {
      updates.push(`description = $${idx++}`);
      values.push(description?.trim() || null);
    }
    if (amount !== undefined) {
      if (isNaN(Number(amount)) || Number(amount) <= 0)
        return res.status(400).json({ error: 'amount must be positive' });
      updates.push(`amount = $${idx++}`);
      values.push(Number(amount));
    }
    if (sort_order !== undefined) {
      updates.push(`sort_order = $${idx++}`);
      values.push(sort_order);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    updates.push(`updated_at = NOW()`);
    values.push(req.params.goalId, req.params.id);
    const { rows } = await db.query(
      `UPDATE campaign_stretch_goals SET ${updates.join(', ')}
     WHERE id = $${idx} AND campaign_id = $${idx + 1}
     RETURNING id, title, description, amount, sort_order`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Stretch goal not found' });
    res.json(rows[0]);
  })
);

// DELETE /campaigns/:id/stretch-goals/:goalId — owner only
router.delete(
  '/:id/stretch-goals/:goalId',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const { rows } = await db.query(
      `DELETE FROM campaign_stretch_goals WHERE id = $1 AND campaign_id = $2 RETURNING id`,
      [req.params.goalId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Stretch goal not found' });
    res.status(204).end();
  })
);

// ── Campaign Report Export (PDF) ──────────────────────────────────────────────

// Download a PDF report for the campaign (owner or admin only)
router.get(
  '/:id/report/export',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const report = await assembleReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const filename = reportFilename(report.campaign.id, report.campaign.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    streamCampaignReportPdf(report, res);
  })
);

// Generate a shareable signed URL for the report (owner or admin only)
router.get(
  '/:id/report/share',
  requireAuth,
  requireCampaignMember('owner'),
  asyncHandler(async (req, res) => {
    const report = await assembleReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const shareableUrl = generateSignedUrl(req.params.id, baseUrl);

    res.json({ url: shareableUrl, expires_in_seconds: 24 * 60 * 60 });
  })
);

// Serve a PDF report via signed URL (no auth required — token-verified)
router.get(
  '/:id/report/share/:token',
  asyncHandler(async (req, res) => {
    if (!verifySignedToken(req.params.token, req.params.id)) {
      return res.status(403).json({ error: 'Invalid or expired share link' });
    }

    const report = await assembleReport(req.params.id);
    if (!report) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const filename = reportFilename(report.campaign.id, report.campaign.title);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    streamCampaignReportPdf(report, res);
  })
);

// Soroban treasury endpoints (#687) live in their own router to keep this file
// from growing further; they are mounted under /api/campaigns/:id/treasury.
router.use('/:id/treasury', require('./treasury'));

let _refundService;
function getRefundService() {
  if (!_refundService) _refundService = require('../services/refundService');
  return _refundService;
}

router.get(
  '/:id/refunds/eligible',
  requireAuth,
  asyncHandler(async (req, res) => {
    const campaign = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const isOwner = campaign.rows[0].creator_id === req.user.userId;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const items = await getRefundService().getEligibleContributions(req.params.id);
    res.json({ items });
  })
);

router.get(
  '/:id/refunds',
  requireAuth,
  asyncHandler(async (req, res) => {
    const campaign = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const isOwner = campaign.rows[0].creator_id === req.user.userId;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });
    const result = await getRefundService().getCampaignRefunds(req.params.id, req.query);
    res.json(result);
  })
);

router.post(
  '/:id/refunds',
  requireAuth,
  asyncHandler(async (req, res) => {
    const campaign = await db.query('SELECT creator_id FROM campaigns WHERE id = $1', [
      req.params.id,
    ]);
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const isOwner = campaign.rows[0].creator_id === req.user.userId;
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

    const { contributionId, amount, reason, isForceRefund, adminNote } = req.body;
    if (!contributionId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'contributionId and positive amount are required' });
    }

    const refund = await getRefundService().processRefund({
      campaignId: req.params.id,
      contributionId,
      amount: parseFloat(amount),
      reason,
      initiatorId: req.user.userId,
      isForceRefund: isAdmin && !!isForceRefund,
      adminNote: isAdmin ? adminNote : null,
    });
    res.status(201).json(refund);
  })
);

// ---------------------------------------------------------------------------
// Campaign draft autosave + recoverable version history (#942)
// ---------------------------------------------------------------------------

function mapDraftError(err, res) {
  if (err.code === 'DRAFT_VERSION_CONFLICT') {
    return res
      .status(409)
      .json({ error: err.message, code: err.code, current_version: err.currentVersion });
  }
  if (err.statusCode === 404) {
    return res.status(404).json({ error: err.message });
  }
  throw err;
}

// Autosave editable draft fields with optimistic concurrency. `base_version`
// (or a `draft_version` body field) is the version the editor started from; a
// mismatch returns 409 and both versions stay recoverable.
router.put(
  '/:id/draft',
  requireAuth,
  requireCampaignMember('owner', 'manager', 'editor'),
  asyncHandler(async (req, res) => {
    try {
      const result = await draftVersionService.saveDraft({
        campaignId: req.params.id,
        actorId: req.user.userId,
        fields: req.body || {},
        expectedVersion: req.body?.base_version ?? req.body?.draft_version,
      });
      return res.status(200).json({
        draft_version: result.draftVersion,
        draft_saved_at: result.draftSavedAt,
        material_change: result.materialChange,
      });
    } catch (err) {
      return mapDraftError(err, res);
    }
  })
);

// List retained versions (metadata only) for the editor's history panel.
router.get(
  '/:id/draft/versions',
  requireAuth,
  requireCampaignMember('owner', 'manager', 'editor', 'viewer'),
  asyncHandler(async (req, res) => {
    const versions = await draftVersionService.listVersions({ campaignId: req.params.id });
    return res.json({ versions });
  })
);

// Preview a retained version using the stored snapshot.
router.get(
  '/:id/draft/versions/:versionId',
  requireAuth,
  requireCampaignMember('owner', 'manager', 'editor', 'viewer'),
  asyncHandler(async (req, res) => {
    const version = await draftVersionService.getVersion({
      campaignId: req.params.id,
      versionId: req.params.versionId,
    });
    if (!version) return res.status(404).json({ error: 'Draft version not found' });
    return res.json(version);
  })
);

// Restore a retained version. Creates a new current version; history is kept.
router.post(
  '/:id/draft/versions/:versionId/restore',
  requireAuth,
  requireCampaignMember('owner', 'manager', 'editor'),
  asyncHandler(async (req, res) => {
    try {
      const result = await draftVersionService.restoreVersion({
        campaignId: req.params.id,
        versionId: req.params.versionId,
        actorId: req.user.userId,
        expectedVersion: req.body?.base_version ?? req.body?.draft_version,
      });
      return res.json({
        draft_version: result.draftVersion,
        restored_from: result.restoredFrom,
        material_change: result.materialChange,
      });
    } catch (err) {
      return mapDraftError(err, res);
    }
  })
);

module.exports = router;

// ─── Reward-tier inventory + fulfillment (issue #958) ───────────────────────
const {
  getFulfillmentsByCampaign,
  getFulfillmentsByUser,
  updateFulfillmentStatus,
  getCampaignFulfillmentSummary,
} = require('../services/rewardTierService');

router.get(
  '/:id/fulfillments',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const items = await getFulfillmentsByCampaign(req.params.id, { status: req.query.status });
    const summary = await getCampaignFulfillmentSummary(req.params.id);
    res.json({ data: items, summary });
  })
);

router.patch(
  '/:id/fulfillments/:fulfillmentId',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const { status, tracking_number, carrier, notes } = req.body || {};
    if (!status) return res.status(422).json({ error: 'status is required' });
    try {
      const updated = await updateFulfillmentStatus(req.params.fulfillmentId, status, {
        trackingNumber: tracking_number,
        carrier,
        notes,
      });
      res.json(updated);
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  })
);

router.get(
  '/:id/fulfillments/export.csv',
  requireAuth,
  requireCampaignMember('owner', 'manager'),
  asyncHandler(async (req, res) => {
    const items = await getFulfillmentsByCampaign(req.params.id, { status: req.query.status });
    const headers = [
      'id',
      'tier_title',
      'status',
      'shipping_name',
      'shipping_address_line1',
      'shipping_address_line2',
      'shipping_city',
      'shipping_region',
      'shipping_postal_code',
      'shipping_country',
      'tracking_number',
      'carrier',
      'created_at',
    ];
    const escape = v => (v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`);
    const csv = [
      headers.join(','),
      ...items.map(r => headers.map(h => escape(r[h])).join(',')),
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fulfillments-${req.params.id}.csv"`
    );
    res.send(csv);
  })
);
