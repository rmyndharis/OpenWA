import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readAllSheets, type Rule } from './test-helpers/css-rules.ts';

// Forced colours (a Windows contrast theme, or Firefox with its colours overridden) paint every background in the page
// colour, replace each text and border colour with a system colour and drop box-shadow. A control that shows focus, a
// state or its own shape by fill, colour or shadow alone is then drawn like its peers, or not at all. What the mode
// keeps is an edge, so each class of control below restates itself with one inside @media (forced-colors: active), in
// a block after the rules it restates: an outline for focus, a heavy border for a selected state, a border for a
// filled button, a border and system colours for a switch. The mode keeps a system colour the author writes, so no rule
// here opts out with forced-color-adjust and the user's palette stays in charge. A control of one of these shapes added
// to a stylesheet fails here until it is restated.

const sheets = readAllSheets();
const isForced = (rule: Rule): boolean => /^@media\s*\(forced-colors:\s*active\)$/.test(rule.media);

/** What the forced-colors rules of `file` give `prop` on one of `selectors`. A rule only counts when no other rule for
 * that selector comes after it in the stylesheet: at equal weight the later one wins. */
function forced(file: string, selectors: string[], prop: string): string | undefined {
  const rules = sheets.get(file) ?? [];
  return rules
    .flatMap((rule, i) => {
      const own = isForced(rule) && rule.selectors.some(s => selectors.includes(s));
      const overridden = rules
        .slice(i + 1)
        .some(later => !isForced(later) && later.selectors.some(s => selectors.includes(s)));
      return own && !overridden ? [decl(rule.body, prop)] : [];
    })
    .filter(value => value !== undefined)
    .at(-1);
}

/** The top-level rules, one entry per selector, with the stylesheet each is in. */
const topLevel = [...sheets].flatMap(([file, rules]) =>
  rules.filter(rule => rule.media === '').flatMap(rule => rule.selectors.map(selector => ({ file, selector, rule }))),
);
const unique = (items: string[]): string[] => [...new Set(items)];

// A ring is a box-shadow and a border colour, both of which the mode drops; the field inside the box has no outline.
test('every box that rings on :focus-within draws an outline in forced colours', () => {
  const boxes = topLevel.filter(
    ({ selector, rule }) =>
      selector.endsWith(':focus-within') &&
      (decl(rule.body, 'box-shadow') ?? decl(rule.body, 'border-color')) !== undefined,
  );
  assert.ok(boxes.length >= 9, `the scan saw only ${boxes.length} boxes that ring on :focus-within`);
  const offenders = boxes.filter(
    ({ file, selector }) => forced(file, [selector], 'outline') !== '2px solid var(--focus-ring)',
  );
  assert.deepEqual(unique(offenders.map(({ file, selector }) => `${file}: ${selector}`)), []);
});

// A focusable element that is not a field has no border of its own for the mode to recolour: with its outline off,
// a colour change is the whole cue.
const FOCUSABLE = [
  ['pages/Webhooks.css', '.webhooks-page .filter-badge-interactive', 'the filter badge, which opens its popover'],
];

test('a focusable badge that switches its outline off draws one on keyboard focus in forced colours', () => {
  for (const [file, selector, what] of FOCUSABLE) {
    const off = topLevel.some(
      entry =>
        entry.file === file &&
        entry.selector === selector &&
        /^(?:none|0)\b/.test(decl(entry.rule.body, 'outline') ?? ''),
    );
    assert.ok(off, `${selector} no longer switches its outline off: drop this entry`);
    assert.equal(
      forced(file, [`${selector}:focus-visible`], 'outline'),
      '2px solid var(--focus-ring)',
      `${what} shows no focus`,
    );
  }
});

// A state that differs from its peers by a fill, a colour or a shadow alone looks the same as they do. A font weight, a
// text decoration, an outline or a border width survive the mode, and so does a mark of its own (a word, an icon, a
// native control), which is what the entries below have instead.
const STATE =
  /\.(?:active|selected|current|on|checked|open|pressed|answered|chosen)\b|:checked|\[aria-(?:pressed|selected|current|expanded)/;
const lastCompound = (selector: string): string =>
  selector
    .replace(/:not\([^)]*\)/g, '')
    .trim()
    .split(/\s*[\s>+~]\s*/)
    .pop() ?? '';
const survives = (body: string): boolean =>
  ['font-weight', 'text-decoration', 'text-decoration-line', 'outline', 'border', 'border-width'].some(property => {
    const value = decl(body, property);
    return value !== undefined && !/^(?:none|0)\b/.test(value);
  }) ||
  /(?:^|;)\s*border-(?:top|bottom|left|right|inline-start|inline-end|block-start|block-end)\s*:\s*(?!none|0\b)/.test(
    body,
  );
const paintsState = (body: string): boolean =>
  ['background', 'background-color', 'color', 'border-color', 'box-shadow'].some(
    property => decl(body, property) !== undefined,
  );

const OWN_MARK: Record<string, string> = {
  '.pi-badge.on': 'a badge that says enabled or disabled',
  '.status-badge.active': 'a badge that says Active or Inactive',
  '.toggle-status.active': 'the word Active or Inactive',
  '.event-tag.selected': 'a check icon',
  '.select-check.checked': 'a check icon',
  '.session-scope-option:has(input:checked)': 'its native checkbox',
};

