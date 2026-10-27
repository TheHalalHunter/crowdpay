const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const db = require('../config/database');
const logger = require('../config/logger');

const TOTP_WINDOW = 1;
const BACKUP_CODE_COUNT = 10;
const DEVICE_TRUST_DAYS = 30;

function generateFingerprint(req) {
  const raw = [req.headers['user-agent'] || '', req.headers['accept-language'] || ''].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function parseJwtExpiresIn(value) {
  const match = String(value).match(/^(\d+)([smhd])$/);
  if (!match) return 900;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return num;
  if (unit === 'm') return num * 60;
  if (unit === 'h') return num * 60 * 60;
  if (unit === 'd') return num * 24 * 60 * 60;
  return 900;
}

function getDeviceTrustTtlMs() {
  const days = parseInt(process.env.DEVICE_TRUST_DAYS, 10) || DEVICE_TRUST_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function verifyTotp(secret, token) {
  return authenticator.verify({ token, secret, window: TOTP_WINDOW });
}

function generateSecret() {
  return authenticator.generateSecret();
}

function buildOtpauthUri(email, secret) {
  return authenticator.keyuri(email, 'CrowdPay', secret);
}

async function generateQrCode(otpauth) {
  return qrcode.toDataURL(otpauth);
}

async function generateBackupCodes() {
  const raw = Array.from({ length: BACKUP_CODE_COUNT }, () =>
    crypto.randomBytes(4).toString('hex')
  );
  const hashed = await Promise.all(raw.map(code => bcrypt.hash(code, 10)));
  return { raw, hashed };
}

/**
 * Atomically consume a backup code.
 *
 * Fetches all code hashes for the user, bcrypt-compares each one, then issues
 * a single DELETE … RETURNING to consume the matching row.  Because the DELETE
 * is the only write, two concurrent requests that both pass the bcrypt check
 * will race on the DELETE: only the request whose DELETE returns a row wins;
 * the other gets rowCount 0 and returns { consumed: false }.
 *
 * @param {string} userId
 * @param {string} code  - the raw backup code supplied by the user
 * @returns {{ consumed: boolean }}
 */
async function consumeBackupCode(userId, code) {
  const { rows } = await db.query(
    'SELECT id, code_hash FROM user_backup_codes WHERE user_id = $1',
    [userId]
  );

  for (const row of rows) {
    if (await bcrypt.compare(code, row.code_hash)) {
      // Atomically delete this specific row.  If another concurrent request
      // already deleted it the rowCount will be 0 and we return failure.
      const result = await db.query(
        'DELETE FROM user_backup_codes WHERE id = $1 AND user_id = $2 RETURNING id',
        [row.id, userId]
      );
      if (result.rowCount > 0) {
        return { consumed: true };
      }
      // Lost the race — the code was already consumed.
      return { consumed: false };
    }
  }

  return { consumed: false };
}

/**
 * Replace all backup codes for a user.
 * Runs a DELETE then bulk INSERT inside a single transaction so there is never
 * a window where the user has zero codes mid-operation.
 *
 * @param {string}   userId
 * @param {string[]} hashedCodes - bcrypt hashes of the new codes
 */
async function storeBackupCodes(userId, hashedCodes) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_backup_codes WHERE user_id = $1', [userId]);
    for (const hash of hashedCodes) {
      await client.query('INSERT INTO user_backup_codes (user_id, code_hash) VALUES ($1, $2)', [
        userId,
        hash,
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function logAuditEvent(userId, eventType, req, metadata = {}) {
  const ip = req.ip || req.connection?.remoteAddress;
  const userAgent = req.headers?.['user-agent'] || null;
  await db.query(
    `INSERT INTO security_audit_log (user_id, event_type, ip_address, user_agent, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, eventType, ip, userAgent, JSON.stringify(metadata)]
  );
  logger.info('2FA audit event', {
    event: eventType,
    userId,
    ip,
    metadata,
  });
}

async function isDeviceTrusted(userId, fingerprint) {
  const { rows } = await db.query(
    `SELECT id FROM trusted_devices
     WHERE user_id = $1 AND device_fingerprint = $2 AND expires_at > NOW()`,
    [userId, fingerprint]
  );
  return rows.length > 0;
}

async function trustDevice(userId, fingerprint, req) {
  const deviceName = req.headers['user-agent'] || 'Unknown device';
  const ip = req.ip || req.connection?.remoteAddress;
  const expiresAt = new Date(Date.now() + getDeviceTrustTtlMs());

  await db.query(
    `INSERT INTO trusted_devices (user_id, device_fingerprint, device_name, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, device_fingerprint)
     DO UPDATE SET trusted_at = NOW(), expires_at = $5, ip_address = $4, device_name = $3`,
    [userId, fingerprint, deviceName, ip, expiresAt]
  );
}

async function revokeDevice(userId, deviceId) {
  const result = await db.query('DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2', [
    deviceId,
    userId,
  ]);
  return result.rowCount > 0;
}

async function revokeAllDevices(userId) {
  await db.query('DELETE FROM trusted_devices WHERE user_id = $1', [userId]);
}

async function getUserDevices(userId) {
  const { rows } = await db.query(
    `SELECT id, device_name, ip_address, trusted_at, expires_at
     FROM trusted_devices
     WHERE user_id = $1 AND expires_at > NOW()
     ORDER BY trusted_at DESC`,
    [userId]
  );
  return rows;
}

async function enforce2faCheck(user) {
  if (user.enforce_2fa && !user.totp_enabled) {
    return {
      enforced: true,
      message: '2FA is required for your account. Please set up 2FA before continuing.',
    };
  }
  return { enforced: false };
}

module.exports = {
  generateFingerprint,
  verifyTotp,
  generateSecret,
  buildOtpauthUri,
  generateQrCode,
  generateBackupCodes,
  consumeBackupCode,
  storeBackupCodes,
  logAuditEvent,
  isDeviceTrusted,
  trustDevice,
  revokeDevice,
  revokeAllDevices,
  getUserDevices,
  enforce2faCheck,
  parseJwtExpiresIn,
  getDeviceTrustTtlMs,
  TOTP_WINDOW,
  BACKUP_CODE_COUNT,
};
