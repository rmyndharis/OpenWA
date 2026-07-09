import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderHighlightedSnippet } from './search-highlight.ts';

test('splits a <mark>-carrying snippet into text + marked segments', () => {
  const segs = renderHighlightedSnippet('hello <mark>world</mark>!');
  assert.deepEqual(segs, [
    { text: 'hello ', marked: false },
    { text: 'world', marked: true },
    { text: '!', marked: false },
  ]);
});

test('XSS-guard: a payload between markers is returned as inert text, never executed', () => {
  // The renderer returns SEGMENTS (strings) — it never produces executable HTML.
  // A consumer rendering them as React text nodes is safe; the payload is just characters.
  const segs = renderHighlightedSnippet('<mark><img src=x onerror=alert(1)></mark>');
  assert.equal(segs.length, 1);
  assert.equal(segs[0].marked, true);
  assert.equal(segs[0].text, '<img src=x onerror=alert(1)>'); // literal text, not HTML
  assert.ok(!/<script/i.test(JSON.stringify(segs))); // segments are data, not markup
});

test('no markers → single unmarked segment', () => {
  assert.deepEqual(renderHighlightedSnippet('plain text'), [{ text: 'plain text', marked: false }]);
});
