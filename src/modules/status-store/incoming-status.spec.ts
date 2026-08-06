import { buildIncomingStatus } from './incoming-status';
import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';

const base: IncomingMessage = {
  id: 'false_status@broadcast_ABC',
  from: 'status@broadcast',
  to: 'me@c.us',
  chatId: 'status@broadcast',
  author: '628111@c.us',
  body: 'hello story',
  type: 'text',
  timestamp: 1700000000,
  fromMe: false,
  isGroup: false,
  isStatusBroadcast: true,
  kind: 'status',
};

it('maps a text status to IncomingStatus with the poster as contactJid', () => {
  const s = buildIncomingStatus(base)!;
  expect(s.contactJid).toBe('628111@c.us');
  expect(s.waStatusId).toBe('false_status@broadcast_ABC');
  expect(s.type).toBe('text');
  expect(s.caption).toBe('hello story');
  expect(s.postedAt).toBe(1700000000 * 1000);
});

it('carries media and collapses the type to the status union', () => {
  const s = buildIncomingStatus({
    ...base,
    type: 'image',
    body: 'cap',
    media: { mimetype: 'image/jpeg', data: 'AAAA' },
  })!;
  expect(s.type).toBe('image');
  expect(s.caption).toBe('cap');
  expect(s.media).toEqual({ mimetype: 'image/jpeg', data: 'AAAA' });
});

it('carries text-status styling through to the store row', () => {
  const s = buildIncomingStatus({ ...base, backgroundColor: '#25d366', font: 2 })!;
  expect(s.backgroundColor).toBe('#25d366');
  expect(s.font).toBe(2);
});

it('returns null when the message is not a status', () => {
  expect(buildIncomingStatus({ ...base, isStatusBroadcast: false })).toBeNull();
});

it('falls back to `from` as the poster when the engine did not set `author`', () => {
  const s = buildIncomingStatus({ ...base, author: undefined, from: '628222@c.us' })!;
  expect(s.contactJid).toBe('628222@c.us');
});

it('returns null when there is no resolvable poster (author/from both the broadcast pseudo-JID)', () => {
  expect(buildIncomingStatus({ ...base, author: undefined, from: 'status@broadcast' })).toBeNull();
});

it('returns null when the message has no id', () => {
  expect(buildIncomingStatus({ ...base, id: '' })).toBeNull();
});

/**
 * Both engines map a PTT message to `voice`, and everything that was not an image or a video used to
 * collapse into `text`. That silently turned an incoming voice status into a text one — a status with
 * audio attached but a type saying otherwise.
 */
it('keeps a voice status as voice rather than collapsing it to text', () => {
  const s = buildIncomingStatus({
    ...base,
    type: 'voice',
    body: '',
    media: { mimetype: 'audio/ogg; codecs=opus', data: 'AAAA' },
  })!;

  expect(s.type).toBe('voice');
  expect(s.media?.mimetype).toBe('audio/ogg; codecs=opus');
});

it('still collapses a type the status union does not model', () => {
  expect(buildIncomingStatus({ ...base, type: 'document' })!.type).toBe('text');
  expect(buildIncomingStatus({ ...base, type: 'audio' })!.type).toBe('text');
});
