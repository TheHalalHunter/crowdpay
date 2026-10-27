const { body, param, query, validationResult } = require('express-validator');
const { Keypair } = require('@stellar/stellar-sdk');
const { getSupportedAssetCodes } = require('../services/stellarService');
const { stripHtml, sanitizeRichText } = require('../lib/sanitize');
const { isValidAmount, STROOP_DECIMALS } = require('../utils/stroops');

const SUPPORTED_ASSETS = getSupportedAssetCodes();
const VALID_CAMPAIGN_STATUSES = ['active', 'funded', 'closed', 'failed'];
const VALID_ORDER_BY = [
  'newest',
  'ending_soon',
  'most_funded',
  'most_backed',
  'closest_to_goal',
  'trending',
  'relevance',
];
const VALID_CATEGORIES = [
  'technology',
  'community',
  'arts',
  'education',
  'environment',
  'health',
  'business',
  'open_source',
  'other',
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function blankToNull(value) {
  return typeof value === 'string' && value.trim() === '' ? null : value;
}

const passwordValidation = [
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long')
    .matches(/[a-z]/)
    .withMessage('Password must include a lowercase letter')
    .matches(/[A-Z]/)
    .withMessage('Password must include an uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must include a number'),
];

const registerValidation = [
  body('email').trim().toLowerCase().isEmail().withMessage('Invalid email format'),
  ...passwordValidation,
  body('name').customSanitizer(stripHtml).notEmpty().withMessage('Name is required'),
  body('wallet_type')
    .optional()
    .isIn(['custodial', 'freighter'])
    .withMessage('wallet_type must be custodial or freighter'),
  body('wallet_public_key')
    .optional()
    .custom((value, { req }) => {
      if (req.body.wallet_type === 'freighter') {
        try {
          Keypair.fromPublicKey(value);
          return true;
        } catch (_err) {
          throw new Error('wallet_public_key must be a valid Stellar public key');
        }
      }
      return true;
    }),
  body('role')
    .optional()
    .isIn(['contributor', 'creator'])
    .withMessage('Role must be contributor or creator'),
];

const loginValidation = [
  body('email').trim().toLowerCase().isEmail().withMessage('Invalid email format'),
  body('password').notEmpty().withMessage('Password is required'),
];

const forgotPasswordValidation = [
  body('email').trim().toLowerCase().isEmail().withMessage('Invalid email format'),
];

const resetPasswordValidation = [
  body('token').notEmpty().withMessage('Reset token is required'),
  ...passwordValidation,
];

const validateDeadline = value => {
  if (!value) return true;
  const deadline = new Date(value);
  const now = new Date();
  const minFutureTime = now.getTime() + 24 * 60 * 60 * 1000;
  if (isNaN(deadline.getTime()) || deadline.getTime() < minFutureTime) {
    throw new Error('Deadline must be at least 24 hours in the future');
  }
  return true;
};

const createCampaignValidation = [
  body('title')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Title is required')
    .isLength({ max: 100 })
    .withMessage('Title must be at most 100 characters'),
  body('category')
    .optional({ nullable: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 50 })
    .withMessage('Category must be at most 50 characters'),
  body('description')
    .optional({ nullable: true })
    .customSanitizer(sanitizeRichText)
    .isLength({ max: 1000 })
    .withMessage('Description must be at most 1000 characters'),
  body('target_amount')
    .exists()
    .withMessage('Target amount is required')
    .isFloat({ gt: 0 })
    .withMessage('Target amount must be greater than zero')
    .bail()
    .custom(value => isValidAmount(value))
    .withMessage(
      `Target amount must have at most ${STROOP_DECIMALS} decimal places and fit a Stellar amount`
    ),
  body('asset_type')
    .notEmpty()
    .withMessage('Asset type is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`Asset type must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('template_id')
    .optional({ nullable: true, checkFalsy: true })
    .custom(isUuid)
    .withMessage('template_id must be a valid UUID'),
  body('deadline')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Deadline must be a valid ISO 8601 date (preferably with Z suffix for UTC)')
    .custom(validateDeadline),
  body('min_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Minimum contribution must be greater than zero'),
  body('max_contribution')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Maximum contribution must be greater than zero'),
  body('max_per_user')
    .optional({ nullable: true, checkFalsy: true })
    .isFloat({ gt: 0 })
    .withMessage('Maximum per user must be greater than zero')
    .custom((value, { req }) => {
      if (value === undefined || value === null || value === '') return true;
      const maxPerUser = parseFloat(value);
      if (isNaN(maxPerUser) || maxPerUser <= 0) return true; // handled by isFloat above
      const minContribution = parseFloat(req.body.min_contribution);
      if (!isNaN(minContribution) && maxPerUser <= minContribution) {
        throw new Error('Per-contributor cap must be greater than minimum contribution');
      }
      return true;
    }),
  body('milestones')
    .optional({ nullable: true })
    .isArray({ max: 20 })
    .withMessage('Milestones must be an array of at most 20 items'),
  body('milestones.*.release_percentage')
    .optional({ nullable: true })
    .isFloat({ min: 0, max: 100 })
    .withMessage('Milestone release_percentage must be between 0 and 100'),
  body('milestones').custom(milestones => {
    if (!milestones || !Array.isArray(milestones)) return true;
    if (milestones.length === 0) return true;
    const total = milestones.reduce((sum, m) => {
      const pct = parseFloat(m?.release_percentage);
      return sum + (isNaN(pct) ? 0 : pct);
    }, 0);
    if (total > 100) {
      throw new Error('Milestone percentages must not exceed 100%');
    }
    return true;
  }),
];

const updateCampaignValidation = [
  body('title')
    .optional({ nullable: true, checkFalsy: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 100 })
    .withMessage('Title must be at most 100 characters'),
  body('category')
    .optional({ nullable: true, checkFalsy: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 50 })
    .withMessage('Category must be at most 50 characters'),
  body('description')
    .optional({ nullable: true, checkFalsy: true })
    .customSanitizer(sanitizeRichText)
    .isLength({ max: 1000 })
    .withMessage('Description must be at most 1000 characters'),
  body('target_amount')
    .optional({ nullable: true })
    .isFloat({ gt: 0 })
    .withMessage('Target amount must be greater than zero')
    .bail()
    .custom(value => isValidAmount(value))
    .withMessage(
      `Target amount must have at most ${STROOP_DECIMALS} decimal places and fit a Stellar amount`
    ),
  body('deadline')
    .optional({ nullable: true, checkFalsy: true })
    .isISO8601()
    .withMessage('Deadline must be a valid ISO 8601 date (preferably with Z suffix for UTC)')
    .custom(validateDeadline),
  body('country')
    .optional({ nullable: true, checkFalsy: true })
    .customSanitizer(stripHtml)
    .isLength({ max: 80 })
    .withMessage('Country must be at most 80 characters'),
  body('min_contribution')
    .optional({ nullable: true })
    .isFloat({ gt: 0 })
    .withMessage('Minimum contribution must be greater than zero'),
  body('max_contribution')
    .optional({ nullable: true })
    .isFloat({ gt: 0 })
    .withMessage('Maximum contribution must be greater than zero'),
  body('max_per_user')
    .optional({ nullable: true })
    .isFloat({ gt: 0 })
    .withMessage('Maximum per user must be greater than zero')
    .custom((value, { req }) => {
      if (value === undefined || value === null || value === '') return true;
      const maxPerUser = parseFloat(value);
      if (isNaN(maxPerUser) || maxPerUser <= 0) return true;
      const minContribution = parseFloat(req.body.min_contribution);
      if (!isNaN(minContribution) && maxPerUser <= minContribution) {
        throw new Error('Per-contributor cap must be greater than minimum contribution');
      }
      return true;
    }),
];

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: errors.array()[0].msg, errors: errors.array() });
  }
  next();
};

