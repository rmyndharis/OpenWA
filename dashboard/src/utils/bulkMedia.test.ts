import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBulkMessages,
  filenameFromUrl,
  mediaKindFromMime,
  mediaKindFromUrl,
  toBulkAttachment,
} from './bulkMedia.ts';

const file = { base64: 'QUJD', mimetype: 'application/pdf', filename: 'price list.pdf' };

test('maps a MIME type to the bulk media kind, defaulting to document', () => {
  assert.equal(mediaKindFromMime('image/jpeg'), 'image');
  assert.equal(mediaKindFromMime('VIDEO/MP4'), 'video');
  assert.equal(mediaKindFromMime('audio/mpeg'), 'audio');
  assert.equal(mediaKindFromMime('application/pdf'), 'document');
  assert.equal(mediaKindFromMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'document');
  assert.equal(mediaKindFromMime(''), 'document');
});

test('guesses the kind from the URL file extension, ignoring the query string', () => {
  assert.equal(mediaKindFromUrl('https://cdn.example.com/a/photo.JPG'), 'image');
  assert.equal(mediaKindFromUrl('https://cdn.example.com/promo.mp4?token=abc'), 'video');
  assert.equal(mediaKindFromUrl('https://cdn.example.com/voice.ogg'), 'audio');
  assert.equal(mediaKindFromUrl('https://cdn.example.com/report.pdf'), 'document');
  assert.equal(mediaKindFromUrl('https://cdn.example.com/download'), 'document');
  assert.equal(mediaKindFromUrl('not a url'), 'document');
});

test('derives a decoded filename from the URL path', () => {
  assert.equal(filenameFromUrl('https://cdn.example.com/files/price%20list.pdf?x=1'), 'price list.pdf');
  assert.equal(filenameFromUrl('https://cdn.example.com/'), undefined);
  assert.equal(filenameFromUrl('relative/path.pdf'), undefined);
  assert.equal(filenameFromUrl('https://cdn.example.com/bad%E0%A4%A.pdf'), 'bad%E0%A4%A.pdf');
});

test('no file and a blank URL means no attachment', () => {
  assert.equal(toBulkAttachment('image', null, '   '), null);
});

test('a picked file is sent inline and wins over a URL', () => {
  assert.deepEqual(toBulkAttachment('image', { ...file, mimetype: 'image/png' }, 'https://x.test/a.png'), {
    kind: 'image',
    media: { base64: 'QUJD', mimetype: 'image/png' },
  });
});

test('a document keeps the picked filename', () => {
  assert.deepEqual(toBulkAttachment('document', file, ''), {
    kind: 'document',
    media: { base64: 'QUJD', mimetype: 'application/pdf', filename: 'price list.pdf' },
  });
});

test('a URL document takes its filename from the URL, other kinds carry none', () => {
  assert.deepEqual(toBulkAttachment('document', null, ' https://x.test/docs/menu.pdf '), {
    kind: 'document',
    media: { url: 'https://x.test/docs/menu.pdf', filename: 'menu.pdf' },
  });
  assert.deepEqual(toBulkAttachment('video', null, 'https://x.test/clip.mp4'), {
    kind: 'video',
    media: { url: 'https://x.test/clip.mp4' },
  });
});

test('without an attachment every recipient gets a text message', () => {
  assert.deepEqual(buildBulkMessages(['1@c.us', '2@c.us'], 'Hello', null), [
    { chatId: '1@c.us', type: 'text', content: { text: 'Hello' } },
    { chatId: '2@c.us', type: 'text', content: { text: 'Hello' } },
  ]);
});

test('with an attachment the text becomes the caption', () => {
  const attachment = { kind: 'video' as const, media: { url: 'https://x.test/clip.mp4' } };
  assert.deepEqual(buildBulkMessages(['1@c.us'], 'Watch this', attachment), [
    {
      chatId: '1@c.us',
      type: 'video',
      content: { caption: 'Watch this', video: { url: 'https://x.test/clip.mp4' } },
    },
  ]);
});

test('an attachment with blank text is sent without a caption', () => {
  const attachment = { kind: 'document' as const, media: { url: 'https://x.test/a.pdf', filename: 'a.pdf' } };
  assert.deepEqual(buildBulkMessages(['1@c.us'], '  ', attachment), [
    { chatId: '1@c.us', type: 'document', content: { document: { url: 'https://x.test/a.pdf', filename: 'a.pdf' } } },
  ]);
});
