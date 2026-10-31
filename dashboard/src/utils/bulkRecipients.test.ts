import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBulkRecipients } from './bulkRecipients.ts';

test('parses one recipient per line, trimming whitespace and dropping blanks', () => {
  const text = '  +62 812-3456-78  \n\n628987654321@c.us\n   \n1203630000@g.us';
  assert.deepEqual(parseBulkRecipients(text), ['62812345678@c.us', '628987654321@c.us', '1203630000@g.us']);
});

test('normalizes bare phone numbers to @c.us chat IDs', () => {
  assert.deepEqual(parseBulkRecipients('+1 (555) 010-2233'), ['15550102233@c.us']);
});

test('passes full chat IDs through untouched', () => {
  assert.deepEqual(parseBulkRecipients('123@lid\n4567890-1234@g.us'), ['123@lid', '4567890-1234@g.us']);
});

test('splits on CRLF and on bare CR, which an uploaded file can carry', () => {
  const expected = ['628111222333@c.us', '628222333444@c.us'];
  assert.deepEqual(parseBulkRecipients('628111222333\r\n628222333444'), expected);
  assert.deepEqual(parseBulkRecipients('628111222333\r628222333444'), expected);
});

test('de-dupes entries that normalize to the same chat ID', () => {
  const text = '+62 812 3456 78\n62812345678\n62812345678@c.us';
  assert.deepEqual(parseBulkRecipients(text), ['62812345678@c.us']);
});

test('drops lines with neither an @ nor any digits instead of sending "@c.us"', () => {
  assert.deepEqual(parseBulkRecipients('not-a-number\n---\n628123456789'), ['628123456789@c.us']);
});

test('returns an empty list for empty input', () => {
  assert.deepEqual(parseBulkRecipients(''), []);
  assert.deepEqual(parseBulkRecipients('  \n \n'), []);
});

// A real spreadsheet export. The digit strip used to run over the WHOLE line, so the index column
// and the number were concatenated into a different number that still looked plausible.
test('a multi-column CSV row yields the phone column, not the columns concatenated', () => {
  const csv = 'id,phone\n1,628123456789\n2,628987654321';
  assert.deepEqual(parseBulkRecipients(csv), ['628123456789@c.us', '628987654321@c.us']);
});

test('a comma-separated list on one line is several recipients', () => {
  assert.deepEqual(parseBulkRecipients('628111222333, 628222333444'), ['628111222333@c.us', '628222333444@c.us']);
});

test('semicolon and tab separate entries too', () => {
  assert.deepEqual(parseBulkRecipients('628111222333;628222333444'), ['628111222333@c.us', '628222333444@c.us']);
  assert.deepEqual(parseBulkRecipients('628111222333\t628222333444'), ['628111222333@c.us', '628222333444@c.us']);
});

// The formatting characters must NOT split: this is one number, and the existing test above pins it.
test('phone formatting is not a field separator', () => {
  assert.deepEqual(parseBulkRecipients('+62 (812) 345-6789'), ['628123456789@c.us']);
});

test('a chat ID sitting in a CSV column still passes through', () => {
  assert.deepEqual(parseBulkRecipients('alice,4567890-1234@g.us'), ['4567890-1234@g.us']);
});

test('a number too short to be a phone is dropped rather than sent', () => {
  assert.deepEqual(parseBulkRecipients('12345'), []);
  assert.deepEqual(parseBulkRecipients('123456'), ['123456@c.us']);
});

// A contact export carries an email column next to the phone. Passing every '@' field through sent
// each address as a recipient that could only fail, and doubled the count held against the batch cap.
test('an @ field without a WhatsApp chat id shape is dropped, so an email column is not a recipient', () => {
  const csv = 'name,email,phone\nJohn,john@example.com,628123456789\nAmy,12345@qq.com,628987654321';
  assert.deepEqual(parseBulkRecipients(csv), ['628123456789@c.us', '628987654321@c.us']);
  assert.deepEqual(
    parseBulkRecipients('628123456789@s.whatsapp.net\n120363123456789@newsletter\n628123456789:12@lid'),
    ['628123456789@s.whatsapp.net', '120363123456789@newsletter', '628123456789:12@lid'],
  );
});

// A list pasted from an Arabic or a CJK source carries the digits of that script.
test('a number written in native-script or full-width digits is read as ASCII digits', () => {
  const toDigits = (ascii: string, zero: number) => [...ascii].map(d => String.fromCharCode(zero + Number(d))).join('');
  assert.deepEqual(parseBulkRecipients(toDigits('628123456789', 0x0660)), ['628123456789@c.us']);
  assert.deepEqual(parseBulkRecipients(toDigits('628123456789', 0xff10)), ['628123456789@c.us']);
  assert.deepEqual(parseBulkRecipients(`${toDigits('628111222333', 0x0966)}\n628222333444`), [
    '628111222333@c.us',
    '628222333444@c.us',
  ]);
});

