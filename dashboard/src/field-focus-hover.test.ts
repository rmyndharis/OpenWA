import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decl, readRules, type Rule } from './test-helpers/css-rules.ts';

// A field's border at rest is --control-border (field-border-contrast.test.ts), 1.5:1 from the focus border in the light
// theme and 2.3:1 in the dark one, so a field that shows focus by its border colour alone changes little between the two.
// Such a field also draws a 1px ring in the focus colour, in front of the glow it has: a box-shadow takes no room, so
// the border and the layout stay as they are. A hover never draws a border fainter than the one at rest.

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

// WCAG contrast of two hex colours.
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

// The custom-property blocks a theme applies, first match wins: a dark block lists only what it changes.
const MEDIA_DARK = '@media (prefers-color-scheme: dark)';
const SYSTEM_DARK = ":root:not([data-theme='light'])";
const blockBody = (file: string, selector: string, media = ''): string => {
  const rule = scanned.find(r => r.file === file && r.media === media && r.selectors.includes(selector));
  assert.ok(rule, `${file} has no ${selector} rule${media ? ` under ${media}` : ''}`);
  return rule.body;
};
const APP = {
  light: blockBody('App.css', ':root'),
  dark: blockBody('App.css', "[data-theme='dark']"),
  systemDark: blockBody('App.css', SYSTEM_DARK, MEDIA_DARK),
};
const CHATS = {
  light: blockBody('pages/Chats.css', '.chats-page'),
  dark: blockBody('pages/Chats.css', "[data-theme='dark'] .chats-page"),
  systemDark: blockBody('pages/Chats.css', `${SYSTEM_DARK} .chats-page`, MEDIA_DARK),
};
const THEMES: Record<string, string[]> = {
  light: [CHATS.light, APP.light],
  'dark theme': [CHATS.dark, CHATS.light, APP.dark, APP.light],
  'system dark': [CHATS.systemDark, CHATS.light, APP.systemDark, APP.light],
};
// Every surface a field is drawn on or filled with: the dialog and the card, the page, and on the chat page the panel and
// the header strip.
const SURFACES = ['--bg-white', '--bg-light', '--chat-panel', '--chat-panel-header'];

// A colour as written (`var(--x, #fff)` or a hex) resolved to a hex string in one theme.
function hexOf(value: string, blocks: string[]): string {
  const alias = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(value.trim());
  if (!alias) {
    assert.match(value.trim(), /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i, `${value} is not a hex colour`);
    return value.trim();
  }
  const own = blocks.map(css => decl(css, alias[1])).find(v => v !== undefined) ?? alias[2];
  assert.ok(own, `${alias[1]} is defined nowhere`);
  return hexOf(own, blocks);
}

