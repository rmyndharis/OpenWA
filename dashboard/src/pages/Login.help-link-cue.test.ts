import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRules } from '../test-helpers/css-rules.ts';

// A link inside a sentence has to be told apart from the words around it by more than hue (WCAG 2.1 SC 1.4.1,
// technique G183): either an underline at rest, or a 3:1 contrast with the surrounding text. The documentation link
// of the sign-in card ("Need help? View Documentation") is brand green on slate text and underlines only on hover.

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

const appCss = readFileSync(new URL('../App.css', import.meta.url), 'utf8');
const block = (anchor: string): string => {
  const from = appCss.indexOf(anchor);
  assert.notEqual(from, -1, `App.css no longer contains "${anchor}"`);
  return appCss.slice(from, appCss.indexOf('\n}', from));
};
const themes = { light: [block(':root {')], dark: [block("[data-theme='dark'] {"), block(':root {')] };

// A colour as a hex string: a literal, or a custom property looked up in the theme (the dark block first, then the
// root one it inherits from), or the fallback written inside var().
function resolve(colour: string, blocks: string[]): string {
  if (colour.startsWith('#')) return colour;
  const parts = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(colour);
  assert.ok(parts, `${colour} is not a colour this test reads`);
  for (const css of blocks) {
    const value = new RegExp(`${parts[1]}\\s*:\\s*([^;]+);`).exec(css)?.[1].trim();
    if (value !== undefined) return resolve(value, blocks);
  }
  assert.ok(parts[2], `${parts[1]} is defined nowhere`);
  return resolve(parts[2].trim(), blocks);
}

const rules = readRules(new URL('./Login.css', import.meta.url)).filter(r => r.media === '');
// The last value the top-level rules give `selector` through any of `props`, in source order.
function declared(selector: string, props: string[]): string | undefined {
  let value: string | undefined;
  for (const rule of rules.filter(r => r.selectors.includes(selector))) {
    for (const declaration of rule.body.split(';')) {
      const [name, ...rest] = declaration.split(':');
      if (props.includes(name.trim())) value = rest.join(':').trim();
    }
  }
  return value;
}

test('the documentation link of the sign-in card is not told apart from its sentence by hue alone', () => {
  const sentence = declared('.login-container .login-help', ['color']);
  const link = declared('.login-container .login-help a', ['color']);
  assert.ok(sentence && link, 'the help rules moved');
  const underlinedAtRest = /underline/.test(
    declared('.login-container .login-help a', ['text-decoration', 'text-decoration-line']) ?? '',
  );

  const failures = Object.entries(themes).flatMap(([theme, blocks]) => {
    const ratio = contrast(rgb(resolve(link, blocks)), rgb(resolve(sentence, blocks)));
    return underlinedAtRest || ratio >= 3
      ? []
      : [`${theme} theme: the link is ${ratio.toFixed(2)}:1 against its sentence and not underlined at rest`];
  });
  assert.equal(failures.length, 0, failures.join('; '));
});
