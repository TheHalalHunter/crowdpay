# CrowdPay Backend API

## Interactive Swagger UI

In development, browse the interactive API docs at `GET /api/docs`.

## Important Notes

### Timestamps
All timestamps (like campaign deadlines) **must be in ISO 8601 format with a UTC timezone indicator (Z suffix)**, e.g., `2026-12-31T23:59:59.999Z`. The server will treat all timestamps as UTC for validation and storage.

### Public API lifecycle
`GET /api/v1/changelog` returns the v1 changelog without authentication. To announce a sunset, configure both `PUBLIC_API_DEPRECATION_DATE` and `PUBLIC_API_SUNSET_DATE` as ISO 8601 timestamps, with the sunset later than the deprecation date. The v1 API will then include the RFC 9745 `Deprecation` header, the HTTP-date `Sunset` header, and a `Link` to the changelog on every response. Leave either variable unset to avoid announcing a deprecation.

## Recurring contribution architecture

The canonical subsystem for recurring contributions uses Stellar Claimable Balance schedules (`/api/campaigns/:id/subscriptions`). Complete architectural specifications, worker retry semantics, data model diagrams, and migration plans for superseded paths are documented in [`docs/recurring-contributions-architecture.md`](../docs/recurring-contributions-architecture.md).

### Subscriptions endpoints
- `POST /api/campaigns/:id/subscriptions` - Enable a recurring pledge on a campaign.
- `POST /api/campaigns/:id/subscriptions/prepare` - Prepare unsigned XDR for Freighter signing.
- `POST /api/campaigns/:id/subscriptions/submit` - Submit signed XDR from Freighter.
- `DELETE /api/campaigns/:id/subscriptions/:subscriptionId` - Cancel future installments (> 7 days out).
- `GET /api/subscriptions/mine` - List authenticated contributor's subscriptions and claim status.

> **Note on Deprecated Paths**: Legacy recurring contribution cron endpoints under `/api/users/me/recurring-contributions` (`recurring_contributions` table) are superseded and planned for deprecation. See the migration plan in `docs/recurring-contributions-architecture.md`.

## Contribution conversion model

- Campaigns define a default settlement asset via `campaigns.asset_type` (`USDC` or `XLM`).
- Contributors can pay using `send_asset`.
- If `send_asset !== campaign.asset_type`, the backend uses Stellar `pathPaymentStrictReceive` so the campaign receives the exact requested `amount` in its settlement asset.
- Conversion path discovery uses Stellar Horizon `strictReceivePaths` and applies a `5%` slippage buffer when computing `sendMax`.
- Additional credit assets can be enabled through `STELLAR_EXTRA_ASSETS` in `.env` as a JSON object (`{"CODE":"ISSUER"}`).

## Endpoints

### `GET /api/users/me`

Authenticated. Returns the current profile, including `email_verified` (boolean), `kyc_status` (`unverified`, `pending`, `verified`, `rejected`) and `kyc_completed_at`.

### Account data export

Authenticated users can request a portable JSON archive of their own records.

- `POST /api/users/me/exports` — queue an export. Returns `202` with the export
  id/status. A user may have only one `pending` export at a time (`409`).
- `GET /api/users/me/exports` — list the caller's exports and their status.
- `GET /api/users/me/exports/:id/download` — return a short-lived signed
  download URL for a completed export. The export id is always scoped to the
  authenticated user, so another user's export returns `404`. Completed
  archives expire after 24 hours (`410` after expiry) and download URLs expire
  after one hour.

The archive includes the scopes below. It never includes password hashes,
wallet secret ciphertext, API key hashes, device fingerprints, session IP
addresses/user agents, or any row belonging to another user.

