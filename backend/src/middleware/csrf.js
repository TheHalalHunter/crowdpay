const crypto = require('crypto');
const logger = require('../config/logger');

const CSRF_COOKIE_NAME = 'cp_csrf';
const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TOKEN_LENGTH = 32;
const CSRF_COOKIE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// Paths that receive external callbacks and should be exempt from CSRF validation
// Using exact path matching (not prefixes) to prevent silent exemption of new sub-paths
const CSRF_EXEMPT_PATHS = new Set([
  '/api/webhooks/kyc',
  '/api/anchor/callbacks',
  '/api/anchor/callbacks/sep24',
  '/api/anchor/sep24',
  '/api/csp-report',
]);

// Parameterized webhook ingress routes: exactly one additional path segment,
// no further nesting. Deliberately narrow (not a blanket prefix match) so an
// unrelated nested path under the same prefix is never silently exempted.
const CSRF_EXEMPT_PATH_PATTERNS = [/^\/api\/webhooks\/incoming\/[^/]+$/];

// Paths with no mounted route at all (removed/renamed endpoints). These
// aren't "exempt" in the security sense — there's nothing here to protect —
// skipping CSRF lets Express's own 404 handler respond correctly instead of
// masking it behind a CSRF 403.
const CSRF_KNOWN_REMOVED_PATHS = new Set(['/api/kyc-webhook']);

/**
 * Check if the request is authenticated via API key (not cookie-based session).
 * API key requests don't use CSRF cookies, so CSRF validation doesn't apply.
 * @param {object} req - Express request object
 * @returns {boolean}
 */
function isApiKeyRequest(req) {
  const authHeader = req.headers.authorization;
  return Boolean(authHeader && authHeader.startsWith('Bearer cpk_'));
}

/**
 * Check if the request path is explicitly exempt from CSRF validation.
 * Uses exact matching to prevent silent exemption of new sub-paths.
 * @param {string} requestPath - The request path
 * @returns {boolean}
 */
function isExemptPath(requestPath) {
  if (CSRF_EXEMPT_PATHS.has(requestPath)) return true;
  if (CSRF_KNOWN_REMOVED_PATHS.has(requestPath)) return true;
  return CSRF_EXEMPT_PATH_PATTERNS.some(pattern => pattern.test(requestPath));
}

/**
 * Generate a new CSRF token.
 */
function generateCsrfToken() {
  return crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
}

/**
 * Set the CSRF token as a readable (non-httpOnly) cookie.
 * The cookie is readable by JavaScript so the frontend can include it in headers.
 */
function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false, // Must be readable by JS
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: CSRF_COOKIE_MAX_AGE,
    path: '/',
  });
}

/**
 * CSRF protection middleware using the double-submit cookie pattern.
 *
 * How it works:
 * 1. On any authenticated request (or on initial token generation), a random CSRF
 *    token is set as a readable cookie AND attached to req.csrfToken.
 * 2. On state-changing requests (POST, PUT, PATCH, DELETE), the middleware validates
 *    that the X-CSRF-Token header matches the cookie value.
 * 3. An attacker's site cannot read the cookie (SameSite=Strict prevents sending
 *    it cross-site, and even if bypassed, JavaScript cannot read httpOnly=false
 *    cookies from a different origin due to CORS).
 * 4. The attacker cannot set custom headers on cross-origin requests due to CORS
 *    preflight checks.
 *
 * Exemptions:
 * - Webhook endpoints (authenticated by signature, not cookies) - exact paths only
 * - Public auth endpoints (login, register) don't need CSRF since they don't
 *   rely on existing sessions
 * - GET/HEAD/OPTIONS are safe (idempotent)
 * - API key requests (Bearer cpk_*) don't use cookies, so CSRF doesn't apply
 */
function csrfProtection(req, res, next) {
  const method = req.method.toUpperCase();
  const requestPath = (req.originalUrl || req.url || '').split('?')[0];

  // Skip CSRF for safe methods
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    // On GET requests, ensure a CSRF cookie exists (set if missing)
    let token = req.cookies?.[CSRF_COOKIE_NAME];
    if (!token) {
      token = generateCsrfToken();
      setCsrfCookie(res, token);
    }
    req.csrfToken = token;
    return next();
  }

  // Exempt exact paths from CSRF validation (external webhooks/callbacks)
  if (isExemptPath(requestPath)) {
    return next();
  }

  // API key requests don't use cookies, so CSRF validation doesn't apply
  if (isApiKeyRequest(req)) {
    return next();
  }

  // For state-changing methods, validate the CSRF token
  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER_NAME];

  // If there's no cookie token, reject the request (unless it's an API key request, handled above)
  if (!cookieToken) {
    logger.warn('CSRF validation failed: missing cookie token', {
      method,
      path: requestPath,
      hasHeader: Boolean(headerToken),
    });
    return res.status(403).json({
      error: 'CSRF validation failed. Please refresh the page and try again.',
    });
  }

  // Validate: header token must match cookie token
  if (!headerToken || headerToken !== cookieToken) {
    logger.warn('CSRF token mismatch', {
      method,
      path: requestPath,
      hasCookie: Boolean(cookieToken),
      hasHeader: Boolean(headerToken),
    });
    return res.status(403).json({
      error: 'CSRF validation failed. Please refresh the page and try again.',
    });
  }

  req.csrfToken = cookieToken;
  next();
}

/**
 * Middleware to set/refresh the CSRF token on initial page load.
 * Use this on a GET endpoint that the frontend calls on startup.
 */
function ensureCsrfToken(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE_NAME];
  if (!token) {
    token = generateCsrfToken();
    setCsrfCookie(res, token);
  }
  req.csrfToken = token;
  next();
}

module.exports = {
  csrfProtection,
  ensureCsrfToken,
  generateCsrfToken,
  setCsrfCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  CSRF_EXEMPT_PATHS,
  isExemptPath,
  isApiKeyRequest,
};
