const express = require('express');
const db = require('../config/database');
const redis = require('../config/redis');
const Sentry = require('@sentry/node');
const logger = require('../config/logger');
const { isEmailConfigured } = require('../services/emailService');
const { getMissingConfig } = require('../config/env');

const router = express.Router();

const DEFAULT_CHECK_TIMEOUT_MS = Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || 2000;

function getPoolMetrics() {
  if (typeof db.getPoolMetrics === 'function') return db.getPoolMetrics();
  return {
    total: db.totalCount || 0,
    idle: db.idleCount || 0,
    waiting: db.waitingCount || 0,
    max: db.poolMax || 0,
    utilisation: 0,
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function safeFailure(err) {
  if (err?.code === 'ETIMEDOUT' || err?.name === 'AbortError') {
    return 'timeout';
  }
  return 'unavailable';
}

async function checkDatabase(timeoutMs) {
  const started = Date.now();
  try {
    await withTimeout(db.query('SELECT 1'), timeoutMs, 'database');
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness database check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  }
}

async function checkRedis(timeoutMs) {
  const started = Date.now();
  try {
    await withTimeout(redis.ping(), timeoutMs, 'redis');
    return { status: 'ok', latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Redis check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  }
}

async function checkHorizon(timeoutMs) {
  const started = Date.now();
  const horizonUrl = process.env.STELLAR_HORIZON_URL;
  if (!horizonUrl) {
    return { status: 'error', error: 'not_configured', latency_ms: Date.now() - started };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await withTimeout(
      fetch(`${horizonUrl.replace(/\/+$/, '')}/fee_stats`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }),
      timeoutMs,
      'horizon'
    );
    if (!response.ok) {
      return {
        status: 'error',
        error: 'http_error',
        http_status: response.status,
        latency_ms: Date.now() - started,
      };
    }
    return { status: 'ok', http_status: response.status, latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Horizon check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSoroban(timeoutMs) {
  const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_SOROBAN_RPC_URL;
  if (!rpcUrl) return null;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const response = await withTimeout(
      fetch(rpcUrl, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      }),
      timeoutMs,
      'soroban'
    );
    if (!response.ok) {
      return {
        status: 'error',
        error: 'http_error',
        http_status: response.status,
        latency_ms: Date.now() - started,
      };
    }
    const body = await withTimeout(response.json(), timeoutMs, 'soroban');
    if (body?.error) {
      return {
        status: 'error',
        error: 'rpc_error',
        latency_ms: Date.now() - started,
      };
    }
    return { status: 'ok', http_status: response.status, latency_ms: Date.now() - started };
  } catch (err) {
    logger.error('Readiness Soroban RPC check failed', { error: err.message });
    return {
      status: 'error',
      error: safeFailure(err),
      latency_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkConfig() {
  const missing = getMissingConfig();
  if (missing.length) {
    return { status: 'error', error: 'missing_configuration', missing };
  }
  return { status: 'ok' };
}

// Liveness: deliberately dependency-free so a degraded dependency can never
// cause an orchestrator to restart an otherwise healthy process.
router.get('/live', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Readiness: every dependency is checked independently and concurrently. A
// failure is reported by name with a safe error class, never a raw message.
router.get('/ready', async (_req, res) => {
  const timeoutMs =
    Number.parseInt(process.env.HEALTH_CHECK_TIMEOUT_MS, 10) || DEFAULT_CHECK_TIMEOUT_MS;
  const [database, cache, horizon, soroban] = await Promise.all([
    checkDatabase(timeoutMs),
    checkRedis(timeoutMs),
    checkHorizon(timeoutMs),
    checkSoroban(timeoutMs),
  ]);
  const checks = {
    database,
    redis: cache,
    horizon,
    config: checkConfig(),
  };
  if (soroban) checks.soroban = soroban;
  const failed = Object.entries(checks)
    .filter(([, result]) => result.status !== 'ok')
    .map(([name]) => name);

  res.set('Cache-Control', 'no-store');
  res.status(failed.length ? 503 : 200).json({
    status: failed.length ? 'degraded' : 'ok',
    failed,
    checks,
  });
});

// Backwards-compatible aggregate health endpoint. Prefer /health/ready for
// orchestrator readiness probes and /health/live for liveness probes.
router.get('/', async (_req, res) => {
  let metrics;
  try {
    await db.query('SELECT 1');
    metrics = getPoolMetrics();
    const { utilisation, ...pool } = metrics;
    res.json({
      status: 'ok',
      db: { pool, utilisation },
      email: isEmailConfigured() ? 'ready' : 'unconfigured',
    });
  } catch (err) {
    logger.error('Health check database query failed', { error: err.message });
    res.status(503).json({
      error: {
        code: 'ERROR',
        message: err.message,
      },
    });
    return;
  }

  if (metrics && metrics.utilisation > 90) {
    Sentry.captureMessage(
      `Database pool utilisation exceeds 90% (current: ${metrics.utilisation}%)`,
      'warning'
    );
  }
});

module.exports = router;
module.exports.checkConfig = checkConfig;
module.exports.checkDatabase = checkDatabase;
module.exports.checkHorizon = checkHorizon;
module.exports.checkRedis = checkRedis;
module.exports.checkSoroban = checkSoroban;
module.exports.withTimeout = withTimeout;
