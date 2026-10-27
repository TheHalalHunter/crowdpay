const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp({ queryImpl, totpServiceImpl, bcryptImpl, userOverrides = {} } = {}) {
  const bcryptStub = {
    hash: async () => 'hashed',
    compare: async () => false,
    ...bcryptImpl,
  };

  const defaultTotp = {
    generateFingerprint: () => 'fp-abc123',
    verifyTotp: () => true,
    generateSecret: () => 'JBSWY3DPEHPK3PXP',
    buildOtpauthUri: () => 'otpauth://totp/test',
    generateQrCode: () => 'data:image/png;base64,abc',
    generateBackupCodes: async () => ({
      raw: ['code1', 'code2'],
      hashed: ['hashed1', 'hashed2'],
    }),
    consumeBackupCode: async () => ({ consumed: true }),
    storeBackupCodes: async () => {},
    logAuditEvent: async () => {},
    isDeviceTrusted: async () => false,
    trustDevice: async () => {},
    revokeDevice: async () => true,
    revokeAllDevices: async () => {},
    getUserDevices: async () => [],
    enforce2faCheck: async () => ({ enforced: false }),
    ...totpServiceImpl,
  };

  const router = proxyquire('./auth', {
    '@stellar/stellar-sdk': {
      Keypair: {
        random: () => ({
          publicKey: () => 'GUSER',
          secret: () => 'SA3D5',
        }),
      },
    },
    '../config/database': { query: queryImpl },
    '../services/stellarService': {
      ensureCustodialAccountFundedAndTrusted: async () => {},
    },
    '../services/walletSecrets': {
      encryptWalletSecret: async secret => `cpws:v1:${secret.slice(0, 8)}`,
    },
    '../services/walletService': {
      encryptSecret: s => `enc:${s}`,
      decryptSecret: s => s.replace(/^enc:/, ''),
    },
    '../services/emailService': {
      sendEmail: () => {},
      sendWelcomeEmail: async () => {},
    },
    '../middleware/auth': {
      requireAuth: (req, _res, next) => {
        req.user = { userId: userOverrides.userId || 1, role: userOverrides.role || 'creator' };
        next();
      },
    },
    '../services/totpService': defaultTotp,
    jsonwebtoken: {
      sign: () => 'jwt-token',
    },
    bcryptjs: bcryptStub,
  });

  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return { app };
}

const creatorUser = {
  id: 1,
  email: 'creator@example.com',
  name: 'Creator',
  role: 'creator',
  wallet_public_key: 'GUSER',
  totp_enabled: false,
  totp_secret: null,
};

const totpEnabledUser = {
  ...creatorUser,
  totp_enabled: true,
  totp_secret: 'enc:JBSWY3DPEHPK3PXP',
};

test('POST /2fa/setup generates secret and QR code', async () => {
  let updatedSecret = false;
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [creatorUser] };
      }
      if (text.includes('UPDATE users SET totp_secret')) {
        updatedSecret = true;
      }
      return { rows: [] };
    },
  });

  const res = await request(app).post('/api/auth/2fa/setup');
  assert.equal(res.status, 200);
  assert.ok(res.body.secret);
  assert.ok(res.body.qrCodeDataUrl);
  assert.equal(updatedSecret, true);
});

test('POST /2fa/setup rejects contributor role', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ ...creatorUser, role: 'contributor' }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/setup');
  assert.equal(res.status, 403);
  assert.match(res.body.error, /creator and admin/);
});

test('POST /2fa/setup rejects already-enabled account', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ ...creatorUser, totp_enabled: true }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/setup');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /already enabled/);
});

test('POST /2fa/verify activates 2FA and returns backup codes', async () => {
  let updated = false;
  let storedCodes = false;
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [{ ...creatorUser, totp_secret: 'enc:JBSWY3DPEHPK3PXP' }] };
      }
      if (text.includes('UPDATE users SET totp_enabled')) {
        updated = true;
      }
      return { rows: [] };
    },
    totpServiceImpl: {
      storeBackupCodes: async () => {
        storedCodes = true;
      },
    },
  });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '123456' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, '2FA enabled successfully');
  assert.ok(Array.isArray(res.body.backupCodes));
  assert.equal(updated, true);
  assert.equal(storedCodes, true);
});

