import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flagOfRegion, regionOfPhone } from './phoneCountry.ts';

test('a number resolves to the country its two- or three-digit code dials', () => {
  assert.equal(regionOfPhone('491747127865'), 'DE');
  assert.equal(regionOfPhone('+43 664 1234567'), 'AT');
  assert.equal(regionOfPhone('351912345678'), 'PT');
  assert.equal(regionOfPhone('971501234567'), 'AE');
});

test('a code several countries share, or one that is unknown or too short, has no country', () => {
  // NANP: the United States, Canada and the Caribbean all dial 1.
  assert.equal(regionOfPhone('14155552671'), null);
  assert.equal(regionOfPhone('8001234567'), null);
  assert.equal(regionOfPhone('4912'), null);
  assert.equal(regionOfPhone(null), null);
});

test('7 is Russia, except the 76 and 77 ranges, which are Kazakhstan', () => {
  assert.equal(regionOfPhone('79161234567'), 'RU');
  assert.equal(regionOfPhone('77011234567'), 'KZ');
});

test('a region becomes its flag emoji', () => {
  assert.equal(flagOfRegion('DE'), '🇩🇪');
  assert.equal(flagOfRegion('gb'), '🇬🇧');
});
