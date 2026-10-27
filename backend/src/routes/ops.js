/**
 * ops.js
 *
 * Operations Centre REST API.
 * Requires `OPS_API_KEY` header for all routes to isolate ops access from user JWTs.
 */

const express = require('express');
const router = express.Router();
const db = require('../config/database');
const logger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');
const {
  collectHealthMetrics,
  getLatestHealthSnapshot,
  auditCampaignWallets,
} = require('../services/ops/healthCollector');
const { executeRunbook } = require('../services/ops/runbooks');
const { submitWalletTopUpPayment } = require('../services/stellarService');
const {
  listLedgerCheckpoints,
  listLedgerAlerts,
  requestBoundedBackfill,
} = require('../services/ledgerMonitor');

/**
 * Middleware to require and validate OPS_API_KEY.
 */
function requireOpsApiKey(req, res, next) {
  const configuredKey = process.env.OPS_API_KEY;
  if (!configuredKey) {
    logger.error('OPS_API_KEY is not configured — refusing ops access');
    return res.status(500).json({
      error: {
        code: 'OPS_MISCONFIGURED',
        message: 'Operations API is not configured.',
      },
    });
  }
  const providedKey =
    req.headers['ops_api_key'] ||
    req.headers['ops-api-key'] ||
    req.headers['x-ops-api-key'] ||
    (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null);

  if (!providedKey || providedKey !== configuredKey) {
    logger.warn('Unauthorized access attempt to /api/ops', {
      ip: req.ip,
      path: req.path,
    });
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED_OPS',
        message: 'Invalid or missing OPS_API_KEY header.',
      },
    });
  }

  next();
}

router.use(requireOpsApiKey);

router.get(
  '/ledger/checkpoints',
  asyncHandler(async (req, res) => {
    res.json({ checkpoints: await listLedgerCheckpoints(req.query.campaign_id || null) });
  })
);

router.get(
  '/ledger/alerts',
  asyncHandler(async (req, res) => {
    res.json({ alerts: await listLedgerAlerts(req.query.campaign_id || null) });
  })
);

router.post(
  '/ledger/backfill',
  asyncHandler(async (req, res) => {
    const { campaign_id, wallet_public_key, from_cursor, to_cursor, max_events } = req.body || {};
    const result = await requestBoundedBackfill({
      campaignId: campaign_id,
      walletPublicKey: wallet_public_key,
      fromCursor: from_cursor,
      toCursor: to_cursor,
      maxEvents: max_events,
      requestedBy: null,
    });
    res.status(202).json({ backfill: result });
  })
);

/**
 * GET /api/ops/health
 * Returns the current health score, latest metric breakdown, and subsystem status.
 */
router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const forceFresh = req.query.fresh === 'true';
    let snapshot = getLatestHealthSnapshot();

    if (!snapshot || forceFresh) {
      snapshot = await collectHealthMetrics();
    }

    res.json({
      status: 'ok',
      health_score: snapshot.system_health_score,
      collected_at: snapshot.collected_at,
      data: snapshot,
    });
  })
);

/**
 * GET /api/ops/metrics/history
 * Returns historical time-series data for a specific metric.
 */
router.get(
  '/metrics/history',
  asyncHandler(async (req, res) => {
    const { metric = 'horizon_testnet_latency_ms', from, to, limit = 100 } = req.query;

    const fromDate = from ? new Date(from) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const toDate = to ? new Date(to) : new Date();

    const { rows } = await db.query(
      `SELECT id, collected_at, metric_name, metric_value, metric_labels, threshold_breached
     FROM ops_metrics
     WHERE metric_name = $1 AND collected_at >= $2 AND collected_at <= $3
     ORDER BY collected_at ASC
     LIMIT $4`,
      [metric, fromDate, toDate, parseInt(limit, 10)]
    );

    res.json({
      metric_name: metric,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      count: rows.length,
      history: rows,
    });
  })
);

/**
 * GET /api/ops/incidents
 * List open, acknowledged, and resolved incidents with pagination and filtering.
 */
router.get(
  '/incidents',
  asyncHandler(async (req, res) => {
    const { status = 'all', severity = 'all', page = 1, limit = 20 } = req.query;
    const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);

    const conditions = [];
    const params = [];

    if (status !== 'all') {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    if (severity !== 'all') {
      params.push(severity);
      conditions.push(`severity = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.query(
      `SELECT COUNT(*) AS total FROM incidents ${whereClause}`,
      params
    );
    const total = parseInt(countRes.rows[0].total, 10);

    params.push(parseInt(limit, 10));
    params.push(offset);

    const { rows } = await db.query(
      `SELECT id, incident_type, severity, status, triggered_at, acknowledged_at,
            resolved_at, duration_seconds, triggering_metric_values, details, notification_sent
     FROM incidents
     ${whereClause}
     ORDER BY CASE WHEN status = 'open' THEN 1 WHEN status = 'acknowledged' THEN 2 ELSE 3 END,
              triggered_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
      total,
      incidents: rows,
    });
  })
);

