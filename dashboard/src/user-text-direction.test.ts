import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { decl, readAllSheets, readRules } from './test-helpers/css-rules.ts';

// Text a person typed, or that a contact or a plugin author wrote, has a direction of its own. Drawn under the page
// direction, a Latin sentence in an Arabic or Hebrew page shows its full stop and its closing bracket on the wrong end,
// and an Arabic sentence in a block forced left to right reads its clauses in the wrong order. Every element that
// shows such text, and every field it is typed into, takes its direction from its own characters (unicode-bidi:
// plaintext), as the chat list and the template picker already do. What only names a thing (an id, a phone number, a
// URL) is not listed here: it stays on <bdi dir="ltr">. The elements are listed below; the fields are not listed at
// all: one rule in index.css covers them, and a scan of the markup checks that it covers every one.

/** An element, with the declarations that keep its box as wide as its text when its layout needs them. */
type Entry = readonly [sheet: string, selector: string, what: string, hugs?: Readonly<Record<string, string>>];

const FIT = { width: 'fit-content', 'max-width': '100%' };

const SHOWN: readonly Entry[] = [
  ['components/GlobalSearch.css', '.global-search-hit-snippet', 'the excerpt of a found message', FIT],
  [
    'components/chats/RoomSearch.css',
    '.chats-page .room-search-hit-snippet',
    'the excerpt of a message found in a chat',
    FIT,
  ],
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
  ['pages/Logs.css', '.logs-page .timestamp', 'the time of an audit entry', { width: 'fit-content' }],
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

// The fields. index.css declares unicode-bidi: plaintext once, on each kind of field a person types into, so a field
// that is added later has it without being listed. This scan reads every <input> and <textarea> in the markup, sorts it
// by its type, and fails when a kind of typed-text field is not covered by that rule, when a type is neither typed text
// nor known not to be, or when a stylesheet gives a field another direction behavior.

const SRC = dirname(fileURLToPath(import.meta.url));

/** The kinds of typed-text field, by type attribute ('' is no attribute), with the selector that covers each. */
const TYPED_TEXT = new Map([
  ['textarea', 'textarea'],
  ['', 'input:not([type])'],
  ['text', "input[type='text']"],
  ['search', "input[type='search']"],
]);

/** Inputs that hold an address, a number, a secret, a choice or a file: not typed text, they keep their direction. */
const NOT_TYPED_TEXT = new Set([
  'url',
  'email',
  'tel',
  'number',
  'password',
  'checkbox',
  'radio',
  'file',
  'range',
  'color',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
  'hidden',
  'button',
  'submit',
  'reset',
  'image',
]);

/** A field whose type is an expression: the types it can take, and why it is one field. Keyed by file and expression. */
const COMPUTED_TYPE = new Map<string, { types: readonly string[]; why: string }>([
  [
    "pages/Login.tsx: showKey ? 'text' : 'password'",
    { types: ['text', 'password'], why: 'the API key, readable while it is shown' },
  ],
  [
    'pages/Plugins.tsx: inputType',
    { types: ['number', 'password', 'text'], why: 'a plugin setting, by the type its schema gives it' },
  ],
]);

interface Field {
  file: string;
  where: string;
  tag: string;
  /** The type attribute, 'textarea' for a textarea, '' for none, or the expression when it is computed. */
  type: string;
  computed: boolean;
  classes: string[];
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

const text = (node: ts.Node | undefined): string | undefined =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;

function fieldsIn(full: string): Field[] {
  const file = full.slice(SRC.length + 1);
  const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Field[] = [];
  const walk = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      /^(?:input|textarea)$/.test(node.tagName.getText())
    ) {
      const tag = node.tagName.getText();
      const where = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      let type = tag === 'textarea' ? 'textarea' : '';
      let computed = false;
      const classes: string[] = [];
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) {
          // A spread can carry the type, so it is as computed as an expression is.
          type = `{...${attribute.expression.getText()}}`;
          computed = true;
        } else if (attribute.name.getText() === 'type' && tag === 'input' && !computed) {
          const init = attribute.initializer;
          const literal = text(init) ?? (init && ts.isJsxExpression(init) ? text(init.expression) : undefined);
          // type="" is a text field to the browser but matches none of the selectors below, so it stays unclassified.
          if (literal !== undefined) type = literal === '' ? '(empty)' : literal.toLowerCase();
          else if (init && ts.isJsxExpression(init) && init.expression) {
            type = init.expression.getText();
            computed = true;
          }
        } else if (attribute.name.getText() === 'className' && attribute.initializer) {
          const collect = (n: ts.Node): void => {
            const part =
              text(n) ?? (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) ? n.text : undefined);
            if (part !== undefined) classes.push(...part.split(/\s+/).filter(Boolean));
            ts.forEachChild(n, collect);
          };
          collect(attribute.initializer);
        }
      }
      found.push({ file, where, tag, type, computed, classes });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

const markup = tsxFiles(SRC).flatMap(fieldsIn);
/** The types a field can have: its own, or what its COMPUTED_TYPE entry lists. */
const typesOf = (f: Field): readonly string[] =>
  f.computed ? (COMPUTED_TYPE.get(`${f.file}: ${f.type}`)?.types ?? []) : [f.type];
