const crypto = require('crypto');
const db = require('../config/database');
const logger = require('../config/logger');
const { sendEmail } = require('./emailService');
const { safeFetch } = require('../utils/safeFetch');
const {
  isEncryptedIntegrationSecret,
  withDecryptedIntegrationSecret,
} = require('./integrationSecrets');

const WEBHOOK_EVENTS = {
  CAMPAIGN_FUNDED: 'campaign.funded',
  CAMPAIGN_FAILED: 'campaign.failed',
  CONTRIBUTION_RECEIVED: 'contribution.received',
  CONTRIBUTION_INDEXED: 'contribution.indexed', // campaign-level event
  CONTRIBUTION_REFUNDED: 'contribution.refunded',
  MILESTONE_APPROVED: 'milestone.approved',
  MILESTONE_REJECTED: 'milestone.rejected',
  WITHDRAWAL_COMPLETED: 'withdrawal.completed',
  WITHDRAWAL_UPDATED: 'withdrawal.updated',
  DISPUTE_OPENED: 'dispute.opened',
  DISPUTE_RESOLVED: 'dispute.resolved',
  SPONSOR_MATCH_CREATED: 'sponsor_match.created',
  SPONSOR_MATCH_COMPLETED: 'sponsor_match.completed',
};

const ALL_WEBHOOK_EVENTS = Object.values(WEBHOOK_EVENTS);
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_CAMPAIGN_DELIVERY_ATTEMPTS = 3;
const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 86_400_000];
// How long a claimed attempt may stay 'delivering' before another worker may
// reclaim it. Comfortably above the 9s request timeout so a live attempt is
// never stolen; a crashed worker's delivery becomes recoverable after this.
const WEBHOOK_LEASE_MS = 60_000;
const WEBHOOK_REQUEST_TIMEOUT_MS = 9000;
const POLLER_BATCH_SIZE = 25;

function hmacSignature(secret, bodyUtf8) {
  return crypto.createHmac('sha256', secret).update(bodyUtf8, 'utf8').digest('hex');
}

function isValidBackoffStrategy(strategy) {
  return Boolean(
    strategy &&
    typeof strategy === 'object' &&
    Number.isFinite(strategy.base_ms) &&
    strategy.base_ms > 0 &&
    Number.isFinite(strategy.max_ms) &&
    strategy.max_ms > 0 &&
    Number.isFinite(strategy.multiplier) &&
    strategy.multiplier > 0
  );
}

function customBackoffMs(attemptNumber, strategy) {
  const delay = strategy.base_ms * strategy.multiplier ** Math.max(0, attemptNumber - 1);
  return Math.min(strategy.max_ms, Math.round(delay));
}

function backoffMs(attemptNumber, strategy) {
  if (isValidBackoffStrategy(strategy)) return customBackoffMs(attemptNumber, strategy);
  const boundedAttempt = Math.min(Math.max(attemptNumber, 1), WEBHOOK_RETRY_DELAYS_MS.length);
  return WEBHOOK_RETRY_DELAYS_MS[boundedAttempt - 1];
}

function backoffMsForCampaign(attemptNumber, strategy) {
  if (isValidBackoffStrategy(strategy)) return customBackoffMs(attemptNumber, strategy);
  // Campaign webhooks: exponential backoff (5s, 30s, 5min)
  const delays = [5000, 30000, 300000];
  return delays[Math.min(attemptNumber - 1, delays.length - 1)];
}

