const router = require('express').Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const totpService = require('../services/totpService');
const { Keypair } = require('@stellar/stellar-sdk');
const db = require('../config/database');
const logger = require('../config/logger');
const { ensureCustodialAccountFundedAndTrusted } = require('../services/stellarService');
const {
  sendEmail,
  sendWelcomeEmail,
  sendWalletFundingFailedEmail,
} = require('../services/emailService');
const { requireAuth } = require('../middleware/auth');
const { encryptWalletSecret } = require('../services/walletSecrets');
const { encryptSecret, decryptSecret } = require('../services/walletService');
const { isKycRequiredForCampaigns } = require('../services/kycProvider');
const { startKycForUser, getKycStatusForUser } = require('../services/kycService');
const {
  createUserSession,
  recordLoginAttempt,
  checkLoginAnomalies,
} = require('../services/sessionService');
const asyncHandler = require('../utils/asyncHandler');
const {
  registerValidation,
  loginValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  validateRequest,
  validateRequestAsError,
} = require('../middleware/validation');

/**
 * @openapi
 * tags:
 *   - name: Users
 *     description: User registration and login
 */

const ACCESS_TOKEN_COOKIE_NAME = 'cp_token';
const REFRESH_TOKEN_COOKIE_NAME = 'cp_refresh_token';
const REFRESH_TOKEN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const FORGOT_PASSWORD_MESSAGE = 'If that email exists, a password reset link has been sent.';

function parseJwtExpiresIn(value) {
  const match = String(value).match(/^(\d+)([smhd])$/);
  if (!match) return 15 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 's') return num;
  if (unit === 'm') return num * 60;
  if (unit === 'h') return num * 60 * 60;
  if (unit === 'd') return num * 24 * 60 * 60;
  return 15 * 60;
}

function setAccessTokenCookie(res, token) {
  res.cookie(ACCESS_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: parseJwtExpiresIn(process.env.JWT_EXPIRES_IN || '15m') * 1000,
  });
}

function clearAccessTokenCookie(res) {
  res.clearCookie(ACCESS_TOKEN_COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
}

const isTest = process.env.NODE_ENV === 'test';

// Per-IP rate limiter: 5 registration attempts per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isTest ? 100000 : 5,
  message: { error: 'Too many registration attempts from this IP. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

// Per-email rate limiter: 3 registrations per 24 hours
const registerEmailLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: isTest ? 100000 : 3,
  message: { error: 'Too many registration attempts for this email. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: req => {
    return String((req.body?.email || '').trim().toLowerCase());
  },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isTest ? 100000 : 20,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

// Per-IP: 3 TOTP attempts per 30 seconds.
const totpChallengeLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: isTest ? 100000 : 3,
  message: { error: 'Too many 2FA attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
});

// Per-account (by email): 3 TOTP attempts per 30 seconds, independent of IP.
const totpChallengeEmailLimiter = rateLimit({
  windowMs: 30 * 1000,
  max: isTest ? 100000 : 3,
  message: { error: 'Too many 2FA attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => isTest,
  keyGenerator: req => String((req.body?.email || '').trim().toLowerCase()),
});

const TOTP_MAX_CONSECUTIVE_FAILURES = 10;
const TOTP_LOCKOUT_MS = 15 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
}

function generateTokens(user) {
  const accessToken = jwt.sign(
    {
      sub: user.id.toString(),
      iss: 'https://crowdpay.io',
      aud: 'crowdpay-api',
      userId: user.id,
      email: user.email,
      is_admin: user.is_admin,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = crypto.randomBytes(32).toString('hex');
  return { accessToken, refreshToken };
}

function setRefreshTokenCookie(res, token, expiresAt) {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: REFRESH_TOKEN_COOKIE_MAX_AGE,
    expires: expiresAt,
  });
}

function clearRefreshTokenCookie(res) {
  res.cookie(REFRESH_TOKEN_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    expires: new Date(0),
  });
}

async function createRefreshToken(userId) {
  const expiresInSeconds = parseRefreshExpiresIn(process.env.REFRESH_TOKEN_EXPIRES_IN || '7d');
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
  return { token, expiresAt };
}

function parseRefreshExpiresIn(value) {
  const match = value.match(/^(\d+)([dh])$/);
  if (!match) return 7 * 24 * 60 * 60;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'h') return num * 60 * 60;
  return num * 24 * 60 * 60;
}