// The same separators the Number Checker splits its list on, in the script the numbers are written in.
test('a list in native-script digits separated by the Arabic comma or semicolon is several recipients', () => {
  const toDigits = (ascii: string) => [...ascii].map(d => String.fromCharCode(0x0660 + Number(d))).join('');
  const first = toDigits('628123456789');
  const second = toDigits('628987654321');
  const expected = ['628123456789@c.us', '628987654321@c.us'];
  assert.deepEqual(parseBulkRecipients(`${first}${String.fromCharCode(0x060c)}${second}`), expected);
  assert.deepEqual(parseBulkRecipients(`${first}${String.fromCharCode(0x061b)} ${second}`), expected);
});

test('a list in full-width digits separated by the full-width comma or semicolon is several recipients', () => {
  const fullwidth = (ascii: string) => [...ascii].map(ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
  const first = fullwidth('628123456789');
  const second = fullwidth('628987654321');
  const expected = ['628123456789@c.us', '628987654321@c.us'];
  assert.deepEqual(parseBulkRecipients(`${first}${String.fromCharCode(0xff0c)}${second}`), expected);
  assert.deepEqual(parseBulkRecipients(`${first}${String.fromCharCode(0xff1b)}${second}`), expected);
});

test('a chat id written in full-width characters passes through as the plain chat id', () => {
  const fullwidth = (ascii: string) => [...ascii].map(ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).join('');
  assert.deepEqual(parseBulkRecipients(fullwidth('123@c.us')), ['123@c.us']);
  assert.deepEqual(parseBulkRecipients(fullwidth('alice@example.com')), []);
});

test('CSV quoting preserves full chat IDs and existing recipient syntax', () => {
  assert.deepEqual(parseBulkRecipients('"628123456789@c.us","1203630000@g.us"\r\n"628987654321@s.whatsapp.net"'), [
    '628123456789@c.us',
    '1203630000@g.us',
    '628987654321@s.whatsapp.net',
  ]);
  assert.deepEqual(
    parseBulkRecipients(
      '"\u0666\u0662\u0668\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669@c.us";"1203630000@g.us"',
    ),
    ['628123456789@c.us', '1203630000@g.us'],
  );
  assert.deepEqual(parseBulkRecipients('"Alice ""A""",628123456789@c.us'), ['628123456789@c.us']);
  assert.deepEqual(parseBulkRecipients('"+1 (555) 010-2233"\t628123456789@c.us'), [
    '15550102233@c.us',
    '628123456789@c.us',
  ]);
});

test('a list wrapped in one pair of quotes, or a quoted cell of several numbers, keeps every number', () => {
  assert.deepEqual(parseBulkRecipients('"628111222333\n628222333444\n628333444555"'), [
    '628111222333@c.us',
    '628222333444@c.us',
    '628333444555@c.us',
  ]);
  assert.deepEqual(parseBulkRecipients('"628111222333,628222333444"'), ['628111222333@c.us', '628222333444@c.us']);
  assert.deepEqual(parseBulkRecipients('"628111222333@c.us\r\n1203630000@g.us"'), [
    '628111222333@c.us',
    '1203630000@g.us',
  ]);
});

test('a separator inside a quoted CSV field never concatenates two phone numbers', () => {
  assert.deepEqual(parseBulkRecipients('"628123456789,15550102233",628987654321@c.us'), [
    '628123456789@c.us',
    '15550102233@c.us',
    '628987654321@c.us',
  ]);
  assert.deepEqual(parseBulkRecipients('  "628123456789@c.us"  '), ['628123456789@c.us']);
});

test('a quote that never closes does not drop the recipients around it', () => {
  assert.deepEqual(parseBulkRecipients('"628111111111\n628222222222\n628333333333'), [
    '628111111111@c.us',
    '628222222222@c.us',
    '628333333333@c.us',
  ]);
  assert.deepEqual(parseBulkRecipients('628111111111\n  "628222222222\n628333333333'), [
    '628111111111@c.us',
    '628222222222@c.us',
    '628333333333@c.us',
  ]);
  assert.deepEqual(parseBulkRecipients('"628111111111@c.us\n628222222222@c.us'), [
    '628111111111@c.us',
    '628222222222@c.us',
  ]);
  // Quotes are not paired across lines, so a stray one and a later one leave the lines between them alone.
  assert.deepEqual(
    parseBulkRecipients('628111222333\n"628222333444\n628333444555\n628444555666\n628555666777\n"628666777888'),
    [
      '628111222333@c.us',
      '628222333444@c.us',
      '628333444555@c.us',
      '628444555666@c.us',
      '628555666777@c.us',
      '628666777888@c.us',
    ],
  );
});
