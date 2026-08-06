import * as fs from 'fs';
import * as path from 'path';

/**
 * Startup guard for the whatsapp-web.js message-id backport that scripts/patch-wwebjs-201832.js
 * applies at install time.
 *
 * WhatsApp Web 2.3000.x renamed the serialized message-id property `id._serialized` to `id.$1`.
 * whatsapp-web.js 1.34.7 still reads the old name, so an install that never received the backport
 * breaks opaquely once WhatsApp Web serves that shape: a send resolves with no message object at
 * all (the gateway then refuses to report a delivery it cannot confirm) and chat and media reads
 * throw the minified `r: r` (#889). None of those errors name their cause.
 *
 * The install already warns when it skips the patch, but that is one line in a full `npm install`
 * transcript, and the symptom only appears later, when WhatsApp Web rolls a build that carries the
 * rename. So restate it on the machine that is actually broken, as the engine starts.
 *
 * The marker is the patcher's own stand-down predicate, so the two can never disagree about what
 * "patched" means.
 */
const NORMALIZED_ID_MARKER = /_normalizeId\(|\.\$1/;

export const BACKPORT_MISSING_MESSAGE =
  'The installed whatsapp-web.js is missing the message-id backport this build requires. On current ' +
  'WhatsApp Web builds every send will fail with "the engine returned no message" — even when the ' +
  'message is delivered — and chat and media reads will fail with "r: r". The install skipped the ' +
  'patch, usually because neither the `patch` binary nor git was available. Apply it with ' +
  '`node scripts/patch-wwebjs-201832.js` (or reinstall with `npm install`) and restart. ' +
  'See docs/12-troubleshooting-faq.md.';

/**
 * Whether the installed whatsapp-web.js is known NOT to carry the backport.
 *
 * Any uncertainty reads as false — package unresolvable, sources pruned, a bundled install. An
 * install we cannot inspect is not evidence of a broken one, and a false alarm would send operators
 * chasing a patch they do not need.
 */
export function isBackportMissing(wwjsDir?: string): boolean {
  try {
    const dir = wwjsDir ?? path.dirname(require.resolve('whatsapp-web.js/package.json'));
    return !NORMALIZED_ID_MARKER.test(fs.readFileSync(path.join(dir, 'src', 'structures', 'Message.js'), 'utf8'));
  } catch {
    return false;
  }
}
