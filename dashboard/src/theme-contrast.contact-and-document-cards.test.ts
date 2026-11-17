import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The contact card and the document card draw muted lines (a phone, a size and kind) inside a bubble. In an outgoing
// bubble the page draws every muted line in --chat-meta-out, because --chat-meta is too faint on the green; the
// lines of these two cards have to clear the same bars on the card fill, in every theme block and, for the document
// card, while it is hovered (the hover tint is stronger than the resting one).

const here = dirname(fileURLToPath(import.meta.url));
const APP_CSS = readFileSync(join(here, 'App.css'), 'utf8');
const CHATS_CSS = readFileSync(join(here, 'pages', 'Chats.css'), 'utf8');
const STRIPPED = CHATS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const rgb = (hex: string): number[] => {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map(c => c + c).join('')}` : hex;
  return [1, 3, 5].map(i => parseInt(full.slice(i, i + 2), 16));
};
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const mix = (over: number[], alpha: number, under: number[]): number[] =>
  over.map((c, i) => c * alpha + under[i] * (1 - alpha));

const blockOf = (css: string, anchor: string): string => {
  const from = css.indexOf(anchor);
  assert.notEqual(from, -1, `no "${anchor}" block`);
  return css.slice(from, css.indexOf('}', from));
};
// A dark set lists only what it changes; a token it leaves out is the light one.
const chatToken = (block: string, name: string): string => {
  const own = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(block)?.[1];
  if (own) return own;
  const fromApp = new RegExp(`${name}:\\s*var\\(--bg-white\\)`).test(block);
  if (fromApp) return /--bg-white:\s*(#[0-9a-f]{6})/i.exec(blockOf(APP_CSS, ':root {'))![1];
  return chatToken(blockOf(CHATS_CSS, '.chats-page {'), name);
};
/** The declarations of every rule that lists the selector, in source order. */
const ruleBody = (selector: string): string | undefined => {
  const bodies = [...STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => s.trim() === selector))
    .map(m => m[2]);
  return bodies.length > 0 ? bodies.join(';') : undefined;
};
/** The value the first of the selectors that sets the property gives it (the last such rule wins), or undefined. */
const declaredOrNothing = (selectors: string[], property: string): string | undefined => {
  for (const selector of selectors) {
    const all = [...(ruleBody(selector) ?? '').matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'g'))];
    if (all.length > 0) return all[all.length - 1][1].trim();
  }
  return undefined;
};
const declared = (selectors: string[], property: string): string => {
  const value = declaredOrNothing(selectors, property);
  assert.ok(value, `none of ${selectors.join(' | ')} sets ${property}`);
  return value;
};
/** A colour the stylesheet names: a hex, or a chat token read from the theme block under test. */
const colorOf = (block: string, value: string): number[] => {
  if (/^#[0-9a-f]{3,6}$/i.test(value)) return rgb(value);
  const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  assert.ok(name, `${value} is not a colour this test can resolve`);
  return rgb(chatToken(block, name));
};
/** What a background paints over `under`: a mix with transparent, an opaque colour, or nothing. */
const fillOver = (block: string, value: string | undefined, under: number[]): number[] => {
  if (value === undefined || value === 'none' || value === 'transparent') return under;
  const m = /^color-mix\(in srgb, (#[0-9a-f]{3,6}|var\(--[\w-]+\)) (\d+)%, transparent\)$/i.exec(value);
  if (m) return mix(colorOf(block, m[1]), Number(m[2]) / 100, under);
  return colorOf(block, value);
};

const ANCHORS = ['.chats-page {', "[data-theme='dark'] .chats-page {", ":root:not([data-theme='light']) .chats-page {"];

const CARD = '.chats-page .message-contact-card';
const AVATAR = '.chats-page .message-contact-avatar';
const PHONE = '.chats-page .message-contact-phone';
const DOCUMENT_CARD = '.chats-page .chat-document-card';
const META = '.chats-page .chat-document-meta';
/** The rule of the same part inside an outgoing bubble. */
const outgoing = (selector: string): string =>
  selector.replace('.chats-page ', '.chats-page .message-bubble.outgoing ');
/** The rules that decide a property of a part, the one that is most specific first. */
const cascade = (selector: string, isOutgoing: boolean): string[] =>
  isOutgoing ? [outgoing(selector), selector] : [selector];

for (const anchor of ANCHORS) {
  const block = blockOf(CHATS_CSS, anchor);

  for (const isOutgoing of [false, true]) {
    const side = isOutgoing ? 'an outgoing' : 'an incoming';
    const bubble = rgb(chatToken(block, isOutgoing ? '--chat-bubble-out' : '--chat-bubble-in'));
    // What a contact card is drawn on: its own fill over the bubble, whichever rule sets it.
    const cardFill = fillOver(block, declaredOrNothing(cascade(CARD, isOutgoing), 'background'), bubble);

    test(`the phone on a contact card in ${side} bubble clears 4.5:1 (${anchor})`, () => {
      const color = colorOf(block, declared(cascade(PHONE, isOutgoing), 'color'));
      const ratio = contrast(color, cardFill);
      assert.ok(ratio >= 4.5, `the contact phone is ${ratio.toFixed(2)}:1 on the card`);
    });

    test(`the avatar glyph on a contact card in ${side} bubble clears 3:1 (${anchor})`, () => {
      const glyph = colorOf(block, declared(cascade(AVATAR, isOutgoing), 'color'));
      const disc = fillOver(block, declaredOrNothing(cascade(AVATAR, isOutgoing), 'background'), cardFill);
      const ratio = contrast(glyph, disc);
      assert.ok(ratio >= 3, `the contact avatar glyph is ${ratio.toFixed(2)}:1 on its disc`);
    });

    for (const hovered of [false, true]) {
      test(`the size line of a document card in ${side} bubble clears 4.5:1${hovered ? ' while hovered' : ''} (${anchor})`, () => {
        // A line with no colour of its own takes the one of the button that holds it: the outgoing token in an
        // outgoing bubble, the bubble's text everywhere else.
        const inherited = isOutgoing
          ? declared([outgoing('.chats-page .message-media-omitted')], 'color')
          : 'var(--chat-bubble-text)';
        const own = [
          ...(hovered ? [`${DOCUMENT_CARD}:hover ${META.replace('.chats-page ', '')}`] : []),
          ...cascade(META, isOutgoing),
        ];
        const text = colorOf(block, declaredOrNothing(own, 'color') ?? inherited);
        const opacity = Number(declaredOrNothing(own, 'opacity') ?? 1);
        const fill = fillOver(
          block,
          declaredOrNothing(hovered ? [`${DOCUMENT_CARD}:hover`] : cascade(DOCUMENT_CARD, isOutgoing), 'background'),
          bubble,
        );
        const ratio = contrast(mix(text, opacity, fill), fill);
        assert.ok(ratio >= 4.5, `the document size line is ${ratio.toFixed(2)}:1 on the card`);
      });
    }
  }
}

// The muted tone of each line is a token, as every other muted line in a bubble (see BUBBLE_META in
// theme-contrast.test.ts): --chat-meta in an incoming bubble and --chat-meta-out in an outgoing one.
test('every muted line of the two cards draws in the incoming token, and in the outgoing token inside an outgoing bubble', () => {
  for (const line of [PHONE, AVATAR, META]) {
    assert.match(ruleBody(line) ?? '', /color:\s*var\(--chat-meta\)/, `${line} is no longer --chat-meta`);
    assert.match(ruleBody(outgoing(line)) ?? '', /color:\s*var\(--chat-meta-out\)/, outgoing(line));
  }
});
