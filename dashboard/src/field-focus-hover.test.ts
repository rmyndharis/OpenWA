import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decl, readRules, type Rule } from './test-helpers/css-rules.ts';

// A field's border at rest is --control-border (field-border-contrast.test.ts), 1.5:1 from the focus border in the light
// theme and 2.3:1 in the dark one, so a field that shows focus by its border colour alone changes little between the two.
// Such a field also draws a 1px ring in the focus colour, in front of the glow it has: a box-shadow takes no room, so
// the border and the layout stay as they are.

const SRC = dirname(fileURLToPath(import.meta.url));

const cssFiles = (dir = SRC): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full.slice(SRC.length + 1)] : [];
  });

interface Scanned extends Rule {
  file: string;
}
const scanned: Scanned[] = cssFiles().flatMap(file =>
  readRules(pathToFileURL(join(SRC, file))).map(rule => ({ ...rule, file })),
);

// The last compound of a selector: `.a .b > input.c:focus` gives `input.c:focus`.
function lastCompound(selector: string): string {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) cut = i;
  }
  return selector.slice(cut + 1);
}
// The element and the classes a selector ends in, its states, attribute filters and :not() arguments aside.
const subject = (selector: string): string[] => {
  const compound = lastCompound(selector)
    .replace(/:(?:not|where|is|has)\((?:[^()]|\([^()]*\))*\)/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/::?[\w-]+/g, '');
  return [...(/^[a-z][\w-]*/i.exec(compound) ?? []), ...(compound.match(/\.[\w-]+/g) ?? [])];
};

// What a rule paints as a border, one value per declaration; the longhands (border-bottom-color) count.
const BORDER =
  /(?:^|;)\s*border(?:-(?:top|right|bottom|left|inline-start|inline-end|block|inline))?(?:-color)?\s*:\s*([^;]+)/g;
const borders = (body: string): string[] => [...body.matchAll(BORDER)].map(m => m[1].trim());

// A field, or the box around one, is whatever paints --control-border at rest: a state rule for it is found by its
// element or class, so a field added later is covered without a list.
const STATE =
  /:(?:hover|focus|focus-visible|focus-within|active|disabled|checked|invalid|placeholder-shown|read-only)\b|::|\.error\b|\[aria-invalid/;
const FIELD_PARTS = new Set(
  scanned.flatMap(rule =>
    borders(rule.body).some(value => /\bvar\(--control-border\)/.test(value))
      ? rule.selectors.filter(selector => !STATE.test(selector)).flatMap(subject)
      : [],
  ),
);
const isField = (selector: string): boolean => subject(selector).some(part => FIELD_PARTS.has(part));

// A box-shadow value as its layers, the first being the one painted on top.
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.replace(/\s+/g, ' ')) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
    } else current += ch;
  }
  return [...out, current.trim()];
}
// The ring comes first, so the glow behind it never covers it.
const ringIn = (body: string, colour: string): boolean =>
  layers(decl(body, 'box-shadow') ?? '')[0] === `0 0 0 1px var(${colour})`;

const isFocusState = (selector: string): boolean =>
  /:focus(?:-visible|-within)?\b/.test(selector.replace(/:not\([^)]*\)/g, ''));
// The state rules of a field that show focus by painting its border in the focus colour.
const borderCues = (rules: Scanned[]): { rule: Scanned; selector: string }[] =>
  rules.flatMap(rule =>
    borders(rule.body).some(value => /\bvar\(--focus-ring\)/.test(value))
      ? rule.selectors
          .filter(selector => isFocusState(selector) && isField(selector))
          .map(selector => ({ rule, selector }))
      : [],
  );
const focusOffenders = (rules: Scanned[]): string[] => [
  ...new Set(
    borderCues(rules)
      .filter(({ rule }) => !ringIn(rule.body, '--focus-ring'))
      .map(({ rule, selector }) => `${rule.file}: ${selector}`),
  ),
];

// A field that draws the error colour at rest keeps it on focus, so its ring is drawn in that colour, not in the focus one.
const errorOffenders = (rules: Scanned[]): string[] => [
  ...new Set(
    rules.flatMap(rule =>
      rule.selectors
        .filter(
          selector =>
            /\.error\b/.test(selector) &&
            !isFocusState(selector) &&
            isField(selector) &&
            borders(rule.body).some(value => /\bvar\(--error\)/.test(value)),
        )
        .filter(
          selector =>
            !rules.some(other => other.selectors.includes(`${selector}:focus`) && ringIn(other.body, '--error')),
        )
        .map(selector => `${rule.file}: ${selector}:focus`),
    ),
  ),
];