test('POST /2fa/verify rejects invalid code', async () => {
  const { app } = buildApp({
    totpServiceImpl: { verifyTotp: () => false },
    queryImpl: async () => ({
      rows: [{ ...creatorUser, totp_secret: 'enc:JBSWY3DPEHPK3PXP' }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '000000' });

  assert.equal(res.status, 401);
  assert.match(res.body.error, /Invalid 2FA code/);
});

test('POST /2fa/verify rejects missing secret', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ ...creatorUser, totp_secret: null }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '123456' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not initiated/);
});

test('POST /2fa/disable clears TOTP and revokes devices', async () => {
  let cleared = false;
  let revoked = false;
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [totpEnabledUser] };
      }
      if (text.includes('UPDATE users SET totp_enabled = false')) {
        cleared = true;
      }
      return { rows: [] };
    },
    totpServiceImpl: {
      revokeAllDevices: async () => {
        revoked = true;
      },
    },
  });

  const res = await request(app).post('/api/auth/2fa/disable').send({ code: '123456' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, '2FA disabled successfully');
  assert.equal(cleared, true);
  assert.equal(revoked, true);
});

test('POST /2fa/disable rejects when 2FA not enabled', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ ...creatorUser, totp_enabled: false }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/disable').send({ code: '123456' });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /not enabled/);
});

test('POST /2fa/disable rejects invalid code', async () => {
  const { app } = buildApp({
    totpServiceImpl: { verifyTotp: () => false },
    queryImpl: async () => ({
      rows: [{ ...totpEnabledUser }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/disable').send({ code: '000000' });

  assert.equal(res.status, 401);
  assert.match(res.body.error, /Invalid 2FA code/);
});

test('GET /2fa/backup-codes regenerates and returns codes', async () => {
  let updated = false;
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [totpEnabledUser] };
      }
      return { rows: [] };
    },
    totpServiceImpl: {
      storeBackupCodes: async () => {
        updated = true;
      },
    },
  });

  const res = await request(app).get('/api/auth/2fa/backup-codes');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.backupCodes));
  assert.equal(updated, true);
});

test('GET /2fa/backup-codes rejects when 2FA not enabled', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [{ ...creatorUser, totp_enabled: false }],
    }),
  });

  const res = await request(app).get('/api/auth/2fa/backup-codes');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not enabled/);
});

test('POST /2fa/trust-device trusts device after code verification', async () => {
  let trusted = false;
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [totpEnabledUser],
    }),
    totpServiceImpl: {
      trustDevice: async () => {
        trusted = true;
      },
    },
  });

  const res = await request(app).post('/api/auth/2fa/trust-device').send({ code: '123456' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Device trusted successfully');
  assert.equal(trusted, true);
});

test('POST /2fa/trust-device rejects invalid code', async () => {
  const { app } = buildApp({
    totpServiceImpl: { verifyTotp: () => false },
    queryImpl: async () => ({
      rows: [{ ...totpEnabledUser }],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/trust-device').send({ code: '000000' });

  assert.equal(res.status, 401);
});

test('GET /2fa/devices returns device list', async () => {
  const devices = [{ id: 1, device_name: 'Test', trusted_at: '2026-01-01T00:00:00.000Z' }];
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [totpEnabledUser],
    }),
    totpServiceImpl: {
      getUserDevices: async () => devices,
    },
  });

  const res = await request(app).get('/api/auth/2fa/devices');
  assert.equal(res.status, 200);
  assert.equal(res.body.devices.length, 1);
  assert.equal(res.body.devices[0].id, 1);
  assert.equal(res.body.devices[0].device_name, 'Test');
});

test('DELETE /2fa/devices/:id removes device', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [totpEnabledUser],
    }),
  });

  const res = await request(app).delete('/api/auth/2fa/devices/42');
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Device removed');
});

test('DELETE /2fa/devices/:id returns 404 for unknown device', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [totpEnabledUser],
    }),
    totpServiceImpl: {
      revokeDevice: async () => false,
    },
  });

  const res = await request(app).delete('/api/auth/2fa/devices/999');
  assert.equal(res.status, 404);
});

test('GET /2fa/audit-log returns events', async () => {
  const events = [{ id: 1, event_type: 'totp_enabled' }];
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [totpEnabledUser] };
      }
      if (text.includes('FROM security_audit_log')) {
        return { rows: events };
      }
      return { rows: [] };
    },
  });

  const res = await request(app).get('/api/auth/2fa/audit-log');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.events, events);
});

