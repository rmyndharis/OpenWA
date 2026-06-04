// Stub for the ESM-only `archiver` (v8 is `type: module`, which ts-jest can't
// require after compiling specs to CommonJS). The e2e boot test only needs the
// module to be importable — storage export/import is not exercised. Any actual
// use throws loudly so it can't pass silently.
const fail = () => {
  throw new Error('archiver is stubbed in e2e tests; storage archiving is not exercised here');
};
module.exports = new Proxy(fail, { get: () => fail });
