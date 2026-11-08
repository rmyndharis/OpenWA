/**
 * Stop an abandoned Baileys media download from crashing the whole process.
 *
 * `downloadEncryptedContent` (lib/Utils/messages-media.js) wires the HTTP body into the decrypting
 * Transform with a bare `fetched.pipe(output)`. `pipe` forwards data, not errors, and it attaches no
 * 'error' listener to `fetched`. So two things go wrong once the consumer stops reading early:
 *
 *  1. OpenWA destroys `output` when an inbound download passes MEDIA_DOWNLOAD_TIMEOUT_MS or the byte
 *     cap (baileys-events.ts, downloadInboundMediaCapped). That unpipes `fetched` but never destroys
 *     it, so the HTTP/2 stream stays open with nobody reading it.
 *  2. When that idle stream is later reset (NGHTTP2_PROTOCOL_ERROR / NGHTTP2_INTERNAL_ERROR, or
 *     ECONNRESET on HTTP/1.1), undici's body Readable emits 'error' with no listener. Node turns that
 *     into an uncaughtException ("TypeError: terminated"), and OpenWA exits by design.
 *
 * Seen in production three times: each crash followed one or more "Inbound media download passed
 * MEDIA_DOWNLOAD_TIMEOUT_MS" warnings for ~15 MB media by between 3 s and ~60 s.
 *
 * The fix ties the two streams together in both directions: an error on `fetched` destroys `output`
 * (so a reader sees it as an ordinary stream error), and closing `output` destroys `fetched` (so the
 * request is aborted at once instead of being left open). The return value is still `output`, so the
 * caller sees no change in the success path.
 *
 * Exact and self-disabling, like the other patchers: an unknown shape fails rather than silently
 * shipping unpatched.
 *
 * **RETIRE THIS** once @whiskeysockets/baileys stops using a bare `pipe` here (e.g. switches to
 * `stream.pipeline`). The patcher then fails the build because the find string is gone, which is the
 * signal to check upstream and delete it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const MEDIA_PATH = path.join('lib', 'Utils', 'messages-media.js');

const MARKER = 'OpenWA: an abandoned media body must not crash the process';

const PIPE_FIND = `    return fetched.pipe(output, { end: true });`;

const PIPE_REPLACE = `    // ${MARKER}. \`pipe\` forwards no errors
    // and leaves no 'error' listener on \`fetched\`: when the reader destroys \`output\` early (download
    // timeout or byte cap), the HTTP body stays open, and a later stream reset is emitted with no
    // listener and becomes an uncaughtException. Tie the two streams together in both directions.
    fetched.on('error', err => output.destroy(err));
    output.once('close', () => {
        if (!fetched.destroyed) {
            fetched.destroy();
        }
    });
    return fetched.pipe(output, { end: true });`;

/** Apply the transform. Returns {skipped, reason} or {note} — never a partial write. */
function applyMediaStreamPatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, MEDIA_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`@whiskeysockets/baileys ${MEDIA_PATH} not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  const occurrences = source.split(PIPE_FIND).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 media download pipe site in ${MEDIA_PATH}, found ${occurrences} — ` +
        'the upstream shape changed; check whether an abandoned media body can still emit an unhandled ' +
        "'error' before removing this patcher",
    );
  }
  writeFileAtomic(file, source.replace(PIPE_FIND, PIPE_REPLACE));
  return { note: 'tied the media download body to its decrypting stream so an abandoned download cannot crash' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyMediaStreamPatch();
    console.log(`patch-baileys-media-stream: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-media-stream: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-baileys-media-stream: ${error.message}`);
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

module.exports = { applyMediaStreamPatch, isApplied, PIPE_FIND, PIPE_REPLACE, MARKER };
