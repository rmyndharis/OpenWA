import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';

let rtl: typeof import('@testing-library/react');
let CustomSelect: (typeof import('./CustomSelect.tsx'))['CustomSelect'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ CustomSelect } = await import('./CustomSelect.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

test('Tab closes open CustomSelect without pulling focus back to the trigger', () => {
  rtl.render(
    createElement(
      'div',
      null,
      createElement(CustomSelect, {
        value: 'a',
        onChange: () => {},
        ariaLabel: 'Engine',
        options: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
      }),
      createElement('button', { type: 'button' }, 'Next control'),
    ),
  );

  const trigger = rtl.screen.getByRole('button', { name: /^Engine/ });
  const nextControl = rtl.screen.getByRole('button', { name: 'Next control' });
  rtl.fireEvent.click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');

  nextControl.focus();
  rtl.fireEvent.keyDown(trigger, { key: 'Tab' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, nextControl);
});

test('multiple CustomSelect instances generate isolated option IDs and matching aria-controls', () => {
  rtl.render(
    createElement(
      'div',
      null,
      createElement(CustomSelect, {
        value: '1',
        onChange: () => {},
        ariaLabel: 'First select',
        options: [
          { value: '1', label: 'One' },
          { value: '2', label: 'Two' },
        ],
      }),
      createElement(CustomSelect, {
        value: '1',
        onChange: () => {},
        ariaLabel: 'Second select',
        options: [
          { value: '1', label: 'Uno' },
          { value: '2', label: 'Dos' },
        ],
      }),
    ),
  );

  const first = rtl.screen.getByRole('button', { name: /^First select/ });
  const second = rtl.screen.getByRole('button', { name: /^Second select/ });
  rtl.fireEvent.click(first);
  rtl.fireEvent.click(second);

  const listboxes = rtl.screen.getAllByRole('listbox');
  assert.equal(listboxes.length, 2);
  assert.notEqual(listboxes[0].id, listboxes[1].id);
  assert.equal(first.getAttribute('aria-controls'), listboxes[0].id);
  assert.equal(second.getAttribute('aria-controls'), listboxes[1].id);

  const optionIds = rtl.screen.getAllByRole('option').map(el => el.id);
  assert.equal(new Set(optionIds).size, optionIds.length);
});
