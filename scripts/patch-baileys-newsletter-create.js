/**
 * Stop Baileys' newsletter-create parser from throwing away a channel it just created.
 *
 * `parseNewsletterCreateResponse` (lib/Socket/newsletter.js) builds its result eagerly and reads
 * `thread.picture.id` unconditionally. But `newsletterCreate` sends `input: { name, description }`
 * and its signature is `(name, description?)` — there is **no picture parameter anywhere in the
 * chain** — so a newly created newsletter has no picture and `thread.picture` is null on EVERY
 * create. The parse therefore throws `TypeError: Cannot read properties of null (reading 'id')` for
 * every single call, not for an unlucky subset.
 *
 * The damage is worse than a failed request. WhatsApp creates the newsletter **server-side first**;
 * the parser dies afterwards, on the response. So the caller receives a 500 believing nothing
 * happened, while a real channel is left behind — and `createChannel` is non-idempotent, so a client
 * that retries a 5xx leaks one orphan channel per attempt. Confirmed on the test account: two failed
 * calls, two orphan channels, found only by looking at the handset. There is no API path to find
 * them on that engine, because `getSubscribedChannels` answers 501 on Baileys.
 *
 * **Recovering the id is the point, not merely not crashing.** `response.id` is the only place the
 * new channel's id ever appears, so a parser that returns without it would convert "500 plus an
 * orphan" into "200 with no handle" — arguably worse, since nothing would look wrong. Every nested
 * read is therefore made defensive: whatever else is absent, the id survives.
 *
 * `description` has the same defect and is reachable through this gateway's own API: the create DTO
 * makes it optional and `newsletterCreate` sends `description ?? null`, so a channel created without
 * one gets `thread.description === null` and `thread.description.text` throws exactly as the picture
 * read does.
 *
 * Exact and self-disabling, like the other patchers: an unknown shape fails rather than silently
 * shipping unpatched.
 *
 * **RETIRE THIS, do not keep it.** It compensates for an upstream bug with an obvious upstream fix,
 * and it is not tied to a WhatsApp Web version the way the whatsapp-web.js patchers are. Delete it
 * once @whiskeysockets/baileys tolerates a pictureless newsletter in this parser.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BAILEYS = path.join(__dirname, '..', 'node_modules', '@whiskeysockets', 'baileys');
const NEWSLETTER_PATH = path.join('lib', 'Socket', 'newsletter.js');

const MARKER = 'OpenWA: newsletterCreate cannot supply a picture';

const PARSE_FIND = `    return {
        id: id,
        owner: undefined,
        name: thread.name.text,
        creation_time: parseInt(thread.creation_time, 10),
        description: thread.description.text,
        invite: thread.invite,
        subscribers: parseInt(thread.subscribers_count, 10),
        verification: thread.verification,
        picture: {
            id: thread.picture.id,
            directPath: thread.picture.direct_path
        },
        mute_state: viewer.mute
    };`;

const PARSE_REPLACE = `    // ${MARKER} — its input is { name, description } and nothing else — so
    // \`thread.picture\` is null on every create and this eager read threw for all of them. WhatsApp
    // creates the newsletter BEFORE the response is parsed, so each throw left a real channel behind
    // while the caller saw a 500. \`description\` is null too whenever the caller omitted one
    // (newsletterCreate sends \`description ?? null\`). Read every nested field defensively: \`id\` is
    // the only place the new channel's id appears, so it must survive whatever else is missing.
    return {
        id: id,
        owner: undefined,
        name: thread?.name?.text,
        creation_time: parseInt(thread?.creation_time, 10),
        description: thread?.description?.text,
        invite: thread?.invite,
        subscribers: parseInt(thread?.subscribers_count, 10),
        verification: thread?.verification,
        picture: thread?.picture ? { id: thread.picture.id, directPath: thread.picture.direct_path } : undefined,
        mute_state: viewer?.mute
    };`;

/** Apply the transform. Returns {skipped, reason} or {note} — never a partial write. */
function applyNewsletterCreatePatch(baileysDir = DEFAULT_BAILEYS) {
  const file = path.join(baileysDir, NEWSLETTER_PATH);
  if (!fs.existsSync(file)) {
    return { skipped: true, reason: `${NEWSLETTER_PATH} not found — nothing to patch` };
  }
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(MARKER)) {
    return { skipped: true, reason: 'already patched' };
  }
  const occurrences = source.split(PARSE_FIND).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `expected exactly 1 newsletter-create parse site in ${NEWSLETTER_PATH}, found ${occurrences} — ` +
        'the upstream shape changed; re-check whether a pictureless newsletter still crashes the parser ' +
        'before removing this patcher',
    );
  }
  fs.writeFileSync(file, source.replace(PARSE_FIND, PARSE_REPLACE), 'utf8');
  return { note: 'made the newsletter-create parse tolerate an absent picture, keeping the new channel id' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyNewsletterCreatePatch();
    console.log(`patch-baileys-newsletter-create: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-baileys-newsletter-create: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-baileys-newsletter-create: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyNewsletterCreatePatch, PARSE_FIND, PARSE_REPLACE, MARKER };
