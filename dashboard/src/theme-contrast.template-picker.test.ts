import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The template picker draws muted lines (what Enter does, a template's preview, the cut-off notice) on the composer banner,
// and a preview line on the row the arrow keys highlight. A line of text has to clear 4.5:1 on what it is drawn on, in
// every theme block, as the muted lines of a bubble do (theme-contrast.contact-and-document-cards.test.ts).

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
  if (new RegExp(`${name}:\\s*var\\(--bg-white\\)`).test(block)) {
    return /--bg-white:\s*(#[0-9a-f]{6})/i.exec(blockOf(APP_CSS, ':root {'))![1];
  }
  return chatToken(blockOf(CHATS_CSS, '.chats-page {'), name);
};
const declared = (selector: string, property: string): string => {
  const bodies = [...STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => s.trim() === selector))
    .map(m => m[2]);
  const all = [...bodies.join(';').matchAll(new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, 'g'))];
  assert.ok(all.length > 0, `${selector} sets no ${property}`);
  return all[all.length - 1][1].trim();
};
const colorOf = (block: string, value: string): number[] => {
  if (/^#[0-9a-f]{3,6}$/i.test(value)) return rgb(value);
  const name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  assert.ok(name, `${value} is not a colour this test can resolve`);
  return rgb(chatToken(block, name));
};
const fillOver = (block: string, value: string, under: number[]): number[] => {
  const m = /^color-mix\(in srgb, (#[0-9a-f]{3,6}|var\(--[\w-]+\)) (\d+)%, transparent\)$/i.exec(value);
  assert.ok(m, `${value} is not a fill this test can resolve`);
  return mix(colorOf(block, m[1]), Number(m[2]) / 100, under);
};

const ANCHORS = ['.chats-page {', "[data-theme='dark'] .chats-page {", ":root:not([data-theme='light']) .chats-page {"];
const BANNER = '.chats-page .composer-banner';

for (const anchor of ANCHORS) {
  const block = blockOf(CHATS_CSS, anchor);
  const banner = colorOf(block, declared(BANNER, 'background'));

  test(`the lines of the template picker clear 4.5:1 on the composer banner (${anchor})`, () => {
    for (const line of ['hint', 'empty', 'more'].map(part => `.chats-page .slash-template-${part}`)) {
      const ratio = contrast(colorOf(block, declared(line, 'color')), banner);
      assert.ok(ratio >= 4.5, `${line} is ${ratio.toFixed(2)}:1 on the banner`);
    }
    const preview = contrast(colorOf(block, declared('.chats-page .slash-template-preview', 'color')), banner);
    assert.ok(preview >= 4.5, `the preview line is ${preview.toFixed(2)}:1 on the banner`);
  });

  test(`the preview line on the highlighted template row clears 4.5:1 (${anchor})`, () => {
    const row = fillOver(block, declared('.chats-page .slash-template-item.active', 'background'), banner);
    const ratio = contrast(colorOf(block, declared('.chats-page .slash-template-preview', 'color')), row);
    assert.ok(ratio >= 4.5, `the preview line is ${ratio.toFixed(3)}:1 on the highlighted row`);
  });
}
