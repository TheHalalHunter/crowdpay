/**
 * Feature Flags Service
 *
 * A lightweight feature flag system supporting:
 * - Environment variable flags (static on/off toggles)
 * - Gradual percentage-based rollouts (deterministic per-user)
 * - Per-user and per-role flag targeting
 * - Route-level gating via Express middleware
 * - Extensible adapter pattern for Unleash / LaunchDarkly integration
 *
 * ── Usage ──────────────────────────────────────────────────────────
 *
 *   const ff = require('./featureFlags');
 *
 *   // Basic check (env var → default)
 *   if (ff.isEnabled('new-dashboard')) { ... }
 *
 *   // Per-user check (evaluates targeting + percentage rollout)
 *   if (ff.isEnabled('new-dashboard', { userId: req.user.userId, role: req.user.role })) { ... }
 *
 *   // Express middleware — returns 404 when flag is off
 *   router.get('/new-feature', ff.requireFlag('new-dashboard'), handler);
 *
 * ── Defining flags ─────────────────────────────────────────────────
 *
 *   FLAGS: {
 *     'flag-name': {
 *       description: 'Human-readable description',
 *       envVar: 'FLAG_ENV_VAR',     // optional env var name
 *       defaultValue: false,        // fallback when env var is unset
 *       rolloutPct: null,           // null = no gradual rollout; 0–100 for percentage-based
 *       allowedRoles: ['admin'],    // optional role allowlist
 *       allowedUserIds: [],         // optional UUID allowlist (always on for these users)
 *     },
 *   }
 *
 * ── Extending with Unleash / LaunchDarkly ──────────────────────────
 *
 *   To integrate a provider:
 *   1. Create an adapter implementing { isEnabled(name, context) → boolean }
 *   2. Call registerAdapter(flagName, adapter) during bootstrap
 *   3. Use syncFlagsToAdapter(adapter) to push definitions to the provider
 *
 * ── Naming convention ──────────────────────────────────────────────
 *
 *   Use kebab-case for flag names (e.g. 'new-dashboard', 'dark-mode-v2').
 *   Environment variables use SCREAMING_SNAKE_CASE.
 */

const crypto = require('node:crypto');
const logger = require('../config/logger');

// ─── Flag Registry ───────────────────────────────────────────────────
// Add new flags here. Keep them sorted alphabetically for readability.

