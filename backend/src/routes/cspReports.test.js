const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const proxyquire = require('proxyquire').noCallThru();

function buildApp(queryImpl) {
  const router = proxyquire('./cspReports', {
    '../config/database': { query: queryImpl },
    '../config/logger': { warn: () => {}, error: () => {}, info: () => {} },
    '../middleware/rateLimiter': { cspReportLimiter: (_req, _res, next) => next() },
  });

  const app = express();
  app.use('/api/csp-report', router);
  return app;
}

test('legacy CSP reports are stored without query strings or script samples', async () => {
  let captured;
  const app = buildApp(async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  });

  const res = await request(app)
    .post('/api/csp-report')
    .set('Content-Type', 'application/csp-report')
    .send(
      JSON.stringify({
        'csp-report': {
          'document-uri': 'https://app.crowdpay.com/campaigns/1?token=super-secret#frag',
          'blocked-uri': 'https://evil.example/collect?password=hunter2',
          'violated-directive': "script-src 'self'",
          'effective-directive': 'script-src',
          disposition: 'report',
          'source-file': 'https://app.crowdpay.com/assets/app.js?api_key=secret',
          'line-number': 42,
          'column-number': 7,
          'status-code': 200,
          'script-sample': 'alert(document.cookie)',
        },
      })
    );

  assert.equal(res.status, 204);
  assert.match(captured.sql, /INSERT INTO csp_reports/);
  assert.equal(captured.params[1], 'https://app.crowdpay.com/campaigns/1');
  assert.equal(captured.params[2], 'https://evil.example/collect');
  assert.equal(captured.params[6], 'https://app.crowdpay.com/assets/app.js');
  assert.equal(captured.params[7], 42);
  assert.equal(captured.params[8], 7);

  const serialized = JSON.stringify(captured.params);
  assert.ok(!serialized.includes('super-secret'));
  assert.ok(!serialized.includes('hunter2'));
  assert.ok(!serialized.includes('api_key'));
  assert.ok(!serialized.includes('script-sample'));
  assert.ok(!serialized.includes('alert(document.cookie)'));
});

test('Reporting API batches are normalized and sanitized', async () => {
  const inserted = [];
  const app = buildApp(async (_sql, params) => {
    inserted.push(params);
    return { rows: [] };
  });

  const res = await request(app)
    .post('/api/csp-report')
    .set('Content-Type', 'application/reports+json')
    .send(
      JSON.stringify([
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://app.crowdpay.com/path?secret=1',
            blockedURL: 'inline',
            effectiveDirective: 'style-src',
            disposition: 'enforce',
            lineNumber: 3,
          },
        },
        { type: 'deprecation', body: { id: 'ignored' } },
      ])
    );

  assert.equal(res.status, 204);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][1], 'https://app.crowdpay.com/path');
  assert.equal(inserted[0][2], 'inline');
  assert.equal(inserted[0][4], 'style-src');
});

test('malformed or unrecognized reports are acknowledged without persistence', async () => {
  const app = buildApp(async () => {
    throw new Error('database should not be called');
  });

  const res = await request(app)
    .post('/api/csp-report')
    .set('Content-Type', 'application/json')
    .send(JSON.stringify({ hello: 'world' }));

  assert.equal(res.status, 204);
});

test('sanitizeUrl strips credentials, queries, fragments, and opaque payloads', () => {
  const { sanitizeUrl } = require('./cspReports');

  assert.equal(
    sanitizeUrl('https://user:pass@app.crowdpay.com/a?token=1#frag'),
    'https://app.crowdpay.com/a'
  );
  assert.equal(sanitizeUrl('data:text/html;base64,c2VjcmV0'), 'data:');
  assert.equal(sanitizeUrl('blob:https://app.crowdpay.com/uuid'), 'blob:');
  assert.equal(sanitizeUrl('inline'), 'inline');
  assert.equal(sanitizeUrl(null), null);
});
