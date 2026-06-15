import { WhatsAppWebJsAdapter, extractLinkedParentJID } from './whatsapp-web-js.adapter';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';

describe('extractLinkedParentJID (#201)', () => {
  it('returns null when no metadata is provided', () => {
    expect(extractLinkedParentJID()).toBeNull();
    expect(extractLinkedParentJID({})).toBeNull();
  });

  it('reads a string candidate directly', () => {
    expect(extractLinkedParentJID({ parentGroup: '120363000@g.us' })).toBe('120363000@g.us');
  });

  it('reads the _serialized field of a Wid candidate', () => {
    expect(extractLinkedParentJID({ parentGroup: { _serialized: '120363111@g.us' } })).toBe('120363111@g.us');
  });

  it('returns null when a Wid candidate has no _serialized', () => {
    expect(extractLinkedParentJID({ parentGroup: {} })).toBeNull();
  });

  it('prefers parentGroup, then linkedParentGroup, then linkedParent', () => {
    expect(
      extractLinkedParentJID({
        parentGroup: 'a@g.us',
        linkedParentGroup: 'b@g.us',
        linkedParent: 'c@g.us',
      }),
    ).toBe('a@g.us');

    expect(extractLinkedParentJID({ linkedParentGroup: 'b@g.us', linkedParent: 'c@g.us' })).toBe('b@g.us');
    expect(extractLinkedParentJID({ linkedParent: 'c@g.us' })).toBe('c@g.us');
  });

  it('ignores null/undefined candidates and falls through to the next', () => {
    expect(extractLinkedParentJID({ parentGroup: null, linkedParentGroup: 'b@g.us' })).toBe('b@g.us');
  });
});

describe('WhatsAppWebJsAdapter readiness guard (#100)', () => {
  const newAdapter = (): WhatsAppWebJsAdapter =>
    new WhatsAppWebJsAdapter({ sessionId: 'sess-1', sessionDataPath: './data/sessions', puppeteer: {} });

  it('rejects engine read ops with EngineNotReadyError when not connected', async () => {
    const adapter = newAdapter(); // status defaults to DISCONNECTED, no client

    await expect(adapter.getGroups()).rejects.toBeInstanceOf(EngineNotReadyError);
    await expect(adapter.checkNumberExists('628123')).rejects.toBeInstanceOf(EngineNotReadyError);
  });

  it('carries HTTP 409 so NestJS returns "session not connected" (not 500) without a custom filter', () => {
    expect(new EngineNotReadyError().getStatus()).toBe(409);
  });
});
