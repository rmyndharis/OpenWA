import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// The Instances tab renders inside the plugin config modal, on the Plugins page. A class that another page styles
// only under its own root (`.api-keys-page .icon-btn`, `.webhooks-page .confirm-modal`) does nothing here, so those
// buttons fell back to the global button padding and the modal to its full width. Every class the component uses
// has to be defined unscoped, or under .plugin-instances.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function classesUsed(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const add = (text: string): void =>
    text
      .split(/\s+/)
      .filter(Boolean)
      .forEach(c => found.add(c));
  // The class names an expression can produce: string parts and the branches of a condition, never the test of one.
  const collect = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n.text);
    else if (ts.isTemplateExpression(n)) {
      add(n.head.text);
      for (const span of n.templateSpans) {
        collect(span.expression);
        add(span.literal.text);
      }
    } else if (ts.isConditionalExpression(n)) {
      collect(n.whenTrue);
      collect(n.whenFalse);
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      collect(n.right);
    else if (ts.isParenthesizedExpression(n) || ts.isJsxExpression(n)) {
      if (n.expression) collect(n.expression);
    }
  };
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText() === 'className' && node.initializer) collect(node.initializer);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return [...found];
}

function selectorsIn(css: string): string[] {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(m =>
    m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')),
  );
}

test('every class the plugin instances tab uses is styled outside another page root', () => {
  const stylesheets = [
    ...readdirSync(join(SRC, 'pages'))
      .filter(f => f.endsWith('.css'))
      .map(f => join(SRC, 'pages', f)),
    ...readdirSync(join(SRC, 'components'))
      .filter(f => f.endsWith('.css'))
      .map(f => join(SRC, 'components', f)),
    join(SRC, 'index.css'),
    join(SRC, 'App.css'),
  ];
  // A page root is the first bare class selector of its stylesheet (styles.scope.test.ts relies on the same).
  const roots = stylesheets
    .filter(f => f.includes('/pages/'))
    .map(f => selectorsIn(readFileSync(f, 'utf8')).find(s => /^\.[a-zA-Z][\w-]*$/.test(s)))
    .filter((root): root is string => Boolean(root));
  assert.ok(roots.length >= 10 && roots.includes('.webhooks-page'), `found page roots: ${roots.join(', ')}`);
  const usable = stylesheets
    .flatMap(f => selectorsIn(readFileSync(f, 'utf8')))
    .filter(
      selector => !roots.some(root => new RegExp(`(^|[\\s>+~])${root.replace('.', '\\.')}(?![\\w-])`).test(selector)),
    );

  const classes = classesUsed(join(SRC, 'components/PluginInstances.tsx'));
  assert.ok(classes.includes('icon-btn') && classes.includes('pi-row'), `read only ${classes.join(', ')}`);
  const missing = classes.filter(c => !usable.some(selector => new RegExp(`\\.${c}(?![\\w-])`).test(selector)));
  assert.deepEqual(missing, []);
});
