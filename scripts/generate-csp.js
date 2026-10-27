#!/usr/bin/env node
'use strict';

/**
 * Generate the static frontend CSP headers consumed by nginx and Vercel.
 *
 * Usage:
 *   node scripts/generate-csp.js --write   # update frontend/nginx.conf + vercel.json
 *   node scripts/generate-csp.js --check   # fail if committed headers are stale
 *
 * Origins and the report collector are configurable through the CSP_* variables
 * documented in docs/csp-reporting.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { buildCspHeaders } = require('../backend/src/config/csp');

const ROOT = path.resolve(__dirname, '..');
const NGINX_PATH = path.join(ROOT, 'frontend', 'nginx.conf');
const VERCEL_PATH = path.join(ROOT, 'frontend', 'vercel.json');

function nginxQuote(value) {
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}

function renderNginx(headers) {
  const headerLines = Object.entries(headers)
    .map(([name, value]) => `  add_header ${name} ${nginxQuote(value)} always;`)
    .join('\n');

  return `server {
  listen 8080;
${headerLines}
  index index.html;

  location ~* \\.map$ {
    deny all;
  }

  location / {
    try_files $uri $uri/ /index.html;  # SPA fallback
  }

  location /api/ {
    proxy_pass http://backend:3001;    # forward API calls to backend service
  }

  location = /health {
    proxy_pass http://backend:3001/health;
    proxy_next_upstream off;
  }
}
`;
}

function renderVercel(headers) {
  const config = {
    headers: [
      {
        source: '/(.*)',
        headers: [
          ...Object.entries(headers).map(([key, value]) => ({ key, value })),
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function main() {
  const mode = process.argv.includes('--check') ? 'check' : 'write';
  const headers = buildCspHeaders();
  const outputs = [
    { path: NGINX_PATH, content: renderNginx(headers) },
    { path: VERCEL_PATH, content: renderVercel(headers) },
  ];

  if (mode === 'check') {
    const stale = outputs.filter(({ path: file, content }) => {
      return !fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content;
    });
    if (stale.length) {
      console.error('[csp] Generated headers are stale:');
      for (const entry of stale) console.error(`  - ${path.relative(ROOT, entry.path)}`);
      console.error('Run `npm run csp:generate` and commit the result.');
      process.exitCode = 1;
      return;
    }
    console.log('[csp] nginx and Vercel headers are up to date.');
    return;
  }

  for (const { path: file, content } of outputs) {
    fs.writeFileSync(file, content);
    console.log(`[csp] Wrote ${path.relative(ROOT, file)}`);
  }
}

main();