| Scope | Contents |
|---|---|
| `profile` | Account id, email, name, role, wallet public key, created timestamp |
| `creator_campaigns` | Campaigns created by the caller |
| `creator_milestones` | Milestones belonging to the caller's campaigns |
| `campaign_updates` | Updates authored by the caller |
| `contributions` | Contributions sent from the caller's wallet |
| `notification_preferences` | Account-level notification settings |
| `category_follows` | Followed campaign categories |
| `notifications` | In-app notifications addressed to the caller |
| `referrals` | Referral links created by the caller |
| `disputes` | Disputes raised by the caller |
| `subscriptions` | Recurring contribution records |
| `credentials` | API-key metadata (never the key hash or secret) |
| `sessions` | Session id/timestamps and coarse region only |

Export requests and downloads are written to the append-only `audit_logs`
table as `user_data_export_requested` and `user_data_export_downloaded`.

### `GET /api/users/verify-email`

Public. Validates a verification token and marks the associated user's email as verified.

Query params:
- `token` (required): The UUID token sent via email.

Returns `200` on success or `400/410` if the token is invalid or expired (> 24 hours).

### `POST /api/users/resend-verification`

Authenticated. Generates a new verification token and sends a new email.
Rate-limited to 3 requests per hour per user.

### `POST /api/users/me/kyc/start`

Authenticated. Creates a hosted KYC session with the configured provider and marks the user `pending`.

Response includes `redirect_url` or `session_token`, plus the updated user. Persona is used when `KYC_PROVIDER=persona`, `PERSONA_API_KEY`, and `PERSONA_TEMPLATE_ID` are configured; otherwise local development returns a dev redirect URL.

### `POST /api/webhooks/kyc`

KYC provider callback. Updates the matched user to `verified` or `rejected` from provider status. The campaign creation gate is controlled by `KYC_REQUIRED_FOR_CAMPAIGNS` and defaults to enabled; set it to `false` for testnet/dev.

### `POST /api/campaigns`

Authenticated creator/admin endpoint. The user must have `email_verified=true`. Additionally, when `KYC_REQUIRED_FOR_CAMPAIGNS` is not `false`, the user must have `kyc_status=verified`; otherwise the API returns `403` with `code=KYC_REQUIRED` or `code=EMAIL_NOT_VERIFIED`.

### `GET /api/contributions/quote`

Get a DEX quote before submitting a conversion contribution.

Query params:

- `send_asset` (required): `XLM` or `USDC`
- `gift` (optional): `{ recipient_name, recipient_email, message? }`. The
  recipient is notified only after the Stellar payment is confirmed and
  indexed. `recipient_name` is limited to 100 characters, `recipient_email`
  must be valid, and `message` is limited to 280 characters.

Gift notifications are written to a database-backed outbox in the same
transaction that records the confirmed contribution. Email delivery retries
with exponential backoff; registered recipients also receive an in-app
notification. Gift data is not added to the public contribution response.
- `dest_asset` (required): `XLM` or `USDC`
- `dest_amount` (required): amount the campaign should receive

Success response (`200`):

```json
{
  "send_asset": "XLM",
  "dest_asset": "USDC",
  "dest_amount": "9",
  "quoted_source_amount": "10.0000000",
  "max_send_amount": "10.5000000",
  "estimated_rate": "0.900000000000000",
  "path": ["AQUA"],
  "path_count": 3
}
```

Errors:

- `400` missing/invalid params
- `404` no path found on Stellar DEX

### `POST /api/contributions`

