import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { copyToClipboard } from './clipboard.ts';

function clipboardWorld(t: TestContext, copy: () => boolean, writeText?: (text: string) => Promise<void>) {
  const children: ElementDouble[] = [];
  const doc = {
    activeElement: null as ElementDouble | null,
    body: {
      appendChild(el: ElementDouble) {
        children.push(el);
      },
      removeChild(el: ElementDouble) {
        children.splice(children.indexOf(el), 1);
      },
    },
    createElement: () => new ElementDouble(),
    execCommand: copy,
  };
  class ElementDouble {
    value = '';
    style = { position: '', opacity: '' };
    setAttribute() {}
    select() {
      doc.activeElement = this;
    }
    focus() {
      doc.activeElement = this;
    }
    remove() {
      doc.body.removeChild(this);
    }
  }
  const opener = new ElementDouble();
  opener.focus();
  for (const [key, value] of Object.entries({
    document: doc,
    HTMLElement: ElementDouble,
    navigator: { clipboard: writeText ? { writeText } : undefined },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  return { doc, opener, children };
}

test('a throwing clipboard fallback removes its textarea and restores focus', async t => {
  const { doc, opener, children } = clipboardWorld(t, () => {
    throw new Error('copy unavailable');
  });
  assert.equal(await copyToClipboard('dummy text'), false);
  assert.equal(children.length, 0);
  assert.equal(doc.activeElement, opener);
});

test('a refused clipboard write still cleans up the successful legacy fallback', async t => {
  const { doc, opener, children } = clipboardWorld(
    t,
    () => true,
    async () => {
      throw new Error('denied');
    },
  );
  assert.equal(await copyToClipboard('dummy text'), true);
  assert.equal(children.length, 0);
  assert.equal(doc.activeElement, opener);
});

test('a false legacy copy result also removes its textarea and restores focus', async t => {
  const { doc, opener, children } = clipboardWorld(t, () => false);
  assert.equal(await copyToClipboard('dummy text'), false);
  assert.equal(children.length, 0);
  assert.equal(doc.activeElement, opener);
});
