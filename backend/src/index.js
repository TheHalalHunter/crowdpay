const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { requestIdMiddleware } = require('./middleware/requestId');
const { requestLogger } = require('./middleware/requestLogger');
const logger = require('./config/logger');
const { normalizeErrorResponse, errorHandler } = require('./middleware/errorHandler');
const compression = require('./middleware/compression');
const Sentry = require('@sentry/node');
const db = require('./config/database');

const { validateEnv } = require('./config/env');

const app = express();

if (process.env.NODE_ENV !== 'test') {
  validateEnv();
}

function buildCorsOrigin() {
  const raw = [process.env.FRONTEND_URL, process.env.CORS_ALLOWED_ORIGINS]
    .filter(Boolean)
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean);
  if (raw.length === 0) {
    return process.env.NODE_ENV === 'production' ? [] : true;
  }
  return raw;
}

app.use(requestIdMiddleware);
app.use(requestLogger);
app.use(helmet());
app.use(cors({ origin: buildCorsOrigin(), credentials: true }));
app.use(compression);

// Preserve the exact raw request bytes for signature-verified webhook callbacks
// (Persona KYC + user webhooks + SEP-24 anchor callbacks). The global JSON
// parser below would otherwise consume the request stream and destroy the
// ability to recompute the HMAC the sender signed, so raw parsers MUST run
// first (#799). Each handler verifies the signature before parsing the JSON
// body itself.
app.use('/api/webhooks/kyc', express.raw({ type: () => true, limit: '1mb' }));
app.use('/api/webhooks/incoming', express.raw({ type: () => true, limit: '1mb' }));
// SEP-24 provider callbacks are public (no API-key auth) and protected by
// HMAC-SHA256 signature verification in the route handler. The raw body must
// be preserved so the HMAC over the exact bytes can be recomputed.
app.use('/api/anchor/callbacks', express.raw({ type: () => true, limit: '1mb' }));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
// CSP reports are sent by browsers without cookies or CSRF tokens, so mount
// this collector before the CSRF guard. The route has its own body parser and
// per-IP rate limit.
app.use('/api/csp-report', require('./routes/cspReports'));
app.use(require('./middleware/csrf').csrfProtection);

app.use('/api/v1', require('./routes/v1'));
// NOTE: adminAuditLogs.js is deprecated â€” audit logs are served via admin.js -> auditLogs.js.
// Do not mount it here; it would shadow GET /api/admin/audit-logs.
app.use('/api/admin', require('./routes/admin'));
app.use('/api/anchor', require('./routes/anchor'));
app.use('/api/announcements', require('./routes/announcement'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/featureFlags'));
app.use('/api/campaigns', require('./routes/bulkCampaigns'));
app.use('/api/campaigns', require('./routes/payoutSchedules'));
app.use('/api/campaigns', require('./routes/campaignComments'));
app.use('/api/campaigns', require('./routes/campaignFollowers'));
app.use('/api/campaigns', require('./routes/campaignCommunicationPreferences'));
app.use('/api/campaigns', require('./routes/outcomeSurveys'));
app.use('/api/campaigns', require('./routes/campaignActivity'));
app.use('/api/campaigns/:campaignId/contribution/preview', require('./routes/pathPaymentPreview'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/campaigns', require('./routes/campaignUpdates'));
app.use('/api/campaigns', require('./routes/translations'));
app.use('/api/campaigns', require('./routes/campaignRequirements'));
// Sponsor matching pledges live under the campaign they fund; the user-scoped
// pledge list is served from /api/user/sponsor-matches.
app.use('/api/campaigns', require('./routes/sponsorMatching').campaignRouter);
app.use('/api', require('./routes/sponsorMatching').userRouter);
app.use('/api/campaign-templates', require('./routes/campaignTemplates'));
app.use('/api/campaign-pools', require('./routes/contributionPools'));
app.use('/api/contributions', require('./routes/contributions'));
app.use('/api/contributions', require('./routes/contributionDedications'));
app.use('/api/campaigns', require('./routes/contributionDedications'));
app.use('/api/contributor-identity', require('./routes/contributorIdentity'));
app.use('/api/creator', require('./routes/creatorAnalytics'));
app.use('/api/creator', require('./routes/payoutForecast'));
app.use('/api/disputes', require('./routes/disputes'));
app.use('/api/emails', require('./routes/emails'));
app.use('/api/embed', require('./routes/embed'));
app.use('/api/governance', require('./routes/governance'));
app.use('/health', require('./routes/health'));
app.use('/api/impact-reports', require('./routes/impactReports'));
app.use('/api/invites', require('./routes/invites'));
app.use('/api/webhooks/kyc', require('./routes/kycWebhook'));
app.use('/api/milestones', require('./routes/milestones'));
app.use('/api/milestones', require('./routes/milestoneChecklists'));
app.use('/api/nft-rewards', require('./routes/nftRewards'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/ops', require('./routes/ops'));
app.use('/api/rates', require('./routes/rates'));
app.use('/api/referrals', require('./routes/referrals'));
app.use('/api/refunds', require('./routes/creatorRefunds'));
app.use('/api/refund-requests', require('./routes/refundRequests'));
app.use('/api/sessions', require('./routes/sessions'));
// Legacy mount kept so existing /api/sponsor-matching/* clients keep working.
app.use('/api/sponsor-matching', require('./routes/sponsorMatching').campaignRouter);
app.use('/api/sponsor-matching', require('./routes/sponsorMatching').userRouter);
app.use('/api/stellar-transactions', require('./routes/stellarTransactions'));
app.use('/api', require('./routes/subscriptions'));
app.use('/api', require('./routes/categoryFollows'));
app.use('/api', require('./routes/thankYou'));
app.use('/api/translations', require('./routes/translations'));
app.use('/api/treasury', require('./routes/treasury'));
app.use('/api/users', require('./routes/users'));
app.use('/api/credentials', require('./routes/credentialActivity'));
app.use('/api/wallets', require('./routes/wallets'));
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/withdrawals', require('./routes/withdrawals'));

// Development-only route for email template preview (#1036)
if (process.env.NODE_ENV === 'development') {
  app.use('/api/dev', require('./routes/dev'));
}

app.use(normalizeErrorResponse);
app.use(errorHandler);

const PORT = process.env.PORT || 3001;
if (require.main === module) {
  const { startBackgroundWorkers, stopBackgroundWorkers } = require('./worker');

  const server = app.listen(PORT, async () => {
    logger.info(`Server running on port ${PORT}`);
    await startBackgroundWorkers();
  });

  const gracefulShutdown = async () => {
    logger.info('Received shutdown signal, stopping background workers...');
    await stopBackgroundWorkers();
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  };

  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

module.exports = app;
