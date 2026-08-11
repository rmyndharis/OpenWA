/**
 * Bound Baileys' app-state resync loop so an unanswered query cannot spin it.
 *
 * `resyncAppState` (lib/Socket/chats.js) drives `while (collectionsToHandle.size)` until every
 * collection reports no more patches. Each pass issues an `iq` through `query()` — and `query()`
 * catches its own `defaultQueryTimeoutMs` (60s) and RESOLVES `undefined` rather than throwing. That
 * `undefined` reaches `extractSyncdPatches`, which yields `{}` (verified by execution against the
 * installed module, alongside a real-node control that also yields `{}`).
 *
 * Every exit from the loop — each `collectionsToHandle.delete(name)`, and every increment of the
 * `attemptsMap` the library's own comment introduces to "ensure we don't enter a loop that cannot be
 * exited from" — lives INSIDE `for (const key in decoded)`. With `decoded` empty that body never
 * runs, so nothing is removed, nothing is counted, and the guard never engages. The loop then burns
 * one 60-second query per pass for as long as the socket lives. It is not permanent: the `await
 * query(...)` sits outside the loop's try/catch, so a socket close rejects out of resyncAppState
 * entirely. On a long-lived gateway that is still on the order of a thousand wasted queries a day.
 *
 * The transform adds the exit the guard assumes: an empty decode ends the walk. Nothing came back,
 * and re-asking in a tight loop is what produced the defect — a later connect re-runs the sync
 * anyway (OpenWA calls it on every `open`).
 *
 * Exact and self-disabling, matching the whatsapp-web.js patchers: an unknown shape fails rather
 * than silently shipping without the fix. Remove this once upstream bounds the loop.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const CHATS_PATH = path.join('lib', 'Socket', 'chats.js');

const LOOP_FIND = `                const decoded = await extractSyncdPatches(result, config?.options);
                for (const key in decoded) {`;

const LOOP_REPLACE = `                const decoded = await extractSyncdPatches(result, config?.options);
                // OpenWA: query() resolves undefined on its own timeout, which decodes to {}. Every
                // exit below — including the attemptsMap guard — is inside this for-in, so an empty
                // decode would otherwise spin the while loop for the life of the socket.
                if (!Object.keys(decoded).length) {
                    break;
                }
                for (const key in decoded) {`;

/** Apply the transform. Returns {skipped, reason} or {note} — never a partial write. */
function applyAppStatePatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, CHATS_PATH);
  if (!fs.existsSync(file)) {
    return { skipped: true, reason: `${CHATS_PATH} not found — nothing to patch` };
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes('OpenWA: query() resolves undefined on its own timeout')) {
    return { skipped: true, reason: 'already patched' };
  }
  const occurrences = source.split(LOOP_FIND).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 resyncAppState decode site in ${CHATS_PATH}, found ${occurrences} — ` +
        'the upstream shape changed; re-check whether the loop is still unbounded before removing this patcher',
    );
  }
  fs.writeFileSync(file, source.replace(LOOP_FIND, LOOP_REPLACE), 'utf8');
  return { note: 'bounded the app-state resync loop on an empty decode' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyAppStatePatch();
    console.log(`patch-baileys-appstate: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-appstate: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-baileys-appstate: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyAppStatePatch, LOOP_FIND, LOOP_REPLACE };
