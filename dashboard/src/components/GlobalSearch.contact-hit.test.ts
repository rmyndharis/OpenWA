// A search hit on a shared contact. The gateway stores the contact's vCard as the message body, so the excerpt of a hit
// is a window of the card's property lines; the chat list row of the same message reads the contact's name and phone.
// The hit reads the same way, and every other kind of hit keeps its highlighted excerpt.
import '../test-helpers/register-hooks.ts';
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { isolateNumber } from '../utils/formatPhone.ts';

const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:;Carlos;;;',
  'FN:Carlos',
  'item1.TEL;waid=5491161862313:+54 9 11 6186-2313',
  'item1.X-ABLabel:Mobile',
  'END:VCARD',
].join('\n');

const hit = (messageId: string, over: Record<string, unknown>) => ({
  messageId,
  waMessageId: `wamid.${messageId}`,
  sessionId: 'sess-1',
  chatId: '5491161862313@c.us',
  timestamp: 1_767_225_600,
  direction: 'incoming',
  from: '5491161862313@c.us',
  ...over,
});

const HITS = [
  hit('contact', {
    type: 'contact',
    body: VCARD,
    snippet: VCARD.replace('Carlos', '<mark>Carlos</mark>').replace(/\n/g, ' '),
  }),
  hit('gateway-sent', { type: 'contact', body: '📇 Carol Jones', snippet: '📇 Carol <mark>Jones</mark>' }),
  hit('text', {
    type: 'text',
    body: 'Carlos asked for the invoice',
    snippet: '<mark>Carlos</mark> asked for the invoice',
  }),
];
const EMPTY_CARD = hit('empty', { type: 'contact', body: 'BEGIN:VCARD\nEND:VCARD', snippet: 'BEGIN:VCARD END:VCARD' });

const realFetch = globalThis.fetch;
// What the stubbed search answers with; every test that changes it is put back by afterEach.
let answer: Array<ReturnType<typeof hit>> = HITS;
let rtl: typeof import('@testing-library/react');
let GlobalSearch: (typeof import('./GlobalSearch.tsx'))['GlobalSearch'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ hits: answer, total: answer.length, tookMs: 1, provider: 'builtin-fts' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ GlobalSearch } = await import('./GlobalSearch.tsx'));
});

afterEach(() => {
  rtl.cleanup();
  answer = HITS;
});

after(() => {
  globalThis.fetch = realFetch;
});

/** The excerpt each listed hit shows, once the search for `term` has answered. */
async function excerptsFor(term: string): Promise<HTMLElement[]> {
  rtl.render(createElement(GlobalSearch, { onHit: () => undefined }));
  rtl.fireEvent.change(rtl.screen.getByRole('combobox'), { target: { value: term } });
  const options = await rtl.screen.findAllByRole('option', undefined, { timeout: 10_000 });
  assert.equal(options.length, answer.length, 'the search did not list every hit');
  return options.map(option => option.querySelector('.global-search-hit-snippet') as HTMLElement);
}

test('a search hit on a shared contact names the contact and the phone, never the vCard text', async () => {
  const [contact, gatewaySent] = await excerptsFor('Carlos');
  assert.equal(contact.textContent, `Carlos · ${isolateNumber('+54 9 11 6186-2313')}`);
  assert.equal(contact.textContent?.includes('BEGIN:VCARD'), false);
  // A contact the gateway sent is stored as the card emoji and the name, which already reads well.
  assert.equal(gatewaySent.textContent, '📇 Carol Jones');
});

test('a search hit on any other message keeps its highlighted excerpt', async () => {
  const text = (await excerptsFor('Carlos'))[2];
  assert.equal(text.textContent, 'Carlos asked for the invoice');
  assert.equal(text.querySelector('mark')?.textContent, 'Carlos');
});

test('a search hit on a contact whose card holds no name or phone says Contact', async () => {
  answer = [EMPTY_CARD];
  const [empty] = await excerptsFor('vcard');
  assert.equal(empty.textContent, 'Contact');
});
