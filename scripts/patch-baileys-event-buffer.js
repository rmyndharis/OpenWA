/**
 * Make the Baileys event buffer keep every buffered event it currently drops or overwrites, in
 * lib/Utils/event-buffer.js.
 *
 * While the buffer is on (from a linked account's connect until the offline marker or 30 seconds,
 * and around every node the socket processes), append() folds what is emitted into one batch per
 * flush. Three of its merges lose data the adapter reports:
 *
 *  1. `groups.update` is stored only when the group has no update yet in the window. WhatsApp sends
 *     one notification per changed setting, so a rename and a new description saved together, or
 *     every change replayed after downtime, reach the listener as the first change only. A
 *     groupFetchAllParticipating() snapshot that lands first (every connect, every GET of the groups)
 *     also hides a real change after it, and the adapter skips the snapshot, so nothing is announced.
 *  2. `messaging-history.set` merges chats, contacts, messages and past participants, and drops
 *     `lidPnMappings`: a sync emitted while buffering reaches the listener without its lid to phone
 *     pairs, while the same sync emitted unbuffered keeps them.
 *  3. `messages.update` merges the updates of one message with Object.assign. A decrypted RSVP arrives
 *     as `{ eventResponses: [rsvp] }` keyed by its event, so of several answers to one event in the
 *     window only the last is delivered.
 *
 * The patch keeps the updates of a group as an ordered list (flattened when the batch is emitted, so
 * the order within a group holds while groups keep the order they first appeared in), concatenates the
 * pairs into the consolidated history set, and concatenates the RSVPs of a message. Every other field
 * keeps the library's merge. The adapter already takes one change, one pair and one RSVP per entry.
 *
 * Exact and self-disabling, like the other patchers: the five sites are all or nothing, an unknown
 * shape fails rather than shipping unpatched, and a library that carries all three fixes itself (a
 * groups.update case without the first-wins guard, and a buffer that handles lidPnMappings and
 * eventResponses) is left alone. A library that carries only some of them fails too, as an unknown shape.
 *
 * **RETIRE THIS** once @whiskeysockets/baileys keeps these events itself. rc14 is the latest release,
 * and the main branch still drops all three.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const BUFFER_PATH = path.join('lib', 'Utils', 'event-buffer.js');

const MARKER = 'OpenWA: keep every buffered group update, history pair and RSVP';

const GROUPS_FIND = `        case 'groups.update':
            const groupUpdates = eventData;
            for (const update of groupUpdates) {
                const id = update.id;
                const groupUpdate = data.groupUpdates[id] || {};
                if (!data.groupUpdates[id]) {
                    data.groupUpdates[id] = Object.assign(groupUpdate, update);
                }
            }
            break;`;

const GROUPS_REPLACE = `        case 'groups.update':
            // ${MARKER}.
            // Every update of a group, in order: WhatsApp sends one per changed setting, and a snapshot
            // (groupFetchAllParticipating) must not hide a change that follows it in the window.
            const groupUpdates = eventData;
            for (const update of groupUpdates) {
                const id = update.id;
                (data.groupUpdates[id] = data.groupUpdates[id] || []).push(update);
            }
            break;`;

const GROUP_LIST_FIND = '    const groupUpdateList = Object.values(data.groupUpdates);';
const GROUP_LIST_REPLACE = '    const groupUpdateList = Object.values(data.groupUpdates).flat();';

const HISTORY_FIND = '            data.historySets.syncType = eventData.syncType;\n';
const HISTORY_REPLACE = `${HISTORY_FIND}            // The sync's lid to phone pairs, which the consolidated set used to leave out
            data.historySets.lidPnMappings = [...(data.historySets.lidPnMappings || []), ...(eventData.lidPnMappings || [])];
`;

const HISTORY_EMIT_FIND = '            pastParticipants: data.historySets.pastParticipants,\n';
const HISTORY_EMIT_REPLACE = `${HISTORY_EMIT_FIND}            lidPnMappings: data.historySets.lidPnMappings,
`;

const RSVP_FIND = `                    const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} };
                    Object.assign(msgUpdate.update, update);`;

const RSVP_REPLACE = `                    const msgUpdate = data.messageUpdates[keyStr] || { key, update: {} };
                    // One RSVP per update: keep every one rather than the last
                    const eventResponses = [...(msgUpdate.update.eventResponses || []), ...(update.eventResponses || [])];
                    Object.assign(msgUpdate.update, update);
                    if (eventResponses.length) {
                        msgUpdate.update.eventResponses = eventResponses;
                    }`;

const SITES = [
  ['groups.update append', GROUPS_FIND, GROUPS_REPLACE],
  ['groups.update list', GROUP_LIST_FIND, GROUP_LIST_REPLACE],
  ['history set append', HISTORY_FIND, HISTORY_REPLACE],
  ['history set emit', HISTORY_EMIT_FIND, HISTORY_EMIT_REPLACE],
  ['messages.update merge', RSVP_FIND, RSVP_REPLACE],
];

const GROUPS_CASE = /case 'groups\.update':((?:(?!break;)[\s\S])*)break;/;

/** A library that keeps all three itself: no first-wins guard on group updates, and a buffer that handles both lists. */
function carriesFix(source) {
  const groups = GROUPS_CASE.exec(source);
  return (
    !!groups &&
    !/if \(!data\.groupUpdates\[/.test(groups[1]) &&
    source.includes('lidPnMappings') &&
    source.includes('eventResponses')
  );
}

/** Apply the transform. Returns {skipped, reason} or {note}, never a partial write. */
function applyEventBufferPatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, BUFFER_PATH);
  if (!fs.existsSync(file)) {
    throw new Error(`@whiskeysockets/baileys ${BUFFER_PATH} not found at ${file}`);
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  const counts = SITES.map(([, find]) => source.split(find).length - 1);
  if (counts.every(count => count === 0) && carriesFix(source)) {
    return { skipped: true, reason: 'the library already keeps every buffered group update, history pair and RSVP' };
  }
  SITES.forEach(([label], i) => {
    if (counts[i] !== 1) {
      throw new Error(
        `expected exactly 1 ${label} site in ${BUFFER_PATH}, found ${counts[i]}; ` +
          'the upstream shape changed, so check what the buffer now keeps before removing this patcher',
      );
    }
  });
  let patched = source;
  for (const [, find, replace] of SITES) patched = patched.replace(find, () => replace);
  writeFileAtomic(file, patched);
  return {
    note: 'the event buffer keeps every group update, the history sync lid to phone pairs and every RSVP',
  };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyEventBufferPatch();
    console.log(`patch-baileys-event-buffer: ${result.skipped ? `skipped, ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-event-buffer: skipped, ${error.message}`);
      return;
    }
    console.error(`patch-baileys-event-buffer: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

/**
 * The stand-down branches above as a predicate, for the startup guard (engine-patch-status.ts): this
 * patch's marker, or a library that keeps all three itself. Unreadable reads as applied, like the siblings.
 */
function isApplied(baileysDir = DEFAULT_BAILEYS) {
  try {
    const source = fs.readFileSync(path.join(baileysDir, BUFFER_PATH), 'utf8');
    return source.includes(MARKER) || carriesFix(source);
  } catch {
    return true;
  }
}

module.exports = {
  applyEventBufferPatch,
  isApplied,
  SITES,
  GROUPS_FIND,
  GROUP_LIST_FIND,
  HISTORY_FIND,
  HISTORY_EMIT_FIND,
  RSVP_FIND,
  MARKER,
};
