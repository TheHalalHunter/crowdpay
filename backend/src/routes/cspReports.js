'use strict';

const express = require('express');
const db = require('../config/database');
const logger = require('../config/logger');
const { cspReportLimiter } = require('../middleware/rateLimiter');
const asyncHandler = require('../utils/asyncHandler');

const MAX_REPORTS_PER_REQUEST = 20;
const MAX_FIELD_LENGTH = 2048;

const SAFE_OPAQUE_VALUES = new Set(['inline', 'eval', 'wasm-eval', 'self', 'none']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_PATTERN = /[\u0000-\u001f\u007f]/g;

function cleanString(value, maxLength = MAX_FIELD_LENGTH) {
  if (value === null || value === undefined) return null;
  return String(value).replace(CONTROL_CHARS_PATTERN, '').slice(0, maxLength);
}

function cleanInteger(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Strip query strings, fragments, credentials, and opaque payloads from
 * browser-supplied URLs. CSP reports can otherwise leak tokens embedded in
 * document/source URLs or the contents of inline/data resources.
 */
function sanitizeUrl(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  if (SAFE_OPAQUE_VALUES.has(raw.toLowerCase())) return raw.toLowerCase();

  if (/^(data|blob|filesystem|about):/i.test(raw)) {
    return raw.slice(0, raw.indexOf(':') + 1);
  }

  try {
    const parsed = new URL(raw, 'https://invalid.local');
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

function firstValue(report, ...keys) {
  for (const key of keys) {
    if (report[key] !== undefined && report[key] !== null) return report[key];
  }
  return null;
}

function sanitizeCspReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return null;

  const violatedDirective = cleanString(
    firstValue(report, 'violated-directive', 'violatedDirective', 'effectiveDirective'),
    200
  );
  const effectiveDirective = cleanString(
    firstValue(report, 'effective-directive', 'effectiveDirective', 'violatedDirective'),
    200
  );

  if (!violatedDirective && !effectiveDirective) return null;

  return {
    document_uri: sanitizeUrl(firstValue(report, 'document-uri', 'documentURI', 'documentURL')),
    blocked_uri: sanitizeUrl(firstValue(report, 'blocked-uri', 'blockedURI', 'blockedURL')),
    violated_directive: violatedDirective,
    effective_directive: effectiveDirective,
    disposition: cleanString(firstValue(report, 'disposition'), 40),
    source_file: sanitizeUrl(firstValue(report, 'source-file', 'sourceFile')),
    line_number: cleanInteger(firstValue(report, 'line-number', 'lineNumber')),
    column_number: cleanInteger(firstValue(report, 'column-number', 'columnNumber')),
    status_code: cleanInteger(firstValue(report, 'status-code', 'statusCode')),
  };
}

function extractCspReports(body) {
  if (!body) return [];

  let candidates = [];
  if (Array.isArray(body)) {
    candidates = body
      .filter(entry => entry && typeof entry === 'object' && entry.type === 'csp-violation')
      .map(entry => entry.body);
  } else if (body['csp-report']) {
    candidates = [body['csp-report']];
  } else {
    candidates = [body];
  }

  return candidates.slice(0, MAX_REPORTS_PER_REQUEST).map(sanitizeCspReport).filter(Boolean);
}

const router = express.Router();

router.use(cspReportLimiter);
router.use(
  express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '64kb',
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const reports = extractCspReports(req.body);

    for (const report of reports) {
      logger.warn('csp_violation', {
        ...report,
        correlation_id: req.id || null,
      });

      try {
        await db.query(
          `INSERT INTO csp_reports
             (correlation_id, document_uri, blocked_uri, violated_directive,
              effective_directive, disposition, source_file, line_number,
              column_number, status_code)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            req.id || null,
            report.document_uri,
            report.blocked_uri,
            report.violated_directive,
            report.effective_directive,
            report.disposition,
            report.source_file,
            report.line_number,
            report.column_number,
            report.status_code,
          ]
        );
      } catch (err) {
        // Reporting must never fail the browser request; keep the sanitized
        // structured log line even if the database is temporarily unavailable.
        logger.error('csp_report_persist_failed', {
          correlation_id: req.id || null,
          error: err.message,
        });
      }
    }

    res.status(204).end();
  })
);

module.exports = router;
module.exports.sanitizeCspReport = sanitizeCspReport;
module.exports.extractCspReports = extractCspReports;
module.exports.sanitizeUrl = sanitizeUrl;
