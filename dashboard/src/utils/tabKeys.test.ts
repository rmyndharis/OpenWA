// The keys of a tab row: an arrow key selects the next or previous tab and wraps, Home and End go to the ends, a
// right-to-left row swaps the two arrows, and everything else (a modified key, an input method's key, another key,
// a press on something that is not a tab) is left to the browser.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';

let rtl: typeof import('@testing-library/react');
let onTabListKeyDown: (typeof import('./tabKeys.ts'))['onTabListKeyDown'];

const NAMES = ['One', 'Two', 'Three'];
let clicks: string[] = [];

// A row wired as the pages wire theirs: the helper on the tablist, the selected tab the only one in the Tab order.
function Tabs() {
  const [selected, setSelected] = useState(0);
  return createElement(
    'div',
    { role: 'tablist', onKeyDown: onTabListKeyDown },
    NAMES.map((name, index) =>
      createElement(
        'button',
        {
          key: name,
          role: 'tab',
          'aria-selected': selected === index,
          tabIndex: selected === index ? 0 : -1,
          onClick: () => {
            clicks.push(name);
            setSelected(index);
          },
        },
        name,
      ),
    ),
    createElement('button', { type: 'button' }, 'Not a tab'),
  );
}

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ onTabListKeyDown } = await import('./tabKeys.ts'));
});

afterEach(() => {
  rtl.cleanup();
  document.documentElement.removeAttribute('dir');
  clicks = [];
});

const tab = (name: string) => rtl.screen.getByRole('tab', { name });
const focused = () => document.activeElement?.textContent ?? 'nothing';
const selected = () =>
  rtl.screen
    .getAllByRole('tab')
    .filter(el => el.getAttribute('aria-selected') === 'true')
    .map(el => el.textContent);

/** Presses `key` on the tab called `on`, and says whether the browser was left to act on it. */
function press(on: string, key: string, init: Record<string, unknown> = {}): boolean {
  const target = rtl.screen.getByText(on);
  target.focus();
  return rtl.fireEvent.keyDown(target, { key, ...init });
}

test('the arrow keys select the next and previous tab, take focus there and wrap at the ends', () => {
  rtl.render(createElement(Tabs));
  const moves: [string, string, string][] = [
    ['One', 'ArrowRight', 'Two'],
    ['Two', 'ArrowRight', 'Three'],
    ['Three', 'ArrowRight', 'One'],
    ['One', 'ArrowLeft', 'Three'],
    ['Three', 'ArrowLeft', 'Two'],
  ];
  for (const [from, key, to] of moves) {
    assert.equal(press(from, key), false, `${key} on ${from} was left to the browser`);
    assert.equal(focused(), to, `${key} on ${from} moved focus to ${focused()}`);
    assert.deepEqual(selected(), [to], `${key} on ${from} selected ${selected().join()}`);
  }
});

test('Home and End select the first and the last tab', () => {
  rtl.render(createElement(Tabs));
  assert.equal(press('One', 'End'), false);
  assert.deepEqual([focused(), selected()], ['Three', ['Three']]);
  assert.equal(press('Three', 'Home'), false);
  assert.deepEqual([focused(), selected()], ['One', ['One']]);
});

test('the tab row is one stop in the Tab order', () => {
  rtl.render(createElement(Tabs));
  const stops = () => rtl.screen.getAllByRole('tab').filter(el => el.getAttribute('tabindex') === '0');
  assert.deepEqual(
    stops().map(el => el.textContent),
    ['One'],
  );
  press('One', 'ArrowRight');
  assert.deepEqual(
    stops().map(el => el.textContent),
    ['Two'],
  );
});

test('a right-to-left row swaps the arrow keys and keeps Home and End', () => {
  document.documentElement.dir = 'rtl';
  rtl.render(createElement(Tabs));
  press('One', 'ArrowLeft');
  assert.deepEqual([focused(), selected()], ['Two', ['Two']], 'ArrowLeft is the way forward in a right-to-left row');
  press('Two', 'ArrowRight');
  assert.deepEqual([focused(), selected()], ['One', ['One']], 'ArrowRight is the way back in a right-to-left row');
  press('One', 'ArrowRight');
  assert.deepEqual([focused(), selected()], ['Three', ['Three']], 'ArrowRight wraps from the first tab to the last');
  press('Three', 'Home');
  assert.deepEqual([focused(), selected()], ['One', ['One']]);
});

test('a key it does not own is left to the browser, with no tab selected', () => {
  rtl.render(createElement(Tabs));
  for (const [key, init] of [
    ['ArrowDown', {}],
    ['Tab', {}],
    ['Enter', {}],
    ['ArrowRight', { shiftKey: true }],
    ['ArrowRight', { altKey: true }],
    ['ArrowLeft', { metaKey: true }],
    ['ArrowRight', { ctrlKey: true }],
    ['ArrowRight', { isComposing: true }],
    ['ArrowRight', { keyCode: 229 }],
  ] as [string, Record<string, unknown>][]) {
    assert.equal(press('One', key, init), true, `${key} ${JSON.stringify(init)} was taken`);
  }
  assert.deepEqual([focused(), selected(), clicks], ['One', ['One'], []]);
});

test('a key pressed on something that is not a tab is left alone', () => {
  rtl.render(createElement(Tabs));
  assert.equal(press('Not a tab', 'ArrowRight'), true);
  assert.deepEqual([focused(), selected(), clicks], ['Not a tab', ['One'], []]);
});

test('a key that stays on the current tab does not press it again', () => {
  rtl.render(createElement(Tabs));
  press('One', 'Home');
  press('One', 'ArrowRight');
  press('Two', 'ArrowLeft');
  press('One', 'Home');
  assert.deepEqual(clicks, ['Two', 'One'], 'Home on the first tab pressed it again');
  assert.equal(focused(), tab('One').textContent);
});
