const fs = require('fs');
const path = require('path');

const BASE = path.resolve(__dirname, '..');

function loadSuppressionFile(packageDir) {
  const file = path.join(packageDir, 'vuln-suppressions.json');
  if (!fs.existsSync(file)) return null;
  const data = fs.readFileSync(file, 'utf-8');
  return JSON.parse(data);
}

function isExpired(expiryDate) {
  if (!expiryDate) return true;
  const expiry = new Date(expiryDate);
  return expiry < new Date();
}

function checkPackage(packageDir, label) {
  const suppressions = loadSuppressionFile(packageDir);
  if (!suppressions) {
    console.log(`${label}: No vulnerability suppression file found; all audit findings must be addressed`);
    return true;
  }

  let hasError = false;
  for (const [pkgName, details] of Object.entries(suppressions)) {
    if (isExpired(details.expiry)) {
      console.error(`${label}: Suppression for ${pkgName} has expired on ${details.expiry}`);
      hasError = true;
    } else if (!details.justification || details.justification.trim() === '') {
      console.error(`${label}: Suppression for ${pkgName} missing justification`);
      hasError = true;
    } else {
      console.log(`${label}: Suppression for ${pkgName} valid (expires ${details.expiry})`);
    }
  }
  return !hasError;
}

const backendOk = checkPackage(path.join(BASE, 'backend'), 'Backend');
const frontendOk = checkPackage(path.join(BASE, 'frontend'), 'Frontend');

process.exit(backendOk && frontendOk ? 0 : 1);