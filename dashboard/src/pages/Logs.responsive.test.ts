import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The audit log table's six columns sat on fixed tracks (180, 200, 150, 150 and 150px and one flexible), and it
// becomes cards only at 768px. Beside the 260px sidebar that row needed about 1340px, so from 769px up to there the
// Severity column ran out of its container: the header read "SEV" and the badges "IN" and "W", behind a scroll that an
// overlay scrollbar does not show. The cards cannot simply start later: they leave out the session, the key and the
// address, three of the six fields of an audit entry. So the tracks give way instead. Each has a floor, and the row
// fits from the window those floors need:
//   floors 11 + 8 + 5 + 5 + 5.5 + 6.5 = 41rem = 656px (at 16px)
//   + 5 gaps of 1rem (80px) + 2 x 1.5rem of row padding (48px) + 2px of container border
//   + 260px of sidebar + 2 x 2rem of page padding (64px) = 1110px
// The last track may run into the row's right padding, so in a browser the Severity cell is inside its container from
// 1100px (English, German and Arabic); from 769px to there the container scrolls, as it did.
// A name or an address longer than its track is cut with an ellipsis in its own cell, not run under the next one.
const rules = readRules(new URL('./Logs.css', import.meta.url));
const ROW = '.logs-page .logs-table .table-row';
const TRACKS = [
  '11rem',
  'minmax(8rem, 1.4fr)',
  'minmax(5rem, 1fr)',
  'minmax(5rem, 1fr)',
  'minmax(5.5rem, 1fr)',
  'minmax(6.5rem, 0.8fr)',
];

const REM = 16;
/** The least a track takes: a fixed track its size, a minmax() track its floor. */
const floorRem = (track: string): number => Number(/(\d+(?:\.\d+)?)rem/.exec(track)?.[1]);

test('the six columns of the audit log table shrink to floors that fit a laptop window', () => {
  const grid = rules.filter(r => r.media === '' && r.selectors.includes(ROW) && decl(r.body, 'grid-template-columns'));
  assert.equal(grid.length, 1, 'expected one base rule for the columns of a row');
  assert.equal(decl(grid[0].body, 'grid-template-columns')!.replace(/\s+/g, ' '), TRACKS.join(' '));
  const floors = TRACKS.reduce((sum, track) => sum + floorRem(track), 0) * REM;
  const needed = floors + (TRACKS.length - 1) * REM + 48 + 2 + 260 + 64;
  assert.ok(needed <= 1110, `the row needs ${needed}px of window beside the sidebar`);
});

// A grid item keeps its text's width as its minimum unless it says otherwise, so a long name would stretch its track.
test('a cell may be narrower than its text', () => {
  const cells = rules.filter(r => r.media === '' && r.selectors.includes(`${ROW} > span`));
  assert.equal(cells.length, 1, 'expected one rule for the cells of a row');
  assert.equal(decl(cells[0].body, 'min-width'), '0');
});

test('the session, the key and the address are cut with an ellipsis, not run into the next column', () => {
  for (const selector of ['.logs-page .session', '.logs-page .api-key', '.logs-page .ip']) {
    const own = rules.filter(r => r.media === '' && r.selectors.includes(selector));
    assert.ok(own.length > 0, `no rule for ${selector}`);
    const body = own.map(r => r.body).join(';');
    assert.equal(decl(body, 'overflow'), 'hidden', `${selector} does not clip`);
    assert.equal(decl(body, 'text-overflow'), 'ellipsis', `${selector} does not end in an ellipsis`);
    assert.equal(decl(body, 'white-space'), 'nowrap', `${selector} wraps`);
  }
});

// An address reads left to right in any page. Under an Arabic page's direction the ellipsis cut its start, the part
// that tells one network from another, so it takes its direction from its own characters, and as wide as the address
// it keeps the edge the page puts it.
test('an address is cut at its end in any page direction, and keeps the edge the page puts it', () => {
  const body = rules
    .filter(r => r.media === '' && r.selectors.includes('.logs-page .ip'))
    .map(r => r.body)
    .join(';');
  assert.equal(decl(body, 'unicode-bidi'), 'plaintext');
  assert.equal(decl(body, 'width'), 'fit-content');
  assert.equal(decl(body, 'max-width'), '100%');
});
