const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildCspHeaders, buildCspPolicy, getCspConfig } = require('./csp');

const REPO_ROOT = path.resolve(__dirname, '../../..');

test('enforced CSP has no unsafe script directives and allowlists wallets and anchors', () => {
  const headers = buildCspHeaders({});
  const enforced = headers['Content-Security-Policy'];

  assert.ok(enforced.includes("script-src 'self'"));
  assert.ok(!enforced.includes("script-src 'self' 'unsafe-inline'"));
  assert.ok(!enforced.includes("'unsafe-eval'"));
  assert.ok(enforced.includes('https://www.freighter.app'));
  assert.ok(enforced.includes('https://api.freighter.app'));
  assert.ok(enforced.includes('https://extstellar.moneygram.com'));
  assert.ok(enforced.includes('https://stellar.moneygram.com'));
  assert.ok(enforced.includes('https://horizon-testnet.stellar.org'));
  assert.ok(enforced.includes("object-src 'none'"));
  assert.ok(enforced.includes("frame-ancestors 'none'"));
  assert.ok(enforced.includes('report-uri /api/csp-report'));
});

test('report-only CSP is stricter and uses the reporting endpoints', () => {
  const headers = buildCspHeaders({});
  const reportOnly = headers['Content-Security-Policy-Report-Only'];

  assert.ok(reportOnly.includes("style-src 'self';"));
  assert.ok(!reportOnly.includes("style-src 'self' 'unsafe-inline'"));
  assert.ok(reportOnly.includes('report-to csp-endpoint'));
  assert.equal(headers['Reporting-Endpoints'], 'csp-endpoint="/api/csp-report"');
  assert.ok(!reportOnly.includes('upgrade-insecure-requests'));
});

test('CSP origins and report collector are configurable through environment variables', () => {
  const headers = buildCspHeaders({
    CSP_REPORT_URI: 'https://security.crowdpay.com/csp',
    CSP_WALLET_ORIGINS: 'https://wallet.example.com',
    CSP_ANCHOR_ORIGINS: 'https://anchor.example.com',
    CSP_STELLAR_ORIGINS: 'https://horizon.example.com',
    CSP_IMAGE_ORIGINS: 'https://images.example.com',
  });

  const enforced = headers['Content-Security-Policy'];
  const reportOnly = headers['Content-Security-Policy-Report-Only'];

  for (const policy of [enforced, reportOnly]) {
    assert.ok(policy.includes('https://wallet.example.com'));
    assert.ok(policy.includes('https://anchor.example.com'));
    assert.ok(policy.includes('https://horizon.example.com'));
    assert.ok(policy.includes('report-uri https://security.crowdpay.com/csp'));
  }
  assert.ok(!enforced.includes('https://images.example.com'));
  assert.ok(reportOnly.includes('https://images.example.com'));
});

test('configured report URI cannot break out of the policy directive', () => {
  const config = getCspConfig({ CSP_REPORT_URI: '/collect?token=hidden' });
  const policy = buildCspPolicy(config);
  assert.ok(policy.includes('report-uri /collect?token=hidden;'));
});

test('committed nginx and Vercel headers match the generated policy', () => {
  const headers = buildCspHeaders({});
  const nginx = fs.readFileSync(path.join(REPO_ROOT, 'frontend', 'nginx.conf'), 'utf8');
  const vercel = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'frontend', 'vercel.json'), 'utf8')
  );
  const vercelHeaders = Object.fromEntries(
    vercel.headers[0].headers.map(({ key, value }) => [key, value])
  );

  assert.ok(nginx.includes(`Content-Security-Policy "${headers['Content-Security-Policy']}"`));
  assert.ok(
    nginx.includes(
      `Content-Security-Policy-Report-Only "${headers['Content-Security-Policy-Report-Only']}"`
    )
  );
  assert.equal(vercelHeaders['Content-Security-Policy'], headers['Content-Security-Policy']);
  assert.equal(
    vercelHeaders['Content-Security-Policy-Report-Only'],
    headers['Content-Security-Policy-Report-Only']
  );
  assert.equal(vercelHeaders['Reporting-Endpoints'], headers['Reporting-Endpoints']);
});
