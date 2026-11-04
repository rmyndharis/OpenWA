import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// Layout.tsx wraps every route in the page's one <main>. A second <main> inside a page nests landmarks,
// which the HTML content model does not allow and which gives assistive technology two main regions
// to jump to, the outer one around the whole page.

const SRC = dirname(fileURLToPath(import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

function mainElements(full: string): number {
  const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let count = 0;
  const walk = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText() === 'main')
      count++;
    ts.forEachChild(node, walk);
  };
  walk(source);
  return count;
}

test('only the layout renders a main element', () => {
  const withMain = Object.fromEntries(
    tsxFiles(SRC)
      .map(full => [full.slice(SRC.length + 1), mainElements(full)] as const)
      .filter(([, count]) => count > 0),
  );
  assert.deepEqual(withMain, { 'components/Layout.tsx': 1 });
});
