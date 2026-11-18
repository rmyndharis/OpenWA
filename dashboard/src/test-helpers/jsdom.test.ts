import './register-hooks.ts';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Testing Library waits one second for a query or a wait to be satisfied, and a loaded machine does not always grant
// it: the first load of a lazy page under load took longer, and failed a test that was right. The helper that every
// jsdom spec starts with sets a deadline that only a real failure reaches. A satisfied wait still returns at once.
let dom: typeof import('@testing-library/dom');

before(async () => {
  const { installJsdomGlobals } = await import('./jsdom.ts');
  await installJsdomGlobals();
  dom = await import('@testing-library/dom');
});

test('a wait that is satisfied after the old default deadline of one second still succeeds', async () => {
  let ready = false;
  setTimeout(() => (ready = true), 1500);
  await dom.waitFor(() => assert.equal(ready, true));
});

test('a query waits for its element as long as a wait does', async () => {
  setTimeout(
    () => document.body.appendChild(Object.assign(document.createElement('p'), { textContent: 'late' })),
    1500,
  );
  assert.equal((await dom.screen.findByText('late')).textContent, 'late');
});

test('a test that wants a short deadline can still ask for one', async () => {
  const started = performance.now();
  await assert.rejects(dom.waitFor(() => assert.fail('never true'), { timeout: 100 }));
  assert.ok(performance.now() - started < 5_000, 'the explicit timeout was ignored');
});