test('the scan reads a field state rule and tells a ring from a border colour alone', () => {
  assert.deepEqual(subject(".a .b > input[type='text']:focus"), ['input']);
  assert.deepEqual(subject('.a input.error:focus'), ['input', '.error']);
  assert.deepEqual(subject(":root:not([data-theme='light']) .a .chips-text:focus"), ['.chips-text']);
  assert.deepEqual(subject("input[type='checkbox']:not(.toggle-switch input):focus-visible"), ['input']);
  assert.deepEqual(layers('0 0 0 1px var(--focus-ring),\n    0 0 0 3px rgba(37, 211, 102, 0.1)'), [
    '0 0 0 1px var(--focus-ring)',
    '0 0 0 3px rgba(37, 211, 102, 0.1)',
  ]);
  assert.ok(FIELD_PARTS.has('input') && FIELD_PARTS.has('select') && FIELD_PARTS.has('textarea'));
  assert.ok(FIELD_PARTS.has('.search-input'), 'a box around a borderless field is a field part');
  assert.ok(!FIELD_PARTS.has('.filter-badge-interactive'));

  const rule = (selector: string, body: string): Scanned => ({ file: 'x.css', media: '', selectors: [selector], body });
  const border = 'border-color: var(--focus-ring)';
  const ring = '0 0 0 1px var(--focus-ring)';
  const glow = '0 0 0 3px rgba(0, 0, 0, 0.1)';
  // [selector, body, whether the scan reports it, why]
  const focusCases: [string, string, boolean, string][] = [
    ['.a input:focus', border, true, 'a border colour alone is no cue'],
    ['.a input:focus', `${border}; box-shadow: ${ring}`, false, 'the ring'],
    ['.a input:focus', `${border}; box-shadow: ${ring}, ${glow}`, false, 'the ring in front of a glow'],
    ['.a input:focus', `${border}; box-shadow: ${glow}, ${ring}`, true, 'a glow painted over the ring'],
    ['.a input:focus', `${border}; box-shadow: ${glow}`, true, 'a glow alone'],
    ['.a input:focus', `${border}; box-shadow: 0 0 0 2px var(--focus-ring)`, true, 'a 2px ring'],
    ['.a input:focus', `${border}; box-shadow: 0 0 0 1px var(--primary)`, true, 'a ring in the brand fill'],
    ['.a input:focus', 'outline: 2px solid var(--focus-ring)', false, 'an outline cue draws no border'],
    ['.a .search-input:focus-within', border, true, 'a box around a field'],
    ['.a .new-group-name:focus', 'border-bottom-color: var(--focus-ring)', true, 'an underline field'],
    ['.a .new-group-name:focus', `border-bottom-color: var(--focus-ring); box-shadow: ${ring}`, false, 'its ring'],
    ['.a .filter-badge-interactive:focus-visible', border, false, 'not a field'],
  ];
  for (const [selector, body, reported, why] of focusCases) {
    assert.equal(focusOffenders([rule(selector, body)]).length, reported ? 1 : 0, why);
  }

  const error = rule('.a input.error', 'border-color: var(--error)');
  const errorCases: [Scanned[], boolean, string][] = [
    [[error], true, 'an error field with no focus rule'],
    [[error, rule('.a input.error:focus', `box-shadow: ${ring}`)], true, 'a ring in the focus colour'],
    [
      [error, rule('.a input.error:focus', `box-shadow: 0 0 0 1px var(--error), ${glow}`)],
      false,
      'a ring in the error colour',
    ],
  ];
  for (const [rules, reported, why] of errorCases) {
    assert.equal(errorOffenders(rules).length, reported ? 1 : 0, why);
  }
});

test('a field that shows focus by its border colour also draws a 1px ring in the focus colour', () => {
  const cues = borderCues(scanned);
  assert.ok(cues.length >= 35, `the scan saw only ${cues.length} field focus rules that paint a border`);
  assert.deepEqual(focusOffenders(scanned), []);
});

test('a field that draws the error colour at rest keeps its ring in that colour on focus', () => {
  const errorFields = scanned.filter(rule =>
    rule.selectors.some(
      selector =>
        /\.error\b/.test(selector) && !isFocusState(selector) && isField(selector) && borders(rule.body).length > 0,
    ),
  );
  assert.ok(errorFields.length >= 1, 'no field draws the error colour any more: drop this check');
  assert.deepEqual(errorOffenders(scanned), []);
});

// The Message Tester's field rule is written for `input` and reaches the native checkbox of a group option, which shows
// no border and keeps the outline ring it draws on keyboard focus: the 1px ring is not drawn around it as well.
test('a native checkbox on the Message Tester takes no ring from the field rule', () => {
  const selector = ".message-tester .form-group input[type='checkbox']:focus";
  const rule = scanned.find(r => r.file === 'pages/MessageTester.css' && r.selectors.includes(selector));
  assert.ok(rule, `pages/MessageTester.css has no ${selector} rule`);
  assert.equal(decl(rule.body, 'box-shadow'), 'none');
});
