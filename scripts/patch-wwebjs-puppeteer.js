/** Puppeteer 25 removed isConnected(), which whatsapp-web.js 1.34.7 still calls during teardown. */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const REPLACEMENTS = [
  ['const isConnected = browser?.isConnected?.();', 'const isConnected = browser?.connected;'],
  ['while (this.pupBrowser.isConnected() && maxDelay < 10)', 'while (this.pupBrowser.connected && maxDelay < 10)'],
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function isPatched(source) {
  return REPLACEMENTS.every(([before, after]) => occurrences(source, before) === 0 && occurrences(source, after) === 1);
}

function applyPatch(wwjsDir = DEFAULT_WWJS) {
  const file = path.join(wwjsDir, 'src', 'Client.js');
  let source = fs.readFileSync(file, 'utf8');
  if (isPatched(source)) return { skipped: true };
  if (!REPLACEMENTS.every(([before, after]) => occurrences(source, before) === 1 && occurrences(source, after) === 0)) {
    throw new Error('unsupported Client.js shape; recheck Puppeteer browser teardown compatibility');
  }
  for (const [before, after] of REPLACEMENTS) source = source.replace(before, after);
  writeFileAtomic(file, source);
  return { skipped: false };
}

function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    return isPatched(fs.readFileSync(path.join(wwjsDir, 'src', 'Client.js'), 'utf8'));
  } catch {
    return true;
  }
}

if (require.main === module) {
  try {
    const { skipped } = applyPatch();
    console.log(`patch-wwebjs-puppeteer: ${skipped ? 'already applied' : 'browser teardown updated'}`);
  } catch (error) {
    console.error(`patch-wwebjs-puppeteer: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { applyPatch, isApplied, REPLACEMENTS };
