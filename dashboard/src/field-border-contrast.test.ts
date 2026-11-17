import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decl, readRules, type Rule } from './test-helpers/css-rules.ts';

// WCAG 2.2 SC 1.4.11 asks 3:1 of the boundary that tells a control from what is around it, and an empty text field is
// told apart from its dialog by that border alone. The card hairline (--border) is 1.23:1 on white in the light theme
// and 1.41:1 on --bg-white in the dark one, so every text field, select and textarea paints its border at rest in
// --control-border (App.css), and so does the box around a field that draws none of its own: a search box, the
// composer pill, a custom select. Focus, hover and error keep their own borders.

const SRC = dirname(fileURLToPath(import.meta.url));

const cssFiles = (dir = SRC): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full.slice(SRC.length + 1)] : [];
  });
const sheets = new Map(cssFiles().map(file => [file, readRules(pathToFileURL(join(SRC, file)))]));

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

const MEDIA_DARK = '@media (prefers-color-scheme: dark)';
const SYSTEM_DARK = ":root:not([data-theme='light'])";
const ruleBody = (file: string, selector: string, media = ''): string => {
  const rule = sheets.get(file)?.find(r => r.media === media && r.selectors.includes(selector));
  assert.ok(rule, `${file} has no ${selector} rule${media ? ` under ${media}` : ''}`);
  return rule.body;
};
const APP = {
  light: ruleBody('App.css', ':root'),
  dark: ruleBody('App.css', "[data-theme='dark']"),
  systemDark: ruleBody('App.css', SYSTEM_DARK, MEDIA_DARK),
};
const CHATS = {
  light: ruleBody('pages/Chats.css', '.chats-page'),
  dark: ruleBody('pages/Chats.css', "[data-theme='dark'] .chats-page"),
  systemDark: ruleBody('pages/Chats.css', `${SYSTEM_DARK} .chats-page`, MEDIA_DARK),
};
// The custom-property blocks a theme applies, first match wins: a dark block lists only what it changes.
const THEMES: Record<string, string[]> = {
  light: [CHATS.light, APP.light],
  'dark theme': [CHATS.dark, CHATS.light, APP.dark, APP.light],
  'system dark': [CHATS.systemDark, CHATS.light, APP.systemDark, APP.light],
};

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

test('the field border token is set in the light block and in both dark blocks, to one dark value', () => {
  const [light, dark, systemDark] = [APP.light, APP.dark, APP.systemDark].map(css => decl(css, '--control-border'));
  for (const [name, value] of [
    ['light', light],
    ['dark theme', dark],
    ['system dark', systemDark],
  ] as const) {
    assert.match(value ?? '', /^#[0-9a-f]{6}$/i, `${name} sets no --control-border`);
  }
  assert.equal(dark, systemDark, 'the two dark blocks give the field border different values');
});

// Every surface a field is drawn on or filled with: the dialog and the card, the page, and on the chat page the panel
// and the header strip (the group and contact dialogs fill their fields with it, and the composer pill sits on it).
const SURFACES = ['--bg-white', '--bg-light', '--chat-panel', '--chat-panel-header'];

test('the field border clears 3:1 on every surface a field is drawn on or filled with, in every theme', () => {
  const failures = Object.entries(THEMES).flatMap(([theme, blocks]) =>
    SURFACES.flatMap(surface => {
      const ratio = contrast(rgb(hexOf('var(--control-border)', blocks)), rgb(hexOf(`var(${surface})`, blocks)));
      return ratio >= 3 ? [] : [`${theme}: --control-border is ${ratio.toFixed(2)}:1 on ${surface}`];
    }),
  );
  assert.deepEqual(failures, []);
});

// What a rule paints as a border: the border declarations that carry a colour, in source order. `border: none` and
// `border: 0` paint nothing, so `.chips-text` (`border: none` first, a border further down) is read for the border it
// paints.
const BORDER_DECL =
  /(?:^|;)\s*border(?:-(?:top|right|bottom|left|inline-start|inline-end|block|inline))?(?:-color)?\s*:\s*([^;]+)/g;
const painted = (body: string): string[] =>
  [...body.matchAll(BORDER_DECL)]
    .map(m => m[1].trim())
    .filter(v => /\b(?:var|rgba?|hsla?)\(|#[0-9a-f]{3,8}\b/i.test(v));
const isToken = (value: string): boolean => /\bvar\(--control-border\)/.test(value);

test('a text field in a dialog is bordered at 3:1 against the dialog it sits in, in every theme', () => {
  const border = painted(ruleBody('index.css', '.modal-body input'));
  assert.equal(border.length, 1, `.modal-body input paints ${border.length} borders`);
  const colour = /var\([^)]*\)|#[0-9a-f]{3,6}\b/i.exec(border[0])?.[0];
  assert.ok(colour, `${border[0]} holds no colour`);
  const dialog = decl(ruleBody('index.css', '.modal'), 'background');
  assert.ok(dialog, '.modal paints no background');
  const failures = Object.entries(THEMES).flatMap(([theme, blocks]) => {
    const ratio = contrast(rgb(hexOf(colour, blocks)), rgb(hexOf(dialog, blocks)));
    return ratio >= 3 ? [] : [`${theme}: ${colour} is ${ratio.toFixed(2)}:1 against the dialog`];
  });
  assert.deepEqual(failures, []);
});

// A selector split into what leads to its last compound and the compound itself: `.a .b > input.c` is `.a .b > ` and
// `input.c`.
function split(selector: string): [string, string] {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) cut = i;
  }
  return [selector.slice(0, cut + 1), selector.slice(cut + 1)];
}
const parentOf = (selector: string): string =>
  split(selector)[0]
    .trim()
    .replace(/[>+~]$/, '')
    .trim();

