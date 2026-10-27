# CrowdPay
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)


[![CI](https://github.com/Savitura/crowdpay/actions/workflows/ci.yml/badge.svg)](https://github.com/Savitura/crowdpay/actions/workflows/ci.yml)

**Donation and reward crowdfunding for Nigerian causes, funded from home and abroad.**

CrowdPay raises support for campaigns in Nigeria — school fees, medical funds, community projects, disaster relief — from supporters at home and in the diaspora. Backers give a donation or claim a reward tier. Nothing on CrowdPay is an investment: campaigns never sell equity, shares, or promised returns, and the platform does not broker securities. Each campaign gets its own Stellar wallet, every contribution is recorded, and contributors can fund USDC through MoneyGram's Stellar anchor.

> **Status**: Active development — testnet only.

---

## How it works

1. Creator launches a campaign with a funding goal, deadline, and optional milestones
2. Contributors send USDC (or any Stellar asset — path payments handle conversion)
3. Funds sit in a campaign escrow wallet; the Soroban contract tracks milestone completion
4. Creator requests withdrawal → platform co-signs → funds released to creator (see [Custodial vs. non-custodial creators](#custodial-vs-non-custodial-creators) for what that does and does not protect)
5. If the campaign fails to hit its goal, contributors can claim refunds

---

## Architecture

```
Browser  ──────────────────────────────────────────────────────────────
  React 18 + Vite │ React Router │ Freighter wallet │ i18next (en, fr)
────────────────────────────────────────────────────────────────────────
                            │ HTTPS
                            ▼
Backend  ──────────────────────────────────────────────────────────────
  Express │ JWT auth │ Winston │ Sentry │ rate-limit │ Swagger docs
  ┌────────────────────────────────────────────────────────────────┐
  │ routes: campaigns · contributions · withdrawals · milestones   │
  │         disputes · users · wallets · notifications · webhooks  │
  │         anchor · admin · api-keys · comm-prefs · surveys       │
  └────────────────────────────────────────────────────────────────┘
  ┌────────────────────────────────────────────────────────────────┐
  │ services: stellarService · sorobanService · anchorService      │
  │           ledgerMonitor · reconciliation · contributionService │
  │           emailService · kycProvider · webhookDispatcher       │
  │           walletSecrets · campaignStatusService                │
  │           communicationPreferenceService · outcomeSurveyService│
  └────────────────────────────────────────────────────────────────┘
          │                    │                      │
          ▼                    ▼                      ▼
    PostgreSQL          Stellar Horizon         AWS S3 / R2
    (pgv8/pg)          + Soroban RPC        (campaign images)
                             │
                   MoneyGram SEP-24 Anchor
                   (fiat ↔ USDC rails)
```

---

## Database Migrations

CrowdPay uses a strict SQL migration runner located in `backend/db/`. All migration files must be `.sql` files in `backend/db/migrations/`.

- Run migrations: `npm run migrate`
- Verify the complete schema: `npm run verify-schema`
- Check migration status: `npm run migrate:status` (lists all migrations, including unsupported formats with explicit states)
- Bootstrap schema and run migrations: `npm run migrate:fresh`

To add a migration, create the next timestamped `.sql` file in
`backend/db/migrations/`, include a reversible `.down.sql` when rollback is
supported, and run `npm run migrate` followed by `npm run verify-schema` against
a scratch database before committing it.

## Project Structure

```
crowdpay/
├── backend/
│   ├── src/
│   │   ├── config/          # env, database, stellar client, logger, constants
│   │   ├── routes/          # one file per resource (campaigns, contributions, ...)
│   │   ├── services/        # all business logic and third-party integrations
│   │   ├── middleware/      # auth, validation, error handler, request ID
│   │   └── index.js         # Express app entry point
│   └── db/
│       ├── schema.sql       # canonical base schema (same table/column set as migrations; physical column order is not significant)
│       ├── migrate.js       # migration runner (--bootstrap-schema for the fresh flow)
│       └── migrations/      # date-prefixed SQL files
├── frontend/
│   └── src/
│       ├── pages/           # 18 route-level page components
│       ├── components/      # reusable UI (CampaignCard, ContributeModal, ...)
│       ├── context/         # AuthContext, ThemeContext, ToastContext
│       ├── services/        # typed API client functions
│       ├── locales/         # i18n JSON (en, fr)
│       └── config/          # Stellar/Freighter config
└── contracts/
    └── soroban/             # Rust Soroban contracts (escrow, milestone release)
```

---

## Quick Start

### With Docker (recommended)

```bash
git clone https://github.com/Savitura/crowdpay
cd crowdpay
cp backend/.env.example backend/.env
docker compose up
```

| Service  | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend  | http://localhost:3001 |
| API docs | http://localhost:3001/api/docs |

The database schema is applied automatically. Hot-reload is active for both processes.

### Without Docker

```bash
# Prerequisites: Node.js 20+, PostgreSQL 14+

cd backend && npm install && cp .env.example .env
# Fill in .env (see Environment Variables below)
npm run migrate

cd ../frontend && npm install
# Optional: copy frontend defaults before overriding API, Stellar, Firebase, or Sentry settings
lp .env.example .env

# Two terminals:
cd backend  && npm run dev   # http://localhost:3001
cd frontend && npm run dev   # http://localhost:5173
```

### Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Random 32+ char secret |
| `STELLAR_NETWORK` | `testnet` or `mainnet` |
| `STELLAR_HORIZON_URL` | Horizon endpoint URL |
| `PLATFORM_SECRET_KEY` | Stellar secret key for the platform co-signer wallet |
| `CUSTODIAL_WITHDRAWAL_LIMIT` | Largest withdrawal (asset units, default `1000`) the server will sign with a custodial creator key. Larger payouts need a Freighter creator. See [Custodial vs. non-custodial creators](#custodial-vs-non-custodial-creators). |
| `USDC_ISSUER` | USDC issuer (`GBBD47...` on testnet) |
| `NGN_ISSUER` | Optional. When set, `config/stellar.js` registers an `NGN` (`credit_alphanum4`) asset alongside USDC |
| `SOROBAN_ENABLED` | `true` to run campaigns through the contracts instead of the classic multisig wallet. Requires one of the two configurations below |
| `ESCROW_CONTRACT_ID` / `MILESTONES_CONTRACT_ID` | **env mode** — both must be set together. Re-uses the given instances for every campaign, so it suits a single demo campaign (see [Deployed testnet contracts](#deployed-testnet-contracts)) |
| `ESCROW_WASM_HASH` / `MILESTONES_WASM_HASH` | **deploy mode** — deploys a fresh escrow and milestones instance per campaign from WASM already installed on the network |
| `WALLET_ENCRYPTION_KEY` | Base64 or hex-encoded 32-byte encryption key used by backend wallet recovery |
| `WALLET_SECRET_LOCAL_KEK` | Base64-encoded 32-byte key-encryption key for stored secrets |
| `FRONTEND_URL` | Allowed CORS origin (dev: `http://localhost:5173`) |
| `SMTP_HOST` / `EMAIL_SERVICE_API_KEY` | Email delivery. **Required in production** — boot fails without one of them unless `DISABLE_EMAILS=true` is set as an explicit opt-out (which logs a warning). Optional in dev. `/health` reports `email: "ready" \| "unconfigured"`. |
| `PERSONA_API_KEY` / `PERSONA_TEMPLATE_ID` | KYC provider (optional in dev) |
| `AWS_ACCESS_KEY_ID` + S3 vars | Image uploads (optional in dev) |
| `FEATURE_FLAG_PROVIDER` | Feature flag backend: `env` (default), `unleash`, or `launchdarkly` |
| `UNLEASH_API_URL` | Unleash API URL (required for Unleash adapter) |
| `UNLEASH_API_TOKEN` | Unleash API token (required for Unleash adapter) |
| `UNLEASH_APP_NAME` | Unleash application name (default: `crowdpay`) |
| `UNLEASH_ENVIRONMENT` | Unleash environment (default: `development`) |
| `LAUNCHDARKLY_SDK_KEY` | LaunchDarkly SDK key (required for LaunchDarkly adapter) |
| `RATE_LIMIT_BYPASS_ACCOUNTS` | Comma-separated Stellar addresses (G...) that bypass the contribution rate limiter. **Only for test accounts in non-production.** Adding accounts here allows unlimited contribution requests — a security risk if misused. |

The frontend runs locally without an `.env`: Vite proxies `/api` to `http://localhost:3001` and Stellar explorer links default to testnet. Use `frontend/.env.example` when you need to override those defaults or configure optional integrations.

Generate a 32-byte key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Wallet secret key rotation

- `WALLET_SECRET_LOCAL_KEK` and `WALLET_ENCRYPTION_KEY` must remain stable across process restarts. If either key is changed while encrypted wallet secrets still exist, those secrets become unrecoverable.
- For local secret storage, generate the keys once and keep them in a secure secret store or deployment environment.
- To rotate keys safely, decrypt existing secrets with the current key and re-encrypt them with the new key before switching the environment to use the new value.
- In production, using `WALLET_SECRET_PROVIDER=aws-kms` is the recommended approach because AWS KMS can manage key lifecycle without direct key material rotation in the app.

Generate a platform keypair:
```bash
node -e "const {Keypair} = require('@stellar/stellar-sdk'); const kp = Keypair.random(); console.log('Public:', kp.publicKey()); console.log('Secret:', kp.secret());"
```

Fund it on testnet:
```bash
curl "https://friendbot.stellar.org?addr=<PLATFORM_PUBLIC_KEY>"
```

### Wallet secret rotation (destructive operation)

```bash
# Dry run - simulate without making changes
npm run rotate-wallet-secrets:dry-run --prefix backend

# Confirm and execute rotation (requires explicit --confirm flag)
npm run rotate-wallet-secrets:confirm --prefix backend
```

---

## Available Scripts

### Root (repo level)
| Script | Description |
|---|---|
| `npm test` | Run all backend and frontend tests |
| `npm run lint` | Lint both backend and frontend |
| `npm run format` | Format frontend code with Prettier |
| `npm run format:check` | Check formatting without writing (both packages) |
| `npm run test:e2e` | Run all Playwright E2E tests |
| `npm run test:public` | Run public Playwright E2E tests |
| `npm run load-test` | Run k6 load tests |

### Backend
| Script | Description |
|---|---|
| `npm run dev` | Start development server with hot reload |
| `npm start` | Start production server |
| `npm run lint` | Lint backend code |
| `npm run lint:fix` | Lint and auto-fix backend code |
| `npm run format:check` | Check backend formatting with Prettier |
| `npm test` | Run backend tests (requires `scripts/test-env.sh` sourced) |
| `npm run migrate` | Run pending database migrations |
| `npm run verify-schema` | Verify every application table and compare a bootstrap against a saved schema snapshot |
| `npm run migrate:status` | Show migration status |
| `npm run migrate:down` | Rollback last migration (no .down.sql files exist yet) |
| `npm run migrate:fresh` | Reset DB from schema.sql + run migrations + verify convergence |
| `npm run validate-milestones` | Validate milestone percentage constraints |
| `npm run deploy-contracts` | Deploy Soroban contracts |
| `npm run rotate-wallet-secrets:dry-run` | Simulate wallet secret rotation |
| `npm run rotate-wallet-secrets:confirm` | Execute wallet secret rotation (destructive) |

### Frontend
| Script | Description |
|---|---|
| `npm run dev` | Start Vite dev server |
| `npm run build` | Build for production |
| `npm run lint` | Lint frontend code |
| `npm run lint:fix` | Lint and auto-fix frontend code |
| `npm run format` | Format with Prettier |
| `npm run format:check` | Check formatting without writing |
| `npm run test` | Run Vitest tests |
| `npm run test:watch` | Run Vitest in watch mode |

---

## Production database

Production Compose intentionally expects an external PostgreSQL service. See the **[Production PostgreSQL guide](docs/production-database.md)** for provisioning, TLS connection configuration, migrations, pooling, backups, recovery, monitoring, and tuning.

---

## Testing

```bash
# Run all tests (backend + frontend) from repo root
npm test

# Or run individually
cd backend  && npm test       # Node test runner + Supertest
cd frontend && npm test       # Vitest

# E2E tests
npm run test:e2e              # All E2E tests
npm run test:public           # Public E2E tests only

# Load tests (requires k6)
npm run load-test             # Run all k6 load tests

# Backend test environment variables are in scripts/test-env.sh
# Source it before running backend tests:
source scripts/test-env.sh && cd backend && npm test
```

---

## Key Concepts

**Campaign wallet**: Each campaign has a dedicated Stellar account with a 2-of-2 creator + platform multisig threshold — contributions go directly to it. The platform co-signer key is required for withdrawals. Whether the creator's signature is an independent check depends on who holds the creator key; see below.

#### Custodial vs. non-custodial creators

The 2-of-2 multisig only gives two-party control when the two keys are held by two different parties.

- **Non-custodial (Freighter) creators** sign withdrawals in their own wallet. The backend holds only the platform key, so neither a compromised server nor a platform admin can move campaign funds alone.
- **Custodial creators** have their wallet secret stored encrypted on the backend, next to the platform key. For these campaigns the backend can produce *both* signatures, so the multisig does **not** protect against a backend compromise or a malicious admin.

To bound that exposure, every server-side path that signs as a custodial creator (creator withdrawal approval, platform milestone release, scheduled milestone auto-release, and contract-treasury withdrawal requests) refuses amounts above `CUSTODIAL_WITHDRAWAL_LIMIT` (default `1000` units of the campaign asset) with `403 NON_CUSTODIAL_SIGNATURE_REQUIRED`; an auto-release above the limit falls back to manual review. Larger withdrawals require a Freighter creator. Refunds to contributors are exempt, since they return funds to where they came from. The limit caps what the application will sign; it is not a cryptographic guarantee, since anyone with full access to the server's key material can still sign directly. Creators raising significant amounts should use Freighter.

**Escrow**: Milestone-gated releases run through the escrow and milestones contracts in `contracts/soroban/`, but only in **contract mode** — when `SOROBAN_ENABLED=true` and `ESCROW_CONTRACT_ID` / `MILESTONES_CONTRACT_ID` (or the WASM hashes) are configured. Without those, `sorobanService.js` falls back to the classic 2-of-2 multisig path above, and milestone approval is enforced by the backend rather than by a contract. Deployed testnet contract IDs are listed in [Deployed testnet contracts](#deployed-testnet-contracts); there is nothing to list for mainnet yet.

**Reward tiers**: `rewardTierService.js` tracks the non-financial perks a creator promises backers, plus fulfilment and delivery status. Reward tiers are perks, not returns on money given.

**Anchor deposits**: `anchorService.js` implements SEP-10 (web auth) + SEP-24 (interactive deposit) with MoneyGram. Users can deposit cash or USD and receive USDC in their CrowdPay wallet.

**Reconciliation**: `reconciliation.js` runs periodically to compare `raised_amount` in PostgreSQL against the live Stellar account balance. Discrepancies are logged and resolved.

**Campaign status cron**: `campaignStatusService.js` runs hourly (via `node-cron` in `backend/src/index.js`) to transition active campaigns to `funded` or `failed` when goals or deadlines are met. Set `ENABLE_CAMPAIGN_STATUS_CRON=false` to disable the in-process scheduler (e.g. when using an external cron that calls `POST /api/campaigns/cron/fail-expired` instead). On each transition, `campaignStatusActions.js` sends emails, fires webhooks, creates in-app notifications, logs the change in `campaign_status_events`, and queues contributor refunds for failed campaigns.

**Weekly digest cron**: `weeklyDigestService.js` runs Sunday evenings by default (`0 18 * * 0`) and sends grouped contributor digests for campaign updates, milestone releases, funded/failed transitions, and upcoming deadlines. Users can also **follow campaign categories** (`POST /api/users/me/category-follows`) to include up to 5 new campaigns per followed category (max 20) under a `New in <category>` heading; the `category_digest` notification preference opts out. See [Category follows & digest](docs/category-digests.md). Set `ENABLE_WEEKLY_DIGEST_CRON=false` to disable it, or override the schedule with `WEEKLY_DIGEST_CRON`.

**Background worker**: `WORKER_ENABLED=false` disables the worker process. Otherwise, startup fails when every processor is disabled. Recurring processors can be individually disabled with `ENABLE_RECURRING_CONTRIBUTIONS_WORKER=false` and `ENABLE_SUBSCRIPTION_CLAIM_WORKER=false`; standalone processor toggles and scheduled-job flags retain their existing defaults.

**Per-campaign communication preferences**: `notification_preferences` mutes a category across *every* campaign at once. `campaign_communication_preferences` (#961) is the middle layer — a contributor can mute `updates`, `milestones`, `funding_updates`, `messages`, or `surveys` for one campaign and keep receiving everything on the others. Every channel defaults to on and an absent row means "no override", so nothing changes for existing accounts. The preference is applied at the point of contact (update dispatch, follower fan-out, survey invites) rather than at the point of configuration, and the update path **fails open**: a lookup error logs and notifies everybody rather than silently muting the campaign. See [docs/contributor-communication-preferences.md](docs/contributor-communication-preferences.md).

**Outcome surveys**: after a campaign finishes funding, its creator can ask the people who backed it what actually happened. A beneficiary is any contributor to *that* campaign (derived from the contribution ledger, not from follow rows or role), one response per backer is enforced by a `UNIQUE (survey_id, user_id)` constraint, and the lifecycle `draft → open → closed` is a closed state machine built from compare-and-set updates so concurrent open/close/respond calls resolve to a deterministic `409` rather than double-notifying. Individual answers are never exposed: the public read returns the aggregate count and your own response, and the results endpoint selects answer bags without `user_id`. See [docs/outcome-surveys.md](docs/outcome-surveys.md).

---

## Deployed testnet contracts

Both contracts are live on Stellar testnet. Machine-readable records (contract ID, deploy transaction, WASM file and its SHA-256) are in [`contracts/soroban/deployments/testnet.json`](contracts/soroban/deployments/testnet.json), written by `backend/src/scripts/deployContracts.js`.

| Contract | Testnet ID | Deploy transaction |
|---|---|---|
| `escrow` | [`CDEIPEYJKCGRJAHOAUAWAOBFZSRNJBPUI2HQ2PVHVX6KJLWH735XTHDN`](https://stellar.expert/explorer/testnet/contract/CDEIPEYJKCGRJAHOAUAWAOBFZSRNJBPUI2HQ2PVHVX6KJLWH735XTHDN) | [`bf3cb7bc…782173`](https://stellar.expert/explorer/testnet/tx/bf3cb7bcc9a5a3f230a586352d13b0aeba83764a80ebf8c6d16108fa08782173) |
| `milestones` | [`CCHMTYXHG33WL2HB5NVZC334EH3VLNYPC4KTWDPAQOPXABQ3SYFBV67H`](https://stellar.expert/explorer/testnet/contract/CCHMTYXHG33WL2HB5NVZC334EH3VLNYPC4KTWDPAQOPXABQ3SYFBV67H) | [`3f674ebc…82c24`](https://stellar.expert/explorer/testnet/tx/3f674ebc79cc999fbaef9e392d0960fe05cdc603576f39c47444573c3a782c24) |

The token used for the walkthrough is a Stellar asset SAC, `TEST` issued by `GD7GCW35LXOM7ZPMQJ2Q6CFDQCJGGVOXNIPFDSIBLH6XHKLC3UBRTPRX`, contract [`CCJNPC6JE6IPKIQJU3ZUZPEK37KKPI7IHECSN4EO454QFQ7PW6NPOXSD`](https://stellar.expert/explorer/testnet/contract/CCJNPC6JE6IPKIQJU3ZUZPEK37KKPI7IHECSN4EO454QFQ7PW6NPOXSD). Testnet assets have no real-world value.

### One campaign end to end

Funds are 1 TEST = `10000000` stroops. The campaign targeted 50 TEST and raised 2 TEST, so it failed at its deadline and refunds opened.

| Step | Transaction |
|---|---|
| escrow `initialize` (admin = milestones contract, target 50 TEST, 1% platform fee) | [`0a8ffc6a…5d523f`](https://stellar.expert/explorer/testnet/tx/0a8ffc6a5836d505c17037517966efba560203c7fe1d05a0dd75e8083d5d523f) |
| milestones `initialize` (milestone 0 releases 40%) | [`515f9d6e…312fa6`](https://stellar.expert/explorer/testnet/tx/515f9d6e5bb6011c44caabeb0b28421291ca9c6c885a4950d6f5a7a8b9312fa6) |
| `contribute` — backer A, 1 TEST | [`aa8571dc…195177`](https://stellar.expert/explorer/testnet/tx/aa8571dc55482b0ee45955b4d5a4f83a5c67044c6e6caed128e32c7fe6195177) |
| creator `submit_milestone` evidence hash | [`66c5e397…9b9aa8`](https://stellar.expert/explorer/testnet/tx/66c5e397088269405e65d89f7556a1daba34b8690e2297dd57c67967519b9aa8) |
| platform `approve_milestone` — released 4 TEST (3.9 TEST to the creator, 0.1 TEST platform fee) | [`10e04dce…a4b0b8`](https://stellar.expert/explorer/testnet/tx/10e04dcee171ef63b5154e211bb8b74dfdcbe3e2ad7219274f5c48756fa4b0b8) |
| `contribute` — backer B, 1 TEST | [`ce054bde…692424`](https://stellar.expert/explorer/testnet/tx/ce054bde40bc1f02df366bd2bbcd8337befe87bcde928ecd26c9bbbd23692424) |
| `refund` — backer B, 1 TEST, after the deadline | [`b7263161…f11faa`](https://stellar.expert/explorer/testnet/tx/b7263161a6b375e7c75b6dbec3f7a9ce4cfee77bffad164c62ec14caf1f11faa) |

### Reading this section before turning on contract mode

- `ESCROW_CONTRACT_ID` + `MILESTONES_CONTRACT_ID` put the backend in **env mode**, which re-uses the one pair of instances above for every published campaign. `escrow::initialize` panics with `Contract is already initialized` on the second campaign, so env mode demonstrates a single campaign, not several. Per-campaign custody is what **deploy mode** (`SOROBAN_ENABLED=true` with `ESCROW_WASM_HASH` and `MILESTONES_WASM_HASH`) is meant for: it creates a fresh escrow instance per campaign from WASM already installed on the network, the two hashes recorded in the deployment file. Deploy mode was not exercised by the walkthrough above, which drove the contracts directly with `stellar contract invoke`.
- The escrow records each contributor's full deposit and refunds it unchanged, so after a partial milestone release the contract holds less than the sum of recorded balances and later contributors cannot be refunded. The walkthrough above stops at the first refund for exactly this reason. This is a contract accounting gap, not a configuration problem, and needs its own fix.

---

## Feature Flags

Feature flags use pluggable adapters. In addition to the default `env` adapter, [Unleash](https://www.getunleash.io) and [LaunchDarkly](https://launchdarkly.com) are supported. Set `FEATURE_FLAG_PROVIDER` to one of `env` (default), `unleash`, or `launchdarkly` and configure the corresponding environment variables listed above. If the external service is unavailable, the system automatically falls back to the `env` adapter.

---

## Part of Savitura

CrowdPay operates as a fully self-contained crowdfunding platform with native Stellar/Soroban payments, escrow, and anchor integrations.

Within the broader Savitura ecosystem:
- **[Fluxa](https://github.com/Savitura/Fluxa)** — a separate, standalone payment infrastructure product under development, planned as a modular integration in future iterations (see [Architecture Decision](docs/architecture-decision-fluxa.md))
- **[SaviTools](https://github.com/Savitura/SaviTools)** — developer tools for Stellar builders

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
 
## Feature Flags

CrowdPay supports runtime feature flags stored in PostgreSQL. This lets the team ship behind flags, gather feedback, and kill a bad feature instantly without a deploy.

### Database schema

Migration: `backend/db/migrations/20260906_feature_flags.sql`

`backend/db/schema.sql` declares the same canonical table (`key` PK +
`default_enabled`) so the two bootstrap paths agree. Local dev uses
`npm run migrate:fresh` (`psql -f db/schema.sql` followed by `migrate up
--bootstrap-schema`), which skips early migrations whose objects schema.sql
already provides instead of failing on duplicate tables. A CI job
(`backend/db/verify-schema-convergence.js`) guards against drift between the two
paths (#800).

| Column            | Type        | Description                          |
|-------------------|-------------|--------------------------------------|
| `key`             | TEXT (PK)   | Flag identifier (kebab-case)         |
| `enabled`         | BOOLEAN     | Current runtime state                |
| `default_enabled` | BOOLEAN     | Fallback when row is absent          |
| `description`     | TEXT        | Human-readable purpose               |
| `updated_at`      | TIMESTAMPTZ | Last modification time               |

### API

- `GET /api/feature-flags` — list all flags (public, no admin required)
- `GET /api/feature-flags/enabled` — list only enabled flag keys (public)
- `GET /api/admin/feature-flags` — list all flags with details (admin only)
- `PUT /api/admin/feature-flags/:key` — toggle a flag (admin only)

### Frontend usage

Wrap your app with `FeatureFlagsProvider` (already added in `App.jsx`).

```jsx
import { useFeatureFlags } from './context/FeatureFlagsContext';

function MyComponent() {
  const { isEnabled } = useFeatureFlags();
  if (isEnabled('new-dashboard')) {
    return <NewDashboard />;
  }
  return <OldDashboard />;
}
```

Flags are fetched once on app load and cached. Call `refreshFlags()` to force a refresh.

### Defaults

Unknown flags resolve to `false` unless `default_enabled` is explicitly `true`.
Streamlined payment reconciliation pipelines to reduce ledger processing delays.
​Updated webhook dispatch parameters for external payment processing partners.
​Expanded code comments within core billing routines to assist team onboarding.
​Corrected outdated configuration keys in environment setup templates.
​Clarified unit testing procedures for validating mock gateway transaction flows.
​Standardized error status codes and recovery payloads across payment APIs.
​Reinforced token security handling and permission checks across administrative endpoints.
Refactored payment settlement modules to minimize API latency during peak traffic.
​Updated payment gateway service configurations for enhanced transaction handling.
​Expanded inline comments across core ledger services for improved onboarding.
​Corrected deprecated environmental options in deployment configuration files.
​Clarified testing execution steps for verifying end-to-end payment workflows.
​Standardized status response formats across transaction routing endpoints.
Provides automated staking reward calculations for users locking tokens in campaign pools.
​Features decentralized dispute mechanisms backed by community oracle nodes.
​Supports zero-fee native token transfers for internal platform ecosystem interactions.
​Utilizes encrypted peer-to-peer data channels for confidential campaign communication.
​Includes integrated threshold signatures to enhance smart contract wallet security
