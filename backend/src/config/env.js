const { validateWalletSecretConfig } = require('../services/walletSecrets');
const { validateWalletEncryptionKey } = require('../services/walletService');
const { validateGeoipConfig } = require('../services/geoipService');

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'API_KEY_PEPPER',
  'PLATFORM_SECRET_KEY',
  'ARBITRATOR_SECRET_KEY',
  'STELLAR_NETWORK',
  'STELLAR_HORIZON_URL',
  'WALLET_ENCRYPTION_KEY',
  'OPS_API_KEY',
  'UNSUBSCRIBE_SECRET',
  'IMPACT_SIGNING_SECRET',
];
const STORAGE_VARS = ['STORAGE_BUCKET', 'STORAGE_ENDPOINT'];

function getMissingConfig() {
  const missing = REQUIRED.filter(key => !process.env[key]);
  const storageConfigured = STORAGE_VARS.some(key => !!process.env[key]);
  if (storageConfigured) {
    missing.push(...STORAGE_VARS.filter(key => !process.env[key]));
  }
  if (
    process.env.NODE_ENV === 'production' &&
    String(process.env.DISABLE_EMAILS || '').toLowerCase() !== 'true' &&
    !process.env.SMTP_HOST &&
    !process.env.EMAIL_SERVICE_API_KEY
  ) {
    missing.push('SMTP_HOST|EMAIL_SERVICE_API_KEY');
  }
  return [...new Set(missing)];
}

function validateEnv() {
  const missing = REQUIRED.filter(key => !process.env[key]);
  const errors = [];
  const warnings = [];

  if (missing.length) {
    const list = missing.map(k => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: missing required environment variables:\n${list}\n\nSet them in your .env file.\n\n`
    );
    process.exit(1);
  }

  if (process.env.API_KEY_PEPPER === process.env.JWT_SECRET) {
    process.stderr.write(
      '\n[crowdpay] Cannot start: API_KEY_PEPPER must differ from JWT_SECRET — secrets must not be reused across concerns.\n\n'
    );
    process.exit(1);
  }

  if (process.env.JWT_SECRET.length < 32) {
    warnings.push('JWT_SECRET should be at least 32 characters');
  }

  const network = process.env.STELLAR_NETWORK;
  if (network !== 'testnet' && network !== 'mainnet') {
    errors.push(
      `STELLAR_NETWORK must be one of: testnet, mainnet (received: ${JSON.stringify(network)})`
    );
  }

  const platformKey = process.env.PLATFORM_SECRET_KEY;
  if (!/^S[A-Z2-7]{55}$/.test(platformKey)) {
    errors.push(
      'PLATFORM_SECRET_KEY must be a valid Stellar secret seed (56 characters, starting with S)'
    );
  }

  const arbitratorKey = process.env.ARBITRATOR_SECRET_KEY;
  if (!/^S[A-Z2-7]{55}$/.test(arbitratorKey)) {
    errors.push(
      'ARBITRATOR_SECRET_KEY must be a valid Stellar secret seed (56 characters, starting with S)'
    );
  }

  const portRaw = process.env.PORT;
  if (portRaw && portRaw.length > 0) {
    const portNum = Number(portRaw);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      errors.push(
        `PORT must be an integer between 1 and 65535 (received: ${JSON.stringify(portRaw)})`
      );
    }
  }

  if (process.env.NODE_ENV === 'production') {
    const emailsDisabled = String(process.env.DISABLE_EMAILS || '').toLowerCase() === 'true';
    if (emailsDisabled) {
      warnings.push(
        'DISABLE_EMAILS=true in production — no transactional email (receipts, password resets, KYC/withdrawal decisions) will be sent'
      );
    } else if (!process.env.SMTP_HOST && !process.env.EMAIL_SERVICE_API_KEY) {
      errors.push(
        'SMTP_HOST or EMAIL_SERVICE_API_KEY must be set in production (or set DISABLE_EMAILS=true to opt out explicitly)'
      );
    }
  }

  const storageConfigured = STORAGE_VARS.some(key => !!process.env[key]);
  const storageMissing = STORAGE_VARS.filter(key => !process.env[key]);
  if (storageConfigured && storageMissing.length) {
    const list = storageMissing.map(k => `  - ${k}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: incomplete storage configuration. Set all of:\n${STORAGE_VARS.join(', ')}\n\nMissing:\n${list}\n\n`
    );
    process.exit(1);
  }

  if (errors.length) {
    const list = errors.map(e => `  - ${e}`).join('\n');
    process.stderr.write(
      `\n[crowdpay] Cannot start: invalid environment configuration:\n${list}\n\n`
    );
    process.exit(1);
  }

  if (warnings.length) {
    const list = warnings.map(w => `  - ${w}`).join('\n');
    process.stderr.write(`\n[crowdpay] Environment warnings:\n${list}\n\n`);
  }

  try {
    validateWalletSecretConfig();
  } catch (err) {
    process.stderr.write(`\n[crowdpay] Cannot start: ${err.message}\n\n`);
    process.exit(1);
  }

  try {
    validateWalletEncryptionKey();
  } catch (err) {
    process.stderr.write(`\n[crowdpay] Cannot start: ${err.message}\n\n`);
    process.exit(1);
  }

  try {
    validateGeoipConfig();
  } catch (err) {
    process.stderr.write(`\n[crowdpay] Cannot start: ${err.message}\n\n`);
    process.exit(1);
  }

  // Warn about important optional variables
  if (!process.env.PLATFORM_APPROVER_USER_ID) {
    process.stderr.write(
      '[crowdpay] Warning: PLATFORM_APPROVER_USER_ID not set — withdrawal approvals are open to all users (dev mode)\n'
    );
  }
  if (!process.env.JWT_EXPIRES_IN) {
    process.stderr.write(
      '[crowdpay] Warning: JWT_EXPIRES_IN not set — access tokens will use the default expiry (15m)\n'
    );
  }
}

module.exports = { validateEnv, getMissingConfig, REQUIRED };
