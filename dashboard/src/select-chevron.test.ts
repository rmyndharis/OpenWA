import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// index.css turns the native arrow off (appearance: none) and draws a chevron as the select's
// background-image. A later rule that sets the `background` shorthand on a select resets that image to
// none, so the select renders as an empty box with no cue that it opens a list. Rules that only mean to
// set the fill colour have to use background-color.

const SRC = dirname(fileURLToPath(import.meta.url));

function filesUnder(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full, ext);
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

// The class names carried by every <select> element in the app.
function selectClasses(): Set<string> {
  const found = new Set<string>();
  for (const full of filesUnder(SRC, '.tsx')) {
    const source = ts.createSourceFile(
      full,
      readFileSync(full, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const walk = (node: ts.Node): void => {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'select') {
        for (const p of node.attributes.properties) {
          if (
            ts.isJsxAttribute(p) &&
            p.name.getText() === 'className' &&
            p.initializer &&
            ts.isStringLiteral(p.initializer)
          )
            p.initializer.text.split(/\s+/).forEach(c => found.add(c));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return found;
}

// Does the last compound selector (the element the rule styles) name `select` or a class a select carries?
function targetsSelect(selector: string, classes: Set<string>): boolean {
  const compound =
    selector
      .trim()
      .split(/[\s>+~]+/)
      .pop() ?? '';
  const head = compound.replace(/:[\w-]+(\([^)]*\))?/g, '');
  if (/^select\b/.test(head) || /(?:^|[^\w-])select(?![\w-])/.test(head)) return true;
  return [...head.matchAll(/\.([\w-]+)/g)].some(m => classes.has(m[1]));
}

test('no rule that styles a select sets the background shorthand', () => {
  const classes = selectClasses();
  assert.ok(classes.has('sessions-select'), 'the scan no longer finds the select classes');
  const offenders: string[] = [];
  for (const full of filesUnder(SRC, '.css')) {
    const css = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = m[1].split(',').map(s => s.trim());
      if (selectors.some(s => targetsSelect(s, classes)) && /(?:^|;)\s*background\s*:/.test(m[2]))
        offenders.push(`${full.slice(SRC.length + 1)}: ${selectors.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the global select rule keeps the chevron room against a page rule that pads the select', () => {
  const css = readFileSync(join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /(?:^|})\s*select\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'index.css has no select rule');
  assert.match(rule[1], /background-image:\s*url\(/);
  // The chevron sits in the end padding; a page rule with a padding shorthand would otherwise take it back.
  assert.match(rule[1], /padding-inline-end:\s*2\.5rem\s*!important/);
});
