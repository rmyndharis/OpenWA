// The recipients parser differs from the one before quote handling was added in reading a chat id wrapped in CSV
// quotes, and in dropping a field of more than 15 digits, which the generator below never builds: every recipient
// that parser found, this one finds too, and each line is read on its own, so an unmatched quote cannot take other
// lines with it. The reference below is the pre-quote-handling parser, kept verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkRecipients } from './bulkRecipients.ts';
import { normalizePhoneText } from './phone.ts';

const FIELD_SEPARATORS = /[,;\t،؛]/;
const MIN_PHONE_DIGITS = 6;
const CHAT_ID = /^[0-9][0-9:-]*@(c\.us|g\.us|s\.whatsapp\.net|lid|newsletter|broadcast)$/i;

function plainParse(text: string): string[] {
  const seen = new Set<string>();
  for (const rawLine of normalizePhoneText(text).split(/\r\n?|\n/)) {
    for (const rawField of rawLine.split(FIELD_SEPARATORS)) {
      const field = rawField.trim();
      if (!field) continue;
      if (field.includes('@')) {
        if (CHAT_ID.test(field)) seen.add(field);
        continue;
      }
      const digits = field.replace(/[^0-9]/g, '');
      if (digits.length >= MIN_PHONE_DIGITS) seen.add(`${digits}@c.us`);
    }
  }
  return [...seen];
}

// A fixed generator, so a failure names an input that can be run again.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NUMBERS = [
  '628111222333',
  '+62 812-3456-7890',
  '+1 (555) 010-2233',
  '0049 170 1234567',
  '12345',
  '1',
  '٦٢٨١٢٣٤٥٦٧٨٩',
  '６２８１１１２２２３３３',
];
const IDS = [
  '628111222333@c.us',
  '1203630000-1600000000@g.us',
  '628111222333:7@s.whatsapp.net',
  '262813461250071@lid',
  '120363000000000000@newsletter',
  'status@broadcast',
  'alice@example.com',
  '12345@qq.com',
];
const SEPARATORS = [',', ';', '\t', '،', '؛', ', '];
const LINE_ENDINGS = ['\n', '\r\n', '\r'];

function build(rand: () => number): string {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
  const lines: string[] = [];
  for (let l = 1 + Math.floor(rand() * 6); l > 0; l--) {
    const fields: string[] = [];
    for (let f = 1 + Math.floor(rand() * 4); f > 0; f--) {
      let field = rand() < 0.5 ? pick(NUMBERS) : rand() < 0.8 ? pick(IDS) : pick(['', ' ', 'Alice', '"', '""']);
      const quoting = rand();
      if (quoting < 0.35) field = `"${field}"`;
      else if (quoting < 0.45) field = `"${field}`;
      else if (quoting < 0.55) field = `${field}"`;
      fields.push(field);
    }
    let line = fields.map((field, i) => (i === 0 ? field : pick(SEPARATORS) + field)).join('');
    if (rand() < 0.2) line = `"${line}"`;
    lines.push(line);
  }
  let text = lines.map((line, i) => (i === 0 ? line : pick(LINE_ENDINGS) + (rand() < 0.1 ? '\n' : '') + line)).join('');
  for (let stray = Math.floor(rand() * 3); stray > 0; stray--) {
    const at = Math.floor(rand() * (text.length + 1));
    text = `${text.slice(0, at)}"${text.slice(at)}`;
  }
  return text;
}

test('every recipient the plain parser found is still found, whatever the quoting', () => {
  const rand = random(20261027);
  for (let n = 0; n < 5000; n++) {
    const input = build(rand);
    const found = new Set(parseBulkRecipients(input));
    for (const id of plainParse(input)) assert.ok(found.has(id), `${id} lost from ${JSON.stringify(input)}`);
  }
});

test('the only recipients added are chat ids a CSV quote had been hiding, and every line reads as it does alone', () => {
  const rand = random(7);
  for (let n = 0; n < 5000; n++) {
    const input = build(rand);
    const before = new Set(plainParse(input));
    for (const id of parseBulkRecipients(input)) {
      if (before.has(id)) continue;
      assert.match(id, CHAT_ID, JSON.stringify(input));
      assert.ok(input.includes(id) && input.includes('"'), `${id} added to ${JSON.stringify(input)}`);
    }
    // A parser that pairs quotes across lines loses recipients the line alone would give.
    const whole = new Set(parseBulkRecipients(input));
    for (const line of input.split(/\r\n?|\n/)) {
      for (const id of parseBulkRecipients(line)) assert.ok(whole.has(id), `${id} lost from ${JSON.stringify(input)}`);
    }
  }
});

test('a chat id in CSV quotes is kept, which the plain parser dropped', () => {
  assert.deepEqual(plainParse('"1203630000@g.us"'), []);
  assert.deepEqual(parseBulkRecipients('"1203630000@g.us"'), ['1203630000@g.us']);
  assert.deepEqual(parseBulkRecipients('Alice,"628123456789@c.us"'), ['628123456789@c.us']);
});
