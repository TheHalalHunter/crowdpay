/**
 * ledgerMonitor.js
 *
 * Streams Horizon payments for campaign wallets. Persists paging cursors so
 * restarts can REST-replay missed operations, then resumes the SSE stream.
 * Reconnects with exponential backoff on stream errors.
 */

const { server, configuredAssets } = require('../config/stellar');
const db = require('../config/database');
const logger = require('../config/logger');
const { markContributionIndexed } = require('./stellarTransactionService');
const { assignTierToContribution } = require('./rewardTierService');
const { attributeContributionToReferrer } = require('./referralService');
const { reconcileCampaignBalances: runBalanceReconciliation } = require('./reconciliation');
const { sendContributionReceipt } = require('./emailService');
const {
  processPendingGiftNotifications,
  startGiftNotificationWorker,
} = require('./contributionGiftNotifications');
const {
  emitWebhookEventForUser,
  emitWebhookEventForCampaign,
  WEBHOOK_EVENTS,
} = require('./webhookDispatcher');
const { processContributionMatch } = require('./sponsorMatchingService');
const { indexContribution: indexTreasuryContribution } = require('./contractTreasury');
const cache = require('../utils/cache');
const Sentry = require('@sentry/node');
const { HorizonIngestionWorker, defaultIngestionWorker } = require('./horizonIngestionWorker');

/** wallet_public_key -> stream metadata */
const streamRegistry = new Map();

/** Consecutive stream failures per wallet (survives registry clears between errors). */
const reconnectAttempts = new Map();

// Map of campaignId -> Set<res> for SSE clients
const sseClients = new Map();

function addSSEClient(campaignId, res) {
  if (!sseClients.has(campaignId)) {
    sseClients.set(campaignId, new Set());
  }
  sseClients.get(campaignId).add(res);
}

function removeSSEClient(campaignId, res) {
  const clients = sseClients.get(campaignId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(campaignId);
  }
}

/**
 * Cleanup stream registry and reconnect attempts for a wallet.
 * Called when streams are closed, campaigns are deleted, or reconnects are abandoned.
 */
function cleanupStreamForWallet(walletPublicKey) {
  defaultIngestionWorker.unregisterWallet(walletPublicKey);
  const entry = streamRegistry.get(walletPublicKey);
  if (entry && typeof entry.close === 'function') {
    try {
      entry.close();
    } catch (err) {
      logger.warn('Failed to close stream during cleanup', {
        wallet_public_key: walletPublicKey,
        error: err.message,
      });
    }
  }
  streamRegistry.delete(walletPublicKey);
  reconnectAttempts.delete(walletPublicKey);
}

function broadcastCampaignUpdate(campaignId, data) {
  const clients = sseClients.get(campaignId);
  if (!clients || clients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // client likely disconnected; cleanup handled by close event
    }
  }
}

const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

function extractPagingToken(record) {
  if (!record || typeof record !== 'object') return null;
  return record.paging_token || record.pagingToken || record.id || null;
}

async function loadCursor(campaignId) {
  const { rows } = await db.query(
    'SELECT last_cursor FROM ledger_stream_cursors WHERE campaign_id = $1',
    [campaignId]
  );
  return rows.length ? rows[0].last_cursor : null;
}

async function saveCursor(campaignId, walletPublicKey, cursorToken) {
  if (!cursorToken) return;
  await saveCheckpoint(db, campaignId, walletPublicKey, { cursorToken });
}

async function saveCheckpoint(runner, campaignId, walletPublicKey, metadata = {}) {
  if (!metadata.cursorToken) return;
  await runner.query(
    `INSERT INTO ledger_stream_cursors
       (campaign_id, wallet_public_key, last_cursor, last_ledger_sequence, last_event_key,
        state, gap_detected, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, NULL, NOW())
     ON CONFLICT (campaign_id) DO UPDATE
       SET last_cursor = EXCLUDED.last_cursor,
           wallet_public_key = EXCLUDED.wallet_public_key,
           last_ledger_sequence = COALESCE(EXCLUDED.last_ledger_sequence, ledger_stream_cursors.last_ledger_sequence),
           last_event_key = COALESCE(EXCLUDED.last_event_key, ledger_stream_cursors.last_event_key),
           state = 'running', gap_detected = ledger_stream_cursors.gap_detected OR EXCLUDED.gap_detected,
           last_error = NULL, updated_at = NOW()`,
    [
      campaignId,
      walletPublicKey,
      String(metadata.cursorToken),
      metadata.ledgerSequence || null,
      metadata.eventKey || null,
      Boolean(metadata.gapDetected),
    ]
  );
}

async function loadCheckpoint(campaignId) {
  const { rows } = await db.query(
    `SELECT last_cursor, last_ledger_sequence, last_event_key, gap_detected
       FROM ledger_stream_cursors WHERE campaign_id = $1`,
    [campaignId]
  );
  return rows[0] || null;
}