// [stylesheet, selector] of a field a class styles, and of the boxes that draw the border of a field that has none of
// its own (a search box, the composer pill, the row of chips) or of a custom select. Each has to keep existing, so a
// rename cannot take it out of this check unseen.
const CLASS_FIELDS = [
  ['components/FilterBuilder.css', '.chips-row .chips-text'],
  ['components/GlobalSearch.css', '.global-search-input'],
  ['pages/Chats.css', '.chats-page .new-group-name'],
  ['pages/NumberChecker.css', '.number-checker .nc-input'],
  ['pages/NumberChecker.css', '.number-checker .nc-textarea'],
  ['pages/Plugins.css', '.plugins-page .sessions-select'],
  ['pages/Sessions.css', '.sessions-page .pairing-input'],
] as const;
const BOXES = [
  ['components/FilterBuilder.css', '.chips-row'],
  ['pages/Chats.css', '.chats-page .chat-search-input'],
  ['pages/Chats.css', '.chats-page .message-input-pill'],
  ['pages/Login.css', '.login-container .login-language'],
  ['pages/Logs.css', '.logs-page .filter-group'],
  ['pages/Logs.css', '.logs-page .search-input'],
  ['pages/Plugins.css', '.plugins-page .catalog-search'],
  ['pages/Sessions.css', '.sessions-page .filter-group'],
  ['pages/Sessions.css', '.sessions-page .search-input'],
  ['pages/Templates.css', '.templates-page .templates-search'],
] as const;
// Classes whose rules style a field or a custom select but may paint no border of their own.
const FIELD_CLASSES = [
  ...CLASS_FIELDS.map(([, selector]) => /\.([\w-]+)$/.exec(selector)![1]),
  'message-text-input',
  'templates-session-select',
  'filter-field',
  'filter-operator',
  'filter-bool',
  'custom-select',
];

