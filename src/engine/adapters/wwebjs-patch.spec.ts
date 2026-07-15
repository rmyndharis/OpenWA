import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('patch-wwebjs-lid-last-received-key', () => {
  it('adds a string fallback for WhatsApp MsgKey objects without _serialized', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { applyPatch } = require('../../../scripts/patch-wwebjs-lid-last-received-key');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-patch-'));
    const target = path.join(dir, 'Utils.js');
    fs.writeFileSync(
      target,
      `            const lastMessage = chat.lastReceivedKey
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
                : null;`,
    );

    expect(applyPatch(target)).toBe('patched');
    const patched = fs.readFileSync(target, 'utf8');

    expect(patched).toContain('chat.lastReceivedKey?._serialized || chat.lastReceivedKey?.toString?.()');
    expect(patched).toContain('Msg.get(lastReceivedKey)');
    expect(patched).toContain('Msg.getMessagesById([\n                              lastReceivedKey,');
  });
});
