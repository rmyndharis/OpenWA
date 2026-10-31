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

test('7 is Kazakhstan in its 6 and 7 ranges and Russia everywhere else, the toll-free range both share included', () => {
  assert.equal(regionOfPhone('79161234567'), 'RU');
  assert.equal(regionOfPhone('78123456789'), 'RU');
  assert.equal(regionOfPhone('77011234567'), 'KZ');
  assert.equal(regionOfPhone('78001234567'), 'RU');
});

// A code several territories share answers a territory only in the ranges that are its alone, the main country of the
// plan in the ranges a territory borrows from it, and no country in a range only territories other than it share.
test('a shared code answers a territory in its own ranges and the main country in the ranges it borrows', () => {
  const cases: Array<[string, string | null]> = [
    // The United Kingdom and the Crown Dependencies: landline codes and mobile blocks of their own.
    ['447400123456', 'GB'],
    ['442079460000', 'GB'],
    ['441534123456', 'JE'],
    ['447797123456', 'JE'],
    ['441481256789', 'GG'],
    ['447781123456', 'GG'],
    ['449801234567', 'GG'],
    ['441624567890', 'IM'],
    ['447624123456', 'IM'],
    // A block the Isle of Man shares with the United Kingdom, and a range all four share.
    ['447924123456', 'GB'],
    ['443001234567', 'GB'],
    // Reunion and Mayotte.
    ['262262123456', 'RE'],
    ['262692123456', 'RE'],
    ['262269601234', 'YT'],
    ['262639012345', 'YT'],
    ['262939801234', 'YT'],
    ['262801234567', 'RE'],
    // Guadeloupe's mobiles serve Saint Barthelemy and Saint Martin too; some landline ranges are Saint Martin's alone,
    // and some are shared by the two of them without Guadeloupe.
    ['590690123456', 'GP'],
    ['590590121234', 'GP'],
    ['590590071234', 'MF'],
    ['590590271234', null],
    // Bonaire, Sint Eustatius and Saba against Curacao.
    ['5997001234', 'BQ'],
    ['5993181234', 'BQ'],
    ['59995123456', 'CW'],
    // A territory's own landlines, and the mobiles it borrows from the country whose plan it is in.
    ['61891621234', 'CC'],
    ['61851002123', 'CC'],
    ['61891641234', 'CX'],
    ['61891012345', 'AU'],
    ['61212345678', 'AU'],
    ['61412345678', 'AU'],
    ['4779012345', 'SJ'],
    ['4721234567', 'NO'],
    ['4791234567', 'NO'],
    ['4741234567', 'NO'],
    ['35818123456', 'AX'],
    ['35891234567', 'FI'],
    ['358401234567', 'FI'],
    ['358501234567', 'FI'],
    ['390669812345', 'VA'],
    ['390612345678', 'IT'],
    ['393123456789', 'IT'],
    ['212522123456', 'MA'],
    ['212528812345', 'MA'],
    ['212612345678', 'MA'],
    ['212712345678', 'MA'],
  ];
  assert.deepEqual(
    cases.map(([phone]) => [phone, regionOfPhone(phone)]),
    cases,
  );
});

test('a region becomes its flag emoji', () => {
  assert.equal(flagOfRegion('DE'), '🇩🇪');
  assert.equal(flagOfRegion('gb'), '🇬🇧');
});
