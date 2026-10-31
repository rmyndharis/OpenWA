import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeCsvCell } from './csv.ts';

test('a cell starting with = is apostrophe-prefixed (formula neutralized)', () => {
  // The value contains double quotes, so structural quoting wraps it too — prefix stays inside.
  assert.equal(escapeCsvCell('=HYPERLINK("https://evil.example")'), `"'=HYPERLINK(""https://evil.example"")"`);
});

test('cells starting with +, -, @ are apostrophe-prefixed', () => {
  assert.equal(escapeCsvCell('+cmd'), `'+cmd`);
  assert.equal(escapeCsvCell('-2+3'), `'-2+3`);
  assert.equal(escapeCsvCell('@SUM(A1)'), `'@SUM(A1)`);
});

test('safe cells pass through unchanged', () => {
  assert.equal(escapeCsvCell('session.start'), 'session.start');
  assert.equal(escapeCsvCell('200'), '200');
  assert.equal(escapeCsvCell('a=b'), 'a=b'); // risky char not in leading position
  assert.equal(escapeCsvCell('info@example.com'), 'info@example.com');
  assert.equal(escapeCsvCell(''), '');
});

test('null/undefined become empty cells', () => {
  assert.equal(escapeCsvCell(null), '');
  assert.equal(escapeCsvCell(undefined), '');
});

test('a risky value that also needs quoting keeps the prefix inside the quotes', () => {
  assert.equal(escapeCsvCell('=1,2'), `"'=1,2"`);
});

test('structural quoting is unchanged for commas, quotes and newlines', () => {
  assert.equal(escapeCsvCell('a,b'), '"a,b"');
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
  assert.equal(escapeCsvCell('line1\nline2'), '"line1\nline2"');
});

test('a bare carriage return is quoted, like a newline', () => {
  assert.equal(escapeCsvCell('a\rb'), '"a\rb"');
});

test('cells starting with a tab or carriage return are apostrophe-prefixed', () => {
  assert.equal(escapeCsvCell('\t=1+1'), `'\t=1+1`);
  assert.equal(escapeCsvCell('\r=1'), `"'\r=1"`);
});

test('a bare run of digits is written as is, so a reader gets the number itself', () => {
  assert.equal(escapeCsvCell('919612345678'), '919612345678');
  assert.equal(escapeCsvCell('08123456789'), '08123456789');
});

test('a number that starts with a plus is neutralized like any other formula start', () => {
  assert.equal(escapeCsvCell('+628123456789'), `'+628123456789`);
});
