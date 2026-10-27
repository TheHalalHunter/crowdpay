const crypto = require('crypto');
const db = require('../config/database');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../config/logger');

const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

/**
 * Documented scopes for GET /api/users/me/exports (#1073). Only fields listed
 * here are copied into the archive; secrets, wallet ciphertext and other
 * users' rows are never selected.
 */
const EXPORT_SCOPES = Object.freeze({
  profile: ['id', 'email', 'name', 'role', 'created_at', 'wallet_public_key'],
  creator_campaigns: [
    'id',
    'title',
    'description',
    'target_amount',
    'raised_amount',
    'asset_type',
    'status',
    'deadline',
    'category',
    'country',
    'created_at',
  ],
  creator_milestones: [
    'id',
    'campaign_id',
    'title',
    'description',
    'release_percentage',
    'sort_order',
    'status',
    'created_at',
    'completed_at',
    'approved_at',
    'released_at',
  ],
  campaign_updates: [
    'id',
    'campaign_id',
    'title',
    'body',
    'status',
    'scheduled_for',
    'created_at',
    'updated_at',
  ],
  contributions: [
    'id',
    'campaign_id',
    'amount',
    'asset',
    'payment_type',
    'source_amount',
    'source_asset',
    'refunded',
    'refund_status',
    'refunded_amount',
    'tx_hash',
    'created_at',
  ],
  notification_preferences: [
    'campaign_updates',
    'refunds',
    'disputes',
    'milestones',
    'marketing',
    'category_digest',
  ],
  category_follows: ['category', 'created_at'],
  notifications: ['id', 'type', 'title', 'body', 'read_at', 'created_at'],
  referrals: ['id', 'campaign_id', 'referral_code', 'click_count', 'created_at'],
  disputes: ['id', 'campaign_id', 'reason', 'status', 'created_at'],
  subscriptions: ['id', 'campaign_id', 'amount', 'interval', 'active', 'created_at'],
  credentials: ['id', 'label', 'scopes', 'expires_at', 'created_at'],
  sessions: ['id', 'created_at', 'last_seen_at', 'location_region'],
});

function pickColumns(row, columns) {
  if (!row) return row;
  const picked = {};
  for (const column of columns) {
    if (row[column] !== undefined) picked[column] = row[column];
  }
  return picked;
}

function pickRows(rows, columns) {
  return (rows || []).map(row => pickColumns(row, columns));
}

function createStorageClient() {
  const endpoint = process.env.STORAGE_ENDPOINT;
  const bucket = process.env.STORAGE_BUCKET;

  if (!endpoint || !bucket) {
    throw new Error('Object storage is not configured. Set STORAGE_ENDPOINT and STORAGE_BUCKET.');
  }

  return new S3Client({
    endpoint,
    region: process.env.STORAGE_REGION || 'auto',
    forcePathStyle: true,
    credentials:
      process.env.STORAGE_ACCESS_KEY && process.env.STORAGE_SECRET_KEY
        ? {
            accessKeyId: process.env.STORAGE_ACCESS_KEY,
            secretAccessKey: process.env.STORAGE_SECRET_KEY,
          }
        : undefined,
  });
}