test('POST /2fa/challenge uses clock skew via totpService.verifyTotp', async () => {
  let verifyCalledWith = null;
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return {
          rows: [
            {
              ...totpEnabledUser,
              totp_failed_attempts: 0,
              totp_locked_until: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    bcryptImpl: {
      compare: async () => true,
    },
    totpServiceImpl: {
      verifyTotp: (secret, token) => {
        verifyCalledWith = { secret, token };
        return true;
      },
      isDeviceTrusted: async () => false,
    },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'creator@example.com', password: 'pass', code: '123456' });

  assert.equal(res.status, 200);
  assert.deepEqual(verifyCalledWith, { secret: 'JBSWY3DPEHPK3PXP', token: '123456' });
});

test('POST /2fa/challenge skips 2FA for trusted device', async () => {
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return {
          rows: [
            {
              ...totpEnabledUser,
              totp_failed_attempts: 0,
              totp_locked_until: null,
            },
          ],
        };
      }
      return { rows: [] };
    },
    bcryptImpl: {
      compare: async () => true,
    },
    totpServiceImpl: {
      isDeviceTrusted: async () => true,
    },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'creator@example.com', password: 'pass', code: '123456' });

  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.device_trusted, true);
});

test('POST /2fa/setup logs audit event', async () => {
  let auditLogged = false;
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [creatorUser] };
      }
      return { rows: [] };
    },
    totpServiceImpl: {
      logAuditEvent: async (userId, eventType) => {
        if (eventType === 'totp_setup_initiated') auditLogged = true;
      },
    },
  });

  await request(app).post('/api/auth/2fa/setup');
  assert.equal(auditLogged, true);
});

test('POST /2fa/verify generates 10 backup codes', async () => {
  const { app } = buildApp({
    queryImpl: async text => {
      if (text.includes('SELECT * FROM users')) {
        return { rows: [{ ...creatorUser, totp_secret: 'enc:JBSWY3DPEHPK3PXP' }] };
      }
      return { rows: [] };
    },
    totpServiceImpl: {
      generateBackupCodes: async () => {
        return {
          raw: Array.from({ length: 10 }, (_, i) => `code${i}`),
          hashed: Array.from({ length: 10 }, (_, i) => `hashed${i}`),
        };
      },
    },
  });

  const res = await request(app).post('/api/auth/2fa/verify').send({ code: '123456' });

  assert.equal(res.status, 200);
  assert.equal(res.body.backupCodes.length, 10);
});

test('POST /2fa/disable requires code parameter', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [totpEnabledUser],
    }),
  });

  const res = await request(app).post('/api/auth/2fa/disable');
  assert.equal(res.status, 400);
  assert.match(res.body.error, /required/);
});

test('POST /2fa/challenge rejects locked account', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [
        {
          ...totpEnabledUser,
          totp_locked_until: new Date(Date.now() + 60000),
        },
      ],
    }),
    bcryptImpl: {
      compare: async () => true,
    },
  });

  const res = await request(app)
    .post('/api/auth/2fa/challenge')
    .send({ email: 'creator@example.com', password: 'pass', code: '123456' });

  assert.equal(res.status, 423);
  assert.match(res.body.error, /Too many/);
});

test('Login returns requires_2fa for untrusted device with 2FA enabled', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [
        {
          ...totpEnabledUser,
          password_hash: 'hashed',
          kyc_status: 'verified',
        },
      ],
    }),
    bcryptImpl: {
      compare: async () => true,
    },
    totpServiceImpl: {
      isDeviceTrusted: async () => false,
    },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'creator@example.com', password: 'pass' });

  assert.equal(res.status, 200);
  assert.equal(res.body.requires_2fa, true);
});

test('Login enforces 2FA policy for accounts that must enable it', async () => {
  const { app } = buildApp({
    queryImpl: async () => ({
      rows: [
        {
          ...creatorUser,
          enforce_2fa: true,
          totp_enabled: false,
          kyc_status: 'verified',
        },
      ],
    }),
    bcryptImpl: {
      compare: async () => true,
    },
    totpServiceImpl: {
      enforce2faCheck: async user => {
        if (user.enforce_2fa && !user.totp_enabled) {
          return { enforced: true, message: '2FA required' };
        }
        return { enforced: false };
      },
    },
  });

  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: 'creator@example.com', password: 'pass' });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /2FA required/);
});
