const test = require('node:test');
const assert = require('node:assert/strict');
const proxyquire = require('proxyquire').noCallThru();

function buildHarness() {
  const rows = new Map();
  const errors = [];
  const db = {
    async query(text, params) {
      if (text.includes('INSERT INTO idempotency_keys')) {
        const [actorId, scope, key, requestHash] = params;
        const identity = `${actorId}:${scope}:${key}`;
        const existing = rows.get(identity);
        if (existing) return { rows: [] };
        const row = {
          actor_id: actorId,
          scope,
          key,
          request_hash: requestHash,
          status: 'processing',
          response_status: null,
          response_body: null,
        };
        rows.set(identity, row);
        return { rows: [row] };
      }
      if (text.includes('SELECT status, response_status')) {
        const [actorId, scope, key] = params;
        const row = rows.get(`${actorId}:${scope}:${key}`);
        return { rows: row ? [row] : [] };
      }
      if (text.includes('UPDATE idempotency_keys')) {
        const [status, responseStatus, responseBody, actorId, scope, key] = params;
        const row = rows.get(`${actorId}:${scope}:${key}`);
        if (row) {
          row.status = status;
          row.response_status = responseStatus;
          row.response_body = JSON.parse(responseBody);
        }
        return { rows: [] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const middleware = proxyquire('./idempotency', {
    '../config/database': db,
    '../config/logger': { error: (...args) => errors.push(args) },
  }).idempotency;
  return { middleware, rows, errors };
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function request(actorId, key = 'retry-1') {
  return {
    method: 'POST',
    originalUrl: '/api/contributions',
    url: '/api/contributions',
    headers: { 'idempotency-key': key },
    body: { campaign_id: 'campaign-1', amount: '10' },
    user: { userId: actorId },
  };
}

test('idempotency keys are actor-scoped and concurrent claims conflict', async () => {
  const { middleware } = buildHarness();
  const firstResponse = response();
  let firstNext = 0;
  await middleware('contribution:create', { bodyField: 'idempotency_key' })(
    request('user-1'),
    firstResponse,
    () => {
      firstNext += 1;
    }
  );

  const secondResponse = response();
  let secondNext = 0;
  await middleware('contribution:create')(request('user-1'), secondResponse, () => {
    secondNext += 1;
  });

  assert.equal(firstNext, 1);
  assert.equal(secondNext, 0);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(secondResponse.body.code, 'IDEMPOTENCY_CONFLICT');

  const otherActorResponse = response();
  let otherActorNext = 0;
  await middleware('contribution:create')(request('user-2'), otherActorResponse, () => {
    otherActorNext += 1;
  });
  assert.equal(otherActorNext, 1);
});

test('completed results replay, including a 5xx result', async () => {
  const { middleware, errors } = buildHarness();
  const firstResponse = response();
  await middleware('wallet:submit')(request('user-1', 'wallet-1'), firstResponse, () => {});
  firstResponse.status(502).json({ error: 'provider unavailable' });
  await new Promise(resolve => setImmediate(resolve));

  const replayResponse = response();
  let nextCalled = false;
  await middleware('wallet:submit')(request('user-1', 'wallet-1'), replayResponse, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(replayResponse.statusCode, 502);
  assert.equal(replayResponse.headers['Idempotency-Replay'], 'true');
  assert.deepEqual(replayResponse.body, { error: 'provider unavailable' });
  assert.equal(errors.length, 0);
});

test('malformed keys are rejected before touching durable storage', async () => {
  const { middleware } = buildHarness();
  const res = response();
  let nextCalled = false;
  await middleware('contribution:create')(request('user-1', 'bad key'), res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_IDEMPOTENCY_KEY');
});