async function detectOrdering(campaignId, record, eventKey) {
  const observed = Number(record?.ledger || record?.ledger_sequence || record?.ledgerSequence);
  if (!Number.isSafeInteger(observed) || observed <= 0) return false;
  const checkpoint = await loadCheckpoint(campaignId);
  const previous = Number(checkpoint?.last_ledger_sequence);
  if (!Number.isSafeInteger(previous) || observed === previous || observed === previous + 1) {
    return false;
  }
  const alertType = observed < previous ? 'reordered' : 'gap';
  await db.query(
    `INSERT INTO ledger_stream_alerts
       (campaign_id, alert_type, expected_sequence, observed_sequence, event_key, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      campaignId,
      alertType,
      previous + 1,
      observed,
      eventKey,
      JSON.stringify({
        actionable: true,
        message: alertType === 'gap' ? 'Request a bounded backfill' : 'Inspect stream ordering',
      }),
    ]
  );
  return true;
}

function registrySet(walletPublicKey, patch) {
  const prev = streamRegistry.get(walletPublicKey) || {
    wallet_public_key: walletPublicKey,
    state: 'idle',
    last_message_at: null,
    last_error: null,
    reconnect_attempt: 0,
  };
  streamRegistry.set(walletPublicKey, {
    ...prev,
    ...patch,
    wallet_public_key: walletPublicKey,
  });
}

/**
 * REST page through operations after stored cursor (missed while server was down).
 */
async function replayMissedPayments(campaignId, walletPublicKey) {
  let cursor = await loadCursor(campaignId);
  if (!cursor) return;

  for (;;) {
    let page;
    try {
      page = await server
        .payments()
        .forAccount(walletPublicKey)
        .cursor(cursor)
        .order('asc')
        .limit(100)
        .call();
    } catch (err) {
      logger.error('Ledger REST replay failed; continuing with stream', {
        wallet_public_key: walletPublicKey,
        campaign_id: campaignId,
        error: err.message,
      });
      return;
    }

    const records = page.records || [];
    if (!records.length) break;

    for (const record of records) {
      await onPaymentRecord(campaignId, walletPublicKey, record);
    }

    const pageToken = page.paging_token || extractPagingToken(records[records.length - 1]);
    if (!pageToken || pageToken === cursor) break;
    cursor = pageToken;
    if (records.length < 100) break;
  }
}

/**
 * Process one Horizon payment record.
 * The cursor is only advanced after successful processing.
 * Failed records are persisted to failed_payment_records for retry on restart.
 */
async function onPaymentRecord(campaignId, walletPublicKey, record) {
  const token = extractPagingToken(record);
  const ledgerSequence = Number(
    record?.ledger || record?.ledger_sequence || record?.ledgerSequence
  );
  const eventKey = token || record?.transaction_hash;
  try {
    const gapDetected = await detectOrdering(campaignId, record, eventKey);
    await handlePayment(campaignId, walletPublicKey, record, {
      cursorToken: token,
      eventKey,
      ledgerSequence: Number.isSafeInteger(ledgerSequence) ? ledgerSequence : null,
      gapDetected,
    });
    if (token) {
      try {
        await saveCheckpoint(db, campaignId, walletPublicKey, {
          cursorToken: token,
          eventKey,
          ledgerSequence: Number.isSafeInteger(ledgerSequence) ? ledgerSequence : null,
          gapDetected,
        });
      } catch (e) {
        logger.error('Failed to persist ledger cursor', {
          wallet_public_key: walletPublicKey,
          campaign_id: campaignId,
          error: e.message,
        });
      }
    }
  } catch (err) {
    logger.error('Payment processing failed; cursor not advanced', {
      wallet_public_key: walletPublicKey,
      campaign_id: campaignId,
      tx_hash: record.transaction_hash,
      error: err.message,
    });
    try {
      await db.query(
        `INSERT INTO failed_payment_records
           (campaign_id, wallet_public_key, payment_record, error_message)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tx_hash, campaign_id) DO UPDATE
         SET error_message = EXCLUDED.error_message,
             retry_count = failed_payment_records.retry_count + 1,
             updated_at = NOW()`,
        [campaignId, walletPublicKey, JSON.stringify(record), err.message]
      );
    } catch (insertErr) {
      logger.error('Failed to persist failed payment record', {
        wallet_public_key: walletPublicKey,
        campaign_id: campaignId,
        tx_hash: record.transaction_hash,
        error: insertErr.message,
      });
    }
  }
}

/**
 * Records a mismatched-asset payment for audit instead of crediting it. Dedups
 * on tx_hash so REST replay / stream redelivery doesn't spam quarantine rows.
 */
async function quarantinePayment({
  campaignId,
  walletPublicKey,
  senderPublicKey,
  txHash,
  assetCode,
  assetIssuer,
  amount,
  expectedAssetType,
  reason,
}) {
  try {
    await db.query(
      `INSERT INTO quarantined_payments
         (campaign_id, wallet_public_key, sender_public_key, tx_hash, asset_code,
          asset_issuer, amount, expected_asset_type, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (tx_hash) DO NOTHING`,
      [
        campaignId,
        walletPublicKey,
        senderPublicKey,
        txHash,
        assetCode || null,
        assetIssuer || null,
        amount,
        expectedAssetType,
        reason,
      ]
    );
  } catch (err) {
    logger.error('Failed to persist quarantined payment', {
      campaign_id: campaignId,
      tx_hash: txHash,
      error: err.message,
    });
  }

  Sentry.withScope(scope => {
    scope.setTag('stellar.network', process.env.STELLAR_NETWORK);
    scope.setExtra('tx_hash', txHash);
    scope.setExtra('campaign_id', campaignId);
    scope.setExtra('asset_code', assetCode);
    scope.setExtra('asset_issuer', assetIssuer);
    Sentry.captureMessage(`Quarantined mismatched-asset payment: ${reason}`, 'warning');
  });
  logger.warn('Quarantined mismatched-asset payment', {
    campaign_id: campaignId,
    tx_hash: txHash,
    asset_code: assetCode,
    asset_issuer: assetIssuer,
    expected_asset_type: expectedAssetType,
    reason,
  });
}

async function handlePayment(campaignId, walletPublicKey, payment, eventMetadata = {}) {
  if (payment.to !== walletPublicKey) return;
  if (payment.type !== 'payment' && payment.type !== 'path_payment_strict_receive') return;

  const { rows: campaignRows } = await db.query(
    'SELECT status, asset_type, wallet_mode FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaignRows.length || !['active', 'funded'].includes(campaignRows[0].status)) return;
  const expectedAssetType = campaignRows[0].asset_type;

  const destinationAsset = payment.asset_type === 'native' ? 'XLM' : payment.asset_code;
  const destinationAmount = parseFloat(payment.amount);
  const sourceAsset = payment.source_asset_type
    ? payment.source_asset_type === 'native'
      ? 'XLM'
      : payment.source_asset_code
    : null;
  const sourceAmount = payment.source_amount ? parseFloat(payment.source_amount) : null;
  const path = Array.isArray(payment.path)
    ? payment.path.map(asset => (asset.asset_type === 'native' ? 'XLM' : asset.asset_code))
    : null;
  const paymentType = payment.type;
  const conversionRate =
    sourceAmount && destinationAmount ? destinationAmount / sourceAmount : null;
  const txHash = payment.transaction_hash;

  // #707: only credit payments in the campaign's own configured asset, from
  // the trusted issuer for that asset code. Anything else is quarantined —
  // never folded into raised_amount, rewards, referrals, or notifications.
  const expectedAssetConfig = configuredAssets[expectedAssetType];
  const assetMatches =
    destinationAsset === expectedAssetType &&
    (payment.asset_type === 'native' ||
      (expectedAssetConfig && payment.asset_issuer === expectedAssetConfig.issuer));
  if (!assetMatches) {
    await quarantinePayment({
      campaignId,
      walletPublicKey,
      senderPublicKey: payment.from,
      txHash,
      assetCode: destinationAsset,
      assetIssuer: payment.asset_issuer || null,
      amount: destinationAmount,
      expectedAssetType,
      reason:
        destinationAsset !== expectedAssetType
          ? `asset code ${destinationAsset} does not match campaign asset ${expectedAssetType}`
          : `untrusted issuer for ${destinationAsset}`,
    });
    return;
  }

  await recordConfirmedContribution({
    campaignId,
    walletPublicKey,
    senderPublicKey: payment.from,
    destinationAmount,
    destinationAsset,
    sourceAsset,
    sourceAmount,
    path,
    paymentType,
    conversionRate,
    txHash,
    walletMode: campaignRows[0].wallet_mode,
    eventMetadata,
  });
}

/**
 * Finalizes a confirmed on-chain payment as a contribution: inserts the
 * `contributions` row, updates campaign raised_amount/status, assigns a
 * reward tier, marks the matching `stellar_transactions` row indexed, and
 * fires all downstream side effects (referrals, sponsor matching, receipts,
 * webhooks, fraud/badge/follow hooks). Used both by the classic Horizon
 * payment stream (`handlePayment`) and by contract-mode deposits, which
 * confirm synchronously right after submission instead of via ledger replay.
 */
async function recordConfirmedContribution({
  campaignId,
  walletPublicKey,
  senderPublicKey,
  destinationAmount,
  destinationAsset,
  sourceAsset = null,
  sourceAmount = null,
  path = null,
  paymentType,
  conversionRate = null,
  txHash,
  walletMode = null,
  eventMetadata = {},
}) {
  const client = await db.connect();
  let postCommitHooks = null;
  try {
    await client.query('BEGIN');
    if (eventMetadata.eventKey) {
      const receipt = await client.query(
        `INSERT INTO ledger_event_receipts
           (campaign_id, event_key, transaction_hash, ledger_sequence, paging_token)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (campaign_id, event_key) DO NOTHING
         RETURNING event_key`,
        [
          campaignId,
          String(eventMetadata.eventKey),
          txHash,
          eventMetadata.ledgerSequence || null,
          eventMetadata.cursorToken || null,
        ]
      );
      if (!receipt.rows.length) {
        await saveCheckpoint(client, campaignId, walletPublicKey, eventMetadata);
        await client.query('COMMIT');
        return;
      }
    }
    const existing = await client.query('SELECT id FROM contributions WHERE tx_hash = $1', [
      txHash,
    ]);
    if (existing.rows.length > 0) {
      await saveCheckpoint(client, campaignId, walletPublicKey, eventMetadata);
      await client.query('COMMIT');
      return;
    }

    const { rows: txRows } = await client.query(
      `SELECT metadata FROM stellar_transactions WHERE tx_hash = $1 AND kind = 'contribution'`,
      [txHash]
    );
    const platformFeeAmount = txRows[0]?.metadata?.platform_fee_amount ?? null;

    const { rows: creatorRows } = await client.query(
      'SELECT creator_id, title FROM campaigns WHERE id = $1',
      [campaignId]
    );
    const creatorId = creatorRows[0].creator_id;

    const { rows: submittedRows } = await client.query(
      `SELECT metadata
       FROM stellar_transactions
       WHERE tx_hash = $1 AND kind = 'contribution'
       LIMIT 1`,
      [txHash]
    );
    const anchorMetadata = submittedRows[0]?.metadata?.anchor || null;
    const displayName = submittedRows[0]?.metadata?.display_name || null;
    const attributionMode = submittedRows[0]?.metadata?.attribution_mode || 'public';
    const gift = submittedRows[0]?.metadata?.gift || null;
    const referralCode = submittedRows[0]?.metadata?.referral_code || null;
    const ipAddress = submittedRows[0]?.metadata?.ip_address || null;
    const deviceFingerprint = submittedRows[0]?.metadata?.device_fingerprint || null;
    const reservedTierId = submittedRows[0]?.metadata?.tier_id || null;
    const referralLinkId = submittedRows[0]?.metadata?.referral_link_id || null;
    const nftRewardRequested = submittedRows[0]?.metadata?.nft_reward === true;
    const pathHops = submittedRows[0]?.metadata?.path_hops ?? null;
    const effectiveRate = submittedRows[0]?.metadata?.effective_rate ?? null;
    const slippageBps = submittedRows[0]?.metadata?.slippage_bps ?? null;
    const sendMax = submittedRows[0]?.metadata?.send_max ?? null;
    const retryCount = submittedRows[0]?.metadata?.retry_count ?? 0;

    const { rows: inserted } = await client.query(
      `INSERT INTO contributions
         (campaign_id, sender_public_key, amount, asset, anchor_id, anchor_transaction_id,
          anchor_asset, anchor_amount, payment_type, source_amount, source_asset,
          conversion_rate, path, tx_hash, platform_fee_amount, display_name, ip_address, device_fingerprint,
          referral_link_id, path_hops, effective_rate, slippage_bps, send_max, retry_count, attribution_mode, diagnosis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19,
               $20, $21, $22, $23, $24, $25, $26)
       RETURNING id`,
      [
        campaignId,
        senderPublicKey,
        destinationAmount,
        destinationAsset,
        anchorMetadata?.anchor_id || null,
        anchorMetadata?.anchor_transaction_id || null,
        anchorMetadata?.anchor_asset || null,
        anchorMetadata?.anchor_amount || null,
        paymentType,
        sourceAmount,
        sourceAsset,
        conversionRate,
        path ? JSON.stringify(path) : null,
        txHash,
        platformFeeAmount,
        displayName,
        ipAddress,
        deviceFingerprint,
        referralLinkId,
        pathHops ? JSON.stringify(pathHops) : null,
        effectiveRate,
        slippageBps,
        sendMax,
        retryCount,
        attributionMode,
        'completed',
      ]
    );

    if (gift) {
      await client.query(
        `INSERT INTO contribution_gift_notifications
           (contribution_id, campaign_id, recipient_email, recipient_name, message,
            amount, asset, campaign_title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (contribution_id) DO NOTHING`,
        [
          inserted[0].id,
          campaignId,
          gift.recipient_email,
          gift.recipient_name,
          gift.message || null,
          destinationAmount,
          destinationAsset,
          creatorRows[0].title,
        ]
      );
    }

    const { rows: fundedRows } = await client.query(
      `UPDATE campaigns
       SET raised_amount = raised_amount + $1,
           status = CASE
             WHEN raised_amount + $1 >= target_amount THEN 'funded'
             ELSE status
           END
       WHERE id = $2
       RETURNING id, creator_id, title, raised_amount, target_amount, asset_type,
         (raised_amount >= target_amount AND raised_amount - $1 < target_amount) AS newly_funded`,
      [destinationAmount, campaignId]
    );

    // Match this contribution to the highest reward tier it qualifies for that
    // still has capacity (idempotent + atomic with the insert above).
    // If the contribution was made with an explicit tier_id that was reserved
    // atomically in the route, use that tier directly without bumping claimed_count.
    const assignedTier = await assignTierToContribution(client, {
      campaignId,
      amount: destinationAmount,
      contributionId: inserted[0].id,
      tierId: reservedTierId || undefined,
    });

    if (assignedTier?.nft_enabled && nftRewardRequested) {
      await client.query(
        `INSERT INTO nft_rewards (campaign_id, reward_tier_id, contribution_id, status)
         SELECT $1, $2, $3, 'minting'
         WHERE EXISTS (
           SELECT 1
           FROM reward_tiers rt
           WHERE rt.id = $2
           AND rt.campaign_id = $1
         )
         ON CONFLICT (reward_tier_id, contribution_id) DO NOTHING`,
        [campaignId, assignedTier.id, inserted[0].id]
      );
    }

    await markContributionIndexed(client, txHash, inserted[0].id);

    if (referralCode) {
      await attributeContributionToReferrer(campaignId, referralCode, client);
    }

    // Process sponsor matching
    let matchAmount = 0;
    try {
      matchAmount = await processContributionMatch({
        campaignId,
        contributionId: inserted[0].id,
        contributionAmount: destinationAmount,
        client,
      });
    } catch (matchErr) {
      logger.warn('Sponsor matching processing failed (non-blocking)', {
        campaign_id: campaignId,
        contribution_id: inserted[0].id,
        error: matchErr.message,
      });
    }

    if (anchorMetadata?.anchor_deposit_id) {
      await client.query(
        `UPDATE anchor_deposits
         SET contribution_id = $1,
             status = 'completed',
             updated_at = NOW(),
             completed_at = COALESCE(completed_at, NOW())
         WHERE id = $2`,
        [inserted[0].id, anchorMetadata.anchor_deposit_id]
      );
    }

    const { rows: updatedCampaign } = await client.query(
      'SELECT raised_amount, status FROM campaigns WHERE id = $1',
      [campaignId]
    );

    // The contribution effect and its stream checkpoint commit together.
    await saveCheckpoint(client, campaignId, walletPublicKey, eventMetadata);

    await client.query('COMMIT');
    postCommitHooks = {
      creatorId,
      contributionId: inserted[0].id,
      campaignId,
      fundedCampaign: fundedRows[0]?.newly_funded ? fundedRows[0] : null,
      contributionPayload: {
        id: inserted[0].id,
        campaign_id: campaignId,
        tx_hash: txHash,
        sender_public_key: senderPublicKey,
        amount: String(destinationAmount),
        asset: destinationAsset,
        payment_type: paymentType,
        anchor_transaction_id: anchorMetadata?.anchor_transaction_id || null,
        reward_tier: assignedTier || null,
        nft_reward: assignedTier?.nft_enabled && nftRewardRequested ? true : false,
      },
      receiptPayload: {
        campaignId,
        txHash,
        amount: destinationAmount,
        asset: destinationAsset,
        senderPublicKey,
      },
      hasGift: Boolean(gift),
    };
    logger.info('Contribution indexed', {
      campaign_id: campaignId,
      wallet_public_key: walletPublicKey,
      amount: destinationAmount,
      asset: destinationAsset,
      tx_hash: txHash,
    });

    broadcastCampaignUpdate(campaignId, {
      type: 'contribution',
      contribution: {
        id: inserted[0].id,
        campaign_id: campaignId,
        sender_public_key: senderPublicKey,
        amount: destinationAmount,
        asset: destinationAsset,
        payment_type: paymentType,
        source_amount: sourceAmount,
        source_asset: sourceAsset,
        conversion_rate: conversionRate,
        path,
        tx_hash: txHash,
        display_name: displayName,
      },
      raised_amount: updatedCampaign[0]?.raised_amount,
      status: updatedCampaign[0]?.status,
    });

    // A contract-mode campaign also books the contribution on-chain, so the
    // treasury's totals track the ledger. This runs after COMMIT and never
    // throws: the contribution is already recorded and confirmed on Stellar, so
    // a Soroban hiccup must not undo it — it is logged for retry instead.
    if (walletMode === 'contract') {
      try {
        await indexTreasuryContribution(campaignId, {
          contributor: senderPublicKey,
          amount: String(destinationAmount),
          txHash,
        });
      } catch (treasuryError) {
        logger.error('Failed to index contribution on the treasury contract', {
          campaign_id: campaignId,
          tx_hash: txHash,
          error: treasuryError.message,
        });
      }
    }
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors after failed work
    }
    Sentry.withScope(scope => {
      scope.setTag('stellar.network', process.env.STELLAR_NETWORK);
      scope.setExtra('tx_hash', txHash);
      scope.setExtra('campaign_id', campaignId);
      Sentry.captureException(err);
    });
    logger.error('Failed to index contribution', {
      campaign_id: campaignId,
      tx_hash: txHash,
      error: err.message,
    });
  } finally {
    client.release();
  }

  if (postCommitHooks) {
    setImmediate(() => {
      // Evaluate fraud signals on every new contribution
      const { evaluateCampaign } = require('./fraudService');
      evaluateCampaign(postCommitHooks.campaignId).catch(e =>
        logger.error('[fraud] Assessment failed', {
          campaign_id: postCommitHooks.campaignId,
          error: e.message,
        })
      );

      // Award any badge this contribution has just unlocked
      const { syncBadgesForWallet } = require('./badgeService');
      syncBadgesForWallet(postCommitHooks.receiptPayload.senderPublicKey).catch(e =>
        logger.error('[badges] Sync failed', {
          campaign_id: postCommitHooks.campaignId,
          error: e.message,
        })
      );

      // Tell followers when the campaign crosses a funding threshold
      const { announceFundingProgress } = require('./campaignFollowService');
      announceFundingProgress(postCommitHooks.campaignId).catch(e =>
        logger.error('[follow] Funding progress announcement failed', {
          campaign_id: postCommitHooks.campaignId,
          error: e.message,
        })
      );

      // Bust public caches — contribution changes raised_amount and contributor_count
      cache.invalidate(`campaigns:id:${postCommitHooks.campaignId}`);
      cache.invalidatePrefix('campaigns:list:');
      cache.invalidatePrefix('stats:');

      sendContributionReceipt(postCommitHooks.receiptPayload).catch(e =>
        logger.error('[receipt] Email failed', {
          campaign_id: postCommitHooks.campaignId,
          tx_hash: postCommitHooks.receiptPayload.txHash,
          error: e.message,
        })
      );

      if (postCommitHooks.hasGift) {
        processPendingGiftNotifications().catch(error =>
          logger.error('Gift contribution notification processing failed', {
            campaign_id: postCommitHooks.campaignId,
            contribution_id: postCommitHooks.contributionId,
            error: error.message,
          })
        );
      }

      // User-level webhooks (legacy)
      emitWebhookEventForUser(
        postCommitHooks.creatorId,
        WEBHOOK_EVENTS.CONTRIBUTION_RECEIVED,
        postCommitHooks.contributionPayload
      ).catch(e => logger.error('Contribution webhook emit failed', { error: e.message }));

      // Campaign-level webhooks
      emitWebhookEventForCampaign(postCommitHooks.campaignId, WEBHOOK_EVENTS.CONTRIBUTION_INDEXED, {
        campaign_id: postCommitHooks.campaignId,
        tx_hash: postCommitHooks.receiptPayload.txHash,
        amount: postCommitHooks.receiptPayload.amount,
        asset: postCommitHooks.receiptPayload.asset,
        sender: postCommitHooks.receiptPayload.senderPublicKey,
        timestamp: new Date().toISOString(),
      }).catch(e =>
        logger.error('Campaign contribution webhook emit failed', { error: e.message })
      );

      if (postCommitHooks.fundedCampaign) {
        const { triggerCampaignStatusActions } = require('./campaignStatusActions');
        triggerCampaignStatusActions(
          { id: postCommitHooks.campaignId, status: 'funded' },
          'active'
        ).catch(e =>
          logger.error('Funded status actions failed', {
            campaign_id: postCommitHooks.campaignId,
            error: e.message,
          })
        );
      }
    });
  }
}

function scheduleStreamReconnect(campaignId, walletPublicKey, attempt) {
  if (attempt > MAX_RECONNECT_ATTEMPTS) {
    logger.error('Ledger stream reconnect abandoned after max attempts', {
      wallet_public_key: walletPublicKey,
      campaign_id: campaignId,
      attempt,
      max_attempts: MAX_RECONNECT_ATTEMPTS,
    });
    cleanupStreamForWallet(walletPublicKey);
    return;
  }

  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** Math.max(0, attempt - 1));
  registrySet(walletPublicKey, {
    state: 'reconnecting',
    reconnect_attempt: attempt,
    next_reconnect_at: new Date(Date.now() + delay).toISOString(),
  });
  logger.info('Scheduling ledger stream reconnect', {
    wallet_public_key: walletPublicKey,
    campaign_id: campaignId,
    delay_ms: delay,
    attempt,
  });
  setTimeout(() => {
    watchCampaignWallet(campaignId, walletPublicKey)
      .then(() => reconnectAttempts.delete(walletPublicKey))
      .catch(err =>
        logger.error('Ledger stream reconnect failed', {
          wallet_public_key: walletPublicKey,
          campaign_id: campaignId,
          error: err.message,
        })
      );
  }, delay);
}

async function openStreamForWallet(campaignId, walletPublicKey) {
  const stored = await loadCursor(campaignId);
  const streamCursor = stored || 'now';

  logger.info('Opening ledger stream', {
    wallet_public_key: walletPublicKey,
    campaign_id: campaignId,
    cursor_mode: stored ? 'resumed' : 'now',
  });

  const closeStream = server
    .payments()
    .forAccount(walletPublicKey)
    .cursor(streamCursor)
    .stream({
      onmessage: record => {
        reconnectAttempts.delete(walletPublicKey);
        registrySet(walletPublicKey, {
          state: 'connected',
          last_message_at: new Date().toISOString(),
          reconnect_attempt: 0,
          last_error: null,
        });
        onPaymentRecord(campaignId, walletPublicKey, record).catch(err =>
          logger.error('Ledger onPaymentRecord failed', {
            wallet_public_key: walletPublicKey,
            campaign_id: campaignId,
            error: err.message,
          })
        );
      },
      onerror: err => {
        logger.error('Ledger stream error', {
          wallet_public_key: walletPublicKey,
          campaign_id: campaignId,
          error: err.message,
        });
        const attempt = (reconnectAttempts.get(walletPublicKey) || 0) + 1;
        reconnectAttempts.set(walletPublicKey, attempt);
        cleanupStreamForWallet(walletPublicKey);
        scheduleStreamReconnect(campaignId, walletPublicKey, attempt);
      },
    });

  registrySet(walletPublicKey, {
    close: closeStream,
    campaign_id: campaignId,
    wallet_public_key: walletPublicKey,
    state: 'connected',
    stream_cursor: streamCursor,
    opened_at: new Date().toISOString(),
    reconnect_attempt: 0,
    last_error: null,
  });
}

/**
 * REST-replay from DB cursor, then register with Horizon Ingestion Worker.
 * Supports both positional args (campaignId, walletPublicKey) and object param ({ campaignId, walletPublicKey, cursor }).
 */
async function watchCampaignWallet(campaignIdOrOpts, walletPublicKeyArg) {
  let campaignId;
  let walletPublicKey;
  let cursor;

  if (campaignIdOrOpts && typeof campaignIdOrOpts === 'object') {
    campaignId = campaignIdOrOpts.campaignId;
    walletPublicKey = campaignIdOrOpts.walletPublicKey;
    cursor = campaignIdOrOpts.cursor;
  } else {
    campaignId = campaignIdOrOpts;
    walletPublicKey = walletPublicKeyArg;
  }

  if (!campaignId || !walletPublicKey) return;

  const existing = streamRegistry.get(walletPublicKey);
  if (existing && existing.state === 'connected' && typeof existing.close === 'function') {
    return;
  }
  if (existing) {
    try {
      if (typeof existing.close === 'function') existing.close();
    } catch {
      // ignore
    }
    streamRegistry.delete(walletPublicKey);
  }

  await defaultIngestionWorker.registerWallet(campaignId, walletPublicKey, cursor);

  await replayMissedPayments(campaignId, walletPublicKey);
  await openStreamForWallet(campaignId, walletPublicKey);
}

const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

async function startLedgerMonitor() {
  startGiftNotificationWorker();
  await defaultIngestionWorker.start();

  const { rows } = await db.query(
    `SELECT id, wallet_public_key FROM campaigns WHERE status IN ('active', 'funded')`
  );

  await Promise.all(
    rows.map(campaign =>
      watchCampaignWallet(campaign.id, campaign.wallet_public_key).catch(err =>
        logger.error('Failed to watch campaign wallet', {
          wallet_public_key: campaign.wallet_public_key,
          campaign_id: campaign.id,
          error: err.message,
        })
      )
    )
  );

  logger.info('Watching active and funded campaigns via Horizon Ingestion Worker', {
    campaign_count: rows.length,
  });

  setInterval(() => {
    runBalanceReconciliation().catch(err =>
      logger.error('Periodic balance reconciliation failed', {
        error: err.message,
      })
    );
  }, RECONCILE_INTERVAL_MS);

  setInterval(
    () => {
      getLedgerStreamHealth()
        .then(h => {
          const bad = (h.streams || []).filter(s => s.stale_stream_no_messages_15m);
          if (bad.length) {
            logger.warn('Ledger stream health: connected streams idle >15m', {
              wallet_public_keys: bad.map(b => b.wallet_public_key),
            });
          }
        })
        .catch(err =>
          logger.warn('Ledger stream health check failed', {
            error: err.message,
          })
        );
    },
    5 * 60 * 1000
  );
}

/** For GET /health/ledger — in-process stream status + DB cursors + worker metrics. */
async function getLedgerStreamHealth() {
  const workerHealth = defaultIngestionWorker.getHealth();

  const { rows: dbCursors } = await db.query(
    `SELECT c.id AS campaign_id, c.wallet_public_key, c.status AS campaign_status,
            lc.last_cursor, lc.last_ledger_sequence, lc.last_event_key,
            lc.gap_detected, lc.state AS cursor_state, lc.last_error,
            lc.updated_at AS cursor_updated_at
     FROM campaigns c
     LEFT JOIN ledger_stream_cursors lc ON lc.campaign_id = c.id
     WHERE c.status IN ('active', 'funded')`
  );

  const streams = dbCursors.map(row => {
    const live = streamRegistry.get(row.wallet_public_key) || {};
    const workerStream = (workerHealth.streams || []).find(
      s => s.wallet_public_key === row.wallet_public_key
    );
    const streamState = workerStream?.stream_state || live.state || 'not_connected';

    return {
      campaign_id: row.campaign_id,
      wallet_public_key: row.wallet_public_key,
      campaign_status: row.campaign_status,
      last_cursor: row.last_cursor || workerStream?.last_cursor || null,
      last_ledger_sequence: row.last_ledger_sequence || null,
      last_event_key: row.last_event_key || null,
      gap_detected: Boolean(row.gap_detected),
      cursor_state: row.cursor_state || 'unknown',
      cursor_error: row.last_error || null,
      cursor_updated_at: row.cursor_updated_at || null,
      stream_state: streamState,
      stream_opened_at: live.opened_at || null,
      last_stream_message_at: live.last_message_at || null,
      last_stream_error: live.last_error || null,
      reconnect_attempt:
        workerStream?.reconnect_attempt ||
        live.reconnect_attempt ||
        reconnectAttempts.get(row.wallet_public_key) ||
        0,
      next_reconnect_at: live.next_reconnect_at || null,
    };
  });

  const staleMs = 15 * 60 * 1000;
  const now = Date.now();
  const streamsWithStale = streams.map(s => {
    const last = s.last_stream_message_at ? new Date(s.last_stream_message_at).getTime() : 0;
    const stale = s.stream_state === 'connected' && last > 0 && now - last > staleMs;
    return { ...s, stale_stream_no_messages_15m: stale };
  });

  return {
    active_campaigns: streamsWithStale.length,
    worker_status: workerHealth.worker_status,
    queue_depth: workerHealth.queue_depth,
    throughput_eps: workerHealth.throughput_eps,
    metrics: workerHealth.metrics,
    streams: streamsWithStale,
  };
}

async function listLedgerCheckpoints(campaignId = null) {
  const params = campaignId ? [campaignId] : [];
  const where = campaignId ? 'WHERE lsc.campaign_id = $1' : '';
  const { rows } = await db.query(
    `SELECT lsc.campaign_id, lsc.wallet_public_key, lsc.last_cursor,
            lsc.last_ledger_sequence, lsc.last_event_key, lsc.state,
            lsc.gap_detected, lsc.last_error, lsc.updated_at
       FROM ledger_stream_cursors lsc ${where}
      ORDER BY lsc.updated_at DESC`,
    params
  );
  return rows;
}

async function listLedgerAlerts(campaignId = null) {
  const params = campaignId ? [campaignId] : [];
  const where = campaignId ? 'WHERE campaign_id = $1' : '';
  const { rows } = await db.query(
    `SELECT id, campaign_id, alert_type, expected_sequence, observed_sequence,
            event_key, details, status, created_at, resolved_at
       FROM ledger_stream_alerts ${where}
      ORDER BY created_at DESC LIMIT 200`,
    params
  );
  return rows;
}

/** Run a bounded, operator-requested replay and persist its progress. */
async function requestBoundedBackfill({
  campaignId,
  walletPublicKey,
  fromCursor,
  toCursor = null,
  maxEvents = 1000,
  requestedBy = null,
}) {
  const boundedMax = Math.max(1, Math.min(10000, Number(maxEvents) || 0));
  if (!campaignId || !fromCursor || !boundedMax) {
    const error = new Error('campaignId, fromCursor, and maxEvents are required');
    error.statusCode = 400;
    throw error;
  }
  if (!walletPublicKey) {
    const { rows } = await db.query('SELECT wallet_public_key FROM campaigns WHERE id = $1', [
      campaignId,
    ]);
    walletPublicKey = rows[0]?.wallet_public_key;
  }
  if (!walletPublicKey) {
    const error = new Error('Campaign wallet not found');
    error.statusCode = 404;
    throw error;
  }

  const { rows: inserted } = await db.query(
    `INSERT INTO ledger_backfill_requests
       (campaign_id, requested_by, from_cursor, to_cursor, max_events, status, started_at)
     VALUES ($1, $2, $3, $4, $5, 'running', NOW())
     RETURNING id`,
    [campaignId, requestedBy, String(fromCursor), toCursor ? String(toCursor) : null, boundedMax]
  );
  const requestId = inserted[0].id;
  let cursor = String(fromCursor);
  let processed = 0;
  let replayed = 0;
  try {
    while (processed < boundedMax) {
      const page = await server
        .payments()
        .forAccount(walletPublicKey)
        .cursor(cursor)
        .order('asc')
        .limit(Math.min(100, boundedMax - processed))
        .call();
      const records = page.records || [];
      if (!records.length) break;
      for (const record of records) {
        await onPaymentRecord(campaignId, walletPublicKey, record);
        processed += 1;
        replayed += 1;
        const token = extractPagingToken(record);
        if (toCursor && token === String(toCursor)) break;
        if (processed >= boundedMax) break;
      }
      const pageToken = page.paging_token || extractPagingToken(records[records.length - 1]);
      if (
        !pageToken ||
        pageToken === cursor ||
        (toCursor && records.some(r => extractPagingToken(r) === String(toCursor)))
      )
        break;
      cursor = String(pageToken);
      if (records.length < 100) break;
    }
    await db.query(
      `UPDATE ledger_backfill_requests
          SET status = 'completed', processed_events = $1, replayed_events = $2,
              completed_at = NOW()
        WHERE id = $3`,
      [processed, replayed, requestId]
    );
    return {
      id: requestId,
      status: 'completed',
      processedEvents: processed,
      replayedEvents: replayed,
    };
  } catch (err) {
    await db.query(
      `UPDATE ledger_backfill_requests
          SET status = 'failed', processed_events = $1, replayed_events = $2,
              error_message = $3, completed_at = NOW()
        WHERE id = $4`,
      [processed, replayed, err.message, requestId]
    );
    throw err;
  }
}

module.exports = {
  startLedgerMonitor,
  watchCampaignWallet,
  handlePayment,
  recordConfirmedContribution,
  reconcileCampaignBalances: runBalanceReconciliation,
  getLedgerStreamHealth,
  listLedgerCheckpoints,
  listLedgerAlerts,
  requestBoundedBackfill,
  onPaymentRecord,
  addSSEClient,
  removeSSEClient,
  cleanupStreamForWallet,
  HorizonIngestionWorker,
  defaultIngestionWorker,
};
