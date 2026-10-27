const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');

const IDEMPOTENCY_TTL_SECONDS = 86_400;
const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function requestHash(req, bodyField) {
  const body = req.body && typeof req.body === 'object' ? { ...req.body } : req.body;
  if (body && typeof body === 'object' && bodyField) delete body[bodyField];
  return crypto
    .createHash('sha256')
    .update(`${req.method}\n${req.originalUrl || req.url}\n${stableJson(body)}`)
    .digest('hex');
}

function invalidKeyResponse(res, message) {
  return res.status(400).json({ error: message, code: 'INVALID_IDEMPOTENCY_KEY' });
}

function idempotency(scope, options = {}) {
  const bodyField = options.bodyField || null;
  const requireKey = options.requireKey === true;

  return async function idempotencyMiddleware(req, res, next) {
    const headerKey = req.headers[IDEMPOTENCY_KEY_HEADER];
    const bodyKey = bodyField && req.body ? req.body[bodyField] : null;
    if (headerKey && bodyKey && String(headerKey) !== String(bodyKey)) {
      return invalidKeyResponse(res, 'Idempotency-Key header and request body key must match');
    }
    const rawKey = headerKey || bodyKey;
    if (rawKey === undefined || rawKey === null || rawKey === '') {
      if (requireKey) return invalidKeyResponse(res, 'Idempotency-Key is required');
      return next();
    }
    const key = String(rawKey);
    if (!KEY_PATTERN.test(key)) {
      return invalidKeyResponse(
        res,
        'Idempotency-Key must be 1-255 printable ASCII characters without whitespace'
      );
    }
    const actorId = req.user?.userId;
    if (!actorId) return res.status(401).json({ error: 'Authentication required' });
    const hash = requestHash(req, bodyField);
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);

    try {
      const claimed = await db.query(
        `INSERT INTO idempotency_keys
           (actor_id, scope, key, request_hash, status, expires_at)
         VALUES ($1, $2, $3, $4, 'processing', $5)
         ON CONFLICT (actor_id, scope, key) DO UPDATE
           SET request_hash = EXCLUDED.request_hash,
               status = 'processing', response_status = NULL, response_body = NULL,
               expires_at = EXCLUDED.expires_at, updated_at = NOW()
         WHERE idempotency_keys.expires_at <= NOW()
         RETURNING status, response_status, response_body, request_hash`,
        [actorId, scope, key, hash, expiresAt]
      );

      if (!claimed.rows.length) {
        const existing = await db.query(
          `SELECT status, response_status, response_body, request_hash, expires_at
             FROM idempotency_keys WHERE actor_id = $1 AND scope = $2 AND key = $3`,
          [actorId, scope, key]
        );
        const row = existing.rows[0];
        if (row?.request_hash !== hash) {
          return res.status(409).json({
            error: 'The idempotency key was already used with a different request',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        }
        if (row?.status !== 'processing' && row?.response_status !== null) {
          res.setHeader('Idempotency-Replay', 'true');
          return res.status(row.response_status).json(row.response_body);
        }
        return res.status(409).json({
          error: 'A request with this Idempotency-Key is already being processed',
          code: 'IDEMPOTENCY_CONFLICT',
        });
      }

      req.idempotencyKey = key;
      req.idempotencyScope = scope;
      const originalJson = res.json.bind(res);
      res.json = body => {
        const status = res.statusCode || 200;
        // Persist every completed HTTP result, including 5xx responses. A
        // request that failed after performing a mutation must not leave its
        // key permanently stuck in `processing`.
        if (status >= 200 && status < 600) {
          db.query(
            `UPDATE idempotency_keys
                SET status = $1, response_status = $2, response_body = $3::jsonb, updated_at = NOW()
              WHERE actor_id = $4 AND scope = $5 AND key = $6 AND request_hash = $7`,
            [
              status >= 400 ? 'failed' : 'succeeded',
              status,
              JSON.stringify(body),
              actorId,
              scope,
              key,
              hash,
            ]
          ).catch(err =>
            logger.error('Failed to persist idempotency result', { scope, error: err.message })
          );
        }
        return originalJson(body);
      };
      return next();
    } catch (err) {
      logger.error('Durable idempotency claim failed', { scope, actorId, key, error: err.message });
      return next(err);
    }
  };
}

module.exports = { idempotency, IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_TTL_SECONDS, requestHash };
