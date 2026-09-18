import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addGroupIds, filterGroupsByName, groupLabel, toggleGroupId } from './groupSelection.ts';

const groups = [
  { id: '111@g.us', name: 'Family' },
  { id: '222@g.us', name: 'Work Team' },
  { id: '333@g.us', name: 'Football' },
  { id: '444@g.us', name: '  ' },
];

test('labels a group by its name, falling back to the id when the name is blank', () => {
  assert.equal(groupLabel(groups[0]), 'Family');
  assert.equal(groupLabel(groups[3]), '444@g.us');
});

test('an empty or whitespace query keeps every group', () => {
  assert.deepEqual(filterGroupsByName(groups, ''), groups);
  assert.deepEqual(filterGroupsByName(groups, '   '), groups);
});

test('filters by a case-insensitive substring of the name', () => {
  assert.deepEqual(
    filterGroupsByName(groups, 'fa').map(group => group.id),
    ['111@g.us'],
  );
  assert.deepEqual(
    filterGroupsByName(groups, ' TEAM ').map(group => group.id),
    ['222@g.us'],
  );
});

test('a nameless group is found by its id', () => {
  assert.deepEqual(
    filterGroupsByName(groups, '444').map(group => group.id),
    ['444@g.us'],
  );
});

test('returns a new array so callers never mutate the source list', () => {
  const result = filterGroupsByName(groups, '');
  assert.notEqual(result, groups);
});

test('toggling adds a missing id and removes a present one', () => {
  assert.deepEqual(toggleGroupId(['111@g.us'], '222@g.us'), ['111@g.us', '222@g.us']);
  assert.deepEqual(toggleGroupId(['111@g.us', '222@g.us'], '111@g.us'), ['222@g.us']);
});

test('adding ids keeps the existing selection first and drops duplicates', () => {
  assert.deepEqual(addGroupIds(['333@g.us', '111@g.us'], ['111@g.us', '222@g.us']), [
    '333@g.us',
    '111@g.us',
    '222@g.us',
  ]);
});
