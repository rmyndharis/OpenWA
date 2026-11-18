import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decl, readRules } from './test-helpers/css-rules.ts';

// Text a person typed, or that a contact or a plugin author wrote, has a direction of its own. Drawn under the page
// direction, a Latin sentence in an Arabic or Hebrew page shows its full stop and its closing bracket on the wrong end,
// and an Arabic sentence in a block forced left to right reads its clauses in the wrong order. Every element that
// shows such text, and every field it is typed into, takes its direction from its own characters (unicode-bidi:
// plaintext), as the chat list and the template picker already do. What only names a thing (an id, a phone number, a
// URL) is not listed here: it stays on <bdi dir="ltr">.

/** An element or a field, with the declarations that keep its box as wide as its text when its layout needs them. */
type Entry = readonly [sheet: string, selector: string, what: string, hugs?: Readonly<Record<string, string>>];

const FIT = { width: 'fit-content', 'max-width': '100%' };

const SHOWN: readonly Entry[] = [
  ['components/GlobalSearch.css', '.global-search-hit-snippet', 'the excerpt of a found message', FIT],
  ['pages/Dashboard.css', '.dashboard .session-name', 'a session name in the sessions table', { width: 'fit-content' }],
  ['pages/Sessions.css', '.sessions-page .card-header h3', 'a session name on its card'],
  [
    'pages/Webhooks.css',
    '.webhooks-page .webhook-meta-value',
    'the session a webhook belongs to',
    { width: 'fit-content' },
  ],
  ['pages/Templates.css', '.templates-page .template-list-title', 'a template name in the list', FIT],
  ['pages/Templates.css', '.templates-page .template-list-body', 'a template body in the list', FIT],
  ['pages/ApiKeys.css', '.api-keys-page .name-cell', 'the name of a key'],
  ['pages/ApiKeys.css', '.api-keys-page .sessions-cell', 'the sessions a key is limited to'],
  ['pages/Logs.css', '.logs-page .action .log-message', 'the message of an audit entry', FIT],
  ['pages/Logs.css', '.logs-page .session', 'the session an audit entry names', FIT],
  ['pages/Logs.css', '.logs-page .api-key', 'the key an audit entry names', FIT],
  ['pages/Plugins.css', '.plugins-page .plugin-name', 'the name of a plugin'],
  ['pages/Plugins.css', '.plugins-page .plugin-description', 'the description of a plugin', FIT],
  [
    'pages/Plugins.css',
    '.plugins-page .rail-active-name',
    'the name of an active plugin in the status rail',
    { flex: '0 1 auto', 'margin-inline-end': 'auto' },
  ],
  ['pages/Plugins.css', '.plugins-page .catalog-row-name', 'the name of a catalog plugin', FIT],
  ['pages/Plugins.css', '.plugins-page .catalog-row-desc', 'the description of a catalog plugin', FIT],
  ['pages/Plugins.css', '.plugins-page .catalog-row-author', 'the author of a catalog plugin'],
];

const FIELDS: readonly Entry[] = [
  ['pages/Chats.css', '.chats-page .message-input-pill .message-text-input', 'the message field of a chat'],
  ['pages/Templates.css', '.templates-page .template-form input', 'the name, header and footer of a template'],
  ['pages/Templates.css', '.templates-page .template-form textarea', 'the body of a template'],
  ['pages/Templates.css', '.templates-page .placeholder-list input', 'a value tried in the preview'],
  ['pages/Templates.css', '.templates-page .templates-search input', 'the template search box'],
  ['pages/Sessions.css', '.sessions-page .search-input input', 'the session search box'],
  ['pages/Logs.css', '.logs-page .search-input input', 'the audit log search box'],
  ['components/GlobalSearch.css', '.global-search-input', 'the message search box'],
];

const sheet = (file: string) => readRules(new URL(`./${file}`, import.meta.url));
/** The rules of `selector` that apply at every width. */
const rulesOf = (file: string, selector: string) =>
  sheet(file).filter(r => r.media === '' && r.selectors.includes(selector));

/** What is wrong with the rule of `selector`, or null when it reads its own direction. */
function problem(file: string, selector: string): string | null {
  const own = rulesOf(file, selector);
  if (own.length === 0) return 'no rule for it';
  return own.some(r => decl(r.body, 'unicode-bidi') === 'plaintext') ? null : 'no unicode-bidi: plaintext';
}

const offenders = (entries: readonly Entry[]): string[] =>
  entries.flatMap(([file, selector, what]) => {
    const wrong = problem(file, selector);
    return wrong ? [`${file}: ${selector} (${what}): ${wrong}`] : [];
  });

