set -e

node <<'NODE'
const fs = require('fs');
const vm = require('vm');

const file = 'audit.js';
if (!fs.existsSync(file)) {
  throw new Error('Please run this from the psulit-cash-audit folder.');
}

const original = fs.readFileSync(file, 'utf8');

const dateBlock = /\bconst\s+shiftDate\s*=\s*\(\s*closingCount\.timestamp\s*\|\|\s*''\s*\)\s*\.split\(\s*','\s*\)\s*\[\s*0\s*\]\s*\.trim\(\s*\)\s*;/g;

const dateGuard = /if\s*\(\s*entryDate\s*&&\s*shiftDate\s*&&\s*entryDate\s*!==\s*shiftDate\s*\)\s*(?:\{\s*continue\s*;\s*\}|continue\s*;)/g;

const replacementDates = `const shiftStartDate = (openingCount.timestamp || '')
        .split(',')[0].trim();
      const shiftEndDate = (closingCount.timestamp || '')
        .split(',')[0].trim();`;

const replacementGuard = `if (
          entryDate &&
          entryDate !== shiftStartDate &&
          entryDate !== shiftEndDate
        ) {
          continue;
        }`;

const dates = [...original.matchAll(dateBlock)];
const guards = [...original.matchAll(dateGuard)];

if (dates.length !== 1 || guards.length !== 1) {
  if (original.includes('shiftStartDate') &&
      original.includes('shiftEndDate') &&
      original.includes('entryDate !== shiftStartDate')) {
    console.log('The fix is already installed.');
    process.exit(0);
  }
  throw new Error('Expected code not found exactly once. Nothing was changed.');
}

const updated = original
  .replace(dateBlock, replacementDates)
  .replace(dateGuard, replacementGuard);

// Check the entire file before writing.
new vm.Script(updated, { filename: 'audit.js' });

const backup = 'audit.js.before-overnight-fix.bak';
if (fs.existsSync(backup)) {
  throw new Error('Backup already exists. Nothing was changed.');
}

fs.writeFileSync(backup, original);
fs.writeFileSync(file, updated);

console.log('audit.js updated successfully.');
console.log('Backup saved. Only the overnight expense date filter changed.');
NODE

git add audit.js
git commit -m "Fix overnight expense date filtering"
git push
