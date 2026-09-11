import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupedTimezones, listTimezones } from './timezones.ts';

test('Asia/Kolkata is always selectable, even on a runtime that only enumerates the legacy Asia/Calcutta link name', () => {
  // Verified live: Intl.supportedValuesOf('timeZone') returns 'Asia/Calcutta' on this runtime's ICU
  // build, not the modern 'Asia/Kolkata' — both name the identical zone, but a select whose only
  // matching <option> is 'Calcutta' would silently show no selection for a stored 'Kolkata' value.
  const zones = listTimezones();
  assert.ok(zones.includes('Asia/Kolkata'), 'Asia/Kolkata missing from the zone list');
  assert.ok(!zones.includes('Asia/Calcutta'), 'legacy Asia/Calcutta should be renamed, not listed alongside it');
});

test('every zone appears in exactly one region group, and the region is the part before the first slash', () => {
  const groups = groupedTimezones();
  const flat = groups.flatMap(g => g.zones);
  assert.equal(new Set(flat).size, flat.length, 'a zone appears in more than one group');
  for (const group of groups) {
    for (const zone of group.zones) {
      const expectedRegion = zone.includes('/') ? zone.split('/')[0] : 'Other';
      assert.equal(expectedRegion, group.region, `${zone} filed under ${group.region}`);
    }
  }
});

test('groups are sorted by region, and zones within a group are sorted', () => {
  const groups = groupedTimezones();
  const regions = groups.map(g => g.region);
  assert.deepEqual(
    regions,
    [...regions].sort((a, b) => a.localeCompare(b)),
  );
  for (const group of groups) {
    assert.deepEqual(group.zones, [...group.zones].sort());
  }
});