// A rule for a field at rest. A state (hover, focus, disabled, error) keeps the border it has; a checkbox, radio or
// file input draws no text box.
const STATE =
  /:(?:hover|focus|focus-visible|focus-within|active|disabled|checked|invalid|placeholder-shown|read-only)\b|::|\.error\b|\[aria-invalid/;
const NOT_A_TEXT_BOX = /\[type=['"]?(?:checkbox|radio|file|range|hidden)['"]?\]/;
const isFieldSubject = (subject: string): boolean =>
  /^(?:input|select|textarea)(?![\w-])/.test(subject) ||
  FIELD_CLASSES.some(name => new RegExp(`\\.${name}(?![\\w-])`).test(subject));
const isFieldAtRest = (selector: string): boolean =>
  isFieldSubject(split(selector)[1]) && !STATE.test(selector) && !NOT_A_TEXT_BOX.test(split(selector)[1]);

interface FieldRule {
  file: string;
  selector: string;
  rule: Rule;
}
const fieldRules: FieldRule[] = [...sheets].flatMap(([file, rules]) =>
  rules.flatMap(rule => rule.selectors.filter(isFieldAtRest).map(selector => ({ file, selector, rule }))),
);

test('the scan reads every border a rule paints and leaves states and other inputs alone', () => {
  assert.deepEqual(painted('border: none; border: 1px solid var(--border)'), ['1px solid var(--border)']);
  assert.deepEqual(painted('border-radius: 8px; border: 0'), []);
  assert.deepEqual(painted('border-bottom: 2px solid var(--a); border-color: #fff'), ['2px solid var(--a)', '#fff']);
  assert.deepEqual(split('.a .b > input.c'), ['.a .b > ', 'input.c']);
  assert.equal(parentOf('.a .b > input'), '.a .b');
  assert.equal(isFieldAtRest('.a .b > input'), true);
  assert.equal(isFieldAtRest(".a input[type='color']"), true);
  assert.equal(isFieldAtRest('.a input:focus'), false);
  assert.equal(isFieldAtRest('.a input.error'), false);
  assert.equal(isFieldAtRest('select:hover'), false);
  assert.equal(isFieldAtRest('input::placeholder'), false);
  assert.equal(isFieldAtRest("input[type='checkbox']"), false);
  assert.equal(isFieldAtRest('.a .nc-input'), true);
  assert.equal(isFieldAtRest('.a .custom-select-trigger'), false);
});

test('every text field, select and textarea paints its border at rest in --control-border', () => {
  const painters = fieldRules.filter(({ rule }) => painted(rule.body).length > 0);
  assert.ok(painters.length >= 25, `the scan saw only ${painters.length} field rules that paint a border`);
  const offenders = painters.flatMap(({ file, selector, rule }) =>
    painted(rule.body)
      .filter(value => !isToken(value))
      .map(value => `${file}: ${selector} => ${value}`),
  );
  assert.deepEqual([...new Set(offenders)], []);
});

test('the class-styled fields and the boxes around borderless fields exist and paint the token', () => {
  for (const [file, selector] of [...CLASS_FIELDS, ...BOXES]) {
    const rule = sheets.get(file)?.find(r => r.media === '' && r.selectors.includes(selector));
    assert.ok(rule, `${file} no longer has ${selector}`);
    const values = painted(rule.body);
    assert.ok(values.length > 0, `${file}: ${selector} paints no border`);
    assert.deepEqual(
      values.filter(value => !isToken(value)),
      [],
      `${file}: ${selector}`,
    );
  }
  for (const name of FIELD_CLASSES) {
    assert.ok(
      fieldRules.some(({ selector }) => split(selector)[1].includes(`.${name}`)),
      `no rule styles .${name} any more`,
    );
  }
});

// A box named here draws no boundary of the field it holds.
const NOT_A_FIELD_BOX: Record<string, string> = {
  'pages/Chats.css: .chats-page .session-picker-search':
    'the divider between the search row and the list of sessions in the popover, not a box around the field',
};

test('the box around a borderless field or a custom select paints its border in the token', () => {
  const borderless = (rule: Rule): boolean =>
    /(?:^|;)\s*border\s*:\s*(?:none|0)\b/.test(rule.body) && painted(rule.body).length === 0;
  const boxes = new Map<string, Rule[]>();
  for (const { file, selector, rule } of fieldRules) {
    const subject = split(selector)[1];
    if (!borderless(rule) && !/\.custom-select(?![\w-])/.test(subject)) continue;
    const parent = parentOf(selector);
    if (!parent) continue;
    boxes.set(
      `${file}: ${parent}`,
      (sheets.get(file) ?? []).filter(r => r.selectors.includes(parent)),
    );
  }
  assert.ok(boxes.size >= 9, `the scan found only ${boxes.size} boxes around borderless fields`);
  for (const name of Object.keys(NOT_A_FIELD_BOX)) {
    assert.ok(boxes.has(name), `${name} is no longer a box around a borderless field: drop it from the exceptions`);
  }
  const offenders = [...boxes].flatMap(([key, rules]) =>
    key in NOT_A_FIELD_BOX
      ? []
      : rules.flatMap(rule =>
          painted(rule.body)
            .filter(value => !isToken(value))
            .map(value => `${key} => ${value}`),
        ),
  );
  assert.deepEqual([...new Set(offenders)], []);
});
