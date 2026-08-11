/**
 * Make whatsapp-web.js report which requested participants it actually acted on.
 *
 * `GroupChat.removeParticipants` / `promoteParticipants` / `demoteParticipants` resolve every
 * requested id against the group's OWN participant collection and silently drop what they cannot
 * find (`.filter(Boolean)`), then hand the survivors to a WA Web request builder and resolve
 * `{status: 200}` for the whole batch. Two failures follow, both reproduced live (#1220):
 *
 * 1. When EVERY requested id is dropped the builder receives an empty repeated field and asserts
 *    "expected at least 1 children, but found 0". The page rejects, and because the adapter only
 *    inspects a RESOLVED value the error escapes as an unnamed `500`.
 * 2. When only SOME are dropped — or, for promote/demote, when all are — the call still resolves
 *    `{status: 200}` with no indication of what was ignored, so the adapter reports success for
 *    people WhatsApp never touched. Promote and demote have no arity assertion at all, which makes
 *    their version of this silent rather than loud.
 *
 * One transform per page function, each its own group so an upstream change to one does not disable
 * the other two:
 *  - keep the resolved array WITH its holes, so position still maps to the requested id;
 *  - derive `matched` (a boolean per requested id) and `present` (the survivors);
 *  - call the WA Web action only when something survived — an empty batch is not a request;
 *  - return `matched` alongside the status. The adapter treats a missing or wrong-length `matched`
 *    as "unpatched tree" and keeps its old behaviour, matching the `eventsAttached` marker
 *    convention in patch-wwebjs-ready-sync.js.
 *
 * The source transform is deliberately exact and self-disabling: an unknown shape fails the build
 * instead of silently shipping without the fix, matching the sibling patchers. The file is written
 * once, after the whole group set resolves.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const GROUP_CHAT_PATH = path.join('src', 'structures', 'GroupChat.js');

/**
 * The three page bodies are identical apart from the action name, which is what makes each find
 * unique. Building them from one template keeps the 16-space indentation in step with upstream
 * rather than repeating it three times by hand.
 */
const findFor = (action) => `                ).filter(Boolean);
                await window
                    .require('WAWebModifyParticipantsGroupAction')
                    .${action}(chat, participants);
                return { status: 200 };`;

/**
 * Which resolved members still need the call. `remove` acts on every member; `promote`/`demote` act
 * only on those not already in the requested state — WhatsApp Web rejects a status change that would
 * change nothing, and the minified page bundle reports that as an unnamed error, so promoting an
 * existing admin answered 500. Skipping them makes the operation idempotent: the requested end state
 * already holds, which is exactly what the caller asked for.
 */
const actionableFor = (action) =>
  action === 'promoteParticipants'
    ? 'participants.filter((p) => p && !p.isAdmin)'
    : action === 'demoteParticipants'
      ? 'participants.filter((p) => p && p.isAdmin)'
      : 'participants.filter(Boolean)';

const replaceFor = (action) => `                );
                const matched = participants.map(Boolean);
                const present = ${actionableFor(action)};
                // A requested id that is not a member of this group resolved to undefined above.
                // Handing an empty list to the request builder trips its repeated-field arity
                // assertion, so skip the call entirely when nothing resolved, and report which
                // requested ids did — the batch status alone cannot distinguish a real change
                // from a silently dropped one.
                if (present.length) {
                    await window
                        .require('WAWebModifyParticipantsGroupAction')
                        .${action}(chat, present);
                }
                return { status: 200, matched };`;

/**
 * The shape an earlier version of this patcher left behind: same transform, but `present` was every
 * resolved member regardless of the status change being a no-op. A tree carrying it matches neither
 * the pristine find nor the current replace, so the patcher would refuse it as an unknown shape.
 * Reverse it to pristine first and the normal apply path takes over — that is what makes upgrading
 * the patcher safe on a tree someone already installed against.
 */
const LEGACY_REPLACE = (action) => `                );
                const matched = participants.map(Boolean);
                const present = participants.filter(Boolean);
                // A requested id that is not a member of this group resolved to undefined above.
                // Handing an empty list to the request builder trips its repeated-field arity
                // assertion, so skip the call entirely when nothing resolved, and report which
                // requested ids did — the batch status alone cannot distinguish a real change
                // from a silently dropped one.
                if (present.length) {
                    await window
                        .require('WAWebModifyParticipantsGroupAction')
                        .${action}(chat, present);
                }
                return { status: 200, matched };`;

/**
 * Rewind any legacy-patched body to the pristine upstream shape. A no-op on pristine or current
 * trees.
 *
 * Skips an action whose legacy body is IDENTICAL to the current one — `removeParticipants` acts on
 * every member in both versions. Rewinding that would undo a correctly patched tree and then re-apply
 * it, so `applied` would never be empty and the patcher would stop being idempotent.
 */
function normalizeLegacy(source) {
  for (const action of ACTIONS) {
    const legacy = LEGACY_REPLACE(action);
    if (legacy === replaceFor(action)) continue;
    source = source.split(legacy).join(findFor(action));
  }
  return source;
}

const ACTIONS = ['removeParticipants', 'promoteParticipants', 'demoteParticipants'];

const GROUPS = ACTIONS.map((action) => ({
  name: `${action} batch truth`,
  edits: [{ find: findFor(action), replace: replaceFor(action) }],
}));

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyParticipantArityPatches(wwjsDir = DEFAULT_WWJS) {
  const groupChatFile = path.join(wwjsDir, GROUP_CHAT_PATH);
  if (!fs.existsSync(groupChatFile)) {
    throw new Error(`whatsapp-web.js GroupChat.js not found at ${groupChatFile}`);
  }

  const original = fs.readFileSync(groupChatFile, 'utf8');
  // Rewind a tree patched by an earlier version of this file, so the apply path below sees either
  // the pristine shape or the current one — never a third state it would have to refuse.
  let source = normalizeLegacy(original);
  const applied = [];
  const skipped = [];

  for (const group of GROUPS) {
    const finds = group.edits.map((edit) => occurrences(source, edit.find));
    const replaces = group.edits.map((edit) => occurrences(source, edit.replace));

    if (finds.every((count) => count === 0) && replaces.every((count) => count === 1)) {
      skipped.push(group.name);
      continue;
    }
    if (finds.every((count) => count === 1) && replaces.every((count) => count === 0)) {
      for (const edit of group.edits) {
        source = source.replace(edit.find, edit.replace);
      }
      applied.push(group.name);
      continue;
    }
    throw new Error(
      `unsupported GroupChat.js shape for the ${group.name} ` +
        `(unpatched: ${finds.join(',')}, patched: ${replaces.join(',')}); ` +
        're-evaluate this transform against the installed whatsapp-web.js',
    );
  }

  if (applied.length) {
    fs.writeFileSync(groupChatFile, source);
  }
  return { applied, skipped };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied, skipped } = applyParticipantArityPatches();
    const report = [
      ...applied.map((name) => `applied ${name}`),
      ...skipped.map((name) => `skipped ${name} (already present)`),
    ].join('; ');
    console.log(`patch-wwebjs-participant-arity: ${report}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-participant-arity: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-participant-arity: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  applyParticipantArityPatches,
  GROUPS,
  ACTIONS,
  findFor,
  replaceFor,
  LEGACY_REPLACE,
  normalizeLegacy,
};