async function validateRefreshToken(token) {
  const tokenHash = hashToken(token);
  const { rows } = await db.query(
    `SELECT rt.id, rt.user_id, u.id AS id, u.email, u.name, u.role, u.wallet_public_key,
            u.kyc_status, u.kyc_completed_at
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > NOW()`,
    [tokenHash]
  );
  if (!rows.length) return null;
  return rows[0];
}

async function revokeRefreshToken(token) {
  const tokenHash = hashToken(token);
  await db.query(`UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1`, [tokenHash]);
}

async function rotateRefreshToken(oldToken, userId) {
  await revokeRefreshToken(oldToken);
  return createRefreshToken(userId);
}

router.post(
  '/register',
  registerLimiter,
  registerEmailLimiter,
  registerValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/auth/register:
     *   post:
     *     tags: [Users]
     *     summary: Register a new user
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email, password, name]
     *             properties:
     *               email: { type: string, format: email }
     *               password: { type: string, minLength: 6 }
     *               name: { type: string }
     *               role: { type: string, enum: [contributor, creator] }
     *     responses:
     *       201:
     *         description: Created
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               required: [token, user]
     *               properties:
     *                 token: { type: string }
     *                 user:
     *                   type: object
     *                   properties:
     *                     id: { type: integer }
     *                     email: { type: string, format: email }
     *                     name: { type: string }
     *                     wallet_public_key: { type: string }
     *                     role: { type: string }
     *                     kyc_status: { type: string }
     *                     kyc_completed_at: { type: string, nullable: true }
     *                     kyc_required_for_campaigns: { type: boolean }
     *       409:
     *         description: Email already registered
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error: { type: string }
     * /api/users/register:
     *   post:
     *     tags: [Users]
     *     summary: Register a new user (alias of /api/auth/register)
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email, password, name]
     *             properties:
     *               email: { type: string, format: email }
     *               password: { type: string, minLength: 6 }
     *               name: { type: string }
     *               role: { type: string, enum: [contributor, creator] }
     *     responses:
     *       201: { description: Created }
     *       409: { description: Email already registered }
     */
    const { email, password, name, role } = req.body;
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const normalizedName = String(name || '').trim();
    const allowedRoles = new Set(['contributor', 'creator']);
    const userRole = role || 'contributor';
    if (!allowedRoles.has(userRole)) {
      return res.status(400).json({ error: 'role must be contributor or creator' });
    }

    const existing = await db.query('SELECT id FROM users WHERE LOWER(email) = $1', [
      normalizedEmail,
    ]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Support freighter (non-custodial) registration where frontend provides wallet_public_key
    let publicKey;
    let encryptedSecret = null;
    let secret = null;
    const walletType = req.body.wallet_type || 'custodial';

    if (walletType === 'freighter') {
      publicKey = req.body.wallet_public_key;
      // wallet_public_key validated by middleware when wallet_type=freighter
      encryptedSecret = null;
    } else {
      const keypair = Keypair.random();
      publicKey = keypair.publicKey();
      secret = keypair.secret();
      encryptedSecret = await encryptWalletSecret(secret, { walletPublicKey: publicKey });
    }

    const walletFundedAt = walletType === 'freighter' ? new Date() : null;

    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name, wallet_public_key, wallet_secret_encrypted, role, wallet_type, wallet_funded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, email, name, wallet_public_key, role, kyc_status, kyc_completed_at, wallet_type, wallet_funded_at, wallet_funding_failed_at`,
      [
        normalizedEmail,
        passwordHash,
        normalizedName,
        publicKey,
        encryptedSecret,
        userRole,
        walletType,
        walletFundedAt,
      ]
    );

    const user = {
      ...rows[0],
      kyc_required_for_campaigns: isKycRequiredForCampaigns(),
    };
    const { accessToken } = generateTokens(user);
    const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

    // Get the refresh token ID for session tracking
    const { rows: rtRows } = await db.query('SELECT id FROM refresh_tokens WHERE token_hash = $1', [
      hashToken(refreshToken),
    ]);
    const refreshTokenId = rtRows[0]?.id;

    // Create user session
    if (refreshTokenId) {
      await createUserSession(user.id, refreshTokenId, req);
    }

    // Record successful login attempt
    await recordLoginAttempt({
      userId: user.id,
      email: normalizedEmail,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      success: true,
    });

    setRefreshTokenCookie(res, refreshToken, expiresAt);
    setAccessTokenCookie(res, accessToken);

    const requestId = req.id;
    setImmediate(() => {
      // Only fund and setup trustlines for custodial wallets
      if (walletType === 'custodial' && secret) {
        ensureCustodialAccountFundedAndTrusted({ publicKey, secret })
          .then(async () => {
            await db.query(
              'UPDATE users SET wallet_funded_at = NOW(), wallet_funding_failed_at = NULL WHERE id = $1',
              [user.id]
            );
            logger.info('Background Stellar funding/trustlines succeeded', { userId: user.id });
          })
          .catch(async err => {
            logger.error('Background Stellar funding/trustlines failed', {
              request_id: requestId,
              userId: user.id,
              error: err.message,
            });
            await db.query('UPDATE users SET wallet_funding_failed_at = NOW() WHERE id = $1', [
              user.id,
            ]);
            sendWalletFundingFailedEmail({
              to: normalizedEmail,
              name: normalizedName,
              walletPublicKey: publicKey,
            }).catch(emailErr => {
              logger.error('Failed to send wallet funding failed email', {
                userId: user.id,
                error: emailErr.message,
              });
            });
          });
      }

      sendWelcomeEmail({
        to: normalizedEmail,
        name: normalizedName,
        walletPublicKey: publicKey,
      }).catch(err => {
        logger.error('Welcome email failed', { request_id: requestId, error: err.message });
      });
    });

    res.status(201).json({ token: accessToken, user });
  })
);

router.post(
  '/login',
  loginLimiter,
  loginValidation,
  validateRequest,
  asyncHandler(async (req, res) => {
    /**
     * @openapi
     * /api/auth/login:
     *   post:
     *     tags: [Users]
     *     summary: Login
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email, password]
     *             properties:
     *               email: { type: string, format: email }
     *               password: { type: string }
     *     responses:
     *       200:
     *         description: OK
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               required: [token, user]
     *               properties:
     *                 token: { type: string }
     *                 user:
     *                   type: object
     *                   properties:
     *                     id: { type: integer }
     *                     email: { type: string, format: email }
     *                     name: { type: string }
     *                     wallet_public_key: { type: string }
     *                     role: { type: string }
     *                     kyc_status: { type: string }
     *                     kyc_completed_at: { type: string, nullable: true }
     *                     kyc_required_for_campaigns: { type: boolean }
     *       401:
     *         description: Invalid credentials
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 error: { type: string }
     * /api/users/login:
     *   post:
     *     tags: [Users]
     *     summary: Login (alias of /api/auth/login)
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [email, password]
     *             properties:
     *               email: { type: string, format: email }
     *               password: { type: string }
     *     responses:
     *       200: { description: OK }
     *       401: { description: Invalid credentials }
     */
    const { email, password } = req.body;
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [
      normalizedEmail,
    ]);

    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      // Record failed login attempt
      await recordLoginAttempt({
        email: normalizedEmail,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        success: false,
        failureReason: 'Invalid credentials',
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];

    const enforceResult = await totpService.enforce2faCheck(user);
    if (enforceResult.enforced) {
      return res.status(403).json({ error: enforceResult.message });
    }

    if (user.totp_enabled) {
      const fingerprint = totpService.generateFingerprint(req);
      const trusted = await totpService.isDeviceTrusted(user.id, fingerprint);
      if (trusted) {
        // Skip 2FA for trusted device
      } else {
        return res.json({ requires_2fa: true });
      }
    }

    const { accessToken } = generateTokens(user);
    const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

    // Get the refresh token ID for session tracking
    const { rows: rtRows } = await db.query('SELECT id FROM refresh_tokens WHERE token_hash = $1', [
      hashToken(refreshToken),
    ]);
    const refreshTokenId = rtRows[0]?.id;

    // Create user session
    if (refreshTokenId) {
      await createUserSession(user.id, refreshTokenId, req);
    }

    // Check for login anomalies and record attempt
    await checkLoginAnomalies(user.id, user.email, req);
    await recordLoginAttempt({
      userId: user.id,
      email: normalizedEmail,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      success: true,
    });

    setRefreshTokenCookie(res, refreshToken, expiresAt);
    setAccessTokenCookie(res, accessToken);

    res.json({
      token: accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        wallet_public_key: user.wallet_public_key,
        wallet_type: user.wallet_type || 'custodial',
        role: user.role,
        kyc_status: user.kyc_status,
        kyc_completed_at: user.kyc_completed_at,
        kyc_required_for_campaigns: isKycRequiredForCampaigns(),
      },
    });
  })
);

router.post(
  '/2fa/challenge',
  totpChallengeLimiter,
  totpChallengeEmailLimiter,
  validateRequest,
  asyncHandler(async (req, res) => {
    const { email, password, code } = req.body;
    if (!email || !password || !code) {
      return res.status(400).json({ error: 'Email, password, and code are required' });
    }
    const normalizedEmail = String(email || '')
      .trim()
      .toLowerCase();
    const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [
      normalizedEmail,
    ]);

    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled for this account' });
    }

    if (user.totp_locked_until && new Date(user.totp_locked_until) > new Date()) {
      logger.warn('TOTP challenge blocked: account locked', {
        event: 'totp_locked',
        userId: user.id,
        ip: req.ip,
      });
      return res.status(423).json({ error: 'Too many failed 2FA attempts. Try again later.' });
    }

    let codeValid = false;

    if (code.length === 6) {
      codeValid = totpService.verifyTotp(user.totp_secret, code);
    } else if (user.backup_codes && user.backup_codes.length > 0) {
      const result = await totpService.verifyBackupCode(user.backup_codes, code);
      if (result.valid) {
        codeValid = true;
        await totpService.removeBackupCode(user.id, user.backup_codes, result.index);
      }
    }

    if (!codeValid) {
      const failedAttempts = (user.totp_failed_attempts || 0) + 1;
      const lockingOut = failedAttempts >= TOTP_MAX_CONSECUTIVE_FAILURES;
      await db.query(
        'UPDATE users SET totp_failed_attempts = $1, totp_locked_until = $2 WHERE id = $3',
        [
          lockingOut ? 0 : failedAttempts,
          lockingOut ? new Date(Date.now() + TOTP_LOCKOUT_MS) : null,
          user.id,
        ]
      );
      await totpService.logAuditEvent(user.id, 'totp_challenge_failed', req, {
        consecutiveFailures: failedAttempts,
        lockedOut: lockingOut,
      });
      logger.warn('Failed 2FA attempt', {
        event: 'totp_failed_attempt',
        userId: user.id,
        ip: req.ip,
        consecutiveFailures: failedAttempts,
        lockedOut: lockingOut,
      });
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    if (user.totp_failed_attempts) {
      await db.query(
        'UPDATE users SET totp_failed_attempts = 0, totp_locked_until = NULL WHERE id = $1',
        [user.id]
      );
    }

    const fingerprint = totpService.generateFingerprint(req);
    const wasBackupCode = code.length !== 6;
    await totpService.logAuditEvent(user.id, 'totp_challenge_success', req, {
      method: wasBackupCode ? 'backup_code' : 'totp',
    });

    const { accessToken } = generateTokens(user);
    const { token: refreshToken, expiresAt } = await createRefreshToken(user.id);

    setRefreshTokenCookie(res, refreshToken, expiresAt);
    setAccessTokenCookie(res, accessToken);

    res.json({
      token: accessToken,
      device_trusted: await totpService.isDeviceTrusted(user.id, fingerprint),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        wallet_public_key: user.wallet_public_key,
        wallet_type: user.wallet_type || 'custodial',
        role: user.role,
        kyc_status: user.kyc_status,
        kyc_completed_at: user.kyc_completed_at,
        kyc_required_for_campaigns: isKycRequiredForCampaigns(),
      },
    });
  })
);

router.post(
  '/2fa/setup',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (user.role !== 'admin' && user.role !== 'creator') {
      return res
        .status(403)
        .json({ error: '2FA is only available for creator and admin accounts' });
    }
    if (user.totp_enabled) {
      return res.status(400).json({ error: '2FA is already enabled' });
    }

    const secret = totpService.generateSecret();
    const otpauth = totpService.buildOtpauthUri(user.email, secret);
    const qrCodeDataUrl = await totpService.generateQrCode(otpauth);

    const encryptedTotpSecret = encryptSecret(secret);
    await db.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [
      encryptedTotpSecret,
      user.id,
    ]);
    await totpService.logAuditEvent(user.id, 'totp_setup_initiated', req);

    res.json({
      secret,
      qrCodeDataUrl,
    });
  })
);

router.post(
  '/2fa/verify',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Code is required' });
    }

    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_secret) {
      return res.status(400).json({ error: '2FA setup not initiated' });
    }

    let plainSecret;
    try {
      plainSecret = decryptSecret(user.totp_secret);
    } catch (err) {
      logger.error('Failed to decrypt TOTP secret — run migrate-totp-secrets', {
        userId: user.id,
        error: err.message,
      });
      return res
        .status(503)
        .json({ error: 'Service temporarily unavailable. Please try again later.' });
    }
    const isValid = totpService.verifyTotp(plainSecret, code);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    const { raw: rawBackupCodes, hashed: hashedBackupCodes } =
      await totpService.generateBackupCodes();

    await db.query('UPDATE users SET totp_enabled = true, backup_codes = $1 WHERE id = $2', [
      hashedBackupCodes,
      user.id,
    ]);
    await totpService.logAuditEvent(user.id, 'totp_enabled', req);

    res.json({
      message: '2FA enabled successfully',
      backupCodes: rawBackupCodes,
    });
  })
);

router.post(
  '/2fa/disable',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: 'Current 2FA code is required to disable' });
    }

    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    let codeValid = false;
    if (code.length === 6) {
      if (!user.totp_secret) {
        logger.error('TOTP secret is null for user with 2FA enabled — check DB integrity', {
          userId: user.id,
        });
        return res
          .status(503)
          .json({ error: 'Service temporarily unavailable. Please try again later.' });
      }
      let plainSecret;
      try {
        plainSecret = decryptSecret(user.totp_secret);
      } catch (err) {
        logger.error('Failed to decrypt TOTP secret — run migrate-totp-secrets', {
          userId: user.id,
          error: err.message,
        });
        return res
          .status(503)
          .json({ error: 'Service temporarily unavailable. Please try again later.' });
      }
      codeValid = totpService.verifyTotp(plainSecret, code);
    } else {
      const result = await totpService.consumeBackupCode(user.id, code);
      if (result.consumed) {
        codeValid = true;
      }
    }

    if (!codeValid) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    await db.query('UPDATE users SET totp_enabled = false, totp_secret = NULL WHERE id = $1', [
      user.id,
    ]);
    // Delete orphaned backup codes — ON DELETE CASCADE handles account deletion
    // but not 2FA disable, so we remove them explicitly here.
    await db.query('DELETE FROM user_backup_codes WHERE user_id = $1', [user.id]);
    await totpService.revokeAllDevices(user.id);
    await totpService.logAuditEvent(user.id, 'totp_disabled', req);

    res.json({ message: '2FA disabled successfully' });
  })
);

router.get(
  '/2fa/backup-codes',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    const { raw, hashed } = await totpService.generateBackupCodes();
    await totpService.storeBackupCodes(user.id, hashed);
    await totpService.logAuditEvent(user.id, 'backup_codes_regenerated', req);

    res.json({ backupCodes: raw });
  })
);

router.post(
  '/2fa/trust-device',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: '2FA code is required to trust device' });
    }

    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    if (!user.totp_secret) {
      logger.error('TOTP secret is null for user with 2FA enabled — check DB integrity', {
        userId: user.id,
      });
      return res
        .status(503)
        .json({ error: 'Service temporarily unavailable. Please try again later.' });
    }

    let plainSecret;
    try {
      plainSecret = decryptSecret(user.totp_secret);
    } catch (err) {
      logger.error('Failed to decrypt TOTP secret — run migrate-totp-secrets', {
        userId: user.id,
        error: err.message,
      });
      return res
        .status(503)
        .json({ error: 'Service temporarily unavailable. Please try again later.' });
    }
    const isValid = totpService.verifyTotp(plainSecret, code);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    const fingerprint = totpService.generateFingerprint(req);
    await totpService.trustDevice(user.id, fingerprint, req);
    await totpService.logAuditEvent(user.id, 'device_trusted', req);

    res.json({ message: 'Device trusted successfully' });
  })
);

router.get(
  '/2fa/devices',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    const devices = await totpService.getUserDevices(user.id);
    res.json({ devices });
  })
);

router.delete(
  '/2fa/devices/:deviceId',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_enabled) {
      return res.status(400).json({ error: '2FA is not enabled' });
    }

    const removed = await totpService.revokeDevice(user.id, parseInt(req.params.deviceId, 10));
    if (!removed) {
      return res.status(404).json({ error: 'Device not found' });
    }

    await totpService.logAuditEvent(user.id, 'device_revoked', req, {
      deviceId: parseInt(req.params.deviceId, 10),
    });

    res.json({ message: 'Device removed' });
  })
);

router.get(
  '/2fa/audit-log',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    if (!user.totp_enabled && user.role !== 'admin') {
      return res.status(403).json({ error: '2FA is not enabled' });
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const { rows: events } = await db.query(
      `SELECT id, event_type, ip_address, user_agent, metadata, created_at
     FROM security_audit_log
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
      [user.id, limit]
    );

    res.json({ events });
  })
);

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    if (!token) {
      return res.status(401).json({ error: 'No refresh token provided' });
    }

    const user = await validateRefreshToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const { accessToken } = generateTokens(user);
    const { token: newRefreshToken, expiresAt } = await rotateRefreshToken(token, user.id);

    setRefreshTokenCookie(res, newRefreshToken, expiresAt);
    setAccessTokenCookie(res, accessToken);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        wallet_public_key: user.wallet_public_key,
        wallet_type: user.wallet_type || 'custodial',
        role: user.role,
        kyc_status: user.kyc_status,
        kyc_completed_at: user.kyc_completed_at,
        kyc_required_for_campaigns: isKycRequiredForCampaigns(),
      },
    });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = req.cookies?.[REFRESH_TOKEN_COOKIE_NAME];
    if (token) {
      await revokeRefreshToken(token);
    }
    clearRefreshTokenCookie(res);
    clearAccessTokenCookie(res);
    // Clear CSRF cookie on logout
    res.clearCookie('cp_csrf', { path: '/' });
    res.json({ ok: true });
  })
);

