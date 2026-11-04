import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';

// i18n/index.ts sets <html dir="rtl"> for Hebrew and Arabic. A physical left or right side in a
// margin, padding, border, corner radius or text alignment stays put when the layout mirrors, so a
// divider or accent bar lands on the wrong edge and a header detaches from its column.
const PHYSICAL_SIDE =
  /(?:margin|padding|border)-(?:left|right)\b|border-(?:top|bottom)-(?:left|right)-radius|text-align:\s*(?:left|right)/;

function physicalSides(file: string): string[] {
  const css = readFileSync(new URL(file, import.meta.url), 'utf8')
    // Blank out comments but keep their line breaks, so a reported line number matches the file.
    .replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''));
  return css
    .split('\n')
    .map((line, i) => `${file}:${i + 1}: ${line.trim()}`)
    .filter(line => PHYSICAL_SIDE.test(line));
}

test('the API keys stylesheet uses logical sides only', () => {
  assert.deepEqual(physicalSides('./ApiKeys.css'), []);
});

test('the chats stylesheet uses logical sides only', () => {
  assert.deepEqual(physicalSides('./Chats.css'), []);
});

test('the number checker stylesheet uses logical sides only', () => {
  assert.deepEqual(physicalSides('./NumberChecker.css'), []);
});

// The files above must hold no physical side at all. Everywhere else a physical side is fine only
// when the layout mirrors it: the rule is written for [dir='rtl'] itself, or a [dir='rtl'] rule for the
// same selector sets the same kind of property (a twin that only changes the colour mirrors nothing).
// Besides the single-side properties this also reads the shorthands, where a 4-value margin or padding
// with unequal left and right, or a border-radius whose left and right corners differ, hides a side, and
// the left and right insets, unless a rule sets both to the same value.
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SIDE_PROPERTY =
  /^(?:(?:margin|padding)-(?:left|right)|border-(?:left|right)(?:-(?:width|style|color))?|border-(?:top|bottom)-(?:left|right)-radius|left|right)$/;

