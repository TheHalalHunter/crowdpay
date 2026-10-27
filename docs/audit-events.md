# Privileged audit events

High-impact campaign, payout, and dispute actions write append-only rows to
`audit_logs`. Each row records:

- `actor_id` — the authenticated user, or `NULL` for system transitions;
- `action` — a stable verb such as `campaign.suspended`, `payout.approved`, or
  `dispute.resolved`;
- `resource_type` / `resource_id` — the affected target;
- `before_state` / `after_state` — sanitized state snapshots;
- `correlation_id` — the request ID propagated by `requestIdMiddleware`;
- `source` — request method and route (query strings removed) or a system job name;
- `metadata` — additional non-secret context;
- `ip_address` and `user_agent` for API-originated events.

## Covered actions

| Area | Actions |
| --- | --- |
| Campaigns | `campaign.suspended`, `campaign.restored`, `campaign.status_changed` (funded/failed cron and refresh paths) |
| Payouts | `payout.approved`, `payout.rejected`, `payout.cancelled`, `milestone.released`, `milestone.rejected` |
| Disputes | `dispute.status_changed`, `dispute.resolved` |

## Redaction

Audit metadata, before state, and after state pass through
`auditService.sanitizeMetadata()` before persistence and again on read. Keys matching
password, secret, private key, seed, token, authorization, cookie, TOTP, XDR, signature,
HMAC, API key, or credential patterns are replaced with `[REDACTED]`. Stellar secret
seeds are also redacted by value. Circular references are replaced with `[Circular]`.

`audit_logs` is append-only: update, delete, and truncate privileges are revoked. There is
no application path that mutates or removes an audit row.

## Querying

Authorized administrators can read the trail at:

```text
GET /api/admin/audit-logs
GET /api/admin/audit-logs/export?format=csv
```

Filters: `actor`, `action`, `resourceType`, `correlationId`, `source`, `dateFrom`,
`dateTo`, `limit`, `offset`. The route is protected by `requireAuth` plus
`requireRole('admin')`.