test('the check accepts text that takes its direction from its own characters (the template picker rows)', () => {
  assert.equal(problem('pages/Chats.css', '.chats-page .slash-template-name'), null);
  assert.equal(problem('pages/Chats.css', '.chats-page .slash-template-preview'), null);
});

test('text a person or a plugin author wrote is drawn in its own direction, not the page direction', () => {
  assert.deepEqual(offenders(SHOWN), []);
});

test('the fields a person types into take the direction of what they type', () => {
  assert.deepEqual(offenders(FIELDS), []);
});

// The same property aligns the text by its own direction too, so a box that its container stretches would move a
// Latin name to the other side of an Arabic row (and an Arabic one to the other side of an English row), away from the
// header and the cells beside it. These boxes are as wide as their text instead and sit where the page puts them, as
// the chat list names do (see .chat-item-name in Chats.css). The others hug by their layout: an inline cell, or an
// item of a row that is as wide as its content.
test('a box that shows such text is as wide as the text, so the text stays at the edge the page puts it', () => {
  const missing = SHOWN.flatMap(([file, selector, what, hugs]) => {
    const own = rulesOf(file, selector);
    return Object.entries(hugs ?? {})
      .filter(([prop, value]) => !own.some(r => decl(r.body, prop) === value))
      .map(([prop, value]) => `${file}: ${selector} (${what}): ${prop}: ${value}`);
  });
  assert.deepEqual(missing, []);
});

// In a phone card the key name is a block that the card would stretch: it is as wide as the name there too.
test('the key name in a phone card is as wide as the name, so it keeps the edge the page puts it', () => {
  const selector = '.api-keys-page .keys-table tbody tr.table-row td:first-child .name-cell';
  const card = sheet('pages/ApiKeys.css').filter(
    r => r.media === '@media (max-width: 768px)' && r.selectors.includes(selector),
  );
  assert.equal(card.length, 1, 'no card rule for the key name');
  assert.equal(decl(card[0].body, 'width'), 'fit-content');
  assert.equal(decl(card[0].body, 'max-width'), '100%');
});

// A field keeps the page's alignment: index.css pins a text field and a textarea to the right in an Arabic page, by
// input[type='text'], so under plaintext a one-line field with no type attribute would move a Latin line to its left
// edge, away from the textarea under it. Every input of the template editor says what it is.
test('the one-line template fields are typed text fields, which an Arabic page keeps at the right edge', () => {
  const source = readFileSync(new URL('./pages/Templates.tsx', import.meta.url), 'utf8');
  const inputs = source.match(/<input\b[\s\S]*?\/>/g) ?? [];
  assert.ok(
    inputs.length >= 5,
    `expected the editor, the search and the preview values, found ${inputs.length} inputs`,
  );
  assert.deepEqual(
    inputs.filter(tag => !/\btype="text"/.test(tag)),
    [],
  );
});

// [ids, classes and attributes, elements]: enough for the two selectors compared below.
const specificity = (selector: string): number[] => [
  (selector.match(/#[\w-]+/g) ?? []).length,
  (selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? []).length,
  (selector.replace(/\[[^\]]*\]|[.#][\w-]+/g, ' ').match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length,
];
const beats = (a: number[], b: number[]): boolean => {
  const at = a.findIndex((n, i) => n !== b[i]);
  return at >= 0 && a[at] > b[at];
};

// index.css draws every <pre> left to right and flush left, which is right for code and wrong for the message the
// preview shows: an Arabic template read its clauses in the wrong order. The preview rule has to win that rule on
// specificity, and hand the alignment back to the text.
test('the template preview is drawn by its own text over the code rule for <pre>', () => {
  const code = sheet('index.css').find(r => r.selectors.includes("[dir='rtl'] pre"));
  assert.ok(code, 'index.css no longer sets [dir=rtl] pre: drop this check');
  assert.equal(decl(code.body, 'direction'), 'ltr');
  const selector = '.templates-page .template-preview-message pre';
  const preview = rulesOf('pages/Templates.css', selector);
  assert.equal(preview.length, 1, `Templates.css no longer has ${selector}`);
  assert.equal(decl(preview[0].body, 'unicode-bidi'), 'plaintext');
  assert.equal(decl(preview[0].body, 'text-align'), 'start');
  assert.ok(beats(specificity(selector), specificity("[dir='rtl'] pre")), `${selector} does not win`);
});
