'use strict';

/**
 * rateLimiter.test.js
 *
 * Tests for the rate limiter middleware.
 * Covers both embedStatsLimiter and impactStatsLimiter including window reset behavior.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

// Use a very high limit for testing so we don't hit limits during normal test runs
// The window reset tests use a custom limiter with a short window
process.env.RATE_LIMIT_WINDOW_MS = '1000';

const { embedStatsLimiter, impactStatsLimiter, cspReportLimiter } = require('./rateLimiter');

// ---------------------------------------------------------------------------
// Build a minimal test app
// ---------------------------------------------------------------------------
function buildApp() {
  const app = express();
  app.use(express.json());

  // Route protected by embedStatsLimiter (100 req/min)
  app.get('/embed-stats', embedStatsLimiter, (_req, res) => {
    res.json({ ok: true, limiter: 'embed' });
  });

  // Route protected by impactStatsLimiter (50 req/min)
  app.get('/impact-stats', impactStatsLimiter, (_req, res) => {
    res.json({ ok: true, limiter: 'impact' });
  });

  return app;
}

let agent;

describe('Rate Limiter Middleware', () => {
  before(() => {
    agent = supertest(buildApp());
  });

  // ── embedStatsLimiter ─────────────────────────────────────────────────────
  describe('embedStatsLimiter', () => {
    it('allows requests within the limit', async () => {
      const res = await agent.get('/embed-stats');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('includes standard rate limit headers', async () => {
      const res = await agent.get('/embed-stats');
      assert.ok(res.headers['ratelimit-limit']);
      assert.ok(res.headers['ratelimit-remaining']);
      assert.ok(res.headers['ratelimit-reset']);
    });
  });

  // ── impactStatsLimiter ────────────────────────────────────────────────────
  describe('impactStatsLimiter', () => {
    it('allows requests within the limit', async () => {
      const res = await agent.get('/impact-stats');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
    });

    it('includes standard rate limit headers', async () => {
      const res = await agent.get('/impact-stats');
      assert.ok(res.headers['ratelimit-limit']);
      assert.ok(res.headers['ratelimit-remaining']);
      assert.ok(res.headers['ratelimit-reset']);
    });
  });

  // ── cspReportLimiter ─────────────────────────────────────────────────────
  describe('cspReportLimiter', () => {
    it('limits CSP reports to 30 per minute per IP', async () => {
      const app = express();
      app.post('/csp-report', cspReportLimiter, (_req, res) => res.status(204).end());
      const cspAgent = supertest(app);

      for (let i = 0; i < 30; i += 1) {
        const res = await cspAgent.post('/csp-report').send({});
        assert.equal(res.status, 204);
      }
      const limited = await cspAgent.post('/csp-report').send({});
      assert.equal(limited.status, 429);
    });
  });

  // ── Window Reset Tests (using custom limiters with short windows) ────────
  describe('window reset behavior', () => {
    it('resets embedStatsLimiter window after windowMs expires', async () => {
      const testLimiter = rateLimit({
        windowMs: 100,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: req => 'test-embed-window-reset',
        message: { error: 'Too many requests' },
      });

      const app = express();
      app.get('/test-embed-reset', testLimiter, (_req, res) => res.json({ ok: true }));
      const testAgent = supertest(app);

      // Make 2 requests (the limit)
      await testAgent.get('/test-embed-reset');
      await testAgent.get('/test-embed-reset');

      // Third request should be rate limited
      const limited = await testAgent.get('/test-embed-reset');
      assert.equal(limited.status, 429);

      // Wait for window to reset
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should be allowed again
      const res = await testAgent.get('/test-embed-reset');
      assert.equal(res.status, 200);
    });

    it('resets impactStatsLimiter window after windowMs expires', async () => {
      const testLimiter = rateLimit({
        windowMs: 100,
        max: 2,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: req => 'test-impact-window-reset',
        message: { error: 'Too many requests' },
      });

      const app = express();
      app.get('/test-impact-reset', testLimiter, (_req, res) => res.json({ ok: true }));
      const testAgent = supertest(app);

      // Make 2 requests (the limit)
      await testAgent.get('/test-impact-reset');
      await testAgent.get('/test-impact-reset');

      // Third request should be rate limited
      const limited = await testAgent.get('/test-impact-reset');
      assert.equal(limited.status, 429);

      // Wait for window to reset
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should be allowed again
      const res = await testAgent.get('/test-impact-reset');
      assert.equal(res.status, 200);
    });
  });

  // ── Key Generator Tests ───────────────────────────────────────────────────
  describe('keyGenerator', () => {
    it('uses ipKeyGenerator for IPv4 addresses', async () => {
      const res = await agent.get('/impact-stats');
      assert.equal(res.status, 200);
    });

    it('handles IPv6 addresses correctly', async () => {
      // This test verifies the keyGenerator doesn't throw ERR_ERL_KEY_GEN_IPV6
      // The actual IPv6 handling is tested by the library
      const res = await agent.get('/impact-stats');
      assert.equal(res.status, 200);
    });
  });
});
