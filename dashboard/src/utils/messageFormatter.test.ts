import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENTION_CLOSE, MENTION_OPEN, parseMessageBody, type MessageNode } from './messageFormatter.ts';

/**
 * CPU time this process has used since `since`, in milliseconds. A bound on work is asserted on it and not on the
 * wall clock: a busy runner can hold the worker off the CPU for longer than the whole bound, while code that is slow
 * burns the CPU on every run.
 */
const cpuMsSince = (since: NodeJS.CpuUsage): number => {
  const { user, system } = process.cpuUsage(since);
  return (user + system) / 1000;
};

const text = (value: string): MessageNode => ({ type: 'text', value });
const wrap = (s: string) => `${MENTION_OPEN}${s}${MENTION_CLOSE}`;

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
  assert.deepEqual(parseMessageBody('_em_'), [{ type: 'italic', children: [text('em')] }]);
});

test('~strike~ wraps with strike', () => {
  assert.deepEqual(parseMessageBody('~gone~'), [{ type: 'strike', children: [text('gone')] }]);
});

test('`inline` produces a code node with literal value', () => {
  assert.deepEqual(parseMessageBody('use `npm i` now'), [text('use '), { type: 'code', value: 'npm i' }, text(' now')]);
});

test('```block``` produces a codeblock node with literal value', () => {
  assert.deepEqual(parseMessageBody('```line1\nline2```'), [{ type: 'codeblock', value: 'line1\nline2' }]);
});

test('code segments do not get formatted inside', () => {
  // The `*not*` inside the code segment stays literal.
  assert.deepEqual(parseMessageBody('`*not*`'), [{ type: 'code', value: '*not*' }]);
});