const known = (type: string): boolean => TYPED_TEXT.has(type) || NOT_TYPED_TEXT.has(type);
/** Every selector of a top-level index.css rule that declares `prop: value`. */
const indexSelectors = (prop: string, value: string): Set<string> =>
  new Set(
    sheet('index.css')
      .filter(r => r.media === '' && decl(r.body, prop) === value)
      .flatMap(r => r.selectors),
  );

test('the scan finds the fields of the markup', () => {
  const message = markup.find(f => f.file === 'components/chats/ChatComposer.tsx' && f.type === 'textarea');
  assert.ok(message, 'the scan no longer finds the message field');
  assert.ok(message.classes.includes('message-text-input'), 'the scan no longer reads a field class name');
  assert.ok(
    markup.some(f => f.computed),
    'the scan no longer finds a field with a computed type',
  );
});

test('every input and textarea is typed text, or is known not to be', () => {
  const unclassified = markup.flatMap(f => {
    if (!f.computed) return known(f.type) ? [] : [`${f.where}: <${f.tag} type="${f.type}"> is not classified`];
    const listed = COMPUTED_TYPE.get(`${f.file}: ${f.type}`);
    if (!listed) return [`${f.where}: <${f.tag}> has the computed type ${f.type}: list it in COMPUTED_TYPE`];
    return listed.types.filter(type => !known(type)).map(type => `${f.where}: computed type ${type} is not classified`);
  });
  assert.deepEqual(unclassified, []);
  const stale = [...COMPUTED_TYPE.keys()].filter(
    key => !markup.some(f => f.computed && `${f.file}: ${f.type}` === key),
  );
  assert.deepEqual(stale, [], 'COMPUTED_TYPE lists a field the markup no longer has');
});

test('index.css gives every kind of typed-text field in the markup its direction from its own characters', () => {
  const covered = indexSelectors('unicode-bidi', 'plaintext');
  const missing = new Map<string, string>();
  for (const f of markup)
    for (const type of typesOf(f)) {
      const selector = TYPED_TEXT.get(type);
      if (selector && !covered.has(selector) && !missing.has(selector)) missing.set(selector, f.where);
    }
  assert.deepEqual(
    [...missing].map(
      ([selector, where]) => `index.css: ${selector} has no unicode-bidi: plaintext (first field: ${where})`,
    ),
    [],
  );
});

// The same property aligns a line by its own direction, so a Latin line would sit at the left edge of an Arabic page
// unless the field is pinned to the right as the other text fields are (the text-align: right rule in index.css).
test('an Arabic page keeps every kind of typed-text field at its right edge', () => {
  const right = indexSelectors('text-align', 'right');
  assert.deepEqual(
    [...TYPED_TEXT.values()].filter(selector => !right.has(`[dir='rtl'] ${selector}`)),
    [],
  );
});

/** Does the element that a selector styles (its last compound) name a typed-text field, or a class one carries? */
function targetsField(selector: string, classes: ReadonlySet<string>): boolean {
  const compound =
    selector
      .replace(/:(?:not|is|where|has)\([^)]*\)/g, '')
      .trim()
      .split(/[\s>+~]+/)
      .pop() ?? '';
  const head = compound.replace(/:[\w-]+(\([^)]*\))?/g, '');
  const type = /\[type=['"]?([\w-]+)['"]?\]/.exec(head)?.[1];
  const field =
    /^textarea(?![\w-])/.test(head) || (/^input(?![\w-])/.test(head) && (type === undefined || TYPED_TEXT.has(type)));
  return field || [...head.matchAll(/\.([\w-]+)/g)].some(m => classes.has(m[1]));
}

test('the check tells a field from the rest', () => {
  const classes = new Set(['new-group-name']);
  assert.ok(targetsField('.chats-page .status-compose-modal textarea', classes));
  assert.ok(targetsField("[dir='rtl'] input[type='text']", classes));
  assert.ok(targetsField('input:not([type])', classes));
  assert.ok(targetsField('.chats-page .new-group-name:focus', classes));
  assert.ok(!targetsField("[dir='rtl'] input[type='url']", classes));
  assert.ok(!targetsField("input[type='checkbox']:not(.toggle-switch input)", classes));
  assert.ok(!targetsField("[dir='rtl'] pre", classes));
  assert.ok(!targetsField('.mono', classes));
});

test('no stylesheet gives a typed-text field a unicode-bidi other than plaintext', () => {
  const classes = new Set(markup.filter(f => typesOf(f).some(type => TYPED_TEXT.has(type))).flatMap(f => f.classes));
  const offenders: string[] = [];
  for (const [file, rules] of readAllSheets())
    for (const rule of rules) {
      const value = decl(rule.body, 'unicode-bidi');
      if (value !== undefined && value !== 'plaintext')
        for (const selector of rule.selectors)
          if (targetsField(selector, classes)) offenders.push(`${file}: ${selector} { unicode-bidi: ${value} }`);
    }
  assert.deepEqual(offenders, []);
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