/** @type {Object<string, FlagDefinition>} */
const FLAGS = {
  'campaign-status-cron': {
    description: 'Enable the hourly campaign status cron job (active→funded/failed)',
    envVar: 'ENABLE_CAMPAIGN_STATUS_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'contract-deployment-retry-cron': {
    description: 'Enable the cron that retries failed Soroban contract deployments',
    envVar: 'ENABLE_CONTRACT_DEPLOYMENT_RETRY_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'kyc-required-for-campaigns': {
    description: 'Require KYC verification before a user can create a campaign',
    envVar: 'KYC_REQUIRED_FOR_CAMPAIGNS',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'reconciliation-cron': {
    description: 'Enable the on-chain balance reconciliation cron (every 15 min)',
    envVar: 'ENABLE_RECONCILIATION_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'retention-purge-cron': {
    description: 'Enable scheduled retention and privacy data purges',
    envVar: 'ENABLE_RETENTION_PURGE_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'restore-verification-cron': {
    description: 'Enable scheduled restore verification checks',
    envVar: 'ENABLE_RESTORE_VERIFICATION_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'scheduled-publish-cron': {
    description:
      'Enable the cron that auto-publishes draft campaigns at their scheduled_publish_at time',
    envVar: 'ENABLE_SCHEDULED_PUBLISH_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'serve-frontend': {
    description: 'Serve the compiled frontend SPA from the backend Express server',
    envVar: 'SERVE_FRONTEND',
    defaultValue: false,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'weekly-digest-cron': {
    description: 'Enable the weekly contributor email digest cron job',
    envVar: 'ENABLE_WEEKLY_DIGEST_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'deadline-reminder-cron': {
    description: 'Enable the cron that sends 48h and 12h deadline reminders',
    envVar: 'ENABLE_DEADLINE_REMINDER_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'notification-quiet-hours-cron': {
    description: 'Enable the hourly cron that flushes quiet-hours notification digests',
    envVar: 'ENABLE_NOTIFICATION_QUIET_HOURS_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'scheduled-campaign-updates-cron': {
    description: 'Enable the cron that publishes scheduled campaign updates when due',
    envVar: 'ENABLE_SCHEDULED_CAMPAIGN_UPDATES_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'recurring-payout-schedules-cron': {
    description: 'Enable the cron that raises withdrawal requests for due creator payout schedules',
    envVar: 'ENABLE_RECURRING_PAYOUT_SCHEDULES_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
  'milestone-auto-release-cron': {
    description:
      'Enable the cron that fires automatic milestone releases once their dispute window elapses (kill switch)',
    envVar: 'ENABLE_MILESTONE_AUTO_RELEASE_CRON',
    defaultValue: true,
    rolloutPct: null,
    allowedRoles: null,
    allowedUserIds: null,
  },
};

// ─── Adapter Store ───────────────────────────────────────────────────
// External providers (Unleash, LaunchDarkly) can register themselves here.
// When an adapter is registered for a flag, it takes precedence over static evaluation.

/** @type {Map<string, FeatureFlagAdapter>} */
const adapters = new Map();

// ─── In-memory Override Store ────────────────────────────────────────
// Used for testing and admin debug panels.

/** @type {Map<string, boolean>} */
const _overrides = new Map();

/**
 * @typedef {Object} FlagDefinition
 * @property {string} description
 * @property {string}  [envVar]       – Override the auto-derived env var name
 * @property {boolean} defaultValue   – Fallback when env var is unset
 * @property {number|null} rolloutPct – 0–100 percentage for gradual rollout (null = disabled)
 * @property {string[]|null} allowedRoles – Roles that always see the flag as enabled
 * @property {string[]|null} allowedUserIds – User UUIDs that always see the flag as enabled
 */

/**
 * @typedef {Object} FlagEvalContext
 * @property {string}  [userId]
 * @property {string}  [role]
 * @property {string}  [email]
 * @property {string}  [sessionId]
 */

/**
 * @typedef {Object} FeatureFlagAdapter
 * @property {(name: string, context: FlagEvalContext) => boolean} isEnabled
 * @property {(name: string, definition: FlagDefinition) => void} [register]
 */

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Evaluate whether a feature flag is enabled for the given context.
 *
 * Priority (first match wins):
 *   1. In-memory override (setOverride / admin panel)
 *   2. Registered external adapter (Unleash, LaunchDarkly)
 *   3. Per-user allowlist (allowedUserIds)
 *   4. Per-role allowlist (allowedRoles)
 *   5. Percentage rollout bucket (deterministic hash of userId + flagName)
 *   6. Environment variable
 *   7. Flag's defaultValue
 *
 * @param {string} flagName
 * @param {FlagEvalContext} [context={}]
 * @returns {boolean}
 */
function isEnabled(flagName, context = {}) {
  const flag = FLAGS[flagName];
  if (!flag) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn('Unknown feature flag checked', { flagName });
    }
    return false;
  }

  // 1. In-memory overrides (testing / admin)
  if (_overrides.has(flagName)) {
    return _overrides.get(flagName);
  }

  // 2. External adapter
  const adapter = adapters.get(flagName) || adapters.get('*');
  if (adapter) {
    return adapter.isEnabled(flagName, context);
  }

  // 3. Per-user allowlist
  if (flag.allowedUserIds && context.userId) {
    if (flag.allowedUserIds.includes(context.userId)) {
      return true;
    }
  }

  // 4. Per-role allowlist
  if (flag.allowedRoles && context.role) {
    if (flag.allowedRoles.includes(context.role)) {
      return true;
    }
  }

  // 5. Env var → base enabled state
  const baseEnabled = _resolveEnvVar(flag);

  // 6. Percentage rollout (only applies when base is enabled and rolloutPct is set)
  if (baseEnabled && flag.rolloutPct !== null && flag.rolloutPct > 0 && flag.rolloutPct < 100) {
    if (!context.userId && !context.sessionId) {
      // No user context — only enable for 100% rollouts or specific users
      return flag.rolloutPct >= 100;
    }
    return _isInRolloutBucket(flagName, context, flag.rolloutPct);
  }

  return baseEnabled;
}

/**
 * A/B test variant assignment.
 *
 * Returns the variant (e.g. 'control' or 'treatment') assigned to a user
 * for a given flag, or `null` if the flag is disabled for the user.
 *
 * For env-based flags without `rolloutPct`, this returns `'control'` when
 * the flag is enabled and `null` when disabled (simple on/off behavior).
 * For percentage-rolled flags, users are bucketed into `'control'` or
 * `'treatment'` deterministically.
 *
 * When the `feature_flags` DB table is populated with custom `variants`,
 * extend this method to return the variant from the DB record.
 *
 * @param {string} flagName
 * @param {FlagEvalContext} [context={}]
 * @returns {string|null} 'control', 'treatment', or null
 */
function getVariant(flagName, context = {}) {
  // External adapter takes precedence over static evaluation (same as isEnabled).
  const adapter = adapters.get(flagName) || adapters.get('*');
  if (adapter && typeof adapter.getVariant === 'function') {
    const variant = adapter.getVariant(flagName, context);
    if (!variant) return null;
    if (typeof variant === 'object') {
      if (variant.enabled === false) return null;
      return typeof variant.name === 'string' && variant.name.length > 0 ? variant.name : null;
    }
    return typeof variant === 'string' && variant.length > 0 ? variant : null;
  }

  if (!isEnabled(flagName, context)) return null;

  const flag = FLAGS[flagName];
  if (!flag) return null;

  // When no rollout is configured, treat as simple on/off
  if (flag.rolloutPct === null || flag.rolloutPct >= 100) {
    return 'control';
  }

  // For percentage-based flags, bucket the user
  if (!context.userId && !context.sessionId) {
    return 'control';
  }

  return _isInRolloutBucket(flagName, context, flag.rolloutPct) ? 'treatment' : 'control';
}

/**
 * Return a snapshot of every known flag with its resolved state for the given context.
 *
 * @param {FlagEvalContext} [context={}]
 * @returns {Array<{name: string, description: string, enabled: boolean, envVar: string|null, rolloutPct: number|null}>}
 */
function getAllFlags(context = {}) {
  return Object.entries(FLAGS).map(([name, flag]) => ({
    name,
    description: flag.description,
    enabled: isEnabled(name, context),
    envVar: flag.envVar || null,
    rolloutPct: flag.rolloutPct ?? null,
  }));
}

/**
 * Register an external adapter (Unleash, LaunchDarkly, etc.).
 * Pass '*' as the flagName to act as a fallback for all flags.
 *
 * @param {string} flagName
 * @param {FeatureFlagAdapter} adapter
 */
function registerAdapter(flagName, adapter) {
  adapters.set(flagName, adapter);
  logger.info('Feature flag adapter registered', { flagName });
}

/**
 * Remove a previously registered adapter.
 * @param {string} flagName
 */
function unregisterAdapter(flagName) {
  adapters.delete(flagName);
}

/**
 * Override a flag for the current process lifetime.
 * Useful for tests and admin debug panels.
 * Pass `null` to clear an existing override.
 *
 * @param {string} flagName
 * @param {boolean|null} value
 */
function setOverride(flagName, value) {
  if (value === null) {
    _overrides.delete(flagName);
  } else {
    _overrides.set(flagName, Boolean(value));
  }
}

/** Clear all in-memory overrides (e.g. between test cases). */
function clearOverrides() {
  _overrides.clear();
}

/**
 * Express middleware: gate a route behind a feature flag.
 *
 * @param {string} flagName
 * @param {{ behavior?: '404'|'403'|'feature_disabled' }} [options]
 *   - '404' (default): respond with 404 Not Found (hides the endpoint)
 *   - '403': respond with 403 Forbidden
 *   - 'feature_disabled': respond with 200 and { feature_disabled: true, flag }
 * @returns {import('express').RequestHandler}
 */
function requireFlag(flagName, options = {}) {
  const behavior = options.behavior || '404';
  return (req, res, next) => {
    const context = {
      userId: req.user?.userId,
      role: req.user?.role,
      email: req.user?.email,
    };
    if (isEnabled(flagName, context)) {
      next();
    } else {
      switch (behavior) {
        case '403':
          res.status(403).json({ error: 'Feature disabled' });
          break;
        case 'feature_disabled':
          res.json({ feature_disabled: true, flag: flagName });
          break;
        case '404':
        default:
          res.status(404).json({ error: 'Not found' });
          break;
      }
    }
  };
}

/**
 * Push all static flag definitions into an external provider adapter.
 * Call this during bootstrap when integrating Unleash / LaunchDarkly.
 *
 * @param {FeatureFlagAdapter} adapter – A provider adapter that accepts register(name, definition)
 */
function syncFlagsToAdapter(adapter) {
  for (const [name, definition] of Object.entries(FLAGS)) {
    if (typeof adapter.register === 'function') {
      adapter.register(name, definition);
    }
  }
}

// ─── Internals ───────────────────────────────────────────────────────

/**
 * Resolve a flag's base state from its environment variable.
 * Treats 'false', '0', 'no', 'off' as disabled; everything else truthy.
 */
function _resolveEnvVar(flag) {
  const val = process.env[flag.envVar];
  if (val === undefined || val === null) {
    return flag.defaultValue;
  }
  return !['false', '0', 'no', 'off', ''].includes(String(val).toLowerCase().trim());
}

/**
 * Deterministic rollout bucket using SHA-256.
 * Maps (flagName, userId/sessionId) → 0–99, then checks if bucket < rolloutPct.
 *
 * Exported for testing.
 */
function _isInRolloutBucket(flagName, context, rolloutPct) {
  const seed = context.userId || context.sessionId || 'anonymous';
  const hash = crypto.createHash('sha256').update(`${flagName}::${seed}`).digest('hex');
  const bucket = parseInt(hash.slice(0, 8), 16) % 100; // 0–99
  return bucket < rolloutPct;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  FLAGS,
  isEnabled,
  getVariant,
  getAllFlags,
  registerAdapter,
  unregisterAdapter,
  setOverride,
  clearOverrides,
  requireFlag,
  syncFlagsToAdapter,
  _isInRolloutBucket,
};