/**
 * GET /api/ops/incidents/:id
 * Retrieve single incident details and associated runbook executions.
 */
router.get(
  '/incidents/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { rows } = await db.query('SELECT * FROM incidents WHERE id = $1', [id]);

    if (rows.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } });
    }

    const incident = rows[0];

    const { rows: executions } = await db.query(
      `SELECT id, runbook_type, status, steps, started_at, completed_at
     FROM runbook_executions
     WHERE incident_id = $1
     ORDER BY started_at DESC`,
      [id]
    );

    res.json({
      incident,
      runbook_executions: executions,
    });
  })
);

/**
 * POST /api/ops/incidents/:id/acknowledge
 * Mark incident as acknowledged.
 */
router.post(
  '/incidents/:id/acknowledge',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { rows } = await db.query(
      `UPDATE incidents
     SET status = 'acknowledged', acknowledged_at = NOW()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Open incident not found or already acknowledged' },
      });
    }

    logger.info('Incident acknowledged by operator', { incident_id: id });
    res.json({ status: 'ok', incident: rows[0] });
  })
);

/**
 * GET /api/ops/campaigns/wallet-audit
 * Detailed campaign wallet reserve audit.
 */
router.get(
  '/campaigns/wallet-audit',
  asyncHandler(async (req, res) => {
    const audit = await auditCampaignWallets();
    res.json(audit);
  })
);

/**
 * POST /api/ops/campaigns/wallet-audit/:campaignId/approve-funding
 * Approve top-up transfer for underfunded campaign wallet.
 */
router.post(
  '/campaigns/wallet-audit/:campaignId/approve-funding',
  asyncHandler(async (req, res) => {
    const { campaignId } = req.params;
    const audit = await auditCampaignWallets();
    const target = audit.wallets.find(w => String(w.campaign_id) === String(campaignId));

    if (!target) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Campaign wallet not found in audit' },
      });
    }

    if (target.deficit_xlm <= 0) {
      return res.status(400).json({
        error: { code: 'NO_DEFICIT', message: 'Campaign wallet has no funding deficit' },
      });
    }

    // Idempotency: the partial unique index on (campaign_id) WHERE status IN
    // (pending, submitted) rejects a second concurrent/duplicate approval
    // for the same campaign while one is already in flight.
    let approvalId;
    try {
      const { rows } = await db.query(
        `INSERT INTO wallet_funding_approvals (campaign_id, wallet_public_key, deficit_xlm, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING id`,
        [campaignId, target.wallet_public_key, target.deficit_xlm]
      );
      approvalId = rows[0].id;
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          error: {
            code: 'ALREADY_IN_FLIGHT',
            message: 'A funding approval for this campaign is already in progress',
          },
        });
      }
      throw err;
    }

    let txHash;
    try {
      txHash = await submitWalletTopUpPayment({
        destinationPublicKey: target.wallet_public_key,
        amountXlm: target.deficit_xlm,
      });
      await db.query(
        `UPDATE wallet_funding_approvals SET status = 'confirmed', tx_hash = $1, updated_at = NOW() WHERE id = $2`,
        [txHash, approvalId]
      );
    } catch (err) {
      await db.query(
        `UPDATE wallet_funding_approvals SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [err.message, approvalId]
      );
      throw err;
    }

    logger.info('Operator approved funding for campaign wallet', {
      campaign_id: campaignId,
      deficit_xlm: target.deficit_xlm,
      tx_hash: txHash,
    });

    res.json({
      status: 'confirmed',
      campaign_id: campaignId,
      deficit_xlm: target.deficit_xlm,
      tx_hash: txHash,
      message: `Funding approval submitted for ${target.campaign_title}. Deficit: ${target.deficit_xlm} XLM.`,
    });
  })
);

/**
 * POST /api/ops/runbooks/:incidentId/execute
 * Execute automated runbook for an incident.
 */
router.post(
  '/runbooks/:incidentId/execute',
  asyncHandler(async (req, res) => {
    const { incidentId } = req.params;
    const { runbook_type } = req.body || {};

    const execution = await executeRunbook(incidentId, runbook_type);
    res.json({
      status: 'ok',
      execution,
    });
  })
);

/**
 * GET /api/ops/runbooks/:incidentId/status
 * Get status and step logs for the latest runbook execution of an incident.
 */
router.get(
  '/runbooks/:incidentId/status',
  asyncHandler(async (req, res) => {
    const { incidentId } = req.params;
    const { rows } = await db.query(
      `SELECT id, incident_id, runbook_type, status, steps, started_at, completed_at
     FROM runbook_executions
     WHERE incident_id = $1
     ORDER BY started_at DESC
     LIMIT 1`,
      [incidentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'No runbook executions found for this incident' },
      });
    }

    res.json({ execution: rows[0] });
  })
);

module.exports = router;
module.exports.requireOpsApiKey = requireOpsApiKey;
