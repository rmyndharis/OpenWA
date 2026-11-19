import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The note that says this dashboard is signed in with the key being edited, revoked or deleted carries a small warning icon
// on a tint of the warning colour. App.css keeps the status fills (--warning is 2.15:1 on white) for fills and borders and
// gives text and icons the darkened twin (--warning-text). An icon that tells the note apart has to clear 3:1 (SC 1.4.11)
// on the tint it is drawn on, in every theme block.

const here = dirname(fileURLToPath(import.meta.url));
const APP_CSS = readFileSync(join(here, 'App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const KEYS_CSS = readFileSync(join(here, 'pages', 'ApiKeys.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const bodyOf = (css: string, selector: string, media = ''): string => {
  const scope = media ? css.slice(css.indexOf(media)) : css;
  const rule = [...scope.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(m => m[1].split(',').some(s => s.trim() === selector));
  assert.ok(rule, `no ${selector} rule`);
  return rule[2];
};
const declared = (body: string, property: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1].trim();

// The custom-property blocks a theme applies, first match wins: a dark block lists only what it changes.
const THEMES: Record<string, string[]> = {
  light: [bodyOf(APP_CSS, ':root')],
  'dark theme': [bodyOf(APP_CSS, "[data-theme='dark']"), bodyOf(APP_CSS, ':root')],
  'system dark': [
    bodyOf(APP_CSS, ":root:not([data-theme='light'])", '@media (prefers-color-scheme: dark)'),
    bodyOf(APP_CSS, ':root'),
  ],
};
const tokenHex = (blocks: string[], name: string): string => {
  const value = blocks.map(b => declared(b, name)).find(v => v !== undefined);
  assert.ok(value, `${name} is defined nowhere`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? tokenHex(blocks, alias[1]) : value;
};

for (const [theme, blocks] of Object.entries(THEMES)) {
  test(`the warning icon of the signed-in note clears 3:1 on the note (${theme})`, () => {
    const note = bodyOf(KEYS_CSS, '.api-keys-page .key-signed-in-warning');
    const tint = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(declared(note, 'background') ?? '');
    assert.ok(tint, 'the note no longer has an rgba tint: drop this check');
    const dialog = rgb(tokenHex(blocks, '--bg-white'));
    const alpha = Number(tint[4]);
    const fill = [1, 2, 3].map((i, k) => Number(tint[i]) * alpha + dialog[k] * (1 - alpha));
    const icon = declared(bodyOf(KEYS_CSS, '.api-keys-page .key-signed-in-warning svg'), 'color') ?? '';
    const token = /^var\((--[\w-]+)/.exec(icon)?.[1];
    assert.ok(token, `${icon} is not a token this test can resolve`);
    const ratio = contrast(rgb(tokenHex(blocks, token)), fill);
    assert.ok(ratio >= 3, `the icon (${token}) is ${ratio.toFixed(2)}:1 on the note`);
  });
}
