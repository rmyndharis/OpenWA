import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessageBody, type MessageNode } from './messageFormatter.ts';

const text = (value: string): MessageNode => ({ type: 'text', value });

test('plain text returns a single text node', () => {
  assert.deepEqual(parseMessageBody('hello world'), [text('hello world')]);
});

test('returns an empty array for empty input', () => {
  assert.deepEqual(parseMessageBody(''), []);
});

test('*bold* wraps with bold', () => {
  assert.deepEqual(parseMessageBody('hi *strong* there'), [
    text('hi '),
    { type: 'bold', children: [text('strong')] },
    text(' there'),
  ]);
});

test('_italic_ wraps with italic', () => {
  assert.deepEqual(parseMessageBody('_em_'), [
    { type: 'italic', children: [text('em')] },
  ]);
});

test('~strike~ wraps with strike', () => {
  assert.deepEqual(parseMessageBody('~gone~'), [
    { type: 'strike', children: [text('gone')] },
  ]);
});

test('`inline` produces a code node with literal value', () => {
  assert.deepEqual(parseMessageBody('use `npm i` now'), [
    text('use '),
    { type: 'code', value: 'npm i' },
    text(' now'),
  ]);
});

test('```block``` produces a codeblock node with literal value', () => {
  assert.deepEqual(parseMessageBody('```line1\nline2```'), [
    { type: 'codeblock', value: 'line1\nline2' },
  ]);
});

test('code segments do not get formatted inside', () => {
  // The `*not*` inside the code segment stays literal.
  assert.deepEqual(parseMessageBody('`*not*`'), [
    { type: 'code', value: '*not*' },
  ]);
});

test('nesting: *_a_* -> bold(italic(a))', () => {
  assert.deepEqual(parseMessageBody('*_a_*'), [
    {
      type: 'bold',
      children: [
        { type: 'italic', children: [text('a')] },
      ],
    },
  ]);
});

test('whitespace right after opening marker disables the format', () => {
  // '* not bold *' has space after the opener and before the closer → literal.
  assert.deepEqual(parseMessageBody('* not bold *'), [text('* not bold *')]);
});

test('unbalanced marker stays literal', () => {
  assert.deepEqual(parseMessageBody('a *b c'), [text('a *b c')]);
});

test('newlines are preserved in text nodes', () => {
  assert.deepEqual(parseMessageBody('a\nb'), [text('a\nb')]);
});

test('multiple consecutive formats: *a* _b_', () => {
  assert.deepEqual(parseMessageBody('*a* _b_'), [
    { type: 'bold', children: [text('a')] },
    text(' '),
    { type: 'italic', children: [text('b')] },
  ]);
});

test('marker without outside boundary stays literal (no over-formatting)', () => {
  // 'word*bold*end' has no boundary char before the opening '*' nor after the closer.
  // Per WhatsApp rules this is literal text — the boundary guard prevents over-formatting.
  assert.deepEqual(parseMessageBody('word*bold*end'), [
    { type: 'text', value: 'word*bold*end' },
  ]);
});
