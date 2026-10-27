# Production PostgreSQL

`docker-compose.prod.yml` deliberately has no database service. Production deployments must use a separately managed PostgreSQL instance (or a PostgreSQL service operated by the deployment team); do not expose PostgreSQL to the public internet or store its data directory in the application container.

This guide is for CrowdPay operators. Run database administration commands from a trusted administrative host, not from the public-facing backend container.

## Requirements

| Item | Requirement |
| --- | --- |
| PostgreSQL | **14 or newer** (use a supported minor release; PostgreSQL 15+ is recommended for a new deployment) |
| Required extension | `pgcrypto` in the `crowdpay` database. The application uses `gen_random_uuid()` from this extension. |
| `uuid-ossp` | **Not required.** CrowdPay does not call `uuid_generate_v4()`. Install it only if another operational tool requires it. |
| Initial capacity | At least 2 vCPU, 4 GB RAM, and 50 GB SSD-backed storage for a small production deployment. Size disk for data, indexes, WAL, and retained backups; grow capacity from observed load. |
| Network | Private network access from backend/migration jobs only, TLS enabled for connections that leave the database host. |

The schema also uses built-in PostgreSQL full-text search (`tsvector`/GIN), JSONB, UUID, and `pgcrypto`; no other extension is currently required. Confirm extensions after provisioning:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'pgcrypto';
SELECT gen_random_uuid();
```

## Provision the database

Use separate roles: an owner/migration role that can create the extension and alter the schema, and a least-privileged runtime role. Substitute strong generated passwords (or, preferably, client certificates/your secret manager) for the placeholders.

```bash
# Run as the PostgreSQL cluster administrator.
createuser --pwprompt crowdpay_owner
createuser --pwprompt crowdpay_app
createdb --owner=crowdpay_owner crowdpay

