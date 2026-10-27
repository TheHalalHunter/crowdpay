const db = require('../config/database');
const logger = require('../config/logger');
const { sendWeeklyDigestEmail } = require('./emailService');

const DIGEST_CATEGORY = 'weekly_digest';

function frontendBaseUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function toIsoDate(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function formatMoney(value, asset = '') {
  const numeric = Number(value || 0);
  const formatted = Number.isFinite(numeric)
    ? numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : String(value || 0);
  return asset ? `${formatted} ${asset}` : formatted;
}

function progressPercent(raisedAmount, targetAmount) {
  const raised = Number(raisedAmount || 0);
  const target = Number(targetAmount || 0);
  if (!Number.isFinite(raised) || !Number.isFinite(target) || target <= 0) return 0;
  return Math.min(100, (raised / target) * 100);
}

function buildWindowLabel(windowStart, windowEnd) {
  const start = toIsoDate(windowStart);
  const end = toIsoDate(windowEnd);
  return start === end ? start : `${start} to ${end}`;
}

async function listDigestRecipients(runAt) {
  try {
    const { rows } = await db.query(
      `SELECT u.id,
              u.email,
              u.name,
              COALESCE(MAX(edd.window_ended_at), $1::timestamptz - INTERVAL '7 days') AS window_start
       FROM users u
       LEFT JOIN contributions ctr
         ON u.wallet_public_key = ctr.sender_public_key
       LEFT JOIN category_follows cf
         ON cf.user_id = u.id
       LEFT JOIN email_digest_deliveries edd
         ON edd.user_id = u.id
        AND edd.category = $2
       LEFT JOIN email_unsubscribes eu
         ON eu.email = LOWER(u.email)
        AND eu.category IN ($2, 'category_digest')
       LEFT JOIN notification_preferences np
         ON np.user_id = u.id
       WHERE u.email IS NOT NULL
         AND eu.email IS NULL
         AND (ctr.sender_public_key IS NOT NULL OR cf.user_id IS NOT NULL)
         AND COALESCE(np.category_digest, TRUE) = TRUE
       GROUP BY u.id, u.email, u.name`,
      [runAt.toISOString(), DIGEST_CATEGORY]
    );
    return rows;
  } catch (err) {
    // Backward compatibility: pre-migration database without category_follows
    // or notification_preferences.category_digest serves contributors only.
    if (err?.code !== '42P01' && err?.code !== '42703') throw err;
    const { rows } = await db.query(
      `SELECT u.id,
              u.email,
              u.name,
              COALESCE(MAX(edd.window_ended_at), $1::timestamptz - INTERVAL '7 days') AS window_start
       FROM contributions ctr
       JOIN users u
         ON u.wallet_public_key = ctr.sender_public_key
       LEFT JOIN email_digest_deliveries edd
         ON edd.user_id = u.id
        AND edd.category = $2
       LEFT JOIN email_unsubscribes eu
         ON eu.email = LOWER(u.email)
        AND eu.category = $2
       WHERE u.email IS NOT NULL
         AND eu.email IS NULL
       GROUP BY u.id, u.email, u.name`,
      [runAt.toISOString(), DIGEST_CATEGORY]
    );
    return rows;
  }
}

async function listFollowedCategoryNames(userId) {
  try {
    const { rows } = await db.query('SELECT category FROM category_follows WHERE user_id = $1', [
      userId,
    ]);
    return rows.map(row => row.category);
  } catch (err) {
    // Pre-migration database without the category_follows table.
    if (err?.code === '42P01') return [];
    throw err;
  }
}

async function listNewCampaignsInFollowedCategories({ categories, windowStart, windowEnd }) {
  if (!categories.length) return [];
  const { listNewCampaignsInCategories } = require('./categoryFollowService');
  return listNewCampaignsInCategories(categories, windowStart, windowEnd);
}

async function listBackedCampaigns({ userId, email }) {
  const { rows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id,
            c.title,
            c.status,
            c.deadline,
            c.target_amount,
            c.raised_amount,
            c.asset_type,
            c.category,
            c.created_at
     FROM contributions ctr
     JOIN users u
       ON u.wallet_public_key = ctr.sender_public_key
     JOIN campaigns c
       ON c.id = ctr.campaign_id
     LEFT JOIN campaign_update_unsubscribes cuu
       ON cuu.email = LOWER($2)
      AND cuu.campaign_id = c.id
     WHERE u.id = $1
       AND cuu.email IS NULL
     ORDER BY c.id, ctr.created_at ASC`,
    [userId, email]
  );
  return rows;
}

async function listCampaignUpdates(campaignIds, windowStart, windowEnd) {
  if (!campaignIds.length) return [];
  const { rows } = await db.query(
    `SELECT campaign_id, title, created_at
     FROM campaign_updates
     WHERE campaign_id = ANY($1::uuid[])
       AND created_at > $2
       AND created_at <= $3
     ORDER BY created_at DESC`,
    [campaignIds, windowStart.toISOString(), windowEnd.toISOString()]
  );
  return rows;
}

async function listReleasedMilestones(campaignIds, windowStart, windowEnd) {
  if (!campaignIds.length) return [];
  const { rows } = await db.query(
    `SELECT campaign_id, title, released_at
     FROM milestones
     WHERE campaign_id = ANY($1::uuid[])
       AND released_at > $2
       AND released_at <= $3
     ORDER BY released_at DESC`,
    [campaignIds, windowStart.toISOString(), windowEnd.toISOString()]
  );
  return rows;
}

async function listStatusChanges(campaignIds, windowStart, windowEnd) {
  if (!campaignIds.length) return [];
  const { rows } = await db.query(
    `SELECT campaign_id, new_status, created_at
     FROM campaign_status_events
     WHERE campaign_id = ANY($1::uuid[])
       AND created_at > $2
       AND created_at <= $3
     ORDER BY created_at DESC`,
    [campaignIds, windowStart.toISOString(), windowEnd.toISOString()]
  );
  return rows;
}

function buildCampaignDigest({
  campaigns,
  updates,
  milestones,
  statuses,
  windowEnd,
  newCampaignIds,
}) {
  const updatesByCampaign = new Map();
  const milestonesByCampaign = new Map();
  const statusesByCampaign = new Map();

  for (const row of updates) {
    if (!updatesByCampaign.has(row.campaign_id)) updatesByCampaign.set(row.campaign_id, []);
    updatesByCampaign.get(row.campaign_id).push(`${row.title} (${toIsoDate(row.created_at)})`);
  }

  for (const row of milestones) {
    if (!milestonesByCampaign.has(row.campaign_id)) milestonesByCampaign.set(row.campaign_id, []);
    milestonesByCampaign
      .get(row.campaign_id)
      .push(`${row.title} released (${toIsoDate(row.released_at)})`);
  }

  for (const row of statuses) {
    if (!statusesByCampaign.has(row.campaign_id)) statusesByCampaign.set(row.campaign_id, []);
    const statusLabel = row.new_status === 'funded' ? 'Campaign funded' : 'Campaign failed';
    statusesByCampaign.get(row.campaign_id).push(`${statusLabel} (${toIsoDate(row.created_at)})`);
  }

  const deadlineCutoff = new Date(windowEnd);
  deadlineCutoff.setUTCDate(deadlineCutoff.getUTCDate() + 7);

  return campaigns
    .map(campaign => {
      const deadlineDate = campaign.deadline ? new Date(campaign.deadline) : null;
      const upcomingDeadlines = [];

      if (deadlineDate && deadlineDate >= windowEnd && deadlineDate <= deadlineCutoff) {
        upcomingDeadlines.push(`Deadline on ${toIsoDate(deadlineDate)}`);
      }

      const isNew =
        (newCampaignIds instanceof Set
          ? newCampaignIds.has(campaign.id)
          : Array.isArray(newCampaignIds)
            ? newCampaignIds.includes(campaign.id)
            : false) || false;

      return {
        id: campaign.id,
        title: campaign.title,
        campaignUrl: `${frontendBaseUrl()}/campaigns/${campaign.id}`,
        raisedLabel: formatMoney(campaign.raised_amount, campaign.asset_type),
        targetLabel: formatMoney(campaign.target_amount, campaign.asset_type),
        progressPercent: progressPercent(campaign.raised_amount, campaign.target_amount),
        category: campaign.category || null,
        isNew,
        updates: updatesByCampaign.get(campaign.id) || [],
        milestones: milestonesByCampaign.get(campaign.id) || [],
        statusChanges: statusesByCampaign.get(campaign.id) || [],
        upcomingDeadlines,
      };
    })
    .filter(
      campaign =>
        campaign.isNew ||
        campaign.updates.length ||
        campaign.milestones.length ||
        campaign.statusChanges.length ||
        campaign.upcomingDeadlines.length
    );
}

async function recordDigestDelivery({ userId, windowStart, windowEnd, campaignCount, itemCount }) {
  const { rows } = await db.query(
    `INSERT INTO email_digest_deliveries
       (user_id, category, window_started_at, window_ended_at, campaign_count, item_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, category, window_ended_at) DO NOTHING
     RETURNING id`,
    [
      userId,
      DIGEST_CATEGORY,
      windowStart.toISOString(),
      windowEnd.toISOString(),
      campaignCount,
      itemCount,
    ]
  );
  return rows.length > 0;
}

async function releaseDigestDelivery({ userId, windowEnd }) {
  await db.query(
    `DELETE FROM email_digest_deliveries
     WHERE user_id = $1 AND category = $2 AND window_ended_at = $3`,
    [userId, DIGEST_CATEGORY, windowEnd.toISOString()]
  );
}

async function sendWeeklyContributorDigests({ runAt = new Date() } = {}) {
  const recipients = await listDigestRecipients(runAt);
  const digestUrl = `${frontendBaseUrl()}/my-contributions`;

  let sent = 0;
  let skipped = 0;

  for (const recipient of recipients) {
    const windowStart = new Date(recipient.window_start);
    const windowEnd = new Date(runAt);
    const [backedCampaigns, followedCategories] = await Promise.all([
      listBackedCampaigns({ userId: recipient.id, email: recipient.email }),
      listFollowedCategoryNames(recipient.id),
    ]);
    const categoryCampaigns = await listNewCampaignsInFollowedCategories({
      categories: followedCategories,
      windowStart,
      windowEnd,
    });

    // Merge backed + followed-category campaigns, deduped by id so a backed
    // campaign in a followed category appears once.
    const campaignsById = new Map();
    for (const campaign of backedCampaigns) campaignsById.set(campaign.id, campaign);
    for (const campaign of categoryCampaigns) {
      if (!campaignsById.has(campaign.id)) campaignsById.set(campaign.id, campaign);
    }
    const campaigns = [...campaignsById.values()];
    const campaignIds = campaigns.map(campaign => campaign.id);
    const newCampaignIds = new Set(categoryCampaigns.map(campaign => campaign.id));

    if (!campaignIds.length) {
      skipped += 1;
      continue;
    }

    const [updates, milestones, statuses] = await Promise.all([
      listCampaignUpdates(campaignIds, windowStart, windowEnd),
      listReleasedMilestones(campaignIds, windowStart, windowEnd),
      listStatusChanges(campaignIds, windowStart, windowEnd),
    ]);

    const digestCampaigns = buildCampaignDigest({
      campaigns,
      updates,
      milestones,
      statuses,
      windowEnd,
      newCampaignIds,
    });

    if (!digestCampaigns.length) {
      skipped += 1;
      continue;
    }

    const itemCount = digestCampaigns.reduce(
      (total, campaign) =>
        total +
        (campaign.isNew ? 1 : 0) +
        campaign.updates.length +
        campaign.milestones.length +
        campaign.statusChanges.length +
        campaign.upcomingDeadlines.length,
      0
    );

    const claimed = await recordDigestDelivery({
      userId: recipient.id,
      windowStart,
      windowEnd,
      campaignCount: digestCampaigns.length,
      itemCount,
    });
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      await sendWeeklyDigestEmail({
        to: recipient.email,
        userId: recipient.id,
        windowEnd,
        name: recipient.name,
        windowLabel: buildWindowLabel(windowStart, windowEnd),
        digestUrl,
        campaigns: digestCampaigns,
      });
    } catch (err) {
      await releaseDigestDelivery({ userId: recipient.id, windowEnd });
      throw err;
    }

    sent += 1;
  }

  logger.info('Weekly contributor digest run completed', {
    sent,
    skipped,
    run_at: runAt.toISOString(),
  });

  return { sent, skipped };
}

module.exports = {
  DIGEST_CATEGORY,
  sendWeeklyContributorDigests,
  buildCampaignDigest,
  buildWindowLabel,
  listFollowedCategoryNames,
  listNewCampaignsInFollowedCategories,
};
