// The dialog's focus trap wraps Tab at the first and last control the Tab key can reach. A control with tabindex="-1"
// is not in the Tab order, so it is not an end of the trap: a row of tabs that keeps only the selected one tabbable
// (the install dialog of the Plugins page puts its row before the close button) would otherwise let Shift+Tab from the
// selected tab leave the dialog, because the unselected first tab counted as the first control.
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bindModalA11y } from './modalA11y.ts';

let JSDOM: new (html: string) => { window: Window & typeof globalThis };

before(async () => {
  // @ts-expect-error -- Could not find a declaration file for module 'jsdom'
  ({ JSDOM } = await import('jsdom'));
});

let release: (() => void) | undefined;
afterEach(() => release?.());

// The install dialog's shape: title, the tab row, the close button, a field, then the footer buttons.
function openDialog(selected: 'upload' | 'catalog') {
  const { window } = new JSDOM(`<!doctype html><body>
    <button id="behind">Behind the dialog</button>
    <div id="card" tabindex="-1">
      <div class="header">
        <h2>Install</h2>
        <div role="tablist">
          <button id="upload" role="tab" tabindex="${selected === 'upload' ? 0 : -1}">Upload</button>
          <button id="catalog" role="tab" tabindex="${selected === 'catalog' ? 0 : -1}">Catalog</button>
        </div>
        <button id="close">Close</button>
      </div>
      <div class="body"><input id="field" /></div>
      <div class="footer"><button id="cancel">Cancel</button><button id="install">Install</button></div>
    </div></body>`);
  // No layout in jsdom: every attached element counts as shown, as the other dialog specs have it.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  const doc = window.document;
  const card = doc.getElementById('card') as HTMLElement;
  release = bindModalA11y(doc, card, () => undefined);
  const press = (key: string, shiftKey = false) => {
    const event = new window.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
    (doc.activeElement ?? doc.body).dispatchEvent(event);
    return event.defaultPrevented;
  };
  const activeId = () => doc.activeElement?.id ?? 'nothing';
  return { doc, press, activeId, focus: (id: string) => (doc.getElementById(id) as HTMLElement).focus() };
}

for (const selected of ['upload', 'catalog'] as const) {
  test(`the dialog opens on the selected tab and wraps Tab and Shift+Tab around it (${selected} selected)`, () => {
    const { press, activeId, focus } = openDialog(selected);
    assert.equal(activeId(), selected, 'focus did not start on the selected tab');

    // Shift+Tab from the first control the Tab key reaches wraps to the last one, and Tab from the last wraps back.
    assert.equal(press('Tab', true), true, 'Shift+Tab from the first tab stop was left to the browser');
    assert.equal(activeId(), 'install');
    assert.equal(press('Tab'), true, 'Tab from the last control was left to the browser');
    assert.equal(activeId(), selected);

    // Between the ends the browser moves focus: the trap leaves those keys alone.
    focus(selected);
    assert.equal(press('Tab'), false, 'Tab from the selected tab was taken by the trap');
    focus('close');
    assert.equal(press('Tab', true), false, 'Shift+Tab from the close button was taken by the trap');
  });
}

test('a control outside the Tab order is not an end of the trap', () => {
  const { doc, press, activeId, focus } = openDialog('catalog');
  // The one before the selected tab is the unselected Upload tab. It is no first control: Tab never stops on it.
  focus('catalog');
  assert.equal(press('Tab', true), true);
  assert.equal(activeId(), 'install', 'focus left the dialog or stopped on the tab outside the Tab order');
  assert.ok(doc.getElementById('card')?.contains(doc.activeElement), 'focus is outside the dialog');
});

// A tab selected without taking focus (an assistive technology's click action) leaves focus on the tab that was
// selected before, which is now outside the Tab order. Tab and Shift+Tab move on from where that tab sits in the page,
// so the trap has to take the key when it sits before the first stop or after the last.
test('Shift+Tab from an unselected tab that still holds focus before the first stop wraps to the last control', () => {
  const { doc, press, activeId, focus } = openDialog('catalog');
  focus('upload');
  assert.equal(activeId(), 'upload');
  assert.equal(press('Tab', true), true, 'Shift+Tab was left to the browser, which moves focus behind the dialog');
  assert.equal(activeId(), 'install');
  assert.ok(doc.getElementById('card')?.contains(doc.activeElement), 'focus is outside the dialog');
});

test('Tab from an unselected tab that still holds focus after the last stop wraps to the first control', () => {
  const { window } = new JSDOM(`<!doctype html><body>
    <div id="card" tabindex="-1">
      <input id="field" />
      <div role="tablist">
        <button id="first-tab" role="tab" tabindex="0">One</button>
        <button id="second-tab" role="tab" tabindex="-1">Two</button>
      </div>
    </div>
    <button id="behind">Behind the dialog</button></body>`);
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', {
    get(this: HTMLElement) {
      return this.parentElement;
    },
  });
  const doc = window.document;
  release = bindModalA11y(doc, doc.getElementById('card') as HTMLElement, () => undefined);
  (doc.getElementById('second-tab') as HTMLElement).focus();
  const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  doc.activeElement?.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'Tab was left to the browser, which moves focus behind the dialog');
  assert.equal(doc.activeElement?.id, 'field');
});

test('Shift+Tab from an unselected tab after the first stop is left to the browser, whose next stop is in the dialog', () => {
  const { press, focus } = openDialog('upload');
  focus('catalog');
  assert.equal(press('Tab', true), false, 'Shift+Tab from the middle of the dialog was taken by the trap');
});

test('Tab from an unselected tab before the first stop is left to the browser, whose next stop is in the dialog', () => {
  const { press, focus } = openDialog('catalog');
  focus('upload');
  assert.equal(press('Tab'), false, 'Tab from an element before the first stop was taken by the trap');
});