async function generateUserExport(userId, exportId) {
  try {
    const [
      profileRes,
      campaignsRes,
      milestonesRes,
      campaignUpdatesRes,
      sessionsRes,
      contributionsRes,
      preferencesRes,
      referralsRes,
      disputesRes,
      subscriptionsRes,
      credentialsRes,
      categoryFollowsRes,
    ] = await Promise.all([
      db.query(
        `SELECT id, email, name, role, created_at, wallet_public_key
           FROM users WHERE id = $1`,
        [userId]
      ),
      db.query(
        `SELECT id, title, description, target_amount, raised_amount, asset_type,
                status, deadline, category, country, created_at
           FROM campaigns
          WHERE creator_id = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT m.id, m.campaign_id, m.title, m.description, m.release_percentage,
                m.sort_order, m.status, m.created_at, m.completed_at,
                m.approved_at, m.released_at
           FROM milestones m
           JOIN campaigns c ON c.id = m.campaign_id
          WHERE c.creator_id = $1
          ORDER BY m.campaign_id, m.sort_order ASC`,
        [userId]
      ),
      db.query(
        `SELECT id, campaign_id, title, body, status, scheduled_for, created_at, updated_at
           FROM campaign_updates
          WHERE author_id = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT id, created_at, last_seen_at, location_region
           FROM user_sessions
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT id, campaign_id, amount, asset, payment_type, source_amount,
                source_asset, refunded, refund_status, refunded_amount, tx_hash,
                created_at
           FROM contributions
          WHERE sender_public_key = (
            SELECT wallet_public_key FROM users WHERE id = $1
          )
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT campaign_updates, refunds, disputes, milestones, marketing,
                category_digest, created_at, updated_at
           FROM notification_preferences
          WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT id, campaign_id, referral_code, click_count, created_at
           FROM campaign_referrals
          WHERE referrer_user_id = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT id, campaign_id, reason, status, created_at
           FROM disputes
          WHERE raised_by = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT id, campaign_id, amount, interval, active, created_at
           FROM recurring_contributions
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db.query(
        `SELECT id, label, scopes, expires_at, created_at
           FROM api_keys
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId]
      ),
      db
        .query(
          `SELECT category, created_at
             FROM category_follows
            WHERE user_id = $1
            ORDER BY created_at DESC`,
          [userId]
        )
        .catch(err => {
          // Pre-migration database without the category_follows table.
          if (err?.code === '42P01') return { rows: [] };
          throw err;
        }),
    ]);

    let notificationsRes = { rows: [] };
    try {
      notificationsRes = await db.query(
        `SELECT id, type, title, body, read_at, created_at
           FROM notifications
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [userId]
      );
    } catch (err) {
      logger.warn('Failed to fetch notifications for export', { error: err.message });
    }

    const notificationPreferences = pickColumns(
      preferencesRes.rows[0],
      EXPORT_SCOPES.notification_preferences
    );
    const exportData = {
      scopes: EXPORT_SCOPES,
      profile: pickColumns(profileRes.rows[0], EXPORT_SCOPES.profile),
      creator_campaigns: pickRows(campaignsRes.rows, EXPORT_SCOPES.creator_campaigns),
      creator_milestones: pickRows(milestonesRes.rows, EXPORT_SCOPES.creator_milestones),
      campaign_updates: pickRows(campaignUpdatesRes.rows, EXPORT_SCOPES.campaign_updates),
      sessions: pickRows(sessionsRes.rows, EXPORT_SCOPES.sessions),
      contributions: pickRows(contributionsRes.rows, EXPORT_SCOPES.contributions),
      notification_preferences: notificationPreferences,
      // Backwards-compatible alias for archives created by earlier versions.
      preferences: notificationPreferences,
      category_follows: pickRows(categoryFollowsRes.rows, EXPORT_SCOPES.category_follows),
      notifications: pickRows(notificationsRes.rows, EXPORT_SCOPES.notifications),
      referrals: pickRows(referralsRes.rows, EXPORT_SCOPES.referrals),
      disputes: pickRows(disputesRes.rows, EXPORT_SCOPES.disputes),
      subscriptions: pickRows(subscriptionsRes.rows, EXPORT_SCOPES.subscriptions),
      credentials: pickRows(credentialsRes.rows, EXPORT_SCOPES.credentials),
      exported_at: new Date().toISOString(),
    };

    const buffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
    const hash = crypto.randomBytes(16).toString('hex');
    const key = `exports/${userId}/${hash}.json`;

    const client = createStorageClient();
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.STORAGE_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: 'application/json',
      })
    );

    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    await db.query(
      `UPDATE user_data_exports
          SET status = 'completed', file_url = $1, expires_at = $2, updated_at = NOW()
        WHERE id = $3`,
      [key, expiresAt, exportId]
    );
  } catch (err) {
    logger.error('Data export failed', { userId, exportId, error: err.message });
    await db
      .query(
        `UPDATE user_data_exports
            SET status = 'failed', updated_at = NOW()
          WHERE id = $1`,
        [exportId]
      )
      .catch(updateErr => {
        logger.error('Failed to mark data export as failed', {
          exportId,
          error: updateErr.message,
        });
      });
  }
}

async function getExportDownloadUrl(key) {
  const client = createStorageClient();
  const command = new GetObjectCommand({
    Bucket: process.env.STORAGE_BUCKET,
    Key: key,
  });
  return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

module.exports = {
  EXPORT_SCOPES,
  EXPORT_TTL_MS,
  DOWNLOAD_URL_TTL_SECONDS,
  generateUserExport,
  getExportDownloadUrl,
};
