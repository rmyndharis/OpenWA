import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * docs/08 says src/common/errors/ holds the full set of named domain errors and tabulates them. Each class that extends a
 * built-in exception or another domain error is a row; the one plain Error is named in the paragraph below the table.
 */
describe('docs/08 domain error table', () => {
  const classes = readdirSync(__dirname)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .flatMap(file => [...readFileSync(join(__dirname, file), 'utf8').matchAll(/^export class (\w+) extends (\w+)/gm)])
    .filter(([, , parent]) => parent !== 'Error')
    .map(([, name]) => name);
  const docs = readFileSync(join(__dirname, '..', '..', '..', 'docs', '08-development-guidelines.md'), 'utf8');
  const rows = docs
    .slice(docs.indexOf('### Domain errors extend a built-in exception'))
    .split('\n')
    .filter(line => line.startsWith('|'));

  it('has a row for every error class of the folder', () => {
    // A scan that found little would make the comparison pass for no classes.
    expect(classes.length).toBeGreaterThanOrEqual(18);
    expect(classes.filter(name => !rows.some(row => row.includes(`\`${name}\``)))).toEqual([]);
  });
});
