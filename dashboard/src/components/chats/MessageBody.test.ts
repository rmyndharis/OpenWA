// Render test for the fix on rmyndharis/OpenWA#1676: a resolved @mention's push name is
// attacker-controlled (any WhatsApp user sets their own), and linkify-react auto-links a bare word
// with no scheme, so a participant named "localhost" must not become a clickable link. The name is
// wrapped in messageFormatter.ts's MENTION_OPEN/MENTION_CLOSE sentinels and rendered as its own
// <bdi> element, which 'bdi' in MessageBody's ignoreTags keeps out of Linkify's tree walk —
// verified against the actual linkify-react build, not by asserting on our own parser's output.
import '../../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { MENTION_CLOSE, MENTION_OPEN } from '../../utils/messageFormatter.ts';
import { buildMentionNameMap, resolveMentions } from '../../utils/chatMessages.ts';

/**
 * CPU time this process has used since `since`, in milliseconds. A bound on work is asserted on it and not on the
 * wall clock: a busy runner can hold the worker off the CPU for longer than the whole bound, while code that is slow
 * burns the CPU on every run.
 */
const cpuMsSince = (since: NodeJS.CpuUsage): number => {
  const { user, system } = process.cpuUsage(since);
  return (user + system) / 1000;
};

let rtl: typeof import('@testing-library/react');
let MessageBody: (typeof import('./MessageBody.tsx'))['default'];

before(async () => {
  const { installJsdomGlobals } = await import('../../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  rtl = await import('@testing-library/react');
  ({ default: MessageBody } = await import('./MessageBody.tsx'));
});

afterEach(() => {
  rtl.cleanup();
});

const wrap = (s: string) => `${MENTION_OPEN}${s}${MENTION_CLOSE}`;

test('a mention-wrapped push name that linkify-react would treat as a bare URL renders with no anchor', () => {
  const { container } = rtl.render(createElement(MessageBody, { text: `hi ${wrap('@localhost')} there` }));
  assert.equal(container.querySelectorAll('a').length, 0, 'no <a> tag anywhere in the rendered message');
  const bdi = container.querySelector('bdi');
  assert.ok(bdi, 'the mention renders as a real <bdi> element');
  assert.equal(bdi?.textContent, '@localhost');
});

test('a mention-wrapped push name immediately followed by more text does not form a link across the boundary', () => {
  // e.g. "@6281112345.So" — the un-isolated case the maintainer's review named explicitly.
  const { container } = rtl.render(createElement(MessageBody, { text: `${wrap('@localhost')}.So there` }));
  assert.equal(container.querySelectorAll('a').length, 0);
});

test('a real URL outside any mention is still linkified (the fix does not disable linking generally)', () => {
  const { container } = rtl.render(createElement(MessageBody, { text: 'see https://example.com/x' }));
  const link = container.querySelector('a');
  assert.ok(link, 'a plain URL still becomes a link');
  assert.equal(link?.getAttribute('href'), 'https://example.com/x');
});

test('an unresolved mention (no matching participant) is still plain "@digits" text, still linkified as before', () => {
  const { container } = rtl.render(createElement(MessageBody, { text: 'hi @166868170059932 there' }));
  assert.equal(container.querySelectorAll('a').length, 0, 'digits alone are not a URL');
  assert.ok(container.textContent?.includes('@166868170059932'));
});

test('a push name that smuggles the closing delimiter still renders as one <bdi> with no anchor', () => {
  const names = buildMentionNameMap([
    { author: '6281112345@c.us', chatName: `X${MENTION_CLOSE}bit.ly/free` } as Parameters<
      typeof buildMentionNameMap
    >[0][number],
  ]);
  const { container } = rtl.render(
    createElement(MessageBody, { text: resolveMentions('hi @6281112345 there', names) }),
  );
  assert.equal(container.querySelectorAll('a').length, 0);
  assert.equal(container.querySelectorAll('bdi').length, 1);
  assert.equal(container.querySelector('bdi')?.textContent, '@Xbit.ly/free');
});

test('a mention inside *bold* renders bold with the <bdi> as a child, not literal asterisks', () => {
  const names = buildMentionNameMap([{ author: '6281112345@c.us', chatName: 'Ravi' }]);
  const { container } = rtl.render(
    createElement(MessageBody, { text: resolveMentions('*Reminder @6281112345 at 10*', names) }),
  );
  assert.equal(container.querySelector('strong')?.textContent, 'Reminder @Ravi at 10');
  assert.ok(container.querySelector('strong bdi'), 'the mention sits inside the bold element');
});

test('a backtick in a push name cannot pair with one in the body and hand the name tail to Linkify', () => {
  const names = buildMentionNameMap([
    { author: '6281112345@c.us', chatName: 'a`evil.com' },
    { author: '6281112346@c.us', chatName: '`x`evil.com/login' },
  ]);
  for (const body of ['` look @6281112345', 'please ask @6281112346 about it']) {
    const { container } = rtl.render(createElement(MessageBody, { text: resolveMentions(body, names) }));
    assert.equal(container.querySelectorAll('a').length, 0, body);
    assert.equal(container.querySelectorAll('bdi').length, 1, body);
    rtl.cleanup();
  }
});

test('a body past the link-scanning bound renders as plain text without being scanned', () => {
  // Link detection grows with the square of an unbroken run of domain-like characters, so a long
  // body is left unlinked instead of freezing the thread for seconds.
  const body = `${'a.'.repeat(32_500)} https://example.com/x`;
  const started = process.cpuUsage();
  const { container } = rtl.render(createElement(MessageBody, { text: body }));
  const elapsed = cpuMsSince(started);
  assert.ok(elapsed < 1000, `rendering ${body.length} chars took ${Math.round(elapsed)} ms of CPU`);
  assert.equal(container.querySelectorAll('a').length, 0);
  assert.equal(container.textContent, body);
});

test('a body at the link-scanning bound is still linked', () => {
  const url = 'https://example.com/x';
  const body = `${url} ${'word '.repeat(1000)}`.slice(0, 4096);
  assert.equal(body.length, 4096);
  const { container } = rtl.render(createElement(MessageBody, { text: body }));
  assert.equal(container.querySelector('a')?.getAttribute('href'), url);
  rtl.cleanup();
  const { container: past } = rtl.render(createElement(MessageBody, { text: `${body}x` }));
  assert.equal(past.querySelectorAll('a').length, 0);
});
