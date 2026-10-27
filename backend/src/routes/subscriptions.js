const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { idempotency } = require('../middleware/idempotency');
const asyncHandler = require('../utils/asyncHandler');
const {
  createSubscription,
  cancelSubscription,
  listSubscriptionsForUser,
  prepareSubscription,
  submitSubscription,
} = require('../services/recurring');

/**
 * @openapi
 * tags:
 *   - name: Subscriptions
 *     description: Recurring pledges backed by Stellar claimable balance schedules
 */

function respondWithServiceError(res, err) {
  if (!err.statusCode) throw err;
  return res.status(err.statusCode).json({
    error: err.message,
    ...(err.code ? { code: err.code } : {}),
  });
}

/**
 * @openapi
 * /api/campaigns/{id}/subscriptions:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Enable a recurring pledge on a campaign
 *     description: >
 *       Locks the full commitment into one Stellar claimable balance per period. Each balance
 *       is claimable unconditionally by the platform and, 30 days after its scheduled date,
 *       by the contributor. Every period must fall on or before the campaign deadline: a
 *       longer schedule is rejected with SUBSCRIPTION_EXCEEDS_DEADLINE unless
 *       truncateToDeadline is true, in which case it is shortened to the periods that fit.
 *       If the campaign is later funded, fails, is suspended or deleted, or its deadline
 *       passes, remaining installments are closed (never claimed) and the contributor can
 *       reclaim them on-ledger once each balance's reclaim date opens.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [amountPerPeriod, asset, periodMonths, totalPeriods]
 *             properties:
 *               amountPerPeriod: { type: number }
 *               asset: { type: string, example: XLM }
 *               periodMonths: { type: integer, enum: [1, 3, 6] }
 *               totalPeriods: { type: integer, minimum: 2, maximum: 24 }
 *               truncateToDeadline: { type: boolean, default: false }
 *     responses:
 *       201: { description: Subscription created (totalPeriods reflects any truncation) }
 *       400: { description: Invalid input, INSUFFICIENT_BALANCE_FOR_SUBSCRIPTION or SUBSCRIPTION_EXCEEDS_DEADLINE }
 *       404: { description: Campaign not found }
 */
/**
 * @openapi
 * /api/campaigns/{id}/subscriptions/prepare:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Prepare a recurring pledge for Freighter signing
 *     description: >
 *       Returns unsigned XDR for a Freighter wallet to sign. The unsigned XDR
 *       is bound to the contributor, campaign, asset, amount, and schedule.
 *       The caller must then sign with Freighter and submit via POST /subscriptions/submit.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: Unsigned XDR ready for Freighter signing }
 *       400: { description: UNSUPPORTED_WALLET_TYPE or INVALID_SUBSCRIPTION }
 *       404: { description: Campaign not found }
 */
router.post(
  '/campaigns/:id/subscriptions/prepare',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { amountPerPeriod, asset, periodMonths, totalPeriods } = req.body || {};
    try {
      const prepared = await prepareSubscription({
        campaignId: req.params.id,
        userId: req.user.userId,
        amountPerPeriod,
        asset,
        periodMonths,
        totalPeriods,
      });
      res.json(prepared);
    } catch (err) {
      return respondWithServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/subscriptions/submit:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Submit a signed Freighter recurring pledge
 *     description: >
 *       Submits the signed XDR from a Freighter wallet, verifies it matches the
 *       prepared unsigned XDR, confirms on Horizon, and persists the balance IDs.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [unsignedXdr, signedXdr]
 *             properties:
 *               unsignedXdr: { type: string, description: The original unsigned XDR }
 *               signedXdr: { type: string, description: The signed XDR from Freighter }
 *     responses:
 *       201: { description: Subscription created }
 *       400: { description: XDR_MISMATCH or INVALID_SUBSCRIPTION }
 *       404: { description: Campaign not found }
 */
router.post(
  '/campaigns/:id/subscriptions/submit',
  requireAuth,
  idempotency('wallet:subscription-submit', { bodyField: 'idempotency_key' }),
  asyncHandler(async (req, res) => {
    const { unsignedXdr, signedXdr } = req.body || {};
    try {
      const subscription = await submitSubscription({
        campaignId: req.params.id,
        userId: req.user.userId,
        unsignedXdr,
        signedXdr,
        amountPerPeriod: req.body.amountPerPeriod,
        asset: req.body.asset,
        periodMonths: req.body.periodMonths,
        totalPeriods: req.body.totalPeriods,
        idempotencyKey: req.idempotencyKey || req.body.idempotency_key || null,
      });
      res.status(201).json(subscription);
    } catch (err) {
      return respondWithServiceError(res, err);
    }
  })
);

router.post(
  '/campaigns/:id/subscriptions',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { amountPerPeriod, asset, periodMonths, totalPeriods, truncateToDeadline } =
      req.body || {};
    try {
      const subscription = await createSubscription({
        campaignId: req.params.id,
        userId: req.user.userId,
        amountPerPeriod,
        asset,
        periodMonths,
        totalPeriods,
        truncateToDeadline: truncateToDeadline === true,
      });
      res.status(201).json(subscription);
    } catch (err) {
      return respondWithServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/campaigns/{id}/subscriptions/{subscriptionId}:
 *   delete:
 *     tags: [Subscriptions]
 *     summary: Cancel a recurring pledge
 *     description: >
 *       Periods scheduled more than 7 days out stop being claimed and become reclaimable by the
 *       contributor. Periods due sooner, or already claimed, are returned as non-cancellable.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: path
 *         name: subscriptionId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200: { description: Cancellation summary }
 *       404: { description: Subscription not found }
 */
router.delete(
  '/campaigns/:id/subscriptions/:subscriptionId',
  requireAuth,
  asyncHandler(async (req, res) => {
    try {
      const result = await cancelSubscription({
        campaignId: req.params.id,
        subscriptionId: req.params.subscriptionId,
        userId: req.user.userId,
      });
      res.json(result);
    } catch (err) {
      return respondWithServiceError(res, err);
    }
  })
);

/**
 * @openapi
 * /api/subscriptions/mine:
 *   get:
 *     tags: [Subscriptions]
 *     summary: List the authenticated contributor's subscriptions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: >
 *           Subscriptions with next payment date and claimed period count. A subscription whose
 *           campaign stopped accepting installments has status 'closed', a closure_reason, the
 *           closed period count/amount and reclaimable_from — the first date the contributor
 *           can reclaim a closed balance on-ledger.
 */
router.get(
  '/subscriptions/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ subscriptions: await listSubscriptionsForUser(req.user.userId) });
  })
);

module.exports = router;
