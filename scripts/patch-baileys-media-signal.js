/**
 * Forward caller-supplied AbortSignal from `options.signal` to `fetch()` in Baileys' `getHttpStream`.
 *
 * `getHttpStream` (lib/Utils/messages-media.js) only forwards `dispatcher`, `method`, and `headers`
 * to `fetch(url.toString(), ...)`, dropping `options.signal`. As a result, aborting an inbound
 * media download before response headers arrive (for example, when `MEDIA_DOWNLOAD_TIMEOUT_MS` fires
 * on a stalled origin or proxy) could not cancel the underlying HTTP request, leaving the socket
 * open until the server closed it or Node's idle timeout elapsed.
 *
 * Forwarding `signal: options.signal` lets OpenWA's `AbortController` cancel the in-flight HTTP
 * request immediately on timeout, size-cap breach, or early stream teardown.
 *
 * Exact and self-disabling, like the sibling patchers: an unknown upstream shape fails the build
 * rather than silently shipping unpatched.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const MEDIA_PATH = path.join('lib', 'Utils', 'messages-media.js');

const MARKER = 'OpenWA: forward AbortSignal to getHttpStream fetch';

const FETCH_FIND = `    const response = await fetch(url.toString(), {
        dispatcher: options.dispatcher,
        method: 'GET',
        headers: options.headers
    });`;

const FETCH_REPLACE = `    // ${MARKER}
    const response = await fetch(url.toString(), {
        dispatcher: options.dispatcher,
        method: 'GET',
        headers: options.headers,
        signal: options.signal
    });`;

/** Apply the transform. Returns {skipped, reason} or {note} with atomic write. */
function applyMediaSignalPatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, MEDIA_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`@whiskeysockets/baileys ${MEDIA_PATH} not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  const occurrences = source.split(FETCH_FIND).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 getHttpStream fetch site in ${MEDIA_PATH}, found ${occurrences}: ` +
        'the upstream shape changed; check whether getHttpStream now forwards options.signal before removing this patcher',
    );
  }
  writeFileAtomic(file, source.replace(FETCH_FIND, FETCH_REPLACE));
  return { note: 'forwarded options.signal to fetch() in getHttpStream so aborted media downloads cancel promptly' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyMediaSignalPatch();
    console.log(`patch-baileys-media-signal: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-media-signal: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-baileys-media-signal: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

/** The stand-down branch above as a predicate. Unreadable reads as applied, like the siblings. */
function isApplied(baileysDir = DEFAULT_BAILEYS) {
  try {
    return fs.readFileSync(path.join(baileysDir, MEDIA_PATH), 'utf8').includes(MARKER);
  } catch {
    return true;
  }
}

module.exports = { applyMediaSignalPatch, isApplied, FETCH_FIND, FETCH_REPLACE, MARKER };
