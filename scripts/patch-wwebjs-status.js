/**
 * Repair status posting on whatsapp-web.js 1.34.7, which current WhatsApp Web builds have broken in
 * two independent places. Both faults were confirmed on a live account against stock 1.34.7 with
 * none of this project's code involved.
 *
 * 1. Ranking-gating guard. Every status message is built with
 *    `window.require('WAWebStatusGatingUtils').canCheckStatusRankingPosterGating()` as
 *    `cannotBeRanked`. That helper is gone from current WhatsApp Web builds, so the call threw
 *    before the message was ever sent — text, image, video and voice alike. The replacement calls
 *    the helper when it is there and falls back to `false` (the pre-gating meaning) when it is not,
 *    keeping behaviour intact wherever the API still exists rather than assuming it is gone
 *    everywhere.
 *
 * 2. Media send signature. `sendStatusMediaMsgAction` no longer accepts the positional
 *    `(msg, mediaUpdate)` pair; it takes a single options object and builds the message itself,
 *    so the old call dies inside WhatsApp Web's bundle with
 *    `Cannot read properties of undefined (reading 'id')`. The replacement is adopted from the
 *    open upstream fix (wwebjs/whatsapp-web.js#201816): pass
 *    `{ mediaMsgData, beforeSend, funnelContext }` and return a model built from `mediaMsgData`,
 *    since the model constructed for the old flow is no longer the message that gets sent. The
 *    upstream PR also hardcodes `cannotBeRanked: false`; the guard above is kept instead because
 *    it preserves the live call on builds that still provide the helper.
 *
 * Each transform is deliberately exact and self-disabling: an unknown shape fails the build
 * instead of silently shipping without the fix, matching the sibling patchers. The two edits of
 * the media repair are all-or-nothing — applying one without the other would leave the injected
 * code referencing a variable that no longer exists — and the file is written once, after every
 * group has been resolved, so a refused transform never leaves a half-patched tree behind.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

const GATING_FIND = `                    cannotBeRanked: window
                        .require('WAWebStatusGatingUtils')
                        .canCheckStatusRankingPosterGating(),`;

const GATING_REPLACE = `                    cannotBeRanked: (() => {
                        // WAWebStatusGatingUtils.canCheckStatusRankingPosterGating is absent from
                        // current WhatsApp Web builds; calling it unguarded threw before the status
                        // was sent, breaking every status type. false is the pre-gating meaning.
                        try {
                            const gating = window.require('WAWebStatusGatingUtils');
                            return typeof gating?.canCheckStatusRankingPosterGating === 'function'
                                ? gating.canCheckStatusRankingPosterGating()
                                : false;
                        } catch {
                            return false;
                        }
                    })(),`;

const MEDIA_DATA_FIND = `            const mediaUpdate = (data) =>
                window.require('WAWebMediaUpdateMsg')(data, mediaOptions);`;

const MEDIA_DATA_REPLACE = `            const mediaMsgData = {
                ...message,
                from: from,
                to: chat.id,
                author: from,
            };`;

const MEDIA_SEND_FIND = `            await window
                .require('WAWebSendStatusMsgAction')
                [
                    isMedia
                        ? 'sendStatusMediaMsgAction'
                        : 'sendStatusTextMsgAction'
                ](...(isMedia ? [msg, mediaUpdate] : [statusOptions]));

            return msg;`;

const MEDIA_SEND_REPLACE = `            await window
                .require('WAWebSendStatusMsgAction')
                [
                    isMedia
                        ? 'sendStatusMediaMsgAction'
                        : 'sendStatusTextMsgAction'
                ](
                    ...(isMedia
                        ? [
                              {
                                  mediaMsgData,
                                  beforeSend: async () => {},
                                  funnelContext: undefined,
                              },
                          ]
                        : [statusOptions]),
                );

            return isMedia
                ? new (window.require('WAWebCollections').Msg.modelClass)(
                      mediaMsgData,
                  )
                : msg;`;

/**
 * The independently skippable units. A group is applied only when every edit's `find` is present
 * exactly once and none of its `replace`s are, and skipped only when the mirror holds — anything
 * else is an upstream shape this patcher was not written for, and it must refuse loudly.
 */
const GROUPS = [
  {
    name: 'status ranking-gating guard',
    edits: [{ find: GATING_FIND, replace: GATING_REPLACE }],
  },
  {
    name: 'media status send repair',
    edits: [
      { find: MEDIA_DATA_FIND, replace: MEDIA_DATA_REPLACE },
      { find: MEDIA_SEND_FIND, replace: MEDIA_SEND_REPLACE },
    ],
  },
];

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyStatusPatches(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  let source = fs.readFileSync(utilsFile, 'utf8');
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
      `unsupported Utils.js shape for the ${group.name} ` +
        `(unpatched: ${finds.join(',')}, patched: ${replaces.join(',')}); ` +
        're-evaluate this transform against the installed whatsapp-web.js',
    );
  }

  if (applied.length) {
    fs.writeFileSync(utilsFile, source);
  }
  return { applied, skipped };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const { applied, skipped } = applyStatusPatches();
    const report = [
      ...applied.map((name) => `applied ${name}`),
      ...skipped.map((name) => `skipped ${name} (already present)`),
    ].join('; ');
    console.log(`patch-wwebjs-status: ${report}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-status: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-status: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = {
  applyStatusPatches,
  GROUPS,
  GATING_FIND,
  GATING_REPLACE,
  MEDIA_DATA_FIND,
  MEDIA_DATA_REPLACE,
  MEDIA_SEND_FIND,
  MEDIA_SEND_REPLACE,
};
