import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import ts from 'typescript';

// The session detail modal renders `status-badge <status>` and a session card renders `status-pill <status>`, both
// with the live status as the second class. A status without a rule renders as plain text: the badge once styled
// only the retired names connected, disconnected and connecting, so a ready session showed no green pill and a
// failed one looked the same.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

// The members of the `status` union of the Session interface, read from the API types.
function sessionStatuses(): string[] {
  const file = join(SRC, 'services/api.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'Session') {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name.getText() === 'status' && member.type) {
          const union = member.type;
          if (ts.isUnionTypeNode(union)) {
            for (const t of union.types)
              if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) found.push(t.literal.text);
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

const css = readFileSync(join(SRC, 'pages/Sessions.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = new Set(
  [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(m => m[1].split(',').map(s => s.trim().replace(/\s+/g, ' '))),
);

test('the session detail badge and the card pill are styled for every session status', () => {
  const statuses = sessionStatuses();
  assert.ok(statuses.includes('ready') && statuses.includes('action_required'), `read only ${statuses.join(', ')}`);
  const missing = ['status-badge', 'status-pill'].flatMap(kind =>
    statuses.filter(status => !selectors.has(`.sessions-page .${kind}.${status}`)).map(status => `${kind}.${status}`),
  );
  assert.deepEqual(missing, []);
});
