/**
 * Add destination-chat context to whatsapp-web.js link-preview generation.
 *
 * WhatsApp Web selects a different preview transport for newsletters. The released
 * whatsapp-web.js 1.34.7 call omits the chat, so the internal action cannot select
 * that transport even though the message is later sent through the newsletter job.
 *
 * The source transform is deliberately exact and self-disabling. An unknown shape
 * fails the production image build instead of silently shipping without the fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');
const LEGACY_CALL =
  "let preview = await window\n                    .require('WAWebLinkPreviewChatAction')\n                    .getLinkPreview(link);";
const CONTEXT_CALL =
  "let preview = await window\n                    .require('WAWebLinkPreviewChatAction')\n                    .getLinkPreview(link, chat);";

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyBackport(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  const source = fs.readFileSync(utilsFile, 'utf8');
  const legacyCount = occurrences(source, LEGACY_CALL);
  const contextCount = occurrences(source, CONTEXT_CALL);

  if (legacyCount === 0 && contextCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already passes destination chat context',
    };
  }
  if (legacyCount !== 1 || contextCount !== 0) {
    throw new Error(
      `unsupported Utils.js shape (legacy calls: ${legacyCount}, context calls: ${contextCount}); ` +
        're-evaluate the newsletter preview backport against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(utilsFile, source.replace(LEGACY_CALL, CONTEXT_CALL));
  return { skipped: false, note: 'destination chat context added to link previews' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyBackport();
    console.log(
      `patch-wwebjs-newsletter-preview: ${result.skipped ? `skipped — ${result.reason}` : result.note}`,
    );
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-newsletter-preview: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-newsletter-preview: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyBackport, LEGACY_CALL, CONTEXT_CALL };
