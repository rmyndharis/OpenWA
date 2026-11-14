/**
 * Decode and acknowledge the top-level `<status>` stanza WhatsApp now uses to deliver a contact's status
 * to some accounts, instead of the `<message from="status@broadcast">` node Baileys understands.
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
 * release. This patch routes the node as #2883 does: it goes through `processNode`, so an ignored JID
 * is acknowledged on its fast path and an `offline` node waits its turn in the offline queue, and
 * `status` joins that queue's handler map, which has no entry for a type it did not know.
 *
 * Neither upstream fix reads the content. On the accounts observed the node is the status message itself
 * under another tag (`from="status@broadcast"`, the poster in `participant`, the content in an skmsg
 * `<enc>` and the sender key in a pkmsg or msg one), and it is the only delivery of that status:
 * acknowledged and dropped, it never reaches the status store. So a node of that shape goes through the
 * library's own `decryptMessageNode` and `upsertMessage`, as `handleMessage` takes a `<message>`, with
 * two differences:
 *
 *  - Every outcome ends in one ack with no error code. `handleMessage` answers a failed decryption with
 *    a retry receipt and an error ack, and a decrypted message with a receipt and no ack. Upstream
 *    reports that an error ack keeps the stanza pending on the server, and the plain ack is the only
 *    answer shown to clear it, so a status that does not decrypt is dropped, not retried.
 *  - Any other shape is acknowledged undecoded. `decodeMessageNode` never reads the tag, so a contact
 *    JID in `from`, the form one upstream report describes, would surface the status as a direct message.
 *
 * The first revision of this patch (OpenWA 0.30.1) only acknowledged. An `npm install` that does not
 * reinstall the library leaves its tree in place, so that tree is recognised and brought up to this one.
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

const MARKER = 'OpenWA: decode and acknowledge the top-level <status> stanza';

/** An upstream handler for the stanza, in whatever quoting the compiler emits. */
const UPSTREAM_HANDLER = /['"`]CB:status['"`,]/;

const MAP_FIND = `    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([
        ['message', handleMessage],
        ['call', handleCall],
        ['receipt', handleReceipt],
        ['notification', handleNotification]
    ]), {`;

const MAP_WITH_STATUS = `    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([
        ['message', handleMessage],
        ['call', handleCall],
        ['receipt', handleReceipt],
        ['notification', handleNotification],
        ['status', handleStatus]
    ]), {`;

const MAP_REPLACE = `    // ${MARKER}.
    // WhatsApp delivers some accounts' contact statuses as a <status> node instead of
    // <message from="status@broadcast">. Nothing answers it, so the server ends the stream about 50 minutes
    // later ("Stream Errored (ack)") and redelivers the node on every reconnect.
    const handleStatus = async (node) => {
        // The status message under another tag. Any other shape is only acknowledged: decodeMessageNode
        // would file a contact JID in \`from\` under that contact's chat.
        if (isJidStatusBroadcast(node.attrs.from) && node.attrs.participant) {
            try {
                const { fullMessage: msg, decrypt } = decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, logger);
                // As handleMessage does: learn the poster's other address, so a session kept under it is found
                const alt = msg.key.remoteJidAlt;
                if (alt) {
                    if (jidDecode(alt)?.server === 'lid') {
                        if (!(await signalRepository.lidMapping.getPNForLID(alt))) {
                            await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: msg.key.participant }]);
                            await signalRepository.migrateSession(msg.key.participant, alt);
                        }
                    }
                    else {
                        await signalRepository.lidMapping.storeLIDPNMappings([{ lid: msg.key.participant, pn: alt }]);
                        await signalRepository.migrateSession(alt, msg.key.participant);
                    }
                }
                await messageMutex.mutex(async () => {
                    await decrypt();
                    if (msg.message) {
                        cleanMessage(msg, authState.creds.me.id, authState.creds.me.lid);
                        await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');
                    }
                });
            }
            catch (error) {
                logger.error({ error, id: node.attrs.id }, 'failed to decode status stanza');
            }
        }
        // One ack with no error code, whatever the decoding came to: an error ack is reported to leave the
        // stanza pending, and nothing is known to answer a retry receipt for it.
        await sendMessageAck(node);
    };
${MAP_WITH_STATUS}`;

/** What the acknowledge-only revision of this patch (OpenWA 0.30.1) wrote at the same site. */
const ACK_ONLY_MAP = `    // OpenWA: acknowledge the top-level <status> stanza.
    // WhatsApp delivers some accounts' contact statuses as a <status> node instead of
    // <message from="status@broadcast">. Nothing answers it, so the server ends the stream about 50 minutes
    // later ("Stream Errored (ack)") and redelivers the node on every reconnect. It is only acknowledged
    // here, never decoded.
    const handleStatus = (node) => sendMessageAck(node);
${MAP_WITH_STATUS}`;

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
  // The acknowledge-only revision registered the same listener, so its tree is one site away from this one.
  const sites = source.includes(ACK_ONLY_MAP) ? [['acknowledge-only handler', ACK_ONLY_MAP, MAP_REPLACE]] : SITES;
  if (sites === SITES && UPSTREAM_HANDLER.test(source)) {
    throw new Error(
      `${RECV_PATH} already registers a CB:status handler: upstream now answers <status> stanzas, ` +
        'and this patch would send a second ack. Check the installed Baileys and retire this patcher',
    );
  }
  for (const [label, find] of sites) {
    const occurrences = source.split(find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `expected exactly 1 ${label} site in ${RECV_PATH}, found ${occurrences}; ` +
          'the upstream shape changed, so check how the library answers a <status> stanza before removing this patcher',
      );
    }
  }
  let patched = source;
  for (const [, find, replace] of sites) patched = patched.replace(find, () => replace);
  writeFileAtomic(file, patched);
  return {
    note: 'decoded and acknowledged the top-level <status> stanza: its status is delivered and the server stops ending the stream over it',
  };
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
 * patch's marker, or a library that answers the stanza itself. The acknowledge-only revision's tree
 * drops every status, so it reads as not applied. Unreadable reads as applied, like the siblings.
 */
function isApplied(baileysDir = DEFAULT_BAILEYS) {
  try {
    const source = fs.readFileSync(path.join(baileysDir, RECV_PATH), 'utf8');
    return source.includes(MARKER) || (UPSTREAM_HANDLER.test(source) && !source.includes(ACK_ONLY_MAP));
  } catch {
    return true;
  }
}

module.exports = {
  applyStatusAckPatch,
  isApplied,
  MAP_FIND,
  MAP_REPLACE,
  HANDLER_FIND,
  HANDLER_REPLACE,
  ACK_ONLY_MAP,
  MARKER,
};
