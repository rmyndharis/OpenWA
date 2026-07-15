const fs = require('fs');
const path = require('path');

const DEFAULT_TARGET = path.join(
  __dirname,
  '..',
  'node_modules',
  'whatsapp-web.js',
  'src',
  'util',
  'Injected',
  'Utils.js',
);

const OLD_BLOCK = `            const lastMessage = chat.lastReceivedKey
                ? window
                      .require('WAWebCollections')
                      .Msg.get(chat.lastReceivedKey._serialized) ||
                  (
                      await window
                          .require('WAWebCollections')
                          .Msg.getMessagesById([
                              chat.lastReceivedKey._serialized,
                          ])
                  )?.messages?.[0]
                : null;`;

const NEW_BLOCK = `            const lastReceivedKey = chat.lastReceivedKey?._serialized || chat.lastReceivedKey?.toString?.();
            const lastMessage = lastReceivedKey
                ? window
                      .require('WAWebCollections')
                      .Msg.get(lastReceivedKey) ||
                  (
                      await window
                          .require('WAWebCollections')
                          .Msg.getMessagesById([
                              lastReceivedKey,
                          ])
                  )?.messages?.[0]
                : null;`;

function applyPatch(target = DEFAULT_TARGET) {
  const source = fs.readFileSync(target, 'utf8');
  if (source.includes(NEW_BLOCK)) return 'already-patched';
  if (!source.includes(OLD_BLOCK)) {
    throw new Error(`Unsupported whatsapp-web.js Utils.js shape: ${target}`);
  }
  fs.writeFileSync(target, source.replace(OLD_BLOCK, NEW_BLOCK));
  return 'patched';
}

if (require.main === module) {
  const result = applyPatch(process.argv[2] || DEFAULT_TARGET);
  console.log(`patch-wwebjs-lid-last-received-key: ${result}`);
}

module.exports = { applyPatch };
