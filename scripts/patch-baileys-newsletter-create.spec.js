'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyNewsletterCreatePatch, PARSE_FIND, MARKER } = require('./patch-baileys-newsletter-create');

/**
 * Same contract as the sibling patcher specs: the patcher rewrites a file this repository does not
 * own, so it must fire only on the exact shape it was written for, refuse loudly on anything else,
 * and be safe to run twice (postinstall runs on every install).
 *
 * This one also EXECUTES the parser either side of the patch, because the defect is behavioural. A
 * text assertion would pass just as happily against a transform that stopped the crash while
 * dropping the new channel's id — which is the one thing the response carries that nothing else can
 * recover.
 */

/** A parser file with the real upstream body, in CommonJS so the test can run it. */
function fakeBaileys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-newsletter-'));
  fs.mkdirSync(path.join(dir, 'lib', 'Socket'), { recursive: true });
  const file = path.join(dir, 'lib', 'Socket', 'newsletter.js');
  fs.writeFileSync(
    file,
    `const parseNewsletterCreateResponse = (response) => {
    const { id, thread_metadata: thread, viewer_metadata: viewer } = response;
${PARSE_FIND}
};
module.exports = { parseNewsletterCreateResponse };
`,
  );
  return { dir, file };
}

function load(file) {
  delete require.cache[require.resolve(file)];
  return require(file).parseNewsletterCreateResponse;
}

/** What WhatsApp actually returns for a channel created through `newsletterCreate`. */
const REAL_RESPONSE = {
  id: '120363428347011596@newsletter',
  thread_metadata: {
    name: { text: 'openwa-probe' },
    creation_time: '1786405315',
    description: null, // the caller omitted one; newsletterCreate sends `description ?? null`
    invite: '0029VbCs400HAdNLkrTlCt0r',
    subscribers_count: '1',
    verification: 'UNVERIFIED',
    picture: null, // there is no picture parameter anywhere in the create chain
  },
  viewer_metadata: { mute: 'off' },
};

test('CONTROL — the unpatched parser throws on the shape every create produces', () => {
  // Without this the tests below could pass against a parser that never had the defect.
  const { dir, file } = fakeBaileys();
  const parse = load(file);
  assert.throws(() => parse(REAL_RESPONSE), /Cannot read properties of null/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the patched parser survives an absent picture AND keeps the new channel id', () => {
  const { dir, file } = fakeBaileys();
  const result = applyNewsletterCreatePatch(dir);
  assert.equal(result.skipped, undefined);

  const parsed = load(file)(REAL_RESPONSE);
  // The id is the whole point: it is the only place the created channel's id ever appears, so a
  // patch that merely stopped the crash would leave an orphan nobody can address.
  assert.equal(parsed.id, '120363428347011596@newsletter');
  assert.equal(parsed.picture, undefined);
  assert.equal(parsed.description, undefined);
  assert.equal(parsed.name, 'openwa-probe');
  assert.equal(parsed.invite, '0029VbCs400HAdNLkrTlCt0r');
  assert.equal(parsed.creation_time, 1786405315);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a channel that DOES have a picture still maps it', () => {
  const { dir, file } = fakeBaileys();
  applyNewsletterCreatePatch(dir);
  const parsed = load(file)({
    ...REAL_RESPONSE,
    thread_metadata: {
      ...REAL_RESPONSE.thread_metadata,
      description: { text: 'notes' },
      picture: { id: 'pic-1', direct_path: '/v/t61/pic' },
    },
  });
  assert.deepEqual(parsed.picture, { id: 'pic-1', directPath: '/v/t61/pic' });
  assert.equal(parsed.description, 'notes');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('is idempotent — a second run does not double-patch', () => {
  const { dir, file } = fakeBaileys();
  applyNewsletterCreatePatch(dir);
  const once = fs.readFileSync(file, 'utf8');
  const second = applyNewsletterCreatePatch(dir);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'already patched');
  assert.equal(fs.readFileSync(file, 'utf8'), once);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refuses an unknown shape rather than shipping unpatched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-newsletter-'));
  fs.mkdirSync(path.join(dir, 'lib', 'Socket'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'Socket', 'newsletter.js'), 'const x = 1;\n');
  assert.throws(() => applyNewsletterCreatePatch(dir), /expected exactly 1 newsletter-create parse site/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('skips a tree with no baileys rather than failing the install', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baileys-newsletter-'));
  const result = applyNewsletterCreatePatch(dir);
  assert.equal(result.skipped, true);
  assert.match(result.reason, /not found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the marker the idempotence check keys on is actually written', () => {
  const { dir, file } = fakeBaileys();
  applyNewsletterCreatePatch(dir);
  assert.ok(fs.readFileSync(file, 'utf8').includes(MARKER));
  fs.rmSync(dir, { recursive: true, force: true });
});
