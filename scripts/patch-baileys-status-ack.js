/**
 * Acknowledge the top-level `<status>` stanza WhatsApp now uses to deliver a contact's status to some
 * accounts, instead of the `<message from="status@broadcast">` node Baileys understands.
 *
 * `makeMessagesRecvSocket` (lib/Socket/messages-recv.js) registers handlers for `message`, `call`,
 * `receipt`, `notification` and `ack,class:message`. Nothing answers a `<status>` node, and WhatsApp
 * does not leave an unanswered stanza alone:
 *
 *  1. About 50 minutes after the connection opened, the server closes the stream and names the ack it
 *     never got (`<stream:error><ack class="status"/></stream:error>`). Baileys reports it as
 *     "Stream Errored (ack)" with status code 500, which OpenWA treats as a transient drop and
 *     reconnects from.
 *  2. The pending stanza is redelivered on every reconnect, as an offline node, and is again never
 *     answered, so the loop repeats for as long as one status is pending. Reports also describe an
 *     account that stops receiving after such a reconnect while the session still reads ready.
 *
 * The rollout is server-side and gradual, so an account either receives statuses this way or does not.
 * Upstream tracks it as WhiskeySockets/Baileys#2858, with fixes in #2866 (acknowledge only) and #2883
 * (acknowledge, and route the node through the offline queue). Neither is merged and rc14 is the latest
 * release. This patch is the shape of #2883: the node goes through `processNode`, so an ignored JID is
 * acknowledged on its fast path and an `offline` node waits its turn in the offline queue, and
 * `status` joins that queue's handler map, which has no entry for a type it did not know.
 *
 * The stanza is acknowledged and dropped, never decoded: statuses delivered this way do not reach the
 * status store until the library decodes them. The ack carries no error code: upstream reports that a
 * NACK keeps the stanza pending on the server.
 *
 * Exact and self-disabling, like the other patchers: an unknown shape fails rather than silently
 * shipping unpatched, and a library that already registers its own `CB:status` handler fails too,
 * because this patch would then send a second ack.
 *
 * **RETIRE THIS** once @whiskeysockets/baileys releases a `<status>` handler. The patcher then fails
 * the build because the library already registers one, which is the signal to delete it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const RECV_PATH = path.join('lib', 'Socket', 'messages-recv.js');

const MARKER = 'OpenWA: acknowledge the top-level <status> stanza';

/** An upstream handler for the stanza, in whatever quoting the compiler emits. */
const UPSTREAM_HANDLER = /['"`]CB:status['"`,]/;

const MAP_FIND = `    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([
        ['message', handleMessage],
        ['call', handleCall],
        ['receipt', handleReceipt],
        ['notification', handleNotification]
    ]), {`;

const MAP_REPLACE = `    // ${MARKER}.
    // WhatsApp delivers some accounts' contact statuses as a <status> node instead of
    // <message from="status@broadcast">. Nothing answers it, so the server ends the stream about 50 minutes
    // later ("Stream Errored (ack)") and redelivers the node on every reconnect. It is only acknowledged
    // here, never decoded.
    const handleStatus = (node) => sendMessageAck(node);
    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([
        ['message', handleMessage],
        ['call', handleCall],
        ['receipt', handleReceipt],
        ['notification', handleNotification],
        ['status', handleStatus]
    ]), {`;

const HANDLER_FIND = `    ws.on('CB:notification', async (node) => {
        await processNode('notification', node, 'handling notification', handleNotification);
    });`;

const HANDLER_REPLACE = `${HANDLER_FIND}
    ws.on('CB:status', async (node) => {
        // processNode acknowledges an ignored JID itself, so a failure there reaches this listener
        await processNode('status', node, 'acking status stanza', handleStatus).catch(error => onUnexpectedError(error, 'acking status stanza'));
    });`;

const SITES = [
  ['offline node map', MAP_FIND, MAP_REPLACE],
  ['notification handler', HANDLER_FIND, HANDLER_REPLACE],
];

/** Apply the transform. Returns {skipped, reason} or {note}, never a partial write. */
function applyStatusAckPatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, RECV_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`@whiskeysockets/baileys ${RECV_PATH} not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  if (UPSTREAM_HANDLER.test(source)) {
    throw new Error(
      `${RECV_PATH} already registers a CB:status handler: upstream now answers <status> stanzas, ` +
        'and this patch would send a second ack. Check the installed Baileys and retire this patcher',
    );
  }
  for (const [label, find] of SITES) {
    const occurrences = source.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `expected exactly 1 ${label} site in ${RECV_PATH}, found ${occurrences}; ` +
          'the upstream shape changed, so check how the library answers a <status> stanza before removing this patcher',
      );
    }
  }
  let patched = source;
  for (const [, find, replace] of SITES) patched = patched.replace(find, () => replace);
  writeFileAtomic(file, patched);
  return { note: 'acknowledged the top-level <status> stanza so the server stops ending the stream over it' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyStatusAckPatch();
    console.log(`patch-baileys-status-ack: ${result.skipped ? `skipped, ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-status-ack: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-baileys-status-ack: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

/**
 * The stand-down branches above as a predicate, for the startup guard (engine-patch-status.ts): this
 * patch's marker, or a library that answers the stanza itself. Unreadable reads as applied, like the
 * siblings.
 */
function isApplied(baileysDir = DEFAULT_BAILEYS) {
  try {
    const source = fs.readFileSync(path.join(baileysDir, RECV_PATH), 'utf8');
    return source.includes(MARKER) || UPSTREAM_HANDLER.test(source);
  } catch {
    return true;
  }
}

module.exports = { applyStatusAckPatch, isApplied, MAP_FIND, MAP_REPLACE, HANDLER_FIND, HANDLER_REPLACE, MARKER };
