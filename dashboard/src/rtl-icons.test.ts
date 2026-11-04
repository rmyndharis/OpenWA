import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowLeft, ArrowRight, CornerUpLeft, CornerUpRight, LogIn, LogOut, PanelRight, Send } from 'lucide-react';
import ts from 'typescript';

// A glyph that points along the reading direction (back, send, reply, sign out) has to flip with it:
// under <html dir="rtl"> the back arrow of a single pane chat still pointed left, away from the list it
// returns to, and the paper plane still pointed at the text it was sent from. lucide-react marks each
// icon with a `lucide-<name>` class, which index.css uses to mirror them in one place. A panel icon points at the
// side its panel opens on, the inline end for the chat page's contact panel, so it flips too. (The sidebar's panel
// icons are swapped by Layout.tsx instead and are not part of this rule.)

const SRC = dirname(fileURLToPath(import.meta.url));
const DIRECTIONAL = {
  ArrowLeft,
  ArrowRight,
  CornerUpLeft,
  CornerUpRight,
  LogIn,
  LogOut,
  PanelRight,
  Send,
} as const;
const kebab = (name: string): string => name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

const css = readFileSync(join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const mirrored = new Set(
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => /transform:\s*scaleX\(-1\)/.test(m[2]))
    .flatMap(m => m[1].split(','))
    .map(selector => /^\s*\[dir='rtl'\]\s+\.lucide-([\w-]+)\s*$/.exec(selector)?.[1])
    .filter((name): name is string => Boolean(name)),
);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

/** The directional icons a file imports from lucide-react. */
function importedDirectional(full: string): string[] {
  const source = ts.createSourceFile(full, readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== 'lucide-react') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text;
      if (name in DIRECTIONAL) found.push(name);
    }
  }
  return found;
}

test('lucide renders the class names the mirror rule selects', () => {
  for (const [name, icon] of Object.entries(DIRECTIONAL)) {
    assert.match(
      renderToStaticMarkup(createElement(icon)),
      new RegExp(`class="[^"]*\\blucide-${kebab(name)}\\b`),
      name,
    );
  }
});

test('every directional icon the app imports is mirrored under right-to-left', () => {
  const used = [...new Set(tsxFiles(SRC).flatMap(importedDirectional))];
  assert.ok(used.includes('ArrowLeft') && used.includes('Send'), 'the scan no longer finds the icons in use');
  assert.deepEqual(
    used.filter(name => !mirrored.has(kebab(name))),
    [],
    "add the icon to the [dir='rtl'] rule in index.css, or swap it by direction like Layout.tsx does",
  );
});
