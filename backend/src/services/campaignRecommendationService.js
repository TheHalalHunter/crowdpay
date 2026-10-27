const db = require('../config/database');
const logger = require('../config/logger');
const { parsePagination } = require('../utils/pagination');

async function upsertRecommendationsForUser(userId) {
  if (!userId) return [];

  const { rows: profileRows } = await db.query(`SELECT id FROM users WHERE id = $1`, [userId]);
  if (!profileRows.length) return [];

  await db.query('DELETE FROM campaign_recommendations WHERE user_id = $1', [userId]);

  const { rows: interactionRows } = await db.query(
    `SELECT c.id AS campaign_id, c.category, c.asset_type
     FROM campaigns c
     WHERE c.deleted_at IS NULL
       AND c.status = 'active'
       AND c.is_hidden = FALSE
       AND c.is_flagged_duplicate = FALSE`,
    []
  );

  const campaigns = interactionRows || [];
  if (!campaigns.length) return [];

  const { rows: contributedRows } = await db.query(
    `SELECT DISTINCT ctr.campaign_id
     FROM contributions ctr
     JOIN users u ON u.wallet_public_key = ctr.sender_public_key
     WHERE u.id = $1`,
    [userId]
  );
  const contributedIds = new Set(contributedRows.map(row => row.campaign_id));

  const { rows: followedRows } = await db.query(
    `SELECT campaign_id FROM campaign_followers WHERE user_id = $1`,
    [userId]
  );
  const followedIds = new Set(followedRows.map(row => row.campaign_id));

  const { rows: similarUserRows } = await db.query(
    `SELECT DISTINCT u.id AS user_id
     FROM users u
     JOIN contributions ctr ON ctr.sender_public_key = u.wallet_public_key
     WHERE u.id <> $1
       AND ctr.campaign_id IN (
         SELECT DISTINCT ctr2.campaign_id
         FROM contributions ctr2
         JOIN users u2 ON u2.wallet_public_key = ctr2.sender_public_key
         WHERE u2.id = $1
       )`,
    [userId]
  );

  const similarUserIds = similarUserRows.map(row => row.user_id);
  const recommendations = [];

  for (const campaign of campaigns) {
    if (contributedIds.has(campaign.campaign_id) || followedIds.has(campaign.campaign_id)) {
      continue;
    }

    const { rows: dismissalRows } = await db.query(
      `SELECT 1 FROM campaign_recommendation_dismissals WHERE user_id = $1 AND campaign_id = $2`,
      [userId, campaign.campaign_id]
    );
    if (dismissalRows.length) continue;

    let score = 0;
    const reasons = [];

    if (followedIds.size) {
      const { rows: sameCategoryRows } = await db.query(
        `SELECT 1 FROM campaigns c
         WHERE c.id = $2
           AND c.category = $1`,
        [campaign.category, campaign.campaign_id]
      );
      if (sameCategoryRows.length) {
        score += 0.35;
        reasons.push('category-match');
      }
    }

    if (similarUserIds.length) {
      const { rows: similarContributionRows } = await db.query(
        `SELECT COUNT(*)::int AS count
         FROM contributions ctr
         JOIN users u ON u.wallet_public_key = ctr.sender_public_key
         WHERE u.id = ANY($1::uuid[])
           AND ctr.campaign_id = $2`,
        [similarUserIds, campaign.campaign_id]
      );
      const similarCount = similarContributionRows[0]?.count || 0;
      if (similarCount > 0) {
        score += Math.min(1.0, similarCount * 0.2);
        reasons.push('similar-contributors');
      }
    }

    if (campaign.asset_type === 'USDC') {
      score += 0.1;
      reasons.push('asset-fit');
    }

    if (score >= 0.3) {
      recommendations.push({
        userId,
        campaignId: campaign.campaign_id,
        score,
        reasons,
      });
    }
  }

  if (!recommendations.length) return [];

  const values = recommendations
    .map(
      (item, index) =>
        `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`
    )
    .join(', ');
  const params = [];
  for (const item of recommendations) {
    params.push(item.userId, item.campaignId, item.score, JSON.stringify(item.reasons));
  }

  await db.query(
    `INSERT INTO campaign_recommendations (user_id, campaign_id, score, reasons)
     VALUES ${values}`,
    params
  );

  return recommendations;
}

async function getRecommendedCampaigns(userId, options = {}) {
  if (!userId) return [];

  try {
    await upsertRecommendationsForUser(userId);

    const { limit } = parsePagination(options, { limit: 6, max: 12 });
    const { rows } = await db.query(
      `SELECT
         c.id,
         c.title,
         c.description,
         c.target_amount,
         c.raised_amount,
         c.asset_type,
         c.deadline,
         c.created_at,
         c.cover_image_url,
         c.category,
         u.name AS creator_name,
         cr.score,
         cr.reasons,
         (
           SELECT COUNT(DISTINCT sender_public_key)
           FROM contributions
           WHERE campaign_id = c.id
         )::int AS backer_count,
         ROUND((c.raised_amount / NULLIF(c.target_amount, 0)) * 100, 1) AS progress_pct
       FROM campaign_recommendations cr
       JOIN campaigns c ON c.id = cr.campaign_id
       JOIN users u ON u.id = c.creator_id
       WHERE cr.user_id = $1
         AND c.deleted_at IS NULL
         AND c.status = 'active'
         AND c.is_hidden = FALSE
         AND c.is_flagged_duplicate = FALSE
       ORDER BY cr.score DESC, c.created_at DESC
       LIMIT $2`,
      [userId, limit]
    );

    if (rows.length) return rows;

    const { rows: fallbackRows } = await db.query(
      `SELECT
         c.id,
         c.title,
         c.description,
         c.target_amount,
         c.raised_amount,
         c.asset_type,
         c.deadline,
         c.created_at,
         c.cover_image_url,
         c.category,
         u.name AS creator_name,
         (
           SELECT COUNT(DISTINCT sender_public_key)
           FROM contributions
           WHERE campaign_id = c.id
         )::int AS backer_count,
         ROUND((c.raised_amount / NULLIF(c.target_amount, 0)) * 100, 1) AS progress_pct
       FROM campaigns c
       JOIN users u ON u.id = c.creator_id
       WHERE c.deleted_at IS NULL
         AND c.status = 'active'
         AND c.is_hidden = FALSE
         AND c.is_flagged_duplicate = FALSE
         AND c.id NOT IN (
           SELECT campaign_id FROM contributions ctr JOIN users u2 ON u2.wallet_public_key = ctr.sender_public_key WHERE u2.id = $1
         )
       ORDER BY c.created_at DESC, c.raised_amount DESC
       LIMIT $2`,
      [userId, limit]
    );

    return fallbackRows;
  } catch (err) {
    logger.error('Failed to load campaign recommendations', { error: err.message, userId });
    return [];
  }
}

module.exports = {
  getRecommendedCampaigns,
  upsertRecommendationsForUser,
};