const thankYouValidation = [
  body('message')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Message is required')
    .isLength({ min: 1, max: 500 })
    .withMessage('Message must be between 1 and 500 characters'),
];

const CAMPAIGN_UPDATE_BODY_MAX_LENGTH = 5000;

const createCampaignUpdateValidation = [
  body('title').customSanitizer(stripHtml).notEmpty().withMessage('Title is required'),
  body('body')
    .customSanitizer(stripHtml)
    .notEmpty()
    .withMessage('Body is required')
    .isLength({ max: CAMPAIGN_UPDATE_BODY_MAX_LENGTH })
    .withMessage(`Update body must be ${CAMPAIGN_UPDATE_BODY_MAX_LENGTH} characters or fewer`),
];

const contributionQuoteValidation = [
  query('send_asset')
    .notEmpty()
    .withMessage('send_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`send_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('dest_asset')
    .notEmpty()
    .withMessage('dest_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`dest_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('dest_amount')
    .notEmpty()
    .withMessage('dest_amount is required')
    .isFloat({ gt: 0 })
    .withMessage('dest_amount must be greater than zero'),
];

const contributionValidation = [
  body('campaign_id')
    .notEmpty()
    .withMessage('campaign_id is required')
    .custom(value => {
      if (!isUuid(value)) throw new Error('campaign_id must be a valid UUID');
      return true;
    }),
  body('amount')
    .exists()
    .withMessage('amount is required')
    .isFloat({ gt: 0 })
    .withMessage('amount must be greater than zero')
    .bail()
    .custom(value => isValidAmount(value))
    .withMessage(
      `amount must have at most ${STROOP_DECIMALS} decimal places and fit a Stellar amount`
    ),
  body('send_asset')
    .notEmpty()
    .withMessage('send_asset is required')
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`send_asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  body('display_name')
    .optional({ nullable: true })
    .customSanitizer(val => (typeof val === 'string' ? stripHtml(val).trim() : val))
    .custom(value => {
      if (
        typeof value === 'string' &&
        [...value].some(ch => {
          const c = ch.charCodeAt(0);
          return c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f);
        })
      ) {
        throw new Error('Display name contains invalid control characters or null bytes');
      }
      return true;
    })
    .isLength({ max: 50 })
    .withMessage('Display name must be at most 50 characters'),
  body('gift').optional({ nullable: true }).isObject().withMessage('gift must be an object'),
  body('gift.recipient_email')
    .if(body('gift').isObject({ strict: true }))
    .trim()
    .isLength({ max: 254 })
    .withMessage('gift.recipient_email must be at most 254 characters')
    .isEmail()
    .withMessage('gift.recipient_email must be a valid email address')
    .normalizeEmail(),
  body('gift.recipient_name')
    .if(body('gift').isObject({ strict: true }))
    .customSanitizer(val => (typeof val === 'string' ? stripHtml(val).trim() : val))
    .isLength({ min: 1, max: 100 })
    .withMessage('gift.recipient_name must be between 1 and 100 characters'),
  body('gift.message')
    .optional({ nullable: true })
    .customSanitizer(val => (typeof val === 'string' ? stripHtml(val).trim() : val))
    .isLength({ max: 280 })
    .withMessage('gift.message must be at most 280 characters'),
  body('tier_id')
    .optional({ nullable: true })
    .custom(value => {
      if (value === null || value === undefined || value === '') return true;
      if (!isUuid(value)) throw new Error('tier_id must be a valid UUID');
      return true;
    })
    .withMessage('tier_id must be a valid UUID'),
  body('idempotency_key')
    .optional({ nullable: true })
    .isString()
    .withMessage('idempotency_key must be a string')
    .matches(/^[\x21-\x7e]{1,255}$/)
    .withMessage('idempotency_key must be 1-255 printable ASCII characters without whitespace'),
];

const withdrawalValidation = [
  body('campaign_id')
    .notEmpty()
    .withMessage('campaign_id is required')
    .custom(value => {
      if (!isUuid(value)) throw new Error('campaign_id must be a valid UUID');
      return true;
    }),
  body('amount')
    .exists()
    .withMessage('amount is required')
    .isFloat({ gt: 0 })
    .withMessage('amount must be greater than zero'),
  body('destination_key')
    .notEmpty()
    .withMessage('destination_key is required')
    .custom(value => {
      try {
        Keypair.fromPublicKey(value);
        return true;
      } catch (_err) {
        throw new Error('destination_key must be a valid Stellar public key');
      }
    }),
];

const createAnnouncementValidation = [
  body('message')
    .customSanitizer(stripHtml)
    .trim()
    .notEmpty()
    .withMessage('message is required')
    .isLength({ max: 500 })
    .withMessage('message must be at most 500 characters'),
  body('severity')
    .customSanitizer(blankToNull)
    .optional({ nullable: true })
    .isIn(['info', 'warning', 'critical'])
    .withMessage('severity must be info, warning, or critical'),
  body('details_url')
    .customSanitizer(blankToNull)
    .optional({ nullable: true })
    .isURL({ require_protocol: true })
    .withMessage('details_url must be a valid URL'),
  body('active_from')
    .customSanitizer(blankToNull)
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('active_from must be a valid ISO 8601 date-time'),
  body('active_until')
    .customSanitizer(blankToNull)
    .optional({ nullable: true })
    .isISO8601()
    .withMessage('active_until must be a valid ISO 8601 date-time')
    .custom((value, { req }) => {
      const activeFrom = req.body.active_from;
      const startsAt = activeFrom ? new Date(activeFrom) : new Date();
      if (new Date(value).getTime() <= startsAt.getTime()) {
        throw new Error(
          activeFrom
            ? 'active_until must be after active_from'
            : 'active_until must be in the future'
        );
      }
      return true;
    }),
];

const announcementIdValidation = [
  param('id').custom(value => {
    if (!isUuid(value)) throw new Error('id must be a valid UUID');
    return true;
  }),
];

const getCampaignsValidation = [
  query('search').optional().customSanitizer(stripHtml),
  query('category').optional().customSanitizer(stripHtml),
  query('min_progress')
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage('min_progress must be between 0 and 100'),
  query('status')
    .optional()
    .isIn(VALID_CAMPAIGN_STATUSES)
    .withMessage(`status must be one of: ${VALID_CAMPAIGN_STATUSES.join(', ')}`),
  query('asset')
    .optional()
    .isIn(SUPPORTED_ASSETS)
    .withMessage(`asset must be one of: ${SUPPORTED_ASSETS.join(', ')}`),
  query('sort')
    .optional()
    .isIn(VALID_ORDER_BY)
    .withMessage(`sort must be one of: ${VALID_ORDER_BY.join(', ')}`),
  query('limit')
    .optional()
    .toInt()
    .isInt({ min: 1, max: 100 })
    .withMessage('limit must be a positive integer up to 100'),
  query('offset')
    .optional()
    .toInt()
    .isInt({ min: 0 })
    .withMessage('offset must be a non-negative integer'),
];

function validateRequest(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  const fields = result.array().map(e => ({
    field: e.path || e.param,
    message: e.msg,
  }));

  // Use explicit per-route configuration via req.validationErrorCode, default to 400
  const statusCode = req.validationErrorCode || 400;

  return res.status(statusCode).json({
    error: {
      code: 'VALIDATION_ERROR',
      message: fields[0]?.message || 'Validation failed',
      fields,
    },
  });
}

function validateRequestAsError(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();

  return res.status(400).json({ error: result.array()[0].msg });
}

/**
 * Create a validateRequest middleware with a specific error status code.
 * @param {number} statusCode - HTTP status code for validation errors (e.g., 422)
 * @returns {Function} Express middleware
 */
function createValidateRequest(statusCode) {
  return (req, res, next) => {
    req.validationErrorCode = statusCode;
    validateRequest(req, res, next);
  };
}

const DEDICATION_HONOREE_MAX = 100;
const DEDICATION_MESSAGE_MAX = 1000;
const DEDICATION_TYPES = ['in_honor_of', 'in_memory_of'];

/**
 * Validation for POST /api/contributions/:contributionId/dedication
 * and PATCH /api/contributions/:contributionId/dedication (all fields optional on update).
 */
const dedicationValidation = [
  body('honoree_name')
    .customSanitizer(val => (typeof val === 'string' ? stripHtml(val).trim() : val))
    .notEmpty()
    .withMessage('honoree_name is required')
    .isLength({ min: 1, max: DEDICATION_HONOREE_MAX })
    .withMessage(`honoree_name must be between 1 and ${DEDICATION_HONOREE_MAX} characters`)
    .custom(value => {
      if (
        typeof value === 'string' &&
        [...value].some(ch => {
          const c = ch.charCodeAt(0);
          return c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f);
        })
      ) {
        throw new Error('honoree_name contains invalid control characters');
      }
      return true;
    }),
  body('message')
    .optional({ nullable: true })
    .customSanitizer(val => (typeof val === 'string' ? stripHtml(val).trim() : val))
    .isLength({ max: DEDICATION_MESSAGE_MAX })
    .withMessage(`message must be at most ${DEDICATION_MESSAGE_MAX} characters`),
  body('dedication_type')
    .optional({ nullable: true })
    .customSanitizer(blankToNull)
    .isIn(DEDICATION_TYPES)
    .withMessage(`dedication_type must be one of: ${DEDICATION_TYPES.join(', ')}`),
  body('is_public')
    .optional({ nullable: true })
    .isBoolean()
    .withMessage('is_public must be a boolean'),
];

module.exports = {
  registerValidation,
  loginValidation,
  forgotPasswordValidation,
  resetPasswordValidation,
  passwordValidation,
  validateRequest,
  validateRequestAsError,
  createValidateRequest,
  createCampaignValidation,
  updateCampaignValidation,
  createCampaignUpdateValidation,
  thankYouValidation,
  contributionValidation,
  contributionQuoteValidation,
  withdrawalValidation,
  createAnnouncementValidation,
  announcementIdValidation,
  getCampaignsValidation,
  dedicationValidation,
  handleValidationErrors,
  isUuid,
  blankToNull,
  CAMPAIGN_UPDATE_BODY_MAX_LENGTH,
};