psql "postgresql://crowdpay_owner@db.internal:5432/crowdpay" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
GRANT CONNECT ON DATABASE crowdpay TO crowdpay_app;
GRANT USAGE ON SCHEMA public TO crowdpay_app;
SQL
```


The migration role must be used for `npm run migrate`; it needs to create/alter tables and indexes. After the first migration, grant the runtime role access to the objects it needs:

```bash
psql "postgresql://crowdpay_owner@db.internal:5432/crowdpay" <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crowdpay_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crowdpay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crowdpay_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crowdpay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE crowdpay_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO crowdpay_app;
SQL
```

If migrations are run by a different owner later, repeat the default-privileges commands for that owner. Managed PostgreSQL offerings commonly expose an admin role that can run `CREATE EXTENSION`; grant that capability only to the migration role where the provider permits it.

## Configure the backend

Set the production backend's `DATABASE_URL` to the **runtime** role. Percent-encode reserved characters in usernames/passwords.

```dotenv
# TLS required, with the server certificate verified against this CA.
DATABASE_URL=postgresql://crowdpay_app:ENCODED_PASSWORD@db.internal:5432/crowdpay?sslmode=verify-full&sslrootcert=/run/secrets/postgres-ca.pem
DB_POOL_MAX=10
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=5000
DB_POOL_WAITING_THRESHOLD=5
```

Connection URI form:

```text
postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require
```

Use `verify-full` plus a trusted CA certificate in production whenever the provider supports it. `require` encrypts traffic but does not provide equivalent hostname/certificate verification. For a managed database, use its private endpoint, CA bundle, and TLS settings; do not disable certificate validation. Store the entire URL and CA material in the deployment secret store, never in Git or an image.

`DB_POOL_MAX`, `DB_IDLE_TIMEOUT_MS`, and `DB_CONNECTION_TIMEOUT_MS` are read by `backend/src/config/database.js`. Start with `DB_POOL_MAX=5–10` **per backend replica**, then ensure the total of all application pools, migration jobs, monitoring, and administrative connections remains below PostgreSQL's connection limit. `DB_POOL_WAITING_THRESHOLD` controls when the backend logs pool-pressure warnings.

### Connection pooling

Use PgBouncer between multiple backend replicas and PostgreSQL. Transaction pooling is appropriate for CrowdPay's ordinary request queries; keep `npm run migrate`, `pg_dump`, restores, and other administrative work on a direct/admin connection (or a session-pooled administrative endpoint). Do not size both layers independently:

1. Set each backend replica's `DB_POOL_MAX` to a small bound (for example 5–10).
2. Set PgBouncer's `max_client_conn` above the possible client count.
3. Set PgBouncer's `default_pool_size`/`max_db_connections` so all pools together leave headroom for migrations, backups, replication, and operators.
4. Alert on PgBouncer waiting clients and PostgreSQL connection saturation before requests begin timing out.

## Initial schema and migrations

Run migrations as a one-off deployment job, using the owner/migration URL. Do this **before** rolling out backend instances that require the new schema, and ensure only one migration job runs at a time.

```bash
cd backend
npm ci
export DATABASE_URL='postgresql://crowdpay_owner:...@db.internal:5432/crowdpay?sslmode=verify-full'
npm run migrate
```

The runner (`db/migrate.js`) creates `schema_migrations`, executes SQL files in lexical/date order from `db/migrations/`, and records each successful file in the same transaction. Re-running it is safe for an already recorded migration: it skips that filename. Check the result:

```bash
psql "$DATABASE_URL" -c 'SELECT filename, applied_at FROM schema_migrations ORDER BY filename;'
```

For a **new production database**, use `npm run migrate` only. Do **not** run `npm run migrate:fresh`: it first loads the current `db/schema.sql` snapshot and then replays historical migrations, and is intended only for local development workflows. Likewise, do not edit `schema_migrations` to skip a migration; restore from a tested backup or resolve the failed migration deliberately.

Before every production migration: take a verified backup, test the migration against a recent restored copy, review lock/statement impact, and schedule a maintenance window for potentially locking changes. The migration system has no automatic down migrations. Roll back application code only when the prior version is compatible with the migrated schema; otherwise restore the database according to the recovery procedure below.

`db/seed.sql` is demo data with placeholder wallet secrets and test accounts. **Never run it in production.** Create production users, campaigns, and configuration through the application and approved operational processes.

## Backups and recovery

Backups are mandatory because CrowdPay stores operational and financial audit data. Use provider-managed automated backups with point-in-time recovery (PITR) where available. Independently keep encrypted, access-controlled logical backups in a separate account/region. A practical baseline is:

- nightly `pg_dump` custom-format backup, retained for at least 30 days;
- continuous WAL archiving/PITR with a recovery-point objective that matches the business requirement;
- periodic restore drills (at least quarterly) into an isolated environment;
- alerting for failed, stale, or untested backups.

Example logical backup (the custom format supports selective restore and parallel restore):

```bash
export DATABASE_URL='postgresql://backup_role:...@db.internal:5432/crowdpay?sslmode=verify-full'
pg_dump --format=custom --no-owner --file="crowdpay-$(date +%F).dump" "$DATABASE_URL"
# Encrypt and upload the dump to protected off-site storage; verify the upload.
pg_restore --list "crowdpay-$(date +%F).dump" >/dev/null
```

Test recovery procedure:

1. Declare an incident, stop backend writers/jobs, and preserve the failed database for investigation where possible.
2. Choose the required restore point (the latest verified dump or a provider PITR timestamp). Record the target time and source backup.
3. Restore into a **new, isolated** PostgreSQL instance/database; never overwrite the only copy first.
4. For a logical dump, create the target database and run `pg_restore --clean --if-exists --no-owner --dbname="$TARGET_DATABASE_URL" backup.dump`. For PITR, follow the database provider's recovery workflow.
5. Validate `schema_migrations`, row counts/business-critical records, application health (`GET /health`), and a representative read/write smoke test. Reconcile affected Stellar activity before reopening writes.
6. Switch the backend secret/endpoint to the validated restored database, deploy, monitor, and document the incident. Retain the original database until recovery is signed off.

Practice this procedure with the actual roles, encryption keys, and networking used in production; an untested backup is not a recovery plan.

## Monitoring and tuning

Monitor PostgreSQL and PgBouncer with provider metrics or `pg_stat_*` views. Alert on database availability, disk/WAL usage, backup status, replication/PITR lag, CPU, memory/cache pressure, connection count, slow queries, lock waits/deadlocks, and long-running transactions. Enable and review `pg_stat_statements` if your provider supports it (it is optional and not required by CrowdPay).

CrowdPay exposes `GET /health/live` for dependency-free liveness and
`GET /health/ready` for readiness across PostgreSQL, Redis, Horizon and required
configuration. The legacy `GET /health` still checks `SELECT 1` and returns
pool totals, idle/waiting clients, maximum pool size, and utilisation. See
[`health-checks.md`](health-checks.md) for the probe contract and timeouts.
Protect operational endpoints from public access or monitor them through a
trusted network. A pool utilisation above 90% is reported to Sentry when
configured.

Performance guidance:

- Keep autovacuum enabled; tune it from table growth and dead-tuple measurements rather than disabling it.
- Use SSD-backed storage and leave free disk capacity for WAL, vacuum, index builds, and restores.
- Start with PostgreSQL defaults on a managed service; adjust `shared_buffers`, `work_mem`, and `maintenance_work_mem` only after observing workload and with total concurrent memory in mind.
- Review slow queries with `pg_stat_statements`/slow-query logs and use `EXPLAIN (ANALYZE, BUFFERS)` on a safe environment before adding indexes. Existing migrations provide indexes for common campaign, contribution, search, and analytics paths.
- Keep PostgreSQL minor releases current and rehearse major-version upgrades using a restored copy.
 
