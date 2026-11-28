/**
 * An inbound media download whose address has expired, through the REAL library and the compiled adapter.
 *
 * The jest specs stub downloadMediaMessage, so they cannot see how the library reports a failed media
 * fetch. Its own expired-address retry reads a numeric `error.status`, while its fetch throws a Boom that
 * keeps the status in `output.statusCode`, so that retry never runs and the adapter has to make it. Here
 * the library's real download path runs, with fetch answering 410 for the old address and the encrypted
 * file for the address the phone's new upload names.
 *
 * Runs over dist/, so it needs `npm run build` first. No network: globalThis.fetch is replaced.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

process.env.MEDIA_DOWNLOAD_ENABLED = 'true';

const require = createRequire(import.meta.url);
const lib = await import('@whiskeysockets/baileys');
const { BaileysEvents } = require('../../dist/engine/adapters/baileys-events.js');
const { ConcurrencyLimiter } = require('../../dist/common/utils/concurrency-limiter.js');

const HOST = 'https://mmg.whatsapp.net';
const OLD_PATH = '/v/t62.7118-24/old.enc';
const NEW_PATH = '/v/t62.7118-24/new.enc';
const silent = { log() {}, debug() {}, verbose() {}, warn() {}, error() {} };

test('media whose address expired is uploaded again by the phone and downloaded from the new address', async t => {
  const photo = Buffer.from('the photo bytes');
  const mediaKey = randomBytes(32);
  const { iv, cipherKey } = await lib.getMediaKeys(mediaKey, 'image');
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(photo), cipher.final()]);

  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname;
    fetched.push(path);
    return path === NEW_PATH ? new Response(encrypted) : new Response('gone', { status: 410 });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  // What the socket's updateMediaMessage does once the phone answers: point the message at the new upload.
  let uploadRequests = 0;
  const updateMediaMessage = async message => {
    uploadRequests++;
    message.message.imageMessage.directPath = NEW_PATH;
    message.message.imageMessage.url = `${HOST}${NEW_PATH}`;
    return message;
  };
  const noop = () => undefined;
  const events = new BaileysEvents({
    getSocket: () => ({ updateMediaMessage }),
    getSocketOrNull: () => null,
    logger: silent,
    toNeutralJid: jid => jid.replace('@s.whatsapp.net', '@c.us'),
    normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
    loadLib: () => Promise.resolve(lib),
    getFetchDispatcher: () => undefined,
    inboundLimiter: new ConcurrencyLimiter(2),
    recordKeyLidMappings: noop,
  });
  const message = lib.proto.WebMessageInfo.fromObject({
    key: { id: 'EXPIRED1', remoteJid: '6281111111111@s.whatsapp.net', fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: {
      imageMessage: {
        url: `${HOST}${OLD_PATH}`,
        directPath: OLD_PATH,
        mediaKey,
        mimetype: 'image/jpeg',
        fileLength: photo.length,
      },
    },
  });

  const incoming = await events.mapMessage(message, 'imageMessage');

  assert.equal(uploadRequests, 1);
  assert.deepEqual(fetched, [OLD_PATH, NEW_PATH]);
  assert.equal(incoming.media?.data, photo.toString('base64'));
});