router.post(
  '/forgot-password',
  loginLimiter,
  forgotPasswordValidation,
  validateRequestAsError,
  asyncHandler(async (req, res) => {
    const normalizedEmail = req.body.email.trim().toLowerCase();

    const { rows } = await db.query('SELECT id, email FROM users WHERE LOWER(email) = $1', [
      normalizedEmail,
    ]);

    if (rows.length) {
      const user = rows[0];
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

      await db.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [user.id]
      );
      await db.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );

      const resetUrl = `${getFrontendUrl()}/reset-password?token=${rawToken}`;
      sendEmail({
        to: user.email,
        subject: 'Reset your CrowdPay password',
        text: `You requested a password reset. Open this link within 1 hour to choose a new password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
        html: `<p>You requested a password reset. <a href="${resetUrl}">Reset your password</a> within 1 hour.</p><p>If you did not request this, you can ignore this email.</p>`,
      });
    }

    res.json({ message: FORGOT_PASSWORD_MESSAGE });
  })
);

router.post(
  '/reset-password',
  loginLimiter,
  resetPasswordValidation,
  validateRequestAsError,
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    const tokenHash = hashToken(token);

    const { rows } = await db.query(
      `SELECT prt.id, prt.user_id
       FROM password_reset_tokens prt
       WHERE prt.token_hash = $1
         AND prt.used_at IS NULL
         AND prt.expires_at > NOW()`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(400).json({
        error: 'Invalid or expired reset link. Please request a new one.',
      });
    }

    const resetToken = rows[0];
    const passwordHash = await bcrypt.hash(password, 10);

    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      passwordHash,
      resetToken.user_id,
    ]);
    await db.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [
      resetToken.id,
    ]);
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [resetToken.user_id]
    );

    res.json({ message: 'Password reset successfully' });
  })
);

router.get('/csrf-token', (req, res) => {
  // CSRF cookie is set by the csrfProtection middleware on all requests.
  // This endpoint lets the frontend fetch the current token value.
  const token = req.cookies?.['cp_csrf'] || null;
  res.json({ csrfToken: token });
});

router.post(
  '/kyc/start',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const result = await startKycForUser(req.user.userId);
      if (result.status === 'verified') {
        return res.json(result);
      }
      res.status(201).json(result);
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ error: err.message });
      }
      res.status(502).json({ error: err.message || 'Could not start identity verification' });
    }
  })
);

router.get(
  '/kyc/status',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const status = await getKycStatusForUser(req.user.userId);
      res.json(status);
    } catch (err) {
      if (err.statusCode === 404) {
        return res.status(404).json({ error: err.message });
      }
      throw err;
    }
  })
);

module.exports = router;
