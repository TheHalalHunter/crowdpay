const {
  insertContributionPending,
  markContributionSubmitted,
  markContributionFailed,
} = require('./stellarTransactionService');
const { withDecryptedWalletSecret } = require('./walletSecrets');
const {
  prepareSignedContributionPayment,
  prepareSignedContributionPathPayment,
  submitPreparedTransaction,
  getPathPaymentQuote,
  ensureCustodialAccountFundedAndTrusted,
  calcFee,
} = require('./stellarService');
const { depositToEscrow, isContractDepositEligible } = require('./sorobanService');
const { SLIPPAGE_BPS } = require('../config/constants');
const { toStroops, fromStroops, mulBpsCeil } = require('../utils/stroops');
const { buildReferralMemo } = require('./referral');

const CONTRACT_MODE_CROSS_ASSET_MESSAGE = assetType =>
  `Cross-asset contributions aren't supported for this campaign's contract-backed treasury yet — please contribute in ${assetType} directly.`;

function buildContributionMemo(campaignId) {
  return `cp-${String(campaignId).replace(/-/g, '').slice(0, 25)}`.slice(0, 28);
}

/**
 * A referred contribution carries `ref:<code>` instead of the campaign memo, so
 * attribution is recorded on-chain and stays verifiable from Horizon (#675).
 */
function buildAttributionMemo(campaignId, referralCode) {
  return referralCode ? buildReferralMemo(referralCode) : buildContributionMemo(campaignId);
}

/** Quoted source amount plus slippage headroom, rounded up to the next stroop. */
function slippageSendMax(sourceAmount) {
  return fromStroops(mulBpsCeil(toStroops(sourceAmount), 10000 + SLIPPAGE_BPS));
}

async function buildContributionIntent({
  campaign,
  amount,
  sendAsset,
  contributorPublicKey,
  displayName,
  previewPath,
}) {
  if (sendAsset === campaign.asset_type) {
    return {
      kind: 'payment',
      conversionQuote: null,
      flowMetadata: {
        flow: 'payment',
        send_asset: sendAsset,
        amount: String(amount),
        contributor_public_key: contributorPublicKey,
        display_name: displayName || null,
      },
    };
  }

  // A validated preview path carries its own max_send_amount computed from the
  // quote the contributor approved (#688). Without one we fall back to quoting
  // the best route inline (embeds and legacy callers).
  let bestPath;
  let sendMax;
  if (previewPath) {
    bestPath = previewPath;
    sendMax = previewPath.max_send_amount;
  } else {
    const paths = await getPathPaymentQuote({
      sendAsset,
      destAsset: campaign.asset_type,
      destAmount: amount,
    });
    if (!paths.length) {
      const error = new Error(
        `No conversion path found for ${sendAsset} -> ${campaign.asset_type}`
      );
      error.statusCode = 422;
      throw error;
    }
    bestPath = paths[0];
    sendMax = slippageSendMax(bestPath.source_amount);
  }

  const effectiveRate = String(
    parseFloat(bestPath.source_amount) / parseFloat(bestPath.destination_amount || amount)
  );

  return {
    kind: 'path_payment_strict_receive',
    sendMax,
    conversionQuote: {
      send_asset: sendAsset,
      campaign_asset: campaign.asset_type,
      campaign_amount: String(amount),
      quoted_source_amount: bestPath.source_amount,
      max_send_amount: sendMax,
      path: bestPath.path,
    },
    flowMetadata: {
      flow: 'path_payment_strict_receive',
      send_asset: sendAsset,
      dest_asset: campaign.asset_type,
      dest_amount: String(amount),
      max_send_amount: sendMax,
      quoted_source_amount: bestPath.source_amount,
      path_hops: bestPath.path,
      effective_rate: effectiveRate,
      slippage_bps: SLIPPAGE_BPS,
      send_max: sendMax,
      retry_count: 0,
      contributor_public_key: contributorPublicKey,
      display_name: displayName || null,
    },
  };
}

