#!/usr/bin/env node
/**
 * Validate performance budgets and compare a K6 summary export against the
 * committed baseline (#1076).
 *
 * Usage:
 *   node load-tests/budget-check.js --config load-tests/performance-budgets.json --validate
 *   node load-tests/budget-check.js --summary /tmp/k6-summary.json \
 *     --config load-tests/performance-budgets.json \
 *     --baseline load-tests/performance-baseline.json \
 *     [--dist frontend/dist]
 *
 * Exceptions in the config must name an owner and a future expires_at. Expired
 * exceptions fail the validation step so they cannot become permanent.
 */
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Unable to read ${label} at ${filePath}: ${err.message}`);
  }
}

function formatMs(value) {
  return `${Math.round(value)} ms`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function budgetFailures(config, baseline, now = Date.now()) {
  const failures = [];
  if (!config || config.version !== 1) failures.push('budget config version must be 1');
  if (!config?.paths || !Object.keys(config.paths).length) {
    failures.push('budget config must define at least one path');
    return failures;
  }

  for (const [key, value] of Object.entries(config.paths)) {
    const label = value.label || key;
    for (const field of ['lcp_ms', 'interaction_ms', 'js_payload_kb']) {
      if (!Number.isFinite(value.web?.[field]) || value.web[field] <= 0) {
        failures.push(`${label}: web.${field} must be a positive number`);
      }
    }
    for (const field of ['p95_ms', 'p99_ms']) {
      if (!Number.isFinite(value.api?.[field]) || value.api[field] <= 0) {
        failures.push(`${label}: api.${field} must be a positive number`);
      }
    }
    if (
      !Number.isFinite(value.api?.error_rate) ||
      value.api.error_rate < 0 ||
      value.api.error_rate > 1
    ) {
      failures.push(`${label}: api.error_rate must be between 0 and 1`);
    }
    if (value.api?.p99_ms < value.api?.p95_ms) {
      failures.push(`${label}: api.p99_ms must be greater than or equal to api.p95_ms`);
    }
    if (!value.k6?.latency_metric || !value.k6?.error_metric) {
      failures.push(`${label}: k6 latency_metric and error_metric are required`);
    }
    if (baseline?.metrics && !baseline.metrics[key]) {
      failures.push(`baseline is missing metrics for ${key}`);
    }
  }

  const maxIncrease = config.regression?.max_increase_percent;
  if (!Number.isFinite(maxIncrease) || maxIncrease < 0 || maxIncrease > 100) {
    failures.push('regression.max_increase_percent must be between 0 and 100');
  }

  for (const [index, exception] of (config.exceptions || []).entries()) {
    const prefix = `exceptions[${index}]`;
    if (!exception.path || !config.paths[exception.path]) {
      failures.push(`${prefix}.path must reference a configured path`);
    }
    if (!exception.metric) failures.push(`${prefix}.metric is required`);
    if (!exception.owner || !String(exception.owner).trim()) {
      failures.push(`${prefix}.owner is required`);
    }
    if (!exception.reason || !String(exception.reason).trim()) {
      failures.push(`${prefix}.reason is required`);
    }
    const expiresAt = Date.parse(exception.expires_at || '');
    if (!Number.isFinite(expiresAt)) {
      failures.push(`${prefix}.expires_at must be an ISO 8601 timestamp`);
    } else if (expiresAt <= now) {
      failures.push(`${prefix} expired at ${exception.expires_at}; remove it or renew it`);
    }
  }
  return failures;
}

function summaryValue(summary, metricName, stat) {
  const metric = summary?.metrics?.[metricName];
  if (!metric) return undefined;
  if (stat === 'rate') return metric.values?.rate;
  return metric.values?.[stat];
}

function compareToBudgets(config, baseline, summary) {
  const failures = [];
  const rows = [];
  const maxIncrease = config.regression?.max_increase_percent ?? 20;
  const minAbsolute = config.regression?.min_absolute_ms ?? 0;

  for (const [key, value] of Object.entries(config.paths)) {
    const label = value.label || key;
    const baselineMetrics = baseline?.metrics?.[key] || {};
    const actual = {
      p95_ms: summaryValue(summary, value.k6.latency_metric, 'p(95)'),
      p99_ms: summaryValue(summary, value.k6.latency_metric, 'p(99)'),
      error_rate: summaryValue(summary, value.k6.error_metric, 'rate'),
    };
    if (!Number.isFinite(actual.p95_ms) || !Number.isFinite(actual.p99_ms)) {
      failures.push(`${label}: K6 summary is missing ${value.k6.latency_metric}`);
      continue;
    }

    const checks = [
      ['p95_ms', value.api.p95_ms, baselineMetrics.p95_ms, actual.p95_ms, formatMs],
      ['p99_ms', value.api.p99_ms, baselineMetrics.p99_ms, actual.p99_ms, formatMs],
      [
        'error_rate',
        value.api.error_rate,
        baselineMetrics.error_rate,
        Number.isFinite(actual.error_rate) ? actual.error_rate : 0,
        formatPercent,
      ],
    ];

    for (const [metric, budget, base, measured, formatter] of checks) {
      const exception = (config.exceptions || []).find(
        entry => entry.path === key && entry.metric === metric
      );
      const absoluteExceeded = measured > budget;
      const allowedRegression = Number.isFinite(base)
        ? base * (1 + maxIncrease / 100) + minAbsolute
        : Infinity;
      const regressionExceeded = Number.isFinite(base) && measured > allowedRegression;
      const failed = (absoluteExceeded || regressionExceeded) && !exception;

      rows.push({
        path: label,
        metric,
        budget: formatter(budget),
        baseline: Number.isFinite(base) ? formatter(base) : 'n/a',
        actual: formatter(measured),
        status: failed ? 'FAIL' : exception ? 'EXCEPTION' : 'OK',
      });
      if (failed) {
        const reasons = [];
        if (absoluteExceeded) reasons.push(`budget ${formatter(budget)}`);
        if (regressionExceeded) reasons.push(`baseline ${formatter(base)} +${maxIncrease}%`);
        failures.push(
          `${label} ${metric}: ${formatter(measured)} exceeds ${reasons.join(' and ')}`
        );
      }
    }
  }

  return { failures, rows };
}

function checkJsPayload(config, distDir) {
  const failures = [];
  const rows = [];
  if (!distDir) return { failures, rows };
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(assetsDir)) {
    return {
      failures: [`JavaScript payload directory not found: ${assetsDir}`],
      rows,
    };
  }
  const bytes = fs
    .readdirSync(assetsDir)
    .filter(file => file.endsWith('.js'))
    .reduce((total, file) => total + fs.statSync(path.join(assetsDir, file)).size, 0);
  const kb = Math.ceil(bytes / 1024);
  for (const [key, value] of Object.entries(config.paths)) {
    const label = value.label || key;
    const budget = value.web.js_payload_kb;
    const failed = kb > budget;
    rows.push({
      path: label,
      metric: 'js_payload_kb',
      budget: `${budget} KB`,
      baseline: 'n/a',
      actual: `${kb} KB`,
      status: failed ? 'FAIL' : 'OK',
    });
    if (failed) failures.push(`${label} js_payload_kb: ${kb} KB exceeds budget ${budget} KB`);
  }
  return { failures, rows };
}

function printTable(rows) {
  if (!rows.length) return;
  const headers = ['Path', 'Metric', 'Budget', 'Baseline', 'Actual', 'Status'];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map(row => String(Object.values(row)[index]).length))
  );
  const print = values =>
    values
      .map((value, index) => String(value).padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  console.log(print(headers));
  console.log(widths.map(width => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(print(Object.values(row)));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config || path.join(__dirname, 'performance-budgets.json');
  const config = readJson(configPath, 'budget config');
  const baselinePath = args.baseline || path.join(__dirname, 'performance-baseline.json');
  const baseline = fs.existsSync(baselinePath)
    ? readJson(baselinePath, 'performance baseline')
    : {};

  let failures = budgetFailures(config, baseline);

  if (args.summary) {
    const summary = readJson(args.summary, 'K6 summary');
    const comparison = compareToBudgets(config, baseline, summary);
    failures = failures.concat(comparison.failures);
    printTable(comparison.rows);
  } else if (args.validate) {
    console.log(`[perf-budget] Configuration valid: ${Object.keys(config.paths).join(', ')}`);
  } else if (!args.dist) {
    failures.push('provide --validate, --summary <file>, or --dist <frontend/dist>');
  }

  if (args.dist) {
    const js = checkJsPayload(config, args.dist);
    failures = failures.concat(js.failures);
    printTable(js.rows);
  }

  if (failures.length) {
    console.error('[perf-budget] FAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[perf-budget] OK');
}

main();

module.exports = { budgetFailures, compareToBudgets, checkJsPayload };