test('nesting: *_a_* -> bold(italic(a))', () => {
  assert.deepEqual(parseMessageBody('*_a_*'), [
    {
      type: 'bold',
      children: [{ type: 'italic', children: [text('a')] }],
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
  assert.deepEqual(parseMessageBody('word*bold*end'), [{ type: 'text', value: 'word*bold*end' }]);
});

// Deepest bold/italic/strike nesting in a parsed tree; text/code leaves count as 0.
const treeDepth = (nodes: MessageNode[]): number =>
  nodes.reduce((max, n) => ('children' in n ? Math.max(max, 1 + treeDepth(n.children)) : max), 0);

test('hostile input: deep marker nesting is capped instead of overflowing the stack', () => {
  // 100k alternating openers nest ~100k levels. Unbounded recursion dies with
  // "Maximum call stack size exceeded" here; the cap must produce a shallow tree.
  const evil = '*_'.repeat(100_000) + 'a' + '_*'.repeat(100_000);
  const nodes = parseMessageBody(evil);
  assert.ok(treeDepth(nodes) <= 20, `nesting depth ${treeDepth(nodes)} exceeds the cap`);
  // Beyond the cap the leftover markers degrade to literal text — nothing is dropped.
  const flat = (ns: MessageNode[]): string => ns.map(n => ('children' in n ? flat(n.children) : n.value)).join('');
  const rendered = flat(nodes);
  assert.ok(rendered.includes('a'));
  assert.ok(rendered.includes('*_'), 'unparsed markers must survive as literal text');
});

test('hostile input: a flood of formatted segments parses iteratively', () => {
  // 100k sibling spans used to recurse once per segment (`*a* *a* …`) and overflow the stack.
  const nodes = parseMessageBody('*a* '.repeat(100_000));
  assert.equal(nodes.length, 200_000); // bold + ' ' text per repetition
  assert.deepEqual(nodes[0], { type: 'bold', children: [text('a')] });
  assert.deepEqual(nodes[1], text(' '));
});

test('hostile input: openers with no closer do not rescan the rest of the message each time', () => {
  // Every `*` below follows a space, so none can close, and each opener used to scan to the end of
  // the body: about 3 s of main thread for one 64k message. The second body adds a valid span per
  // repetition, which used to rescan the dead `_` openers after every split.
  for (const evil of ['*a '.repeat(21_000), '_a *b* '.repeat(9_000)]) {
    const started = process.cpuUsage();
    const nodes = parseMessageBody(evil);
    const elapsed = cpuMsSince(started);
    assert.ok(elapsed < 500, `parsing ${evil.length} chars took ${Math.round(elapsed)} ms of CPU`);
    assert.ok(nodes.length > 0);
  }
  assert.deepEqual(parseMessageBody('*a '.repeat(3)), [text('*a *a *a ')]);
  assert.deepEqual(parseMessageBody('_a *b* _a'), [text('_a '), { type: 'bold', children: [text('b')] }, text(' _a')]);
});

test('hostile input: code spans with no triple backtick after them do not rescan the message each time', () => {
  // Each span used to look for a ``` to the end of the body before the next one, which is absent:
  // several seconds of main thread for one 64k message.
  for (const evil of ['`a` '.repeat(16_000), '`` '.repeat(21_000)]) {
    const started = process.cpuUsage();
    const nodes = parseMessageBody(evil);
    const elapsed = cpuMsSince(started);
    assert.ok(elapsed < 1000, `parsing ${evil.length} chars took ${Math.round(elapsed)} ms of CPU`);
    assert.ok(nodes.length > 0);
  }
  // Nor do code blocks: each block used to be followed by a search for a single backtick that ran past
  // every later block to the end of the body, which is quadratic in the number of blocks.
  for (const evil of [
    '```a``` '.repeat(8_000),
    '`'.repeat(64_000),
    '``` '.repeat(16_000),
    '```a``` `b` '.repeat(5_000),
  ]) {
    const started = process.cpuUsage();
    const nodes = parseMessageBody(evil);
    const elapsed = cpuMsSince(started);
    assert.ok(elapsed < 250, `parsing ${evil.length} chars took ${Math.round(elapsed)} ms of CPU`);
    assert.ok(nodes.length > 0);
  }
  // A triple backtick further on is still found once the spans in front of it are consumed.
  assert.deepEqual(parseMessageBody('`a` b ```c``` `d`'), [
    { type: 'code', value: 'a' },
    text(' b '),
    { type: 'codeblock', value: 'c' },
    text(' '),
    { type: 'code', value: 'd' },
  ]);
});

test('a MENTION_OPEN/MENTION_CLOSE span becomes its own mention node, not text', () => {
  assert.deepEqual(parseMessageBody(`hi ${wrap('@Ravi')} there`), [
    text('hi '),
    { type: 'mention', value: '@Ravi' },
    text(' there'),
  ]);
});

test('a mention value is opaque to code/format parsing: *, ~ and ` inside it stay literal', () => {
  assert.deepEqual(parseMessageBody(wrap('@*Ravi*')), [{ type: 'mention', value: '@*Ravi*' }]);
});

test('an unterminated mention marker falls back to one plain text node instead of dropping content', () => {
  // Should not occur from resolveMentions in practice (it always closes what it opens); this only
  // guards against silently losing the rest of the message if it ever does.
  assert.deepEqual(parseMessageBody(`hi ${MENTION_OPEN}@Ravi`), [text(`hi ${MENTION_OPEN}@Ravi`)]);
});

test('two mentions in one message each become their own node', () => {
  assert.deepEqual(parseMessageBody(`${wrap('@Ravi')} and ${wrap('@Sam')}`), [
    { type: 'mention', value: '@Ravi' },
    text(' and '),
    { type: 'mention', value: '@Sam' },
  ]);
});

test('a mention inside *bold* keeps the bold: the split happens at the text leaf, after format parsing', () => {
  assert.deepEqual(parseMessageBody(`*Reminder ${wrap('@Ravi')} at 10*`), [
    { type: 'bold', children: [text('Reminder '), { type: 'mention', value: '@Ravi' }, text(' at 10')] },
  ]);
});

test('a format marker inside a mention name neither opens nor closes a span around it', () => {
  assert.deepEqual(parseMessageBody(`*a ${wrap('@*x*')} b*`), [
    { type: 'bold', children: [text('a '), { type: 'mention', value: '@*x*' }, text(' b')] },
  ]);
});

test('a mention that fills a *bold* span on its own resolves and keeps the bold', () => {
  assert.deepEqual(parseMessageBody(`*${wrap('@Ravi')}*`), [
    { type: 'bold', children: [{ type: 'mention', value: '@Ravi' }] },
  ]);
});

test('text right after a closing triple backtick is kept', () => {
  assert.deepEqual(parseMessageBody('```a```b'), [{ type: 'codeblock', value: 'a' }, text('b')]);
});

test('a space right after the opening marker keeps the span literal even when a closer follows', () => {
  assert.deepEqual(parseMessageBody('* a*'), [text('* a*')]);
});