/** Horizon throws PATH_PAYMENT_OVER_SENDMAX when a strict-receive path payment's sendMax is too tight. */
function isPathPaymentOverSendMax(err) {
  const extras = err?.response?.data?.extras;
  const resultCodes = extras?.result_codes?.operations || extras?.result_codes || [];
  if (Array.isArray(resultCodes) && resultCodes.includes('PATH_PAYMENT_OVER_SENDMAX')) {
    return true;
  }
  return String(err?.message || '').includes('PATH_PAYMENT_OVER_SENDMAX');
}

async function submitCustodialContribution({
  campaign,
  campaignId,
  userId,
  walletPublicKey,
  walletSecretEncrypted,
  amount,
  sendAsset,
  intentOverride,
  anchorMetadata,
  displayName,
  attributionMode,
  gift,
  referralCode,
  referralLinkCode,
  referralLinkId,
  ipAddress,
  deviceFingerprint,
  client,
  tierId,
  previewPath,
  idempotencyKey,
}) {
  const contractMode = isContractDepositEligible(campaign);
  if (contractMode && sendAsset !== campaign.asset_type) {
    const error = new Error(CONTRACT_MODE_CROSS_ASSET_MESSAGE(campaign.asset_type));
    error.statusCode = 422;
    throw error;
  }

  // One exact conversion (#840): the contract deposit, the classic payment
  // operations, the fee split and the persisted metadata all derive from this
  // stroop value, so they reconcile to the stroop. Amounts with more than 7
  // decimal places are rejected (AmountError, 400) rather than rounded.
  const amountStroops = toStroops(amount);
  const destinationAmount = fromStroops(amountStroops);

  const intent =
    intentOverride ||
    (await buildContributionIntent({
      campaign,
      amount: destinationAmount,
      sendAsset,
      contributorPublicKey: walletPublicKey,
      displayName,
      previewPath,
    }));

  // Contract-mode deposits move the full amount into escrow (the contract
  // applies its own fee policy); classic payments split the fee off here.
  const feeSplit = contractMode ? null : await calcFee(destinationAmount);
  const platformFeeAmountClassic = feeSplit ? feeSplit.feeAmount : fromStroops(0n);

  const metadata = {
    ...intent.flowMetadata,
    attribution_mode: attributionMode || 'public',
    ...(gift
      ? {
          gift: {
            recipient_name: gift.recipient_name,
            recipient_email: gift.recipient_email,
            message: gift.message || null,
          },
        }
      : {}),
    platform_fee_amount: 0,
    ip_address: ipAddress || null,
    device_fingerprint: deviceFingerprint || null,
    tier_id: tierId || null,
    nft_reward: Boolean(tierId),
    contract_mode: contractMode,
    ...(contractMode ? { deposit_amount_stroops: amountStroops.toString() } : {}),
    ...(referralCode ? { referral_code: referralCode } : {}),
    ...(referralLinkId
      ? { referral_link_id: referralLinkId, referral_link_code: referralLinkCode }
      : {}),
    ...(anchorMetadata
      ? {
          anchor: {
            anchor_id: anchorMetadata.anchor_id,
            anchor_transaction_id: anchorMetadata.anchor_transaction_id,
            anchor_asset: anchorMetadata.anchor_asset,
            anchor_amount: anchorMetadata.anchor_amount,
            anchor_deposit_id: anchorMetadata.anchor_deposit_id,
          },
        }
      : {}),
  };

  // Record the DB intent BEFORE any Stellar submission happens (#810): this
  // makes the operation atomic in the sense that a durable row always exists
  // first, and idempotent — a retry with the same idempotencyKey (e.g. after
  // a client timeout) reuses the existing row/result instead of paying twice.
  const pendingRow = await insertContributionPending(client, {
    idempotencyKey: idempotencyKey || null,
    idempotencyActorId: userId || null,
    campaignId,
    userId,
    unsignedXdr: null,
    signedXdr: null,
    metadata,
  });

  if (pendingRow.reused) {
    return {
      txHash: pendingRow.txHash,
      stellarTransactionId: pendingRow.id,
      unsignedXdr: null,
      signedXdr: null,
      conversionQuote: intent.conversionQuote,
      flowMetadata: metadata,
      contractMode,
      platformFeeAmount: platformFeeAmountClassic,
      platform_fee_amount: platformFeeAmountClassic,
      destinationAmount,
      destinationAsset: campaign.asset_type,
      replayed: true,
    };
  }

  const pendingRowId = pendingRow.id;
  let unsignedXdr = null;
  let signedXdr = null;
  let platformFeeAmount = 0;
  let txHash;
  let submittedMetadata = null;

  const prepareClassic = (senderSecret, sendMax) => {
    const memo = buildAttributionMemo(campaignId, referralLinkCode);
    if (intent.kind === 'payment') {
      return prepareSignedContributionPayment({
        senderSecret,
        destinationPublicKey: campaign.wallet_public_key,
        asset: sendAsset,
        amount: destinationAmount,
        memo,
        feeSplit,
      });
    }
    return prepareSignedContributionPathPayment({
      senderSecret,
      destinationPublicKey: campaign.wallet_public_key,
      sendAsset,
      sendMax,
      destAmount: destinationAmount,
      destAssetCode: campaign.asset_type,
      memo,
      feeSplit,
    });
  };
  let retryCount = 0;

  try {
    if (contractMode) {
      // Same-asset only (see issue #710) — deposit directly into the escrow
      // contract, self-authorized by the custodial account's own key, instead
      // of paying the classic campaign wallet.
      const depositResult = await withDecryptedWalletSecret(
        walletSecretEncrypted,
        { userId, walletPublicKey },
        async senderSecret => {
          await ensureCustodialAccountFundedAndTrusted({
            publicKey: walletPublicKey,
            secret: senderSecret,
          });
          return depositToEscrow({
            contractId: campaign.escrow_contract_id,
            fromAddress: walletPublicKey,
            amount: amountStroops,
            signerSecret: senderSecret,
          });
        }
      );
      txHash = depositResult.txHash;
    } else {
      const preparedTransaction = await withDecryptedWalletSecret(
        walletSecretEncrypted,
        { userId, walletPublicKey },
        async senderSecret => {
          await ensureCustodialAccountFundedAndTrusted({
            publicKey: walletPublicKey,
            secret: senderSecret,
          });
          return prepareClassic(senderSecret, intent.sendMax);
        }
      );

      unsignedXdr = preparedTransaction.unsignedXdr;
      signedXdr = preparedTransaction.signedXdr;
      platformFeeAmount = preparedTransaction.feeAmount ?? 0;
      try {
        txHash = await submitPreparedTransaction(signedXdr);
      } catch (err) {
        // Slippage safety net (#688): if the strict-receive sendMax was too
        // tight (DEX rate moved since the quote), re-quote once and retry
        // before surfacing the failure to the contributor.
        if (intent.kind !== 'path_payment_strict_receive' || !isPathPaymentOverSendMax(err)) {
          err.statusCode = err.statusCode || 502;
          throw err;
        }
        const freshPaths = await getPathPaymentQuote({
          sendAsset,
          destAsset: campaign.asset_type,
          destAmount: destinationAmount,
        });
        if (!freshPaths.length) {
          err.statusCode = err.statusCode || 502;
          throw err;
        }
        const freshBest = freshPaths[0];
        const freshSendMax = slippageSendMax(freshBest.source_amount);

        const retried = await withDecryptedWalletSecret(
          walletSecretEncrypted,
          { userId, walletPublicKey },
          async senderSecret => prepareClassic(senderSecret, freshSendMax)
        );
        unsignedXdr = retried.unsignedXdr;
        signedXdr = retried.signedXdr;

        // Reflect the re-quote in the stored metadata so diagnostics show the
        // final route that actually moved funds.
        submittedMetadata = {
          send_max: freshSendMax,
          max_send_amount: freshSendMax,
          quoted_source_amount: freshBest.source_amount,
          path_hops: freshBest.path,
          effective_rate: String(
            parseFloat(freshBest.source_amount) / parseFloat(destinationAmount)
          ),
          retry_count: 1,
        };
        Object.assign(metadata, submittedMetadata);

        try {
          txHash = await submitPreparedTransaction(signedXdr);
        } catch (retryErr) {
          retryErr.statusCode = retryErr.statusCode || 502;
          throw retryErr;
        }
        // Slippage safety net (#688): if the strict-receive sendMax was too tight
        // (DEX rate moved since the quote), re-quote once and retry before
        // surfacing the failure to the contributor.
        if (
          intent.kind === 'path_payment_strict_receive' &&
          retryCount === 0 &&
          isPathPaymentOverSendMax(err)
        ) {
          const freshPaths = await getPathPaymentQuote({
            sendAsset,
            destAsset: campaign.asset_type,
            destAmount: amount,
          });
          if (!freshPaths.length) {
            err.statusCode = err.statusCode || 502;
            throw err;
          }
          const freshBest = freshPaths[0];
          const freshSendMax = (
            parseFloat(freshBest.source_amount) *
            (1 + SLIPPAGE_BPS / 10000)
          ).toFixed(7);

          const retried = await withDecryptedWalletSecret(
            walletSecretEncrypted,
            { userId, walletPublicKey },
            async senderSecret =>
              prepareSignedContributionPathPayment({
                senderSecret,
                destinationPublicKey: campaign.wallet_public_key,
                sendAsset,
                sendMax: freshSendMax,
                destAmount: amount,
                destAssetCode: campaign.asset_type,
                memo: buildAttributionMemo(campaignId, referralLinkCode),
              })
          );

          retryCount = 1;
          unsignedXdr = retried.unsignedXdr;
          signedXdr = retried.signedXdr;
          // Reflect the re-quote in the stored metadata so diagnostics show the
          // final route that actually moved funds.
          intent.flowMetadata.send_max = freshSendMax;
          intent.flowMetadata.max_send_amount = freshSendMax;
          intent.flowMetadata.quoted_source_amount = freshBest.source_amount;
          intent.flowMetadata.path_hops = freshBest.path;
          intent.flowMetadata.effective_rate = String(
            parseFloat(freshBest.source_amount) / parseFloat(amount)
          );
          intent.flowMetadata.retry_count = retryCount;

          try {
            txHash = await submitPreparedTransaction(signedXdr);
          } catch (retryErr) {
            retryErr.statusCode = retryErr.statusCode || 502;
            throw retryErr;
          }
        } else {
          err.statusCode = err.statusCode || 502;
          throw err;
        }
      }
    }
  } catch (err) {
    await markContributionFailed(client, pendingRowId, err.message);
    throw err;
  }

  await markContributionSubmitted(client, pendingRowId, txHash, {
    unsignedXdr,
    signedXdr,
    metadata: submittedMetadata,
  });
  // Persist the ID computed by the pending-row insert (already recorded above)
  // so the metadata copied into the earlier pending row carries the final fee.
  const metadataWithFee = { ...metadata, platform_fee_amount: platformFeeAmount };

  await markContributionSubmitted(client, pendingRowId, txHash);

  return {
    txHash,
    stellarTransactionId: pendingRowId,
    unsignedXdr,
    signedXdr,
    conversionQuote: intent.conversionQuote,
    flowMetadata: metadataWithFee,
    contractMode,
    platformFeeAmount,
    platform_fee_amount: platformFeeAmount,
    // Decimal string: never round-trip money through a JS number (#840).
    destinationAmount,
    destinationAsset: campaign.asset_type,
  };
}

module.exports = {
  buildAttributionMemo,
  buildContributionIntent,
  buildContributionMemo,
  submitCustodialContribution,
  CONTRACT_MODE_CROSS_ASSET_MESSAGE,
};