// Splits at the characters `at` accepts that sit outside every pair of parentheses, so var(...) and
// calc(...) stay whole however deeply they nest.
function splitOutsideParens(value: string, at: (char: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') depth--;
    if (depth === 0 && at(char)) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts;
}

// Whitespace separated values.
function values(value: string): string[] {
  return splitOutsideParens(value.replace(/\s*!important\s*$/, ''), c => /\s/.test(c)).filter(Boolean);
}

function hidesSide(property: string, value: string): boolean {
  // `left: auto` resets an inset so that another one can apply; it places nothing on a side.
  if (property === 'left' || property === 'right') return values(value)[0] !== 'auto';
  if (SIDE_PROPERTY.test(property)) return true;
  if (property === 'text-align') return /^(?:left|right)$/.test(values(value)[0] ?? '');
  const v = values(value);
  if (property === 'margin' || property === 'padding' || property === 'inset') return v.length === 4 && v[1] !== v[3];
  if (property === 'border-radius') {
    // Corners in order top-left, top-right, bottom-right, bottom-left; a shorter list repeats.
    const [tl, tr = tl, br = tl, bl = tr] = values(splitOutsideParens(value, c => c === '/')[0]);
    return tl !== tr || bl !== br;
  }
  return false;
}

// The kind of property a declaration sets, physical or logical alike.
function family(property: string): string {
  if (/^border(?:-[a-z]+-[a-z]+)?-radius$/.test(property)) return 'radius';
  if (/^(?:left|right|inset(?:-inline(?:-start|-end)?)?)$/.test(property)) return 'inset';
  return /^(?:margin|padding|border)(?:-|$)/.test(property) ? property.split('-')[0] : property;
}

// Physical edges kept on purpose, as [selector, property]. A switch knob runs from the left (off) to the right (on)
// by translateX and does not mirror. The toast stack does mirror, to the bottom left corner, but its
// [dir='rtl'] .toast-container twin is in index.css and this scan reads one stylesheet at a time.
const KEPT: [RegExp, string][] = [
  [/(?:^|\s)\.toggle-slider::?before$/, 'left'],
  [/^\.toast-container$/, 'right'],
];

function stylesheets(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return stylesheets(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

function unmirroredSides(source: string, label: string): string[] {
  // Blank out comments but keep their line breaks, so a reported line number matches the file.
  const css = source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ''));
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selectors: m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ').replace(/"/g, "'")),
    body: m[2],
    at: m.index + m[1].length + 1,
  }));
  const declared = (body: string): [string, string][] =>
    body
      .split(';')
      .map(d => d.split(':'))
      .filter(([property]) => property?.trim())
      .map(([property, ...rest]) => [property.trim(), rest.join(':').trim()]);
  // The kinds of property each selector sets, to find the [dir='rtl'] twin of a rule.
  const families = new Map<string, Set<string>>();
  for (const rule of rules)
    for (const selector of rule.selectors)
      for (const [property] of declared(rule.body))
        families.set(selector, (families.get(selector) ?? new Set()).add(family(property)));
  const mirrored = (selector: string, kind: string): boolean =>
    selector.startsWith("[dir='rtl']") || (families.get(`[dir='rtl'] ${selector}`)?.has(kind) ?? false);
  const found: string[] = [];
  for (const rule of rules) {
    // A rule that pins the same value to both edges (left: 0; right: 0) is symmetric, not a side.
    const edges = Object.fromEntries(declared(rule.body).filter(([p]) => p === 'left' || p === 'right'));
    const same = edges.left !== undefined && values(edges.left).join(' ') === values(edges.right ?? '').join(' ');
    // left: 50% with a horizontal -50% translation (translateX or the first argument of translate) centres the
    // box, which is the same in both directions. translateY(-50%) does not.
    const centred =
      edges.left === '50%' &&
      declared(rule.body).some(([p, v]) => p === 'transform' && /translate(?:X)?\(\s*(?:calc\(\s*)?-50%/.test(v));
    const symmetric = same || centred;
    let offset = 0;
    for (const declaration of rule.body.split(';')) {
      const [property, ...rest] = declaration.split(':');
      const value = rest.join(':');
      const name = property?.trim();
      const edge = name === 'left' || name === 'right';
      if (
        name &&
        hidesSide(name, value) &&
        !(edge && symmetric) &&
        !rule.selectors.every(
          selector => mirrored(selector, family(name)) || KEPT.some(([kept, p]) => p === name && kept.test(selector)),
        )
      ) {
        const line = css.slice(0, rule.at + offset + declaration.search(/\S|$/)).split('\n').length;
        found.push(`${label}:${line}: ${rule.selectors.join(', ')} { ${declaration.trim()} }`);
      }
      offset += declaration.length + 1;
    }
  }
  return found;
}

test('every stylesheet either mirrors a physical side under RTL or uses logical ones', () => {
  const files = stylesheets();
  assert.ok(files.length >= 20, `only ${files.length} stylesheets found`);
  assert.deepEqual(
    files.flatMap(full => unmirroredSides(readFileSync(full, 'utf8'), full.slice(SRC.length + 1))),
    [],
  );
});

test('the side detector reads single-side properties and shorthands', () => {
  const physical: [string, string][] = [
    ['margin-left', '8px'],
    ['border-right', '1px solid red'],
    ['text-align', 'left'],
    ['margin', '0.25rem 0 0.75rem 1.5rem'],
    ['padding', '0.75rem 3rem 0.75rem 1rem'],
    ['border-radius', '12px 12px 12px 4px'],
    ['border-radius', '12px 4px'],
    ['text-align', 'right !important'],
    ['left', '0.5rem'],
    ['right', '-15px'],
    ['border-radius', 'calc(var(--radius) - 2px) 0 0 calc(var(--radius) - 2px)'],
    ['border-radius', 'calc(8px / 2) 0 0 calc(8px / 2)'],
    ['inset', '0 auto auto 8px'],
    ['inset', '1px 2px 3px 4px'],
  ];
  const neutral: [string, string][] = [
    ['margin', '0 auto'],
    ['padding', '1rem 2rem 1rem 2rem'],
    ['text-align', 'start'],
    ['border-radius', '16px 16px 0 0'],
    ['border-top', '1px solid red'],
    ['margin-inline-start', '8px'],
    ['inset-inline-end', '-15px'],
    ['inset', '0'],
    ['inset', '0 8px'],
    ['inset', '0 8px 4px'],
    ['inset', '0 8px 0 8px'],
    ['left', 'auto'],
    ['border-radius', 'calc(var(--radius) - 2px)'],
    ['border-radius', 'calc(var(--a) - calc(1px + 2px)) calc(var(--a) - calc(1px + 2px)) / calc(8px / 2)'],
  ];
  for (const [property, value] of physical) assert.ok(hidesSide(property, value), `${property}: ${value}`);
  for (const [property, value] of neutral) assert.ok(!hidesSide(property, value), `${property}: ${value}`);
});

// The stylesheets are not the only place a side is written: an inline style object does the same, and
// <span style={{ marginLeft: '0.5rem' }}> lands on the wrong edge of its label under RTL.
const INLINE_SIDE =
  /^(?:(?:margin|padding)(?:Left|Right)|border(?:Left|Right)(?:Width|Style|Color)?|border(?:Top|Bottom)(?:Left|Right)Radius)$/;

function inlineSides(source: string, name = 'inline.tsx'): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const key = node.name.getText(file).replace(/^['"]|['"]$/g, '');
      const value = ts.isStringLiteralLike(node.initializer) ? node.initializer.text : '';
      if (INLINE_SIDE.test(key) || (key === 'textAlign' && /^(?:left|right)$/.test(value)))
        found.push(
          `${name}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${node.getText(file)}`,
        );
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return found;
}

function sources(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

test('no inline style names a physical side', () => {
  const files = sources();
  assert.ok(files.length >= 20, `only ${files.length} components found`);
  assert.deepEqual(
    files.flatMap(full => inlineSides(readFileSync(full, 'utf8'), full.slice(SRC.length + 1))),
    [],
  );
});

test('the inline side detector reads Left and Right keys and leaves logical ones alone', () => {
  assert.equal(inlineSides(`const a = <i style={{ marginLeft: '0.5rem' }} />;`).length, 1);
  assert.equal(inlineSides(`const a = { paddingRight: 4, 'borderLeft': '1px solid red' };`).length, 2);
  assert.equal(inlineSides(`const a = { borderTopLeftRadius: 4, textAlign: 'right' };`).length, 2);
  assert.equal(
    inlineSides(`const a = { marginInlineStart: '0.5rem', textAlign: 'start', margin: '0 auto' };`).length,
    0,
  );
  assert.equal(inlineSides(`const chart = { margin: { top: 5, right: 30, left: 20 } };`).length, 0);
});

// The whole scan on fixtures, one for each thing it has to see or leave alone.
const scan = (css: string): number => unmirroredSides(css, 'fixture.css').length;

test('the scan reads left and right insets, unless the rule is symmetric, a reset or mirrored', () => {
  assert.equal(scan('.mark { position: absolute; right: -15px; bottom: -15px; }'), 1);
  assert.equal(scan('.mark { position: absolute; left: 0.5rem; }'), 1);
  assert.equal(scan('.mark { position: absolute; inset-inline-end: -15px; }'), 0);
  assert.equal(scan(".mark { right: -15px; } [dir='rtl'] .mark { right: auto; left: -15px; }"), 0);
  // Both edges pinned to one value, a centring translation and an auto reset place nothing on one side.
  assert.equal(scan('.fill { position: absolute; left: 0; right: 0; }'), 0);
  assert.equal(scan('.fill { position: absolute; left: 0; right: 8px; }'), 2);
  assert.equal(scan('.pop { left: 50%; transform: translateX(calc(-50% + 4px)); }'), 0);
  assert.equal(scan('.pop { left: 50%; }'), 1);
  assert.equal(scan('.pop { left: auto; inset-inline-end: 0; }'), 0);
});

// -50% only centres the box when the translation is horizontal: translateY(-50%) leaves the left edge at the middle
// of the parent, on the left in both directions.
test('left: 50% counts as centred only with a horizontal -50% translation', () => {
  assert.equal(scan('.pop { left: 50%; transform: translateX(-50%); }'), 0);
  assert.equal(scan('.pop { left: 50%; transform: translate(-50%, -50%); }'), 0);
  assert.equal(scan('.pop { left: 50%; transform: translateX(calc(-50% + 4px)) translateY(-6px); }'), 0);
  assert.equal(scan('.pop { left: 50%; transform: translateY(-50%); }'), 1);
  assert.equal(scan('.pop { left: 50%; transform: translateX(10px) translateY(-50%); }'), 1);
  assert.equal(scan('.pop { left: 50%; transform: translate(0, -50%); }'), 1);
});

test('the scan reads the inset shorthand when its left and right differ', () => {
  assert.equal(scan('.pop { position: absolute; inset: 0 auto auto 8px; }'), 1);
  assert.equal(scan('.pop { position: absolute; inset: 0; }'), 0);
  assert.equal(scan('.pop { position: absolute; inset: 0 8px; }'), 0);
  assert.equal(scan(".pop { inset: 0 auto auto 8px; } [dir='rtl'] .pop { inset: 0 8px auto auto; }"), 0);
  assert.equal(scan(".pop { inset: 0 auto auto 8px; } [dir='rtl'] .pop { color: red; }"), 1);
});

test('the scan reads text-align with !important', () => {
  assert.equal(scan('.cell { text-align: right !important; }'), 1);
  assert.equal(scan('.cell { text-align: start !important; }'), 0);
});

test('a right-to-left twin mirrors a side only when it sets the same kind of property', () => {
  assert.equal(scan(".row { padding-left: 4px; } [dir='rtl'] .row { color: red; }"), 1);
  assert.equal(scan(".row { padding-left: 4px; } [dir='rtl'] .row { padding-right: 4px; }"), 0);
  assert.equal(scan(".row { margin-left: 4px; } [dir='rtl'] .row { padding-right: 4px; }"), 1);
  assert.equal(scan(".row { border-radius: 8px 0 0 8px; } [dir='rtl'] .row { border-radius: 0 8px 8px 0; }"), 0);
  assert.equal(scan(".row { left: 4px; } [dir='rtl'] .row { right: 4px; }"), 0);
});

test('a symmetric border radius written with calc() is not a side', () => {
  assert.equal(scan('.card { border-radius: calc(var(--radius) - 2px); }'), 0);
  assert.equal(
    scan('.card { border-radius: calc(var(--radius) - calc(1px + 1px)) calc(var(--radius) - calc(1px + 1px)); }'),
    0,
  );
  assert.equal(scan('.card { border-radius: calc(var(--radius) - 2px) 0 0 calc(var(--radius) - 2px); }'), 1);
});

test('the edges kept physical on purpose are the switch knob and the toast corner only', () => {
  assert.equal(scan('.page .toggle-slider::before { left: 3px; }'), 0);
  assert.equal(scan('.toast-container { right: 1.5rem; }'), 0);
  assert.equal(scan('.page .knob::before { left: 3px; }'), 1);
  assert.equal(scan('.toast-container { left: 1.5rem; }'), 1);
});
