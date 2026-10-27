'use strict';

/**
 * Content Security Policy builder shared by the header generator and tests.
 *
 * Wallet and anchor origins are explicit allowlists. Deployments can extend
 * them (or point reports at a different collector) with the CSP_* environment
 * variables documented in docs/csp-reporting.md.
 */

const DEFAULT_REPORT_URI = '/api/csp-report';

const DEFAULT_ORIGINS = {
  stellar: [
    'https://horizon-testnet.stellar.org',
    'https://horizon.stellar.org',
    'https://soroban-testnet.stellar.org',
    'https://soroban.stellar.org',
  ],
  wallet: ['https://www.freighter.app', 'https://api.freighter.app'],
  anchor: [
    'https://extstellar.moneygram.com',
    'https://previewstellar.moneygram.com',
    'https://stellar.moneygram.com',
    'https://testanchor.stellar.org',
  ],
  observability: [
    'https://*.ingest.sentry.io',
    'https://firebaseinstallations.googleapis.com',
    'https://fcmregistrations.googleapis.com',
    'https://*.googleapis.com',
  ],
  images: ['https://cdn.crowdpay.com', 'https://images.unsplash.com', 'https://ipfs.io'],
};

const ENV_KEYS = {
  stellar: 'CSP_STELLAR_ORIGINS',
  wallet: 'CSP_WALLET_ORIGINS',
  anchor: 'CSP_ANCHOR_ORIGINS',
  observability: 'CSP_OBSERVABILITY_ORIGINS',
  images: 'CSP_IMAGE_ORIGINS',
};

function parseOrigins(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values)];
}

function getCspConfig(env = process.env) {
  const origins = {};
  for (const [key, envKey] of Object.entries(ENV_KEYS)) {
    const overrides = parseOrigins(env[envKey]);
    origins[key] = unique([...(overrides.length ? overrides : DEFAULT_ORIGINS[key])]);
  }

  const reportUri = String(env.CSP_REPORT_URI || DEFAULT_REPORT_URI).trim() || DEFAULT_REPORT_URI;
  return {
    reportUri,
    reportTo: 'csp-endpoint',
    origins,
    connectSrc: unique([
      "'self'",
      ...origins.stellar,
      ...origins.wallet,
      ...origins.anchor,
      ...origins.observability,
    ]),
  };
}

function buildDirectives(config, { reportOnly = false } = {}) {
  const directives = [
    ['default-src', ["'self'"]],
    ['base-uri', ["'self'"]],
    ['script-src', ["'self'"]],
    ['script-src-attr', ["'none'"]],
    reportOnly ? ['style-src', ["'self'"]] : ['style-src', ["'self'", "'unsafe-inline'"]],
    reportOnly
      ? ['img-src', ["'self'", 'data:', ...config.origins.images]]
      : ['img-src', ["'self'", 'data:', 'https:']],
    ['font-src', ["'self'", 'https://fonts.gstatic.com']],
    ['connect-src', config.connectSrc],
    ['worker-src', ["'self'", 'blob:']],
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['media-src', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['report-uri', [config.reportUri]],
    ['report-to', [config.reportTo]],
  ];

  if (!reportOnly) directives.push(['upgrade-insecure-requests', []]);

  return directives.map(([name, values]) => [name, ...values].join(' '));
}

function buildCspPolicy(config, options = {}) {
  return `${buildDirectives(config, options).join('; ')};`;
}

function buildCspHeaders(env = process.env) {
  const config = getCspConfig(env);
  return {
    'Content-Security-Policy': buildCspPolicy(config, { reportOnly: false }),
    'Content-Security-Policy-Report-Only': buildCspPolicy(config, { reportOnly: true }),
    'Reporting-Endpoints': `${config.reportTo}="${config.reportUri}"`,
  };
}

module.exports = {
  DEFAULT_ORIGINS,
  DEFAULT_REPORT_URI,
  getCspConfig,
  buildDirectives,
  buildCspPolicy,
  buildCspHeaders,
};
