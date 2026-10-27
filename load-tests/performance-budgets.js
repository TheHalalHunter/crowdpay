/**
 * K6 test for the documented performance budgets in
 * load-tests/performance-budgets.json (#1076).
 *
 * The test deliberately uses only local seeded data:
 *   - discovery: public campaign list + campaign detail
 *   - checkout:  login + same-asset checkout preview (no Horizon/Soroban call)
 *
 * Run with `PERF_PROFILE=ci` (default) for a short CI check, or
 * `PERF_PROFILE=full` for a longer local run. Export a summary with
 * `--summary-export` and compare it using load-tests/budget-check.js.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';
const CAMPAIGN_ID = __ENV.CAMPAIGN_ID || '11111111-1111-1111-1111-111111111111';
const CHECKOUT_ASSET = __ENV.CHECKOUT_ASSET || 'USDC';
const CONTRIBUTOR_EMAIL = __ENV.CONTRIBUTOR_EMAIL || 'alice@example.com';
const CONTRIBUTOR_PASSWORD = __ENV.CONTRIBUTOR_PASSWORD || 'password123';

const PROFILES = {
  ci: {
    discovery: [
      { duration: '10s', target: 4 },
      { duration: '15s', target: 4 },
      { duration: '5s', target: 0 },
    ],
    checkout: [
      { duration: '10s', target: 3 },
      { duration: '15s', target: 3 },
      { duration: '5s', target: 0 },
    ],
  },
  full: {
    discovery: [
      { duration: '30s', target: 50 },
      { duration: '1m', target: 50 },
      { duration: '30s', target: 0 },
    ],
    checkout: [
      { duration: '30s', target: 20 },
      { duration: '1m', target: 20 },
      { duration: '30s', target: 0 },
    ],
  },
};

const profile = PROFILES[__ENV.PERF_PROFILE] || PROFILES.ci;

export const options = {
  scenarios: {
    discovery: {
      executor: 'ramping-vus',
      exec: 'discovery',
      stages: profile.discovery,
      gracefulStop: '5s',
    },
    checkout: {
      executor: 'ramping-vus',
      exec: 'checkout',
      stages: profile.checkout,
      gracefulStop: '5s',
    },
  },
  thresholds: {},
};

const discoveryLatency = new Trend('discovery_api_latency', true);
const checkoutLatency = new Trend('checkout_api_latency', true);
const discoveryErrors = new Rate('discovery_error_rate');
const checkoutErrors = new Rate('checkout_error_rate');

export function setup() {
  const response = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: CONTRIBUTOR_EMAIL,
      password: CONTRIBUTOR_PASSWORD,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'setup login' },
    }
  );
  if (response.status !== 200) {
    throw new Error(`Performance seed login failed: ${response.status}`);
  }
  const body = JSON.parse(response.body);
  return { token: body.token || body.accessToken || null };
}

export function discovery() {
  const list = http.get(`${BASE_URL}/api/campaigns?limit=12&status=active`, {
    tags: { name: 'discovery list' },
  });
  discoveryLatency.add(list.timings.duration);
  discoveryErrors.add(list.status >= 400);
  check(list, { 'discovery list 200': response => response.status === 200 });

  const detail = http.get(`${BASE_URL}/api/campaigns/${CAMPAIGN_ID}`, {
    tags: { name: 'discovery detail' },
  });
  discoveryLatency.add(detail.timings.duration);
  discoveryErrors.add(detail.status >= 400);
  check(detail, {
    'discovery detail 200': response => response.status === 200,
  });

  sleep(Math.random() * 0.5 + 0.25);
}

export function checkout(data) {
  if (!data.token) return;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  };
  const preview = http.post(
    `${BASE_URL}/api/campaigns/${CAMPAIGN_ID}/contribution/preview`,
    JSON.stringify({ send_asset: CHECKOUT_ASSET, amount: '5' }),
    { headers, tags: { name: 'checkout preview' } }
  );
  checkoutLatency.add(preview.timings.duration);
  checkoutErrors.add(preview.status >= 400);
  check(preview, {
    'checkout preview 200': response => response.status === 200,
  });

  sleep(Math.random() * 0.75 + 0.25);
}
