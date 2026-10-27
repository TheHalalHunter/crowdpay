# Health checks and deployment probes

CrowdPay exposes three health endpoints. They have deliberately different
contracts so a dependency outage cannot trigger a restart loop.

| Endpoint | Purpose | External dependencies | Success | Failure |
|---|---|---|---|---|
| `GET /health/live` | Liveness probe | None | `200 {"status":"ok"}` | Never fails because of a dependency |
| `GET /health/ready` | Readiness probe | PostgreSQL, Redis, Horizon, required config | `200 {"status":"ok"}` | `503 {"status":"degraded","failed":[...]}` |
| `GET /health` | Legacy aggregate check | PostgreSQL | `200` with pool stats and email state | `503` |

## Readiness contract

`GET /health/ready` checks each dependency independently and concurrently:

- `database` — `SELECT 1`
- `redis` — `PING`
- `horizon` — `GET <STELLAR_HORIZON_URL>/fee_stats`
- `soroban` — JSON-RPC `getHealth` when `SOROBAN_RPC_URL` (or `STELLAR_SOROBAN_RPC_URL`) is configured
- `config` — required environment variables from `src/config/env.js`

Every check is bounded by `HEALTH_CHECK_TIMEOUT_MS` (default `2000`). A timeout
is reported as `"error":"timeout"`; other failures are reported as
`"error":"unavailable"` or `"error":"http_error"` with a safe HTTP status. Raw
exception messages, credentials and connection strings are never returned.

`failed` lists the names of the failing checks so a probe can distinguish a
database outage from a cache or Horizon outage.

## Deployment probes

| Platform | Liveness | Readiness |
|---|---|---|
| Kubernetes | `httpGet /health/live` | `httpGet /health/ready` |
| Docker Compose / systemd | `curl -f $BASE_URL/health/live` | `curl -f $BASE_URL/health/ready` |
| Load balancer | `GET /health/live` | `GET /health/ready` |

Use readiness for deployment gates and traffic admission. Use liveness only to
decide whether the process must be restarted. Do not point liveness at
`/health/ready`: a Redis or Horizon outage would otherwise restart healthy
application processes and amplify the outage.
