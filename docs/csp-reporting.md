# Content Security Policy reporting

CrowdPay ships two policies for the frontend:

| Header | Purpose |
| --- | --- |
| `Content-Security-Policy` | Enforced policy. Blocks disallowed resources and preserves required wallet/anchor/stellar origins. |
| `Content-Security-Policy-Report-Only` | Stricter rollout policy. It does not block anything; violations are sent to the report collector so unsafe exceptions can be removed safely. |
| `Reporting-Endpoints` | Declares the `csp-endpoint` used by `report-to`. |

The committed headers in `frontend/nginx.conf` and `frontend/vercel.json` are generated from
`backend/src/config/csp.js`:

```bash
npm run csp:generate   # regenerate both deployment headers
npm run csp:check      # fail if committed headers are stale
```

## Configuration

Set these environment variables before running `npm run csp:generate`:

| Variable | Default behaviour |
| --- | --- |
| `CSP_REPORT_URI` | `/api/csp-report` |
| `CSP_STELLAR_ORIGINS` | Testnet + mainnet Horizon and Soroban endpoints |
| `CSP_WALLET_ORIGINS` | `https://www.freighter.app`, `https://api.freighter.app` |
| `CSP_ANCHOR_ORIGINS` | MoneyGram sandbox/preview/production and the Stellar test anchor |
| `CSP_OBSERVABILITY_ORIGINS` | Sentry ingest and Firebase messaging endpoints |
| `CSP_IMAGE_ORIGINS` | CrowdPay CDN, Unsplash, IPFS (used by the report-only policy) |

Origin variables accept a comma-separated list. When set, the value replaces the built-in
defaults for that category.

## Report collector

Browsers post reports to `POST /api/csp-report` (no authentication or CSRF cookie is
required). The endpoint:

- is rate-limited to **30 requests per minute per IP**;
- accepts both the legacy `application/csp-report` format and the Reporting API
  `application/reports+json` batch format;
- strips query strings, fragments, credentials, and opaque `data:`/`blob:` payloads from
  document, blocked, and source URLs;
- never stores request bodies, cookies, headers, or `script-sample` values;
- acknowledges every report with `204 No Content`, even if persistence fails, so the
  browser is never blocked by reporting.

Sanitized reports are written to the append-only `csp_reports` table and emitted as
structured `csp_violation` log lines.

## Removing the remaining style exception

The enforced policy still allows `style-src 'unsafe-inline'` because the React app uses
inline `style` props. The report-only policy already omits it. To remove it from
enforcement:

1. Deploy with the report-only header enabled and monitor `/api/csp-report` for
   `style-src` violations.
2. Replace inline `style={{...}}` usage with CSS classes/modules. Start with the
   components that generate the most reports.
3. Once `style-src` reports are near zero across supported browsers, remove
   `'unsafe-inline'` from the enforced `style-src` in `backend/src/config/csp.js`, run
   `npm run csp:generate`, and deploy.
4. Tighten `img-src` the same way using the report-only image allowlist, then promote the
   stricter directives into the enforced policy.

The report-only policy also omits `upgrade-insecure-requests`; that directive remains in
the enforced policy for production HTTPS upgrades.

## Smoke checks

```bash
npm run csp:check                 # headers match the policy source
npm test --prefix backend        # policy + collector tests
npm run build --prefix frontend  # static build still succeeds
```