const stateRules = topLevel.filter(({ selector, rule }) => {
  const subject = lastCompound(selector);
  return (
    STATE.test(subject) && !/:hover|:focus|::|:disabled/.test(subject) && paintsState(rule.body) && !survives(rule.body)
  );
});

// The width of the border the peers of a state draw, from the rules for its selector without the state class.
const borderWidth = (body: string): number =>
  Math.max(
    0,
    ...[
      ...body.matchAll(
        /(?:^|;)\s*border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-width)?\s*:\s*([^;]+)/g,
      ),
    ].map(m => Number(/(\d+(?:\.\d+)?)px/.exec(m[1])?.[1] ?? 0)),
  );
const peerWidth = (file: string, selector: string): number =>
  Math.max(
    0,
    ...topLevel
      .filter(entry => entry.file === file && entry.selector === selector.replace(/\.(?:active|selected)$/, ''))
      .map(entry => borderWidth(entry.rule.body)),
  );

test('every entry that keeps its own mark still names a state rule', () => {
  for (const key of Object.keys(OWN_MARK)) {
    assert.ok(
      topLevel.some(({ selector }) => lastCompound(selector) === key),
      `no rule for ${key}: drop this entry`,
    );
  }
});

test('a selected or highlighted item draws a border heavier than its peers in forced colours', () => {
  const needing = stateRules.filter(({ selector }) => !(lastCompound(selector) in OWN_MARK));
  const states = unique(needing.map(({ file, selector }) => `${file}\t${selector}`)).map(entry => entry.split('\t'));
  assert.ok(states.length >= 19, `the scan saw only ${states.length} states that a fill alone marks`);
  const offenders = states.filter(([file, selector]) => {
    const border = forced(file, [selector], 'border') ?? '';
    const width = Number(/^(\d+)px solid CanvasText$/.exec(border)?.[1] ?? 0);
    return width < 3 || width <= peerWidth(file, selector);
  });
  assert.deepEqual(
    offenders.map(([file, selector]) => `${file}: ${selector}`),
    [],
  );
});

// A switch is a track and a knob drawn from background colours, around a checkbox that is not drawn. Forced colours
// paint both in the page colour and drop the knob's shadow, so nothing is left of it or of the state it shows.
test('every custom switch draws its track, knob and on state in system colours in forced colours', () => {
  const tracks = unique(
    topLevel.flatMap(({ file, selector }) =>
      /^\.[\w-]+ \.toggle-slider$/.test(selector) ? [`${file}\t${selector}`] : [],
    ),
  ).map(entry => entry.split('\t'));
  assert.ok(tracks.length >= 4, `the scan saw only ${tracks.length} switches`);
  const offenders = tracks.flatMap(([file, track]) => {
    const knob = ['::before', ':before'].map(pseudo => track + pseudo);
    const on = `${track.replace(' .toggle-slider', '')} .toggle-switch input:checked + .toggle-slider`;
    const onKnob = ['::before', ':before'].map(pseudo => on + pseudo);
    const checks: [string, string | undefined, string][] = [
      ['track border', forced(file, [track], 'border'), '1px solid CanvasText'],
      ['knob', forced(file, knob, 'background'), 'CanvasText'],
      ['on track', forced(file, [on], 'background'), 'Highlight'],
      ['on track border', forced(file, [on], 'border-color'), 'Highlight'],
      ['on knob', forced(file, onKnob, 'background'), 'HighlightText'],
    ];
    return checks.filter(([, got, want]) => got !== want).map(([what]) => `${file}: ${track} ${what}`);
  });
  assert.deepEqual(offenders, []);
});

// A button that is a fill and nothing else is a frame-less word in the mode, beside a secondary button that keeps its
// border. The members of a segmented control are inside a frame their container draws.
const SEGMENT = {
  '.chats-page .status-compose-modal .compose-type-toggle button': 'inside the frame of its group',
  '.message-tester .toggle-group button': 'inside the frame of its group',
};

test('every filled button draws a border in forced colours', () => {
  const fills = topLevel.filter(({ selector, rule }) => {
    const fill = decl(rule.body, 'background') ?? decl(rule.body, 'background-color') ?? '';
    return (
      !/^(?:none|transparent)\b/.test(fill) &&
      fill !== '' &&
      /^(?:none|0)\b/.test(decl(rule.body, 'border') ?? '-') &&
      decl(rule.body, 'cursor') === 'pointer' &&
      !(selector in SEGMENT)
    );
  });
  assert.ok(fills.length >= 11, `the scan saw only ${fills.length} filled buttons`);
  const offenders = fills.filter(({ file, selector }) => forced(file, [selector], 'border') !== '1px solid ButtonText');
  assert.deepEqual(
    offenders.map(({ file, selector }) => `${file}: ${selector}`),
    [],
  );
  for (const key of Object.keys(SEGMENT))
    assert.ok(
      topLevel.some(({ selector }) => selector === key),
      `no rule for ${key}: drop this entry`,
    );
});
