const db = require('../config/database');

/**
 * Record contribution intent BEFORE the Stellar transaction is submitted
 * (#810), so a crash or failure between submission and indexing leaves an
 * auditable pending row instead of an orphaned on-chain payment. Idempotent
 * on idempotencyKey: a retry with the same key returns the existing row
 * instead of inserting a duplicate.
 */
async function insertContributionPending(client, row) {
  const runner = client || db;
  if (row.idempotencyKey) {
    const existing = row.idempotencyActorId
      ? await runner.query(
          `SELECT id, status, tx_hash FROM stellar_transactions
             WHERE idempotency_actor_id = $1 AND idempotency_key = $2`,
          [row.idempotencyActorId, row.idempotencyKey]
        )
      : await runner.query(
          `SELECT id, status, tx_hash FROM stellar_transactions WHERE idempotency_key = $1`,
          [row.idempotencyKey]
        );
    if (existing.rows.length) {
      return {
        id: existing.rows[0].id,
        reused: true,
        status: existing.rows[0].status,
        txHash: existing.rows[0].tx_hash,
      };
    }
  }
  const { rows } = await runner.query(
    `INSERT INTO stellar_transactions
       (kind, status, campaign_id, initiated_by_user_id,
        unsigned_xdr, signed_xdr, metadata, idempotency_actor_id, idempotency_key)
     VALUES ('contribution', 'pending_signatures', $1, $2, $3, $4, $5::jsonb, $6, $7)
     RETURNING id`,
    [
      row.campaignId,
      row.userId,
      row.unsignedXdr,
      row.signedXdr,
      JSON.stringify(row.metadata || {}),
      row.idempotencyActorId || null,
      row.idempotencyKey || null,
    ]
  );
  return { id: rows[0].id, reused: false };
}

/**
 * Mark a pending contribution submitted. `extra` optionally records the XDR
 * that was actually submitted and merges metadata that only became known at
 * submission time (e.g. a slippage re-quote).
 */
async function markContributionSubmitted(client, id, txHash, extra = {}) {
  const runner = client || db;
  const updates = ["status = 'submitted'", 'tx_hash = $1'];
  const params = [txHash, id];
  if (extra.unsignedXdr) {
    updates.push('unsigned_xdr = COALESCE($3, unsigned_xdr)');
    params.push(extra.unsignedXdr);
  }
  if (extra.signedXdr) {
    updates.push(`signed_xdr = COALESCE($${params.length + 1}, signed_xdr)`);
    params.push(extra.signedXdr);
  }
  if (extra.metadata) {
    updates.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${params.length + 1}::jsonb`);
    params.push(JSON.stringify(extra.metadata));
  }
  updates.push('updated_at = NOW()');
  await runner.query(
    `UPDATE stellar_transactions
     SET ${updates.join(', ')}
     WHERE id = $2`,
    params
  );
}

async function markContributionFailed(client, id, failureReason) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions SET status = 'failed', failure_reason = $1, updated_at = NOW() WHERE id = $2`,
    [failureReason, id]
  );
}

async function insertContributionSubmitted(client, row) {
  const runner = client || db;
  const { rows } = await runner.query(
    `INSERT INTO stellar_transactions
       (kind, status, tx_hash, campaign_id, initiated_by_user_id,
        unsigned_xdr, signed_xdr, metadata)
     VALUES ('contribution', 'submitted', $1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id`,
    [
      row.txHash,
      row.campaignId,
      row.userId,
      row.unsignedXdr,
      row.signedXdr,
      JSON.stringify(row.metadata || {}),
    ]
  );
  return rows[0].id;
}

async function insertWithdrawalPendingSignatures(client, row) {
  const runner = client || db;
  const { rows } = await runner.query(
    `INSERT INTO stellar_transactions
       (kind, status, campaign_id, withdrawal_request_id, initiated_by_user_id,
        unsigned_xdr, metadata)
     VALUES ('withdrawal', 'pending_signatures', $1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      row.campaignId,
      row.withdrawalRequestId,
      row.userId,
      row.unsignedXdr,
      JSON.stringify(row.metadata || {}),
    ]
  );
  return rows[0].id;
}

async function markContributionIndexed(client, txHash, contributionId) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions
     SET status = 'indexed', contribution_id = $1, updated_at = NOW()
     WHERE tx_hash = $2 AND kind = 'contribution'`,
    [contributionId, txHash]
  );
}

async function finalizeWithdrawalSubmitted(client, { withdrawalRequestId, txHash, signedXdr }) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions
     SET status = 'submitted', tx_hash = $1, signed_xdr = $2, updated_at = NOW()
     WHERE withdrawal_request_id = $3 AND kind = 'withdrawal'`,
    [txHash, signedXdr, withdrawalRequestId]
  );
}

async function markWithdrawalFailed(client, { withdrawalRequestId, reason }) {
  const runner = client || db;
  await runner.query(
    `UPDATE stellar_transactions
     SET status = 'failed', failure_reason = $1, updated_at = NOW()
     WHERE withdrawal_request_id = $2 AND kind = 'withdrawal'`,
    [reason || 'unknown', withdrawalRequestId]
  );
}

async function insertContributionAdjustment(client, { campaignId, amount, assetType, adjustedAt }) {
  const runner = client || db;
  const { rows } = await runner.query(
    `INSERT INTO contributions
       (campaign_id, sender_public_key, amount, asset, payment_type, tx_hash, created_at)
     VALUES ($1, 'system', $2, $3, 'reconciliation_adjustment', NULL, $4)
     RETURNING id`,
    [campaignId, amount, assetType, adjustedAt || new Date()]
  );
  return rows[0].id;
}

async function insertReconciliationAdjustment(client, row) {
  const runner = client || db;
  const { rows } = await runner.query(
    `INSERT INTO stellar_transactions
       (kind, status, campaign_id, metadata)
     VALUES ('contribution', 'indexed', $1, $2::jsonb)
     RETURNING id`,
    [
      row.campaignId,
      JSON.stringify({
        source: 'reconciliation_adjustment',
        db_amount: row.dbBalance,
        on_chain_amount: row.liveBalance,
        diff: row.diff,
        asset_type: row.assetType,
        corrected_at: new Date().toISOString(),
      }),
    ]
  );
  return rows[0].id;
}

module.exports = {
  insertContributionSubmitted,
  insertContributionPending,
  markContributionSubmitted,
  markContributionFailed,
  insertWithdrawalPendingSignatures,
  markContributionIndexed,
  finalizeWithdrawalSubmitted,
  markWithdrawalFailed,
  insertContributionAdjustment,
  insertReconciliationAdjustment,
};
