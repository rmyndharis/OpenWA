import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from '../test-helpers/css-rules.ts';

// The two columns of cards need 1035px of viewport with the sidebar open (the widest card holds a form row that is
// 378px wide at its narrowest) and 1190px in German, whose labels are wider. Down to 900px the page spilled past
// the window (41px at 960px), and the right-hand card lost its edge and its badge. Below 1200px the cards stack.
const rules = readRules(new URL('./Infrastructure.css', import.meta.url));

test('the infrastructure cards stack before the columns overflow', () => {
  const stacked = rules.filter(
    r =>
      r.selectors.includes('.infrastructure-page .infra-sections') &&
      decl(r.body, 'grid-template-columns') === 'minmax(0, 1fr)',
  );
  assert.equal(stacked.length, 1, 'expected one rule that stacks the cards in a track that can shrink');
  const width = Number(/max-width: (\d+)px/.exec(stacked[0].media)?.[1]);
  assert.ok(width >= 1200, `the cards stack at ${stacked[0].media || 'every width'}`);
});

// A plain 1fr track never shrinks below the widest content in it, and the three queue counters are a nowrap row: in
// German on a phone they widened the single card track to 392px, so every card ran past the right edge of a 390px
// window (84px of page overflow at 320px). The track may shrink, and the counters wrap onto a second line. The same
// held for the two-column layout above 1200px: the Redis card's counters were its widest content, so in German the
// two columns came out 440px and 413px instead of equal (456px and 402px with a counter of 987,654,321).
test('the two columns of cards stay equal whatever their content', () => {
  const columns = rules.filter(
    r =>
      !r.media && r.selectors.includes('.infrastructure-page .infra-sections') && decl(r.body, 'grid-template-columns'),
  );
  assert.equal(columns.length, 1, 'expected one base rule for the card columns');
  assert.equal(decl(columns[0].body, 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
});

// The counters sit in a grid of two columns that holds the one queue card. A track of 1fr would be half of the Redis
// card, so counters that are allowed to wrap would wrap at every desktop width; sized to the card's own content the
// track lets them stay on one line, and only a card narrower than that squeezes them.
test('the queue card keeps its natural width until the Redis card is narrower than that', () => {
  const row = rules.filter(r => !r.media && r.selectors.includes('.infrastructure-page .stats-row'));
  assert.equal(row.length, 1, 'expected one base rule for the stats row');
  assert.equal(decl(row[0].body, 'grid-template-columns'), 'repeat(2, minmax(0, max-content))');
});

test('the queue counters wrap in a card too narrow for all three', () => {
  const wrap = rules.filter(
    r => r.selectors.includes('.infrastructure-page .stat-values') && decl(r.body, 'flex-wrap'),
  );
  assert.equal(wrap.length, 1, 'expected one rule that lets the counters wrap');
  assert.equal(wrap[0].media, '', 'the counters wrap only inside a media query');
  assert.equal(decl(wrap[0].body, 'flex-wrap'), 'wrap');
});

// The status badge of a card header sits beside the title. A title that cannot share a line with it (the one word
// of "Speicherkonfiguration", the three words of "Configuración de almacenamiento") ran under the badge at 320px in
// German, Spanish, French, Italian, Portuguese and Turkish. The title keeps its natural width as the basis, so the
// badge wraps onto a line of its own when the two do not fit.
test('a card status badge drops below its title when the two do not fit on one line', () => {
  const header = rules.filter(
    r => r.selectors.includes('.infrastructure-page .card-header') && decl(r.body, 'flex-wrap'),
  );
  assert.equal(header.length, 1, 'expected one rule that lets the card header wrap');
  assert.equal(header[0].media, '@media (max-width: 900px)');
  const left = rules.filter(r => r.selectors.includes('.infrastructure-page .header-left') && decl(r.body, 'flex'));
  assert.equal(left.length, 1, 'expected one rule that sizes the title');
  assert.equal(left[0].media, '@media (max-width: 900px)');
  assert.equal(decl(left[0].body, 'flex'), '1 1 auto');
  assert.equal(decl(left[0].body, 'min-width'), '0');
});

test('the data export and import buttons wrap in a card that is too narrow for both', () => {
  const actions = rules.find(r => !r.media && r.selectors.includes('.infrastructure-page .data-migration-actions'));
  assert.ok(actions, 'no .data-migration-actions rule');
  assert.equal(decl(actions.body, 'flex-wrap'), 'wrap');
});