Submit a contribution through the existing custodial wallet flow (direct payment or path payment).

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "message": "Transaction submitted",
  "conversion_quote": {
    "send_asset": "XLM",
    "campaign_asset": "USDC",
    "campaign_amount": "4.5000000",
    "quoted_source_amount": "5.0000000",
    "max_send_amount": "5.2500000",
    "path": []
  }
}
```

`conversion_quote` is `null` for direct same-asset contributions.

Errors:

- `400` missing fields / unsupported assets
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `POST /api/contributions/prepare`

Prepare an unsigned Stellar transaction for a Freighter contribution without submitting it.

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign must receive in campaign asset
- `send_asset` (required): `XLM` or `USDC`
- `sender_public_key` (required): contributor wallet public key from Freighter

Success response (`200`):

```json
{
  "unsigned_xdr": "AAAAAgAAA...",
  "prepare_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "conversion_quote": null,
  "sender_public_key": "G...",
  "network_passphrase": "Test SDF Network ; September 2015",
  "network_name": "TESTNET"
}
```

`prepare_token` is short-lived and must be returned with the signed XDR to `/api/contributions/submit-signed`.

Errors:

- `400` missing fields / invalid Stellar public key / unsupported asset
- `404` campaign not found or not active
- `422` no conversion path found for requested asset pair

### `POST /api/contributions/submit-signed`

Submit a Freighter-signed contribution transaction after backend validation.

Body:

- `prepare_token` (required): opaque token returned by `/prepare`
- `signed_xdr` (required): transaction signed in Freighter

Success response (`202`):

```json
{
  "tx_hash": "c8d6...",
  "stellar_transaction_id": "0f3f...",
  "message": "Transaction submitted",
  "conversion_quote": null
}
```

Validation performed before submission:

- signed transaction source account must match `sender_public_key`
- signed transaction body hash must match the prepared unsigned XDR exactly
- signed transaction must contain a valid signature for the contributor public key

Errors:

- `400` missing fields / invalid prepare token
- `403` prepare token belongs to a different authenticated user
- `422` signed XDR does not match the prepared transaction
- `502` Stellar rejected the signed transaction

### `GET /api/anchor/info`

Returns the configured fiat on-ramp anchors and the CrowdPay asset codes currently enabled on Stellar.

### `POST /api/anchor/deposits/start`

Authenticated. Starts a SEP-24 hosted deposit session for the chosen anchor after backend SEP-10 authentication.

Body:

- `campaign_id` (required)
- `amount` (required): amount the campaign should ultimately receive
- `anchor_id` (required): anchor identifier from `/api/anchor/info`

Success response includes:

- anchor session `id`
- `interactive_url`
- `anchor_transaction_id`
- `anchor_asset` / `anchor_amount`
- `conversion_quote` when the eventual contribution needs a path payment

### `GET /api/anchor/deposits/:id`

Authenticated. Polls the anchor transaction, updates the local anchor session, and once the deposit completes automatically submits the normal Stellar contribution from the user’s custodial wallet.

### Anchor environment configuration

Anchor deposit support requires a configured backend anchor signing wallet and an enabled anchor.
Set `ANCHOR_WALLET_HOME_DOMAIN` and `ANCHOR_WALLET_SIGNING_SECRET` in the backend environment.
MoneyGram anchor support is enabled by default unless `ANCHOR_MONEYGRAM_ENABLED=false`.
Use `ANCHOR_MONEYGRAM_ENV=sandbox|preview|production` to select the MoneyGram deployment.

For a custom anchor, configure `ANCHOR_CUSTOM_ID`, `ANCHOR_CUSTOM_NAME`, `ANCHOR_CUSTOM_HOME_DOMAIN`, `ANCHOR_CUSTOM_WEB_AUTH_ENDPOINT`, `ANCHOR_CUSTOM_SEP24_ENDPOINT`, `ANCHOR_CUSTOM_SIGNING_KEY`, `ANCHOR_CUSTOM_ASSET_CODE`, and `ANCHOR_CUSTOM_ASSET_ISSUER`.

### `GET /api/contributions/campaign/:campaignId`

Fetch indexed contributions with conversion audit fields.

Success response (`200`):

```json
[
  {
    "id": "0f3f...",
    "sender_public_key": "G...",
    "amount": "4.5000000",
    "asset": "USDC",
    "payment_type": "path_payment_strict_receive",
    "source_amount": "4.9973210",
    "source_asset": "XLM",
    "conversion_rate": "0.900482150000000",
    "path": ["AQUA"],
    "tx_hash": "c8d6...",
    "created_at": "2026-04-23T08:13:34.392Z"
  }
]
```

### `GET /api/withdrawals/capabilities`

Returns whether the authenticated user may perform **platform** signing/rejection (`can_approve_platform`). If `PLATFORM_APPROVER_USER_ID` is set in the backend environment, only that user’s JWT subject matches; otherwise (dev only) any authenticated user may act as platform for API calls.

### `POST /api/withdrawals/request`

Create a pending withdrawal request (creator only). Verifies multisig on the campaign wallet, ensures the campaign is `active` or `funded`, and rejects if another `pending` withdrawal already exists for the same campaign.

Body:

- `campaign_id` (required)
- `destination_key` (required)
- `amount` (required)

Returns `201` with withdrawal request (`creator_signed=false`, `platform_signed=false`, `status=pending`).

Appends an audit row to `withdrawal_approval_events` with action `requested`.

Errors:

- `403` not the campaign creator
- `409` campaign status not eligible, or duplicate pending withdrawal
- `422` multisig configuration invalid

### `POST /api/withdrawals/:id/approve/creator`

Creator approval step. Signs withdrawal XDR using creator custodial key and marks `creator_signed=true`.

Errors:

- `403` caller is not campaign creator
- `409` request no longer pending, campaign status not `active`/`funded`, or already creator-approved

Logs `creator_signed` in `withdrawal_approval_events`.

### `POST /api/withdrawals/:id/approve/platform`

Platform approval/finalization step. Signs with platform key, validates dual-signature presence, and submits to Stellar.

Errors:

- `403` caller cannot perform platform signature (see `PLATFORM_APPROVER_USER_ID`)
- `409` creator approval missing, campaign status not eligible, or request not pending
- `422` insufficient signatures in XDR
- `502` Stellar rejected the transaction — request is marked `failed` and `submit_failed` is logged

Success:

- marks request as `status=submitted`
- stores Stellar `tx_hash`
- logs `platform_signed` in `withdrawal_approval_events`

### `POST /api/withdrawals/:id/cancel`

Creator-only. Cancels a **pending** request **before** creator signature (`creator_signed=false`). Sets `status=denied` and stores optional `reason` in `denial_reason`. Logs `creator_cancelled`.

### `POST /api/withdrawals/:id/reject`

Platform-only (same rules as platform approve). Rejects a **pending** request **after** creator has signed and **before** platform signature. Sets `status=denied`. Body optional: `{ "reason": "..." }`. Logs `platform_rejected`.

### `GET /api/withdrawals/campaign/:campaignId`

List withdrawal requests for a campaign (`denial_reason` included when denied). **Authorized for campaign creator or configured platform approver only** (others receive `403`).

### `GET /api/withdrawals/:id/events`

Immutable audit timeline for one withdrawal: `action`, `actor_user_id`, `note`, `metadata`, `created_at`. Same authorization as the campaign list endpoint.

### `GET /api/milestones/campaign/:campaignId`

List milestones for a campaign in display order.

Success response (`200`):

```json
[
  {
    "id": "0f3f...",
    "campaign_id": "4db6...",
    "title": "Prototype delivery",
    "description": "Ship the first production-ready prototype to pilot users.",
    "release_percentage": "25.0000",
    "sort_order": 0,
    "status": "pending",
    "evidence_url": null,
    "destination_key": null,
    "review_note": null,
    "created_at": "2026-04-26T08:13:34.392Z",
    "completed_at": null,
    "approved_at": null,
    "released_at": null
  }
]
```

### `POST /api/milestones/:id/submit`

Creator-only. Submit milestone completion evidence and the payout destination for that release.

Body:

- `evidence_url` (required)
- `destination_key` (required): Stellar public key that will receive the approved release

Errors:

- `403` caller is not the campaign creator
- `409` campaign is not yet in a releaseable state, or milestone is already released
- `400` destination key is invalid

### `POST /api/milestones/:id/approve`

Platform-only. Reviews the submitted milestone, signs the escrow withdrawal using the existing dual-signature flow, submits it to Stellar, records the withdrawal, and advances campaign status to `in_progress` or `completed`.

Body:

- `reason` (optional): review note stored with the milestone and audit trail

Errors:

- `403` caller cannot perform platform approval
- `409` evidence or payout destination is missing, campaign status is not `funded`/`in_progress`, or release already exists
- `422` dual signature requirements were not met
- `502` Stellar rejected the release transaction

### `POST /api/milestones/:id/reject`

Platform-only. Rejects a submitted milestone and stores a required review note.

Body:

- `reason` (required)

## Sponsor matching

Sponsor matching lets a sponsor pledge a pool of funds that is released contribution by contribution. Full behaviour, limits and operational notes live in [`docs/sponsor-matching.md`](../docs/sponsor-matching.md).

### `POST /api/campaigns/:id/matches`

Authenticated. Creates a matching pledge for the campaign.

```json
{ "match_ratio": 1, "pledge_amount": "1000" }
```

- `match_ratio` — match multiplier in `(0, 100]` (`1` is 1:1, `2` is 2:1).
- `pledge_amount` — positive amount in the campaign asset, below `1e13`.

Returns `201` with the created pledge row. `400` on validation failure, `404` when the campaign does not exist, and `409` with `code: "DUPLICATE_MATCHING_PLEDGE"` when the caller already holds an active pledge for this campaign (enforced by a partial unique index, so concurrent duplicate requests are deterministic) or `code: "CAMPAIGN_NOT_MATCHABLE"` when the campaign is closed.

### `GET /api/campaigns/:id/matches`

Public. Aggregated pool progress for the campaign widget and the campaign page:

```json
{
  "campaignId": "…",
  "matches": [
    {
      "id": "…",
      "sponsorName": "Alice",
      "matchRatio": 1,
      "pledgeAmount": 1000,
      "matchedAmount": 250,
      "remainingAmount": 750,
      "status": "active",
      "contributionCount": 2,
      "totalContributed": 250,
      "createdAt": "…"
    }
  ],
  "totalPledged": 1000,
  "totalMatched": 250,
  "remainingPoolAmount": 750,
  "activePoolCount": 1,
  "exhaustedPoolCount": 0,
  "percentageUsed": 25
}
```

Sponsor user IDs are deliberately omitted — this endpoint is unauthenticated.

### `PATCH /api/campaigns/:id/matches/:matchId/complete`

Authenticated. Closes a pledge so unspent funds become reclaimable. Only the sponsor or the campaign creator may call it (`403` otherwise, `404` for an unknown pledge, `409` when it is already completed).

### `GET /api/user/sponsor-matches`

Authenticated. Every pledge held by the caller across all campaigns.

## Embeddable campaign progress widget

### `GET /api/campaigns/:id/widget`

Public, permissive CORS, `Cache-Control: public, max-age=30`. This is the single payload rendered by the iframe embed at `/embed/campaigns/:id` and by the script at `/embed-widget.js`.

```json
{
  "id": "…",
  "title": "Solar grid",
  "description": "Community owned solar",
  "raised_amount": 5000,
  "target_amount": 10000,
  "asset_type": "USDC",
  "status": "active",
  "contributor_count": 25,
  "days_remaining": 10,
  "progress_percentage": 50,
  "contribution_url": "https://…/campaigns/…",
  "milestones": [
    { "id": "m-1", "title": "Design", "release_percentage": 50, "sort_order": 0, "status": "released" }
  ],
  "milestone_summary": { "total": 2, "released": 1, "approved": 0, "submitted": 0, "pending": 1 },
  "recent_backers": [{ "name": "Alice", "amount": 250 }],
  "impact": { }
}
```

Privacy and safety notes:

- Only public summary fields are returned — no creator or contributor identifiers, wallet addresses, emails, or transaction hashes.
- Hidden and soft-deleted campaigns return `404`.
- `recent_backers` honours the campaign's `show_backer_amounts` flag and each contributor's `contributor_privacy` preference (`anonymous` contributors are never listed, `amount_only` contributors never leak a display name, and hidden amounts are returned as `null`).
- `GET /api/embed/:campaignId/stats` remains available for backwards compatibility but is not used by the widget.

## Auditability and traceability

- Every indexed contribution stores:
  - `payment_type` (`payment` vs `path_payment_strict_receive`)
  - destination settlement `amount` and `asset`
  - conversion source `source_amount` and `source_asset` (when applicable)
  - `conversion_rate` (`destination_amount / source_amount`)
  - conversion `path` as JSON
  - immutable Stellar `tx_hash`
- This enables independent reconciliation against Horizon payment records by `tx_hash`.

- Manual fund releases append rows to `withdrawal_approval_events` (`requested`, `creator_signed`, `platform_signed`, `creator_cancelled`, `platform_rejected`, `submit_failed`) with optional `note` and `metadata` JSON for audit and manual review.

- Milestone-based releases reuse the same multisig withdrawal machinery, but the release is triggered from platform approval after the creator has submitted evidence and a payout destination.

- Anchor-assisted contributions persist `anchor_id` and `anchor_transaction_id` on the final `contributions` row for support and reconciliation.

## Ledger monitor health

### `GET /health/ledger`

Public JSON snapshot for operations: Horizon **cursor** row per active campaign wallet (from `ledger_stream_cursors`), in-process **SSE stream state** (`connected`, `reconnecting`, `error`, `not_connected`), last message time, reconnect attempt count, and `stale_stream_no_messages_15m` when a supposedly connected stream has had no SSE traffic for 15 minutes.

The backend also logs a **warning** every 5 minutes if any wallet is in that stale state.

## Test coverage

`node --test src/**/*.test.js` includes route coverage for:

- quote endpoint success
- quote endpoint no-path behavior
- direct payment path for `XLM -> XLM`
- direct payment path for `USDC -> USDC`
- conversion path payment for `XLM -> USDC`
- conversion path payment for `USDC -> XLM`
- withdrawal request creation with multisig validation
- withdrawal creator/platform approval flow
- withdrawal denial paths (missing creator approval, insufficient signatures)


## Creator payout forecast and reserve breakdown

Both endpoints require authentication and are scoped to the campaign's creator
(or a platform admin). They read live data from `campaigns`,
`contributions`, `withdrawal_requests`, `recurring_payout_schedules`, and
`treasury_policies`. No write side effects.

### GET /api/creator/campaigns/:campaignId/payout-forecast

Query parameters:

| name    | type    | default | bounds  |
| ------- | ------- | ------- | ------- |
| horizon | integer | 6       | 1 .. 24 |

Response fields:

- campaign_id, asset_type, horizon_months
- opening_balance, reserve_today, available_today
- projected_total_payout
- months[]: { month, projected_payout, projected_balance_after, payouts[] }
- reserve_breakdown: { platform_fees, pending_withdrawals, scheduled_payouts, unallocated_reserve }
- constraints: { min_hold_days, max_single_withdrawal_pct, withdrawal_cooldown_hours, require_auditor_for_above, wallet_mode, contract_id }
- generated_at

Errors: 401 unauthenticated, 403 not creator/admin, 404 unknown campaign,
422 horizon out of range.

### GET /api/creator/campaigns/:campaignId/reserve

Returns the reserve breakdown without walking the horizon. Same reserve_breakdown
and constraints shape as the forecast, plus campaign_id, asset_type, balance,
reserve, available, scheduled_payouts[], generated_at.

### Reserve semantics

reserve is capped at balance and equals:

- platform_fees        - unsettled platform fee on non-refunded contributions
- pending_withdrawals  - withdrawals in any pending state
- scheduled_payouts    - one run per active recurring schedule
                         (fixed amount, or percentage * balance when amount is null)

unallocated_reserve = reserve - (fees + pending + scheduled), always >= 0; it is
only non-zero when the balance cap kicked in.

### Forecast semantics

Deterministic projection, not a guarantee. Each month consumes the next run of
each active schedule, capping a payout at the remaining projected balance.
projected_total_payout is the sum across the horizon. No new funds, fees, or
refunds are assumed.
