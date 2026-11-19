// Renaming a saved contact starts from the chat's name. A name that is no name, the chat's own id (whatsapp-web.js
// names an unnamed privacy-id chat by it), a push name or the number, must not be put in the first name field.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import type { Chat } from '../../services/api.ts';

let rtl: typeof import('@testing-library/react');
let SaveContactDialog: (typeof import('./ChatDialogs.tsx'))['SaveContactDialog'];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ SaveContactDialog } = await import('./ChatDialogs.tsx'));
});

afterEach(() => rtl.cleanup());

const chat = (id: string, name: string, phone?: string): Chat => ({
  id,
  name,
  ...(phone ? { phone } : {}),
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp: 0,
  archived: false,
  pinned: false,
  muted: false,
});

function fieldsFor(target: Chat): [string, string] {
  rtl.render(
    createElement(SaveContactDialog, {
      chat: target,
      saved: true,
      busy: false,
      onSave: () => undefined,
      onClose: () => undefined,
    }),
  );
  const value = (label: string) => (rtl.screen.getByLabelText(label) as HTMLInputElement).value;
  return [value('First name'), value('Last name (optional)')];
}

const LID = '262813461250072@lid';

test('a saved contact starts from its name, split at the first space', () => {
  assert.deepEqual(fieldsFor(chat('15550001111@c.us', 'Alice Smith')), ['Alice', 'Smith']);
});

for (const [what, target] of [
  ['the privacy id with its suffix', chat(LID, LID)],
  ['the privacy id digits', chat(LID, '262813461250072')],
  ['the mapped phone written as a number', chat(LID, '+1 555 000 6666', '15550006666')],
  ['the digits of a phone id', chat('15550001111@s.whatsapp.net', '15550001111')],
  ['a push name', chat('15550001111@c.us', '~Max')],
  ['a number', chat('15550001111@c.us', '+1 555 000 1111')],
] as const) {
  test(`${what} is no name to start from`, () => {
    assert.deepEqual(fieldsFor(target), ['', '']);
  });
}

test('a name that holds the mapped phone among other words is still a name to start from', () => {
  assert.deepEqual(fieldsFor(chat(LID, 'Taxi 15550006666', '15550006666')), ['Taxi', '15550006666']);
});
