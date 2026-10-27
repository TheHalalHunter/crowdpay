const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const embedStatsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const impactStatsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: req => ipKeyGenerator(req.ip),
});

// Browser CSP reports are unauthenticated. Keep the bucket small so a noisy
// or malicious page cannot flood the collector or the database.
const cspReportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many CSP reports, please try again later.' },
  keyGenerator: req => ipKeyGenerator(req.ip),
});

module.exports = {
  embedStatsLimiter,
  impactStatsLimiter,
  cspReportLimiter,
};
