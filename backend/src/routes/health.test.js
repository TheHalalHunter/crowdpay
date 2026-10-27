const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();
const request = require('supertest');

const mockSentry = {
  init: () => {},
  expressIntegration: () => ({}),
  expressErrorHandler: () => (err, req, res, next) => next(err),
  Handlers: {
    requestHandler: () => (req, res, next) => next(),
    tracingHandler: () => (req, res, next) => next(),
    errorHandler: () => (err, req, res, next) => next(err),
  },
  captureMessage: () => {},
};

function buildApp(mockDb, mockSentryOverride = mockSentry, emailConfigured = true, options = {}) {
  return proxyquire('./health', {
    '../services/emailService': { isEmailConfigured: () => emailConfigured },
    '../config/database': mockDb,
    '../config/redis': options.redis || { ping: async () => 'PONG' },
    '../config/env': { getMissingConfig: options.getMissingConfig || (() => []) },
    '../config/logger': { error: () => {} },
    '@sentry/node': mockSentryOverride,
  });
}

test('GET /health returns pool stats and ok status when database is reachable', async () => {
  const mockDb = {
    query: async text => {
      assert.equal(text, 'SELECT 1');
      return { rows: [] };
    },
    totalCount: 8,
    idleCount: 5,
    waitingCount: 1,
    poolMax: 10,
    getPoolMetrics: () => {
      const total = 8;
      const idle = 5;
      const waiting = 1;
      const max = 10;
      const utilisation = Math.round(((total - idle) / max) * 10000) / 100;
      return { total, idle, waiting, max, utilisation };
    },
  };

  const router = buildApp(mockDb);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    status: 'ok',
    db: {
      pool: { total: 8, idle: 5, waiting: 1, max: 10 },
      utilisation: 30,
    },
    email: 'ready',
  });
});

test('GET /health reports email: unconfigured when no transporter exists', async () => {
  const mockDb = {
    query: async () => ({ rows: [] }),
    getPoolMetrics: () => ({ total: 1, idle: 1, waiting: 0, max: 10, utilisation: 0 }),
  };
  const router = buildApp(mockDb, mockSentry, false);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(response.body.email, 'unconfigured');
});

test('GET /health returns 503 and error message when database query fails', async () => {
  const mockDb = {
    query: async () => {
      throw new Error('Connection refused');
    },
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    poolMax: 10,
    getPoolMetrics: () => ({ total: 0, idle: 0, waiting: 0, max: 10, utilisation: 0 }),
  };

  const router = buildApp(mockDb);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    error: {
      code: 'ERROR',
      message: 'Connection refused',
    },
  });
});

test('GET /health sends Sentry alert when pool utilisation exceeds 90%', async () => {
  const sentryMessages = [];
  const mockSentryCapture = {
    ...mockSentry,
    captureMessage: msg => {
      sentryMessages.push(msg);
    },
  };

  const mockDb = {
    query: async () => ({ rows: [] }),
    totalCount: 10,
    idleCount: 0,
    waitingCount: 8,
    poolMax: 10,
    getPoolMetrics: () => {
      const total = 10;
      const idle = 0;
      const waiting = 8;
      const max = 10;
      const utilisation = Math.round(((total - idle) / max) * 10000) / 100;
      return { total, idle, waiting, max, utilisation };
    },
  };

  const router = buildApp(mockDb, mockSentryCapture);
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health');

  assert.equal(response.status, 200);
  assert.equal(sentryMessages.length, 1);
  assert.match(sentryMessages[0], /Database pool utilisation exceeds 90%/i);
});

test('GET /health/live is fast and does not touch dependencies', async () => {
  const mockDb = {
    query: async () => {
      throw new Error('liveness must not query the database');
    },
  };
  const router = buildApp(mockDb, mockSentry, true, {
    redis: {
      ping: async () => {
        throw new Error('liveness must not ping Redis');
      },
    },
  });
  const express = require('express');
  const app = express();
  app.use('/health', router);

  const response = await request(app).get('/health/live');

  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ok');
  assert.equal(typeof response.body.uptime_seconds, 'number');
});

test('GET /health/ready reports every dependency by name when healthy', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200 });
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';

  try {
    const mockDb = { query: async () => ({ rows: [] }) };
    const router = buildApp(mockDb);
    const express = require('express');
    const app = express();
    app.use('/health', router);

    const response = await request(app).get('/health/ready');

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'ok');
    assert.deepEqual(Object.keys(response.body.checks).sort(), [
      'config',
      'database',
      'horizon',
      'redis',
    ]);
    assert.equal(response.body.failed.length, 0);
  } finally {
    global.fetch = originalFetch;
    delete process.env.STELLAR_HORIZON_URL;
  }
});

test('GET /health/ready names failing dependencies without leaking messages', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('connect ECONNREFUSED 10.0.0.1');
  };
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';

  try {
    const mockDb = {
      query: async () => {
        throw new Error('password authentication failed for user secret');
      },
    };
    const router = buildApp(mockDb, mockSentry, true, {
      redis: { ping: async () => Promise.reject(new Error('NOAUTH secret')) },
      getMissingConfig: () => ['JWT_SECRET'],
    });
    const express = require('express');
    const app = express();
    app.use('/health', router);

    const response = await request(app).get('/health/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.status, 'degraded');
    assert.deepEqual(response.body.failed.sort(), ['config', 'database', 'horizon', 'redis']);
    assert.equal(response.body.checks.database.error, 'unavailable');
    assert.equal(response.body.checks.redis.error, 'unavailable');
    assert.equal(response.body.checks.horizon.error, 'unavailable');
    assert.equal(JSON.stringify(response.body).includes('secret'), false);
    assert.deepEqual(response.body.checks.config.missing, ['JWT_SECRET']);
  } finally {
    global.fetch = originalFetch;
    delete process.env.STELLAR_HORIZON_URL;
  }
});

test('GET /health/ready times out a hanging dependency', async () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.HEALTH_CHECK_TIMEOUT_MS;
  global.fetch = () => new Promise(() => {});
  process.env.STELLAR_HORIZON_URL = 'https://horizon.example.test';
  process.env.HEALTH_CHECK_TIMEOUT_MS = '25';

  try {
    const mockDb = { query: async () => ({ rows: [] }) };
    const router = buildApp(mockDb);
    const express = require('express');
    const app = express();
    app.use('/health', router);

    const started = Date.now();
    const response = await request(app).get('/health/ready');

    assert.equal(response.status, 503);
    assert.equal(response.body.checks.horizon.error, 'timeout');
    assert.ok(Date.now() - started < 1000);
  } finally {
    global.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.HEALTH_CHECK_TIMEOUT_MS;
    else process.env.HEALTH_CHECK_TIMEOUT_MS = originalTimeout;
    delete process.env.STELLAR_HORIZON_URL;
  }
});
