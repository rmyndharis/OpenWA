import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Layout.css under a right-to-left language. The sidebar is position: fixed with no inset, so in an
// RTL flex row it sits at the right edge, and every horizontal rule meant for the left edge has to be
// mirrored for it.

const DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(DIR, 'Layout.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tsx = readFileSync(join(DIR, 'Layout.tsx'), 'utf8');

interface Rule {
  media: string;
  selectors: string[];
  body: string;
}

// Style rules with the @media condition they sit under ('' at the top level).
function rules(text: string, media = ''): Rule[] {
  const out: Rule[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const header = text.slice(i, open).trim();
    let depth = 1;
    let k = open + 1;
    while (k < text.length && depth) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') depth--;
      k++;
    }
    const body = text.slice(open + 1, k - 1);
    if (header.startsWith('@media')) out.push(...rules(body, header));
    else if (!header.startsWith('@')) out.push({ media, selectors: header.split(',').map(s => s.trim()), body });
    i = k;
  }
  return out;
}

const all = rules(css);
const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim();
const find = (selector: string): Rule[] => all.filter(r => r.selectors.includes(selector));

// Layout.tsx switches to the mobile layout below this width.
const mobileBelow = Number(/innerWidth < (\d+)/.exec(tsx)?.[1]);

test('every max-width query in Layout.css switches at the same width as the mobile layout', () => {
  assert.ok(mobileBelow > 0, 'Layout.tsx no longer names its mobile threshold');
  const widths = [...css.matchAll(/max-width:\s*(\d+)px/g)].map(m => Number(m[1]));
  assert.ok(widths.length > 0);
  for (const w of widths)
    assert.equal(w, mobileBelow - 1, `max-width: ${w}px disagrees with innerWidth < ${mobileBelow}`);
});

test('the closed mobile sidebar slides off the right edge under RTL, and opens back in', () => {
  const closed = find("[dir='rtl'] .sidebar.mobile").filter(r => r.media);
  assert.equal(closed.length, 1, 'no RTL transform for the closed mobile sidebar');
  assert.equal(decl(closed[0].body, 'transform'), 'translateX(100%)');
  // The shadow falls on the content side, which under RTL is the left.
  assert.match(decl(closed[0].body, 'box-shadow') ?? '', /^-2px /);
  // Same specificity as the rule above, so the open state has to be scoped to RTL as well.
  const open = find("[dir='rtl'] .sidebar.mobile.open").filter(r => r.media === closed[0].media);
  assert.equal(open.length, 1, 'the RTL closed rule would also hide the open sidebar');
  assert.equal(decl(open[0].body, 'transform'), 'translateX(0)');
});

test('the collapse icon is mirrored once, by the icon Layout.tsx picks', () => {
  assert.match(tsx, /isRtl \?\s*\(?\s*<PanelRightClose/, 'Layout.tsx no longer swaps the collapse icon for RTL');
  assert.match(tsx, /isRtl \?\s*\(?\s*<PanelRightOpen/, 'Layout.tsx no longer swaps the expand icon for RTL');
  for (const r of all.filter(r => r.selectors.some(s => s.includes('.collapse-toggle') && s.includes('svg')))) {
    assert.equal(decl(r.body, 'transform'), undefined, `${r.selectors.join(', ')} flips the icon again`);
  }
});