/** Queue outbound webhook deliveries for every active endpoint owned by `ownerUserId`. */
async function emitWebhookEventForUser(ownerUserId, eventType, payload) {
  if (!ownerUserId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM webhooks
     WHERE user_id = $1 AND revoked_at IS NULL AND $2 = ANY(events)`,
    [ownerUserId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processDelivery(deliveryId).catch(err =>
        logger.error('[webhooks] delivery failed', { deliveryId, err: err.message })
      );
    });
  }
}

async function notifyCreatorOfFailedDelivery(deliveryId, errMsg) {
  try {
    const { rows } = await db.query(
      `SELECT u.email, u.name, w.url, d.event_type
       FROM webhook_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
       JOIN users u ON u.id = w.user_id
       WHERE d.id = $1`,
      [deliveryId]
    );

    if (!rows.length || !rows[0].email) return;

    const row = rows[0];
    const subject = 'Webhook delivery failed after retries';
    const text = `Hi ${row.name || 'there'},\n\nWe could not deliver your webhook for ${row.event_type} to ${row.url} after all retries. Last error: ${errMsg || 'unknown'}.`;
    await sendEmail({
      to: row.email,
      subject,
      text,
    });
  } catch (emailErr) {
    logger.error('[webhooks] failed to notify creator', { deliveryId, err: emailErr.message });
  }
}

// ---------------------------------------------------------------------------
// Delivery claims (#838)
//
// Every network attempt is preceded by an atomic conditional UPDATE that moves
// the row to 'delivering', increments attempt_count and stamps a per-attempt
// lease token. Concurrent callers (the immediate dispatch, retry timers, any
// number of pollers across instances, manual replay) race on that single
// statement; Postgres row locking guarantees at most one of them gets the row
// back, so at most one HTTP request is sent per attempt and attempt_count
// equals the number of attempts actually started. Outcome updates are guarded
// by the lease token, so a worker whose lease expired (and was reclaimed)
// cannot overwrite the newer attempt's state. The delivery ID stays the
// X-CrowdPay-Delivery-Id header on every attempt: it is the receiver's
// deduplication key.
// ---------------------------------------------------------------------------

// A row is claimable when it is queued, due for retry, or its lease expired.
// Rows written before leases existed fall back to updated_at + lease.
const CLAIMABLE_STATUS_SQL = `(
  d.status = 'pending'
  OR (d.status = 'retrying' AND (d.next_retry_at IS NULL OR d.next_retry_at <= NOW()))
  OR (d.status = 'delivering'
      AND COALESCE(d.lease_expires_at, d.updated_at + ($LEASE_MS::int * INTERVAL '1 millisecond')) <= NOW())
)`;

const DELIVERY_KINDS = {
  user: {
    label: '[webhooks]',
    deliveriesTable: 'webhook_deliveries',
    hooksTable: 'webhooks',
    eventColumn: 'event_type',
    maxAttempts: MAX_DELIVERY_ATTEMPTS,
    hookUsableSql: 'w.revoked_at IS NULL',
    unusableReason: 'webhook revoked',
    storesSnippet: true,
    tracksFailedAt: false,
    ownerColumn: 'user_id',
    ownerContextType: 'webhook',
  },
  campaign: {
    label: '[campaign-webhooks]',
    deliveriesTable: 'campaign_webhook_deliveries',
    hooksTable: 'campaign_webhooks',
    eventColumn: 'event',
    maxAttempts: MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
    hookUsableSql: 'w.active IS TRUE',
    unusableReason: 'webhook disabled',
    storesSnippet: false,
    tracksFailedAt: true,
    ownerColumn: 'campaign_id',
    ownerContextType: 'campaign_webhook',
  },
};

function claimableSql(paramIndex) {
  return CLAIMABLE_STATUS_SQL.replace('$LEASE_MS', `$${paramIndex}`);
}

function newLeaseToken() {
  return crypto.randomUUID();
}

/**
 * Atomically claim one attempt of a delivery. Resolves to the claimed row
 * (with the webhook's url/secret/backoff) or null when another worker holds
 * it, it is not due, it is finished, or it can no longer be attempted.
 */
async function claimDelivery(kind, deliveryId, leaseToken = newLeaseToken()) {
  const k = DELIVERY_KINDS[kind];
  const { rows } = await db.query(
    `UPDATE ${k.deliveriesTable} d
     SET status = 'delivering', attempt_count = d.attempt_count + 1,
         lease_token = $2,
         lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
         next_retry_at = NULL, updated_at = NOW()
     FROM ${k.hooksTable} w
     WHERE d.id = $1 AND w.id = d.webhook_id
       AND ${k.hookUsableSql}
        AND d.attempt_count < $4
       AND ${claimableSql(3)}
     RETURNING d.id, d.webhook_id, d.attempt_count, d.payload, d.${k.eventColumn} AS event_type,
               d.lease_token, w.url, w.secret, w.backoff_strategy, w.${k.ownerColumn} AS owner_id${
                 kind === 'user'
                   ? ', w.secret_version, w.previous_secret, w.previous_secret_version, w.previous_secret_expires_at'
                   : ''
               }`,
    [deliveryId, leaseToken, WEBHOOK_LEASE_MS, k.maxAttempts]
  );
  const claimed = rows[0] || null;
  if (claimed) {
    try {
      await db.query(
        `INSERT INTO webhook_delivery_attempts
           (delivery_kind, delivery_id, attempt_number)
         VALUES ($1, $2, $3)
         ON CONFLICT (delivery_kind, delivery_id, attempt_number) DO NOTHING`,
        [kind, claimed.id, claimed.attempt_count]
      );
    } catch (err) {
      // Attempt history is observability data; a transient write failure must
      // not strand a claimed delivery in `delivering`.
      logger.error(`${k.label} failed to record attempt history`, {
        deliveryId: claimed.id,
        error: err.message,
      });
    }
  }
  return claimed;
}

/**
 * A delivery that could not be claimed because its webhook is gone or its
 * attempts are exhausted is closed out as failed. Rows held by a live lease,
 * delivered rows and rows not yet due are left untouched.
 */
async function failUnclaimableDelivery(kind, deliveryId) {
  const k = DELIVERY_KINDS[kind];
  const { rows } = await db.query(
    `UPDATE ${k.deliveriesTable} d
     SET status = 'failed',
         last_error = CASE WHEN ${k.hookUsableSql} THEN 'max delivery attempts exceeded'
                           ELSE '${k.unusableReason}' END,
         lease_token = NULL, lease_expires_at = NULL, next_retry_at = NULL,
         ${k.tracksFailedAt ? 'failed_at = NOW(),' : ''}
         updated_at = NOW()
     FROM ${k.hooksTable} w
     WHERE d.id = $1 AND w.id = d.webhook_id
       AND (NOT (${k.hookUsableSql}) OR d.attempt_count >= $2)
       AND ${claimableSql(3)}
     RETURNING d.id, d.webhook_id, d.${k.eventColumn} AS event_type, d.attempt_count,
               d.last_error, d.response_status`,
    [deliveryId, k.maxAttempts, WEBHOOK_LEASE_MS]
  );
  return rows[0] || null;
}

async function createDeadLetter(kind, deliveryId, fallback = {}) {
  const k = DELIVERY_KINDS[kind];
  const { rows } = await db.query(
    `SELECT webhook_id, ${k.eventColumn} AS event_type, attempt_count,
            last_error, response_status
       FROM ${k.deliveriesTable} WHERE id = $1`,
    [deliveryId]
  );
  const delivery = rows[0] || fallback;
  if (!delivery.webhook_id || !delivery.event_type) return;
  await db.query(
    `INSERT INTO webhook_dead_letters
       (delivery_kind, delivery_id, webhook_id, event_type, attempt_count, last_error, safe_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (delivery_kind, delivery_id) DO UPDATE
       SET attempt_count = EXCLUDED.attempt_count,
           last_error = EXCLUDED.last_error,
           safe_metadata = EXCLUDED.safe_metadata`,
    [
      kind,
      deliveryId,
      delivery.webhook_id,
      delivery.event_type,
      delivery.attempt_count || 0,
      delivery.last_error || fallback.last_error || null,
      JSON.stringify({
        delivery_id: deliveryId,
        event_type: delivery.event_type,
        response_status: delivery.response_status || fallback.response_status || null,
      }),
    ]
  );
}

async function finishDeliveryAttempt(kind, deliveryId, attemptNumber, outcome = {}) {
  await db.query(
    `UPDATE webhook_delivery_attempts
        SET finished_at = NOW(), response_status = $4, succeeded = $5, error_message = $6
      WHERE delivery_kind = $1 AND delivery_id = $2 AND attempt_number = $3`,
    [
      kind,
      deliveryId,
      attemptNumber,
      outcome.responseStatus || null,
      Boolean(outcome.succeeded),
      outcome.error || null,
    ]
  );
}

/** Record an attempt's outcome, only if this worker still holds the lease. */
async function finishAttempt(kind, deliveryId, leaseToken, setSql, params, attemptOutcome = null) {
  const k = DELIVERY_KINDS[kind];
  const result = await db.query(
    `UPDATE ${k.deliveriesTable}
     SET ${setSql}, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE id = $1 AND lease_token = $2 AND status = 'delivering'
     RETURNING id`,
    [deliveryId, leaseToken, ...params]
  );
  const owned = Boolean(result.rows && result.rows.length);
  if (!owned) {
    logger.warn(`${k.label} attempt outcome discarded: lease no longer held`, { deliveryId });
  }
  if (owned && attemptOutcome) {
    await finishDeliveryAttempt(kind, deliveryId, attemptOutcome.attemptNumber, attemptOutcome);
  }
  return owned;
}

function scheduleRetryTimer(kind, deliveryId, delay) {
  const k = DELIVERY_KINDS[kind];
  // Fast path only: the claim makes an overlap with the poller harmless, and
  // the poller recovers the retry if this process exits before the timer fires.
  const timer = setTimeout(() => {
    runDelivery(kind, deliveryId).catch(err =>
      logger.error(`${k.label} retry failed`, { deliveryId, err: err.message })
    );
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

async function recordFailure(kind, claimed, errMsg, httpStatus, snippet, versionsUsed = null) {
  const k = DELIVERY_KINDS[kind];
  const attemptJustUsed = claimed.attempt_count;
  const extraSql = [];
  const extra = [];

  if (k.storesSnippet) {
    extraSql.push(`response_body_snippet = $${4 + (k.tracksFailedAt ? 1 : 0)}`);
    extra.push(snippet);
  }

  if (kind === 'user' && versionsUsed) {
    extraSql.push(`signature_versions = $${4 + (k.tracksFailedAt ? 1 : 0) + extra.length}`);
    extra.push(versionsUsed);
  }

  const extraSqlStr = extraSql.length ? `, ${extraSql.join(', ')}` : '';

  if (attemptJustUsed >= k.maxAttempts) {
    const owned = await finishAttempt(
      kind,
      claimed.id,
      claimed.lease_token,
      `status = 'failed', last_error = $3, response_status = $4, next_retry_at = NULL${
        k.tracksFailedAt ? ', failed_at = NOW()' : ''
      }${extraSqlStr}`,
      [errMsg, httpStatus, ...extra],
      { attemptNumber: attemptJustUsed, responseStatus: httpStatus, error: errMsg }
    );
    if (owned) {
      await createDeadLetter(kind, claimed.id, { last_error: errMsg, response_status: httpStatus });
      if (kind === 'user') await notifyCreatorOfFailedDelivery(claimed.id, errMsg);
    }
    return;
  }

  const delay =
    kind === 'user'
      ? backoffMs(attemptJustUsed, claimed.backoff_strategy)
      : backoffMsForCampaign(attemptJustUsed, claimed.backoff_strategy);
  // next_retry_at comes from the database clock, the same clock the claim
  // compares it against, so app/DB clock skew cannot make a retry early or late.
  const owned = await finishAttempt(
    kind,
    claimed.id,
    claimed.lease_token,
    `status = 'retrying', next_retry_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
     last_error = $4, response_status = $5${extraSqlStr}`,
    [delay, errMsg, httpStatus, ...extra],
    { attemptNumber: attemptJustUsed, responseStatus: httpStatus, error: errMsg }
  );
  if (owned) scheduleRetryTimer(kind, claimed.id, delay);
}

async function runDelivery(kind, deliveryId) {
  const k = DELIVERY_KINDS[kind];
  const claimed = await claimDelivery(kind, deliveryId);
  if (!claimed) {
    const closed = await failUnclaimableDelivery(kind, deliveryId);
    if (closed) {
      await createDeadLetter(kind, deliveryId, closed);
      if (kind === 'user' && closed.last_error === 'max delivery attempts exceeded') {
        await notifyCreatorOfFailedDelivery(deliveryId, closed.last_error);
      }
    }
    return { sent: false };
  }

  const bodyUtf8 = JSON.stringify(claimed.payload);

  const signatures = [];
  const versionsUsed = [];

  async function addSignature(secretValue, versionLabel) {
    if (isEncryptedIntegrationSecret(secretValue)) {
      await withDecryptedIntegrationSecret(
        secretValue,
        { type: k.ownerContextType, id: claimed.owner_id },
        decryptedSecret => {
          signatures.push(`v${versionLabel}=${hmacSignature(decryptedSecret, bodyUtf8)}`);
        }
      );
    } else {
      signatures.push(`v${versionLabel}=${hmacSignature(secretValue, bodyUtf8)}`);
    }
    versionsUsed.push(versionLabel);
  }

  // Primary secret
  const currentVersion = claimed.secret_version || 1;
  await addSignature(claimed.secret, currentVersion);

  // Previous secret if in grace period
  if (
    kind === 'user' &&
    claimed.previous_secret &&
    claimed.previous_secret_expires_at &&
    new Date(claimed.previous_secret_expires_at) > new Date()
  ) {
    await addSignature(claimed.previous_secret, claimed.previous_secret_version);
  }

  let res;
  let responseText = '';
  try {
    // Re-validates and pins the connection target on every hop (including
    // redirects), so neither DNS rebinding between validation and connection
    // nor a redirect to a private/internal target can bypass the guard.
    res = await safeFetch(claimed.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CrowdPay-Signature': signatures.join(', '),
        'X-CrowdPay-Event': claimed.event_type,
        'X-CrowdPay-Delivery-Id': claimed.id,
      },
      body: bodyUtf8,
      timeoutMs: WEBHOOK_REQUEST_TIMEOUT_MS,
    });
    if (k.storesSnippet) responseText = await res.text();
  } catch (err) {
    if (err.isSsrfBlocked) {
      await finishAttempt(
        kind,
        claimed.id,
        claimed.lease_token,
        `status = 'failed', last_error = $3, next_retry_at = NULL${k.tracksFailedAt ? ', failed_at = NOW()' : ''}`,
        [err.message],
        { attemptNumber: claimed.attempt_count, error: err.message }
      );
      await createDeadLetter(kind, claimed.id, { last_error: err.message });
      return { sent: false };
    }
    await recordFailure(kind, claimed, err.message || String(err), null, null, versionsUsed);
    return { sent: true };
  }

  const snippet = responseText.slice(0, 512);

  let finishSetSql = `status = 'delivered', response_status = $3, delivered_at = NOW(), next_retry_at = NULL, last_error = NULL${
    k.storesSnippet ? ', response_body_snippet = $4' : ''
  }`;
  let finishParams = k.storesSnippet ? [res.status, snippet] : [res.status];

  if (kind === 'user') {
    finishSetSql += `, signature_versions = $${finishParams.length + 3}`;
    finishParams.push(versionsUsed);
  }

  if (res.ok) {
    await finishAttempt(kind, claimed.id, claimed.lease_token, finishSetSql, finishParams, {
      attemptNumber: claimed.attempt_count,
      responseStatus: res.status,
      succeeded: true,
    });
    return { sent: true };
  }

  await recordFailure(kind, claimed, `HTTP ${res.status}`, res.status, snippet, versionsUsed);
  return { sent: true };
}

function processDelivery(deliveryId) {
  return runDelivery('user', deliveryId);
}

function processCampaignWebhookDelivery(deliveryId) {
  return runDelivery('campaign', deliveryId);
}

/**
 * Candidate rows for the poller: due retries, expired leases (crashed or
 * restarted workers) and pending rows whose immediate dispatch never ran.
 * Selection is advisory only; each row is still claimed atomically.
 */
async function processDueDeliveries(kind) {
  const k = DELIVERY_KINDS[kind];
  const { rows } = await db.query(
    `SELECT d.id FROM ${k.deliveriesTable} d
     WHERE (d.status = 'retrying' AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= NOW())
        OR (d.status = 'delivering'
            AND COALESCE(d.lease_expires_at, d.updated_at + ($1::int * INTERVAL '1 millisecond')) <= NOW())
        OR (d.status = 'pending' AND d.updated_at <= NOW() - ($1::int * INTERVAL '1 millisecond'))
     ORDER BY COALESCE(d.next_retry_at, d.updated_at)
     LIMIT $2`,
    [WEBHOOK_LEASE_MS, POLLER_BATCH_SIZE]
  );
  const results = await Promise.allSettled(rows.map(r => runDelivery(kind, r.id)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      logger.error(`${k.label} poller delivery failed`, {
        deliveryId: rows[i].id,
        err: r.reason && r.reason.message,
      });
    }
  });
  return rows.length;
}

function processDueRetries() {
  return processDueDeliveries('user');
}

function processDueCampaignWebhookRetries() {
  return processDueDeliveries('campaign');
}

/** Queue outbound webhook deliveries for campaign webhooks */
async function emitWebhookEventForCampaign(campaignId, eventType, payload) {
  if (!campaignId) return;
  const { rows: hooks } = await db.query(
    `SELECT id, url, secret FROM campaign_webhooks
     WHERE campaign_id = $1 AND active = TRUE AND $2 = ANY(events)`,
    [campaignId, eventType]
  );
  for (const h of hooks) {
    const { rows: inserted } = await db.query(
      `INSERT INTO campaign_webhook_deliveries (webhook_id, event, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending') RETURNING id`,
      [h.id, eventType, JSON.stringify(payload)]
    );
    const deliveryId = inserted[0].id;
    setImmediate(() => {
      processCampaignWebhookDelivery(deliveryId).catch(err =>
        logger.error('[campaign-webhooks] delivery failed', { deliveryId, err: err.message })
      );
    });
  }
}

function startWebhookRetryPoller() {
  let running = false;
  const timer = setInterval(async () => {
    // Skip a tick while the previous one is still sending; claims keep this
    // safe regardless, this just avoids piling up in-process work.
    if (running) return;
    running = true;
    try {
      await Promise.all([
        processDueRetries().catch(e => logger.error('[webhooks] poller error', { err: e.message })),
        processDueCampaignWebhookRetries().catch(e =>
          logger.error('[campaign-webhooks] poller error', { err: e.message })
        ),
      ]);
    } finally {
      running = false;
    }
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  WEBHOOK_EVENTS,
  ALL_WEBHOOK_EVENTS,
  MAX_DELIVERY_ATTEMPTS,
  MAX_CAMPAIGN_DELIVERY_ATTEMPTS,
  WEBHOOK_LEASE_MS,
  hmacSignature,
  backoffMs,
  backoffMsForCampaign,
  isValidBackoffStrategy,
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  claimDelivery,
  processDelivery,
  processCampaignWebhookDelivery,
  processDueRetries,
  processDueCampaignWebhookRetries,
  startWebhookRetryPoller,
};
