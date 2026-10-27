const db = require('../config/database');
const logger = require('../config/logger');
const { sendEmail } = require('./emailService');

const { toStroops, STROOPS_PER_UNIT, fromStroops } = require('../utils/stroops');

const FRAUD_THRESHOLD = 75;
const THRESHOLD_HIGH_STROOPS = 10000n * STROOPS_PER_UNIT;
const THRESHOLD_MEDIUM_STROOPS = 5000n * STROOPS_PER_UNIT;

/**
 * Extract and calculate feature vectors for a contribution.
 * Features: amount, frequency (contributions from user in last 24h),
 * ip reputation (known bad IPs/subnet heuristics), wallet age (days since creation),
 * device fingerprint risk score.
 */
async function extractFeatures({ userId, amount, ipAddress, deviceFingerprint }) {
  let recentCount = 0;
  let walletAgeDays = 30;

  if (userId) {
    try {
      const { rows } = await db.query(
        `SELECT COUNT(*) as cnt FROM contributions WHERE user_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [userId]
      );
      recentCount = parseInt(rows[0]?.cnt || '0', 10);

      const { rows: userRows } = await db.query(`SELECT created_at FROM users WHERE id = $1`, [
        userId,
      ]);
      if (userRows[0]?.created_at) {
        const diffMs = Date.now() - new Date(userRows[0].created_at).getTime();
        walletAgeDays = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      }
    } catch (err) {
      logger.warn('Failed to extract advanced fraud features', { error: err.message });
    }
  }

  // Decimal-safe contribution amount calculation using exact BigInt stroops (#1085)
  let amountScore = 0;
  let stroops = 0n;
  let canonicalAmount = '0.0000000';
  if (amount !== undefined && amount !== null && amount !== '') {
    try {
      stroops = toStroops(amount, { allowZero: true });
      canonicalAmount = fromStroops(stroops);
    } catch (err) {
      logger.warn('Failed to parse contribution amount for fraud scoring, defaulting to zero', {
        error: err.message,
        amount,
      });
    }
  }

  if (stroops > THRESHOLD_HIGH_STROOPS) {
    amountScore = 40;
  } else if (stroops > THRESHOLD_MEDIUM_STROOPS) {
    amountScore = 20;
  }

  let frequencyScore = 0;
  if (recentCount > 5) frequencyScore = 35;
  else if (recentCount > 2) frequencyScore = 15;

  let walletAgeScore = 0;
  if (walletAgeDays < 1) walletAgeScore = 30;
  else if (walletAgeDays < 7) walletAgeScore = 15;

  let ipScore = ipAddress && ipAddress.startsWith('192.0.2.') ? 50 : 0;
  let deviceScore = deviceFingerprint && deviceFingerprint.includes('suspicious') ? 40 : 0;

  const score = Math.min(
    100,
    amountScore + frequencyScore + walletAgeScore + ipScore + deviceScore
  );

  const breakdown = {
    amount: { score: amountScore, detail: `Amount: ${canonicalAmount}` },
    frequency: { score: frequencyScore, detail: `Recent contributions (24h): ${recentCount}` },
    walletAge: { score: walletAgeScore, detail: `Wallet age days: ${walletAgeDays}` },
    ipReputation: { score: ipScore, detail: `IP: ${ipAddress || 'unknown'}` },
    deviceFingerprint: { score: deviceScore, detail: `Device fingerprint check` },
  };

  return { score, breakdown, isHighRisk: score >= FRAUD_THRESHOLD };
}

/**
 * Score a contribution in real-time. Records the assessment and flags if high-risk.
 */
async function scoreContribution({
  contributionId,
  campaignId,
  userId,
  amount,
  ipAddress,
  deviceFingerprint,
}) {
  const { score, breakdown, isHighRisk } = await extractFeatures({
    userId,
    amount,
    ipAddress,
    deviceFingerprint,
  });

  const status = isHighRisk ? 'held_for_review' : 'approved';

  try {
    await db.query(
      `INSERT INTO contribution_fraud_scores (contribution_id, campaign_id, user_id, score, breakdown, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (contribution_id) DO UPDATE SET score = $4, breakdown = $5, status = $6`,
      [contributionId, campaignId, userId || null, score, JSON.stringify(breakdown), status]
    );
  } catch (err) {
    logger.error('Failed to store contribution fraud score', {
      error: err.message,
      contributionId,
    });
  }

  if (isHighRisk) {
    logger.warn('Contribution flagged for high fraud risk', {
      contributionId,
      campaignId,
      score,
      breakdown,
    });
    // Optionally notify admins
  }

  return { score, breakdown, status, isHighRisk };
}

/**
 * Admin review of flagged contribution
 */
async function resolveFlaggedContribution({ contributionId, resolution, adminUserId }) {
  if (!['approved', 'rejected'].includes(resolution)) {
    throw new Error('Invalid resolution status');
  }

  const { rows } = await db.query(
    `UPDATE contribution_fraud_scores
     SET status = $1, resolved_by = $2, resolved_at = NOW()
     WHERE contribution_id = $3
     RETURNING *`,
    [resolution, adminUserId, contributionId]
  );

  if (!rows.length) {
    const err = new Error('Fraud score record not found');
    err.statusCode = 404;
    throw err;
  }

  return rows[0];
}

/**
 * Retrieve flagged contributions for the fraud dashboard
 */
async function getFraudDashboard({ status, limit = 50, offset = 0 }) {
  let queryText = `
    SELECT f.*, c.title as campaign_title, u.email as user_email
    FROM contribution_fraud_scores f
    LEFT JOIN campaigns c ON f.campaign_id = c.id
    LEFT JOIN users u ON f.user_id = u.id
  `;
  const params = [];

  if (status) {
    queryText += ` WHERE f.status = $1 `;
    params.push(status);
    queryText += ` ORDER BY f.score DESC LIMIT $2 OFFSET $3 `;
    params.push(limit, offset);
  } else {
    queryText += ` ORDER BY f.score DESC LIMIT $1 OFFSET $2 `;
    params.push(limit, offset);
  }

  const { rows } = await db.query(queryText, params);
  return rows;
}

/**
 * Retrain / re-validate the fraud model.
 *
 * There is no ML training pipeline in this codebase yet — "retrain" here
 * means recomputing validation metrics from real admin review outcomes
 * (contribution_fraud_scores rows an admin has resolved as 'approved' vs
 * 'rejected' after being held for review) and persisting a new versioned
 * snapshot, instead of returning hardcoded numbers (#808). If there isn't
 * enough resolved data yet to compute a meaningful rate, that is reported
 * explicitly rather than papered over with a fake metric.
 */
async function retrainModel() {
  const { rows: statsRows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('approved', 'rejected'))::int AS resolved_count,
       COUNT(*) FILTER (WHERE status = 'approved')::int AS false_positive_count
     FROM contribution_fraud_scores`
  );
  const { resolved_count: resolvedCount, false_positive_count: falsePositiveCount } = statsRows[0];

  const { rows: versionRows } = await db.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM fraud_model_versions`
  );
  const nextVersion = versionRows[0].next_version;

  if (resolvedCount === 0) {
    const { rows } = await db.query(
      `INSERT INTO fraud_model_versions (version, status, false_positive_rate, validation_samples, notes)
       VALUES ($1, 'insufficient_data', NULL, 0, 'No resolved fraud reviews yet to compute a false positive rate')
       RETURNING *`,
      [nextVersion]
    );
    logger.warn('Fraud model retrain skipped scoring: no resolved review data yet', {
      version: nextVersion,
    });
    return {
      success: false,
      version: rows[0].version,
      status: rows[0].status,
      message: rows[0].notes,
      validationSamples: 0,
    };
  }

  const falsePositiveRate = falsePositiveCount / resolvedCount;
  const { rows } = await db.query(
    `INSERT INTO fraud_model_versions (version, status, false_positive_rate, validation_samples)
     VALUES ($1, 'completed', $2, $3)
     RETURNING *`,
    [nextVersion, falsePositiveRate, resolvedCount]
  );

  logger.info('Fraud detection model revalidated from real review outcomes', {
    version: rows[0].version,
    false_positive_rate: falsePositiveRate,
    validation_samples: resolvedCount,
  });

  return {
    success: true,
    version: rows[0].version,
    status: rows[0].status,
    falsePositiveRate,
    validationSamples: resolvedCount,
  };
}

/**
 * Evaluate fraud risk for all contributions on a campaign.
 * Convenience wrapper around per-contribution scoring used by the ledger
 * monitor after a contribution is indexed.
 * @param {string} campaignId
 */
async function evaluateCampaign(campaignId) {
  const { rows } = await db.query(
    `SELECT id, user_id, amount, ip_address, device_fingerprint
     FROM contributions WHERE campaign_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [campaignId]
  );
  const results = await Promise.all(
    rows.map(row =>
      scoreContribution({
        contributionId: row.id,
        campaignId,
        userId: row.user_id,
        amount: row.amount,
        ipAddress: row.ip_address,
        deviceFingerprint: row.device_fingerprint,
      }).catch(err => ({ contributionId: row.id, error: err.message }))
    )
  );
  const highRisk = results.filter(r => r.isHighRisk);
  return { campaignId, assessed: results.length, highRisk: highRisk.length };
}

module.exports = {
  extractFeatures,
  scoreContribution,
  resolveFlaggedContribution,
  getFraudDashboard,
  retrainModel,
  evaluateCampaign,
};
