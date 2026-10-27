# Dependency Vulnerability Scanning SLA

## Overview
CrowdPay uses automated dependency vulnerability scanning via `npm audit` in CI. Findings are classified by severity and must be addressed according to the following thresholds and SLA.

## Severity Thresholds

| Severity | CI Behavior | Resolution SLA | Owner |
|----------|-------------|----------------|-------|
| **Critical** | Job fails immediately | 48 hours | Security Team |
| **High** | Job fails (--audit-level=high) | 7 days | Team Lead |
| **Medium** | Job warns, requires review | 14 days | Developer |
| **Low** | Job warns, documented | 30 days | Developer |

## Suppression Policy

Suppressions must be recorded in `vuln-suppressions.json` at the package root and must include:

1. **`expiry`** (ISO 8601 date) - Suppressions expire on this date. After expiry, the finding must be re-evaluated and either remediated or the suppression renewed.
2. **`justification`** - A non-empty text explanation for why the vulnerability is accepted risk.

### Example Suppression

```json
{
  "@stellar/stellar-sdk": {
    "expiry": "2027-01-15T00:00:00.000Z",
    "justification": "Known vulnerability in transitive dependency; mitigated by pinning to latest compatible patch; tracked in SEC-123"
  }
}
```

## Workflow

1. **CI Run**: `npm audit --omit=dev --audit-level=high` runs on every PR and push to `main`.
2. **Findings**: All vulnerabilities at or above the threshold are reported.
3. **Suppressions**: If `vuln-suppressions.json` exists, suppressed items are validated for expiry and justification.
4. **Fail/Pass**:
   - Critical/High findings without valid suppression → CI job fails.
   - Medium/Low findings without valid suppression → CI job warns but passes (review required).
   - All suppressions must have valid expiry and non-empty justification.

## Remediation Owners

| Package | Component | Remediation Owner | Target Timeline |
|---------|-----------|-------------------|-----------------|
| `@stellar/stellar-sdk` | Backend Stellar SDK | Backend Team Lead | 7 days |
| `@stellar/freighter-api` | Frontend Wallet API | Frontend Team Lead | 7 days |
| `bcryptjs` | Password hashing | Backend Team | 14 days |
| `dompurify` | HTML sanitization | Frontend Team | 14 days |
| `@aws-sdk/client-s3` | AWS S3 client | Platform Team | 30 days |

## Renewal Process

Suppressions may be renewed by updating `vuln-suppressions.json` with a new expiry date and updated justification. Renewals must be reviewed and approved by the relevant Team Lead before the expiry date.

## Audit

The `scripts/check-vuln-suppressions.js` script is run in CI to validate all suppressions. Suppressions failing validation (expired or missing justification) cause the CI job to fail.