const isHover = (selector: string): boolean => /:hover\b/.test(selector.replace(/:not\([^)]*\)/g, ''));
// The border colours a field hover rule paints that are fainter, on some surface of some theme, than the border at rest.
const hoverOffenders = (rules: Scanned[]): string[] => [
  ...new Set(
    rules.flatMap(rule =>
      rule.selectors
        .filter(selector => isHover(selector) && isField(selector))
        .flatMap(selector =>
          borders(rule.body)
            .filter(value => !/^(?:none|0)\b/.test(value))
            .flatMap(value => {
              const colour = /var\([^)]*\)|#[0-9a-f]{3,6}\b/i.exec(value)?.[0];
              if (!colour) return [`${rule.file}: ${selector} => ${value} is neither a token nor a hex colour`];
              return Object.entries(THEMES).flatMap(([theme, blocks]) =>
                SURFACES.flatMap(surface => {
                  const on = rgb(hexOf(`var(${surface})`, blocks));
                  const hover = contrast(rgb(hexOf(colour, blocks)), on);
                  const rest = contrast(rgb(hexOf('var(--control-border)', blocks)), on);
                  return hover >= rest
                    ? []
                    : [
                        `${rule.file}: ${selector} => ${colour}: ${theme}, ${hover.toFixed(2)}:1 on ${surface}, ` +
                          `the border at rest is ${rest.toFixed(2)}:1`,
                      ];
                }),
              );
            }),
        ),
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

// A box that rings on :focus-within holds a borderless field. In a dialog the dialog's input rule reaches that field
// too and would draw a second frame inside the first.
test('the catalog search field draws no ring of its own inside the box that rings', () => {
  const box = scanned.find(
    r => r.file === 'pages/Plugins.css' && r.selectors.includes('.plugins-page .catalog-search:focus-within'),
  );
  assert.ok(box && ringIn(box.body, '--focus-ring'), 'the catalog search box no longer rings: drop this check');
  const selector = '.plugins-page .catalog-search input:focus';
  const rule = scanned.find(r => r.file === 'pages/Plugins.css' && r.selectors.includes(selector));
  assert.ok(rule, `pages/Plugins.css has no ${selector} rule`);
  assert.equal(decl(rule.body, 'box-shadow'), 'none');
});

// The dialog's input rule does not reach a textarea, and no rule of the page did: these kept the browser's own outline
// beside inputs that ring. The scan above holds each rule to the ring once it paints the focus border.
test('the textareas of the API key and plugin instance dialogs state their own focus rule', () => {
  const rules: [string, string][] = [
    ['pages/ApiKeys.css', '.api-keys-page .modal-body > textarea:focus'],
    ['components/PluginInstances.css', '.plugin-instances textarea:focus'],
  ];
  for (const [file, selector] of rules) {
    const rule = scanned.find(r => r.file === file && r.selectors.includes(selector));
    assert.ok(rule, `${file} has no ${selector} rule`);
    assert.equal(decl(rule.body, 'border-color'), 'var(--focus-ring)', `${selector} paints no focus border`);
    assert.ok(ringIn(rule.body, '--focus-ring'), `${selector} draws no ring`);
  }
});

test('the scan reads a field hover rule and flags a border fainter than the one at rest', () => {
  const rule = (selector: string, body: string): Scanned => ({ file: 'x.css', media: '', selectors: [selector], body });
  // The themes the scan reports for a rule: the brand fill is 1.98:1 on white, under the border at rest there, and 7.38:1 on
  // the dark card, over it.
  const themes = (selector: string, body: string): string[] => [
    ...new Set(
      hoverOffenders([rule(selector, body)]).map(
        line => /: (light|dark theme|system dark),/.exec(line)?.[1] ?? 'unreadable',
      ),
    ),
  ];
  const everyTheme = ['light', 'dark theme', 'system dark'];
  assert.deepEqual(themes('select:hover', 'border-color: var(--primary, #25d366)'), ['light']);
  assert.deepEqual(themes('select:hover', 'border-color: var(--focus-ring)'), []);
  assert.deepEqual(themes('select:hover', 'border-color: var(--control-border)'), []);
  assert.deepEqual(themes('select:hover', 'border-color: var(--border)'), everyTheme);
  assert.deepEqual(
    themes('.a .search-input:hover', 'border: 1px solid var(--primary)'),
    ['light'],
    'a box, a shorthand',
  );
  assert.deepEqual(themes('.a input[type="text"]:hover', 'border-color: #94a3b8'), ['light'], 'a hex colour');
  assert.deepEqual(themes('select:hover', 'color: var(--primary)'), [], 'no border');
  assert.deepEqual(themes('select:hover', 'border-color: rgba(0, 0, 0, 0.5)'), ['unreadable']);
  assert.deepEqual(themes('.a .btn-secondary:hover', 'border-color: var(--text-muted)'), [], 'not a field');
  assert.deepEqual(themes('.a .filter-badge-interactive:hover', 'border-color: var(--primary)'), [], 'not a field');
});

test('a field hover never draws a border fainter than the border at rest, in every theme', () => {
  const hovers = scanned.filter(
    rule => rule.selectors.some(selector => isHover(selector) && isField(selector)) && borders(rule.body).length > 0,
  );
  assert.ok(
    hovers.some(rule => rule.selectors.includes('select:hover')),
    'the hover rule of a select is not seen',
  );
  assert.deepEqual(hoverOffenders(scanned), []);
});
