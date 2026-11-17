import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Text that is cut with an ellipsis takes its direction from its own characters (unicode-bidi: plaintext, see the
// comment above .chat-item-name in Chats.css): under the page's direction the ellipsis eats the wrong end of a name
// written the other way round, and a Latin name in an Arabic page lost its first letters. Every box that cuts a name
// somebody else chose carries it: the chat name, its snippet, the quote, the group member's name, the staged
// attachment's file name. The contact card's name and the document card's file name are such boxes too.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'Chats.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const declarations = (selector: string): string => {
  const bodies = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => s.trim() === selector))
    .map(m => m[2]);
  assert.ok(bodies.length > 0, `Chats.css has no ${selector} rule`);
  return bodies.join(';');
};

test('the boxes that already cut a chosen name carry unicode-bidi: plaintext', () => {
  for (const selector of [
    '.chats-page .chat-item-name',
    '.chats-page .chat-item-snippet',
    '.chats-page .quote-body',
    '.chats-page .preview-filename',
  ]) {
    assert.match(
      declarations(selector),
      /unicode-bidi:\s*plaintext/,
      `${selector} lost the rule this test is measured against`,
    );
  }
});

// The name hugs the start edge of the column that would stretch it, as the staged attachment's file name does: the
// property aligns the text by its own direction, so a stretched box would put a Latin name at the left edge of an
// Arabic page while the line under it sits at the right.
const OWN_DIRECTION = [
  /text-overflow:\s*ellipsis/,
  /unicode-bidi:\s*plaintext/,
  /align-self:\s*flex-start/,
  /max-width:\s*100%/,
];

test('the document card file name is cut by its own direction, not the page', () => {
  const body = declarations('.chats-page .chat-document-title');
  for (const rule of OWN_DIRECTION) assert.match(body, rule, `.chat-document-title is missing ${rule}`);
});

// A name that is a number has no strong character of its own: left to the page it is laid out right to left in an
// Arabic page ("4567 123 50 971+"), while plaintext reads it left to right.
test('the contact card name, which can be a number, is cut by its own direction, not the page', () => {
  const body = declarations('.chats-page .message-contact-name');
  for (const rule of OWN_DIRECTION) assert.match(body, rule, `.message-contact-name is missing ${rule}`);
});
