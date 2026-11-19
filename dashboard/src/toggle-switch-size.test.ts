import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readAllSheets } from './test-helpers/css-rules.ts';

// A switch is a 48px track whose 20px knob moves 22px when it is on, so it needs the whole track. It sits in a flex row
// beside text, and a flex item shrinks when the row runs short of room. On Infrastructure the switches beside a long
// description were drawn 25 to 47px wide in a 1280 to 1920px window, which put the knob of an on switch outside its
// track. Every page's rule for the switch keeps its width at every window width.

test('every rule for a switch keeps its track from shrinking as a flex item', () => {
  const switches = [...readAllSheets()].flatMap(([file, rules]) =>
    rules
      .filter(r => r.media === '' && r.selectors.some(s => /(?:^|[\s>+~])\.toggle-switch$/.test(s)))
      .map(r => ({ file, selectors: r.selectors.join(', '), shrink: decl(r.body, 'flex-shrink') })),
  );
  assert.ok(switches.length > 0, 'the scan no longer finds a switch rule');
  assert.deepEqual(
    switches.filter(s => s.shrink !== '0').map(s => `${s.file}: ${s.selectors} has no flex-shrink: 0`),
    [],
  );
});
