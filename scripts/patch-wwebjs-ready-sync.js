/**
 * Make whatsapp-web.js readiness observable and race-free on warm session restores.
 *
 * whatsapp-web.js 1.34.7 runs its entire post-auth pipeline — LoadUtils, ClientInfo,
 * attachEventListeners (the page->Node message bridge), and the `ready` emit — inside a callback
 * fired by the page-side `change:hasSynced` EDGE. Two real failure modes follow, both observed live:
 *
 * 1. On a warm profile the page can reach hasSynced=true BEFORE the listener attaches; the edge
 *    never comes again and the whole pipeline silently never runs.
 * 2. attachEventListeners can throw partway (a transient page evaluate failure); the rejection is
 *    swallowed inside the exposed-function binding, `ready` never fires, and nothing records that
 *    the message bridge is dead — while sends still work, so the session looks merely quiet.
 *
 * Three transforms, one group (all-or-nothing):
 *  - initialize `eventsAttached = false` on the client, so the flag's absence (an unpatched tree)
 *    is distinguishable from "attach has not completed";
 *  - set `eventsAttached = true` only AFTER attachEventListeners resolves, giving the adapter a
 *    truthful completion marker (the adapter treats `undefined` as "marker unsupported" and keeps
 *    its old behaviour);
 *  - after subscribing to `change:hasSynced`, fire the handler once when the level is already
 *    true, closing the missed-edge race. A double fire is tolerated upstream: the callback's
 *    `injected` check makes the second pass a bare re-emit of `ready`, which the adapter dedupes.
 *
 * The source transform is deliberately exact and self-disabling: an unknown shape fails the build
 * instead of silently shipping without the fix, matching the sibling patchers. The file is written
 * once, after the whole group resolves.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const CLIENT_PATH = path.join('src', 'Client.js');

const FLAG_INIT_FIND = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;`;

const FLAG_INIT_REPLACE = `        this.currentIndexHtml = null;
        this.lastLoggedOut = false;
        // Set true only after attachEventListeners() resolves; the message bridge is not
        // trustworthy before that, even when the page itself reports CONNECTED.
        this.eventsAttached = false;`;

const ATTACH_MARK_FIND = `                    await this.attachEventListeners();
                }`;

const ATTACH_MARK_REPLACE = `                    await this.attachEventListeners();
                    this.eventsAttached = true;
                }`;

const HAS_SYNCED_FIND = `            window
                .require('WAWebSocketModel')
                .Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });`;

const HAS_SYNCED_REPLACE = `            window
                .require('WAWebSocketModel')
                .Socket.on('change:hasSynced', () => {
                    window.onAppStateHasSyncedEvent();
                });
            // A warm profile can restore to hasSynced=true before this listener exists; the edge
            // then never fires again. Fire once on the already-reached level as well.
            if (window.require('WAWebSocketModel').Socket.hasSynced) {
                window.onAppStateHasSyncedEvent();
            }`;

const EDITS = [
  { find: FLAG_INIT_FIND, replace: FLAG_INIT_REPLACE },
  { find: ATTACH_MARK_FIND, replace: ATTACH_MARK_REPLACE },
  { find: HAS_SYNCED_FIND, replace: HAS_SYNCED_REPLACE },
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyReadySyncPatch(wwjsDir = DEFAULT_WWJS) {
  const clientFile = path.join(wwjsDir, CLIENT_PATH);
  if (!fs.existsSync(clientFile)) {
    throw new Error(`whatsapp-web.js Client.js not found at ${clientFile}`);
  }

  let source = fs.readFileSync(clientFile, 'utf8');
  const replaces = EDITS.map(edit => occurrences(source, edit.replace));
  // Each replacement CONTAINS its find (the edits append lines), so a find counted on the raw
  // source would still be 1 after patching. Count finds with the replacements removed, so a
  // patched file reads as find=0/replace=1 and a genuinely half-patched one still refuses.
  const finds = EDITS.map(edit => occurrences(source.split(edit.replace).join(''), edit.find));

  if (finds.every(count => count === 0) && replaces.every(count => count === 1)) {
    return { skipped: true, reason: 'installed whatsapp-web.js already carries the ready-sync repair' };
  }
  if (finds.every(count => count === 1) && replaces.every(count => count === 0)) {
    for (const edit of EDITS) {
      source = source.replace(edit.find, edit.replace);
    }
    fs.writeFileSync(clientFile, source);
    return { skipped: false, note: 'readiness marker and hasSynced level-check applied' };
  }
  throw new Error(
    `unsupported Client.js shape (unpatched: ${finds.join(',')}, patched: ${replaces.join(',')}); ` +
      're-evaluate the ready-sync repair against the installed whatsapp-web.js',
  );
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyReadySyncPatch();
    console.log(`patch-wwebjs-ready-sync: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-ready-sync: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-ready-sync: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  applyReadySyncPatch,
  EDITS,
  FLAG_INIT_FIND,
  FLAG_INIT_REPLACE,
  ATTACH_MARK_FIND,
  ATTACH_MARK_REPLACE,
  HAS_SYNCED_FIND,
  HAS_SYNCED_REPLACE,
};
