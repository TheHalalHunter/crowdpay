const admin = require('firebase-admin');
const db = require('../config/database');
const logger = require('../config/logger');

function serviceAccount() {
  const value = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    logger.error('FIREBASE_SERVICE_ACCOUNT must be valid JSON');
    return null;
  }
}

function messaging() {
  const account = serviceAccount();
  if (!account) return null;
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(account) });
  }
  return admin.messaging();
}

function isExpiredOrInvalidToken(error) {
  if (!error) return false;
  const code = error.code || '';
  const message = error.message || '';
  return (
    [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'messaging/token-expired',
      'messaging/mismatched-credential',
    ].includes(code) ||
    /registration token.*(?:not registered|expired|invalid)/i.test(message) ||
    /requested entity was not found/i.test(message) ||
    /unregistered/i.test(code)
  );
}

/**
 * Atomically delete expired or unregistered push subscription tokens for a user (#1086).
 * @param {string} userId - User ID who owns the subscriptions.
 * @param {string[]} tokens - Tokens that failed delivery due to expiration or deregistration.
 * @returns {Promise<number>} Number of pruned subscriptions.
 */
async function pruneExpiredSubscriptions(userId, tokens) {
  if (!userId || !Array.isArray(tokens) || !tokens.length) return 0;
  try {
    const { rows } = await db.query(
      `DELETE FROM push_subscriptions
       WHERE user_id = $1 AND token = ANY($2::text[])
       RETURNING id, token`,
      [userId, tokens]
    );
    if (rows.length) {
      logger.info('push: pruned expired subscriptions atomically', {
        user_id: userId,
        pruned_count: rows.length,
      });
    }
    return rows.length;
  } catch (err) {
    logger.error('push: failed to prune expired subscriptions', {
      user_id: userId,
      error: err.message,
    });
    return 0;
  }
}

/**
 * Atomically prune stale/expired push subscriptions older than maxAgeDays (#1086).
 * @param {{ maxAgeDays?: number }} [options]
 * @returns {Promise<number>} Number of pruned rows.
 */
async function pruneStaleSubscriptions({ maxAgeDays = 90 } = {}) {
  try {
    const { rows } = await db.query(
      `DELETE FROM push_subscriptions
       WHERE updated_at < NOW() - ($1::text || ' days')::interval
       RETURNING id, user_id`,
      [String(maxAgeDays)]
    );
    if (rows.length) {
      logger.info('push: pruned stale push subscriptions', {
        pruned_count: rows.length,
        maxAgeDays,
      });
    }
    return rows.length;
  } catch (err) {
    logger.error('push: failed to prune stale subscriptions', { error: err.message });
    return 0;
  }
}

async function sendToUser(userId, message) {
  const client = messaging();
  if (!client) return false;

  const { rows } = await db.query('SELECT token FROM push_subscriptions WHERE user_id = $1', [
    userId,
  ]);
  if (!rows.length) return false;

  const tokens = rows.map(row => row.token);
  let delivered = false;
  for (let start = 0; start < tokens.length; start += 500) {
    const batch = tokens.slice(start, start + 500);
    const response = await client.sendEachForMulticast({
      tokens: batch,
      notification: { title: message.title, body: message.body || '' },
      data: {
        type: String(message.type),
        link: message.link || '/',
      },
    });
    delivered ||= response.successCount > 0;

    const invalid = response.responses
      .map((result, index) =>
        result.success || !isExpiredOrInvalidToken(result.error) ? null : batch[index]
      )
      .filter(Boolean);
    if (invalid.length) {
      await pruneExpiredSubscriptions(userId, invalid);
    }
  }
  return delivered;
}

module.exports = {
  sendToUser,
  pruneExpiredSubscriptions,
  pruneStaleSubscriptions,
  isExpiredOrInvalidToken,
  isInvalidToken: isExpiredOrInvalidToken,
};
