import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Under <html dir="rtl"> a phone number or an id shown as plain text is laid out right to left: "+1 555 000 1111"
// reads "1111 000 555 1+" and "15550001111@c.us" splits around the at sign. Each such value has to be
// isolated so it keeps its own left to right order.

const SRC = dirname(fileURLToPath(import.meta.url));

function body(file: string, selector: string): string {
  const css = readFileSync(join(SRC, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some(s => s.trim() === selector)) return m[2];
  }
  assert.fail(`${file} has no ${selector} rule`);
}

// The room header shows the number under the name, and the contact panel the raw id. Each is a value of its own,
// isolated left to right in the markup: in an RTL page "+1 555 000 1111" would otherwise read "1111 000 555 1+" and
// "15550001111@c.us" would move "@c.us" to the other end.
const CHATS_TSX = readFileSync(join(SRC, 'pages/Chats.tsx'), 'utf8');

test('the open chat header isolates the phone number, and the contact panel the raw id', () => {
  assert.match(
    CHATS_TSX,
    /<span className="room-contact-phone"[^>]*>\s*<bdi dir="ltr">\{activePhoneText\}<\/bdi>/,
    'the header number is not isolated',
  );
  assert.match(
    CHATS_TSX,
    /<dd className="mono">[\s\S]*?<bdi dir="ltr"[^>]*>\s*\{activeChat\.id\}\s*<\/bdi>/,
    'the chat id in the contact panel is not isolated',
  );
});

test('the header number keeps the page direction, so it sits at the start edge with the name', () => {
  // The isolate inside it carries the number's own direction. Under plaintext the line would resolve to left to
  // right and, in a box the header column stretches, sit at the left edge of an Arabic header with the name at the
  // right; the name, which is cut and so takes its own direction, hugs the start edge instead (see below).
  assert.doesNotMatch(body('pages/Chats.css', '.chats-page .room-contact-phone'), /unicode-bidi/);
});

test('the header number stays on one line in a narrow room, cut by its own isolate, with the whole number in its title', () => {
  // At the room's 262px minimum the number wrapped onto a second line under the name. Cut by the isolate, written left
  // to right, it loses its last digits in either page direction, as the session number does.
  assert.match(
    CHATS_TSX,
    /<span className="room-contact-phone" title=\{activePhoneText\}>/,
    'the header number has no title',
  );
  const line = body('pages/Chats.css', '.chats-page .room-contact-phone');
  assert.match(line, /display:\s*flex/);
  assert.match(line, /min-width:\s*0/);
  const cut = body('pages/Chats.css', '.chats-page .room-contact-phone > bdi');
  for (const declaration of [
    /white-space:\s*nowrap/,
    /overflow:\s*hidden/,
    /text-overflow:\s*ellipsis/,
    /min-width:\s*0/,
  ]) {
    assert.match(cut, declaration);
  }
});

test('text cut with an ellipsis takes its direction from its own characters', () => {
  // The ellipsis removes the end of the line in the direction of the box. Under the page direction a Latin name in
  // an Arabic page (or an Arabic one in an English page) lost its first letters and kept its last.
  const cut = [
    '.chats-page .chat-item-name',
    '.chats-page .chat-item-snippet',
    '.chats-page .room-contact-name',
    '.chats-page .preview-filename',
    '.chats-page .quote-body',
    '.chats-page .replying-to-body',
    '.chats-page .group-info-member .name',
    '.chats-page .session-name',
  ];
  for (const selector of cut) {
    const rule = body('pages/Chats.css', selector);
    assert.match(rule, /text-overflow:\s*ellipsis/, `${selector} is expected to be cut with an ellipsis`);
    assert.match(rule, /unicode-bidi:\s*plaintext/, selector);
  }
});

test('the reply title is a sentence with a name inside, so it keeps the page direction', () => {
  // Read by its first strong letter, "{{name}} kişisine yanıt veriliyor" with an Arabic name would resolve right
  // to left and draw its words backwards.
  const rule = body('pages/Chats.css', '.chats-page .replying-to-title');
  assert.match(rule, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(rule, /unicode-bidi/);
});

test('cut text that a flex column stretches hugs the start edge, where its siblings are', () => {
  // unicode-bidi: plaintext also aligns the text by its own direction, so a stretched box would put a Latin name
  // at the left edge of an Arabic page while the lines beside it sit at the right.
  const hugging = [
    '.chats-page .chat-item-info > .chat-item-name',
    '.chats-page .chat-item-info > .chat-item-snippet',
    '.chats-page .room-contact-name',
    '.chats-page .preview-filename',
    '.chats-page .replying-to-body',
    '.chats-page .session-name',
    '.chats-page .group-info-member .name',
  ];
  for (const selector of hugging) {
    const rule = body('pages/Chats.css', selector);
    assert.match(rule, /align-self:\s*flex-start/, selector);
    assert.match(rule, /max-width:\s*100%/, `${selector} needs a cap, or the ellipsis never shows`);
  }
  const quote = body('pages/Chats.css', '.chats-page .quote-body');
  assert.match(quote, /width:\s*fit-content/);
  // A long nowrap quote is as wide as its text, so the cap has to follow the room in the box, not only a fixed width.
  assert.match(quote, /max-width:\s*min\(\d+px,\s*100%\)/);
});

test("a group member's number hugs the start edge, where the name above it is", () => {
  // Isolated left to right, the number takes start as left: stretched across the column it sat at the left edge of an
  // Arabic page.
  const dialog = readFileSync(join(SRC, 'components/chats/GroupInfoDialog.tsx'), 'utf8');
  assert.match(dialog, /<bdi className="number" dir="ltr">/);
  assert.match(body('pages/Chats.css', '.chats-page .group-info-member'), /flex-direction:\s*column/);
  assert.match(body('pages/Chats.css', '.chats-page .group-info-member .number'), /align-self:\s*flex-start/);
});

test('a message body takes its direction from its own characters', () => {
  // Under the page direction an English question in an Arabic page drew its question mark at the left.
  assert.match(body('pages/Chats.css', '.chats-page .message-content > .message-text'), /unicode-bidi:\s*plaintext/);
});

test('the session number is cut by its own isolate, so an RTL page keeps its first digits', () => {
  // The line around it keeps the page direction; cut there, an Arabic page lost "+4" and kept the last digits.
  const picker = readFileSync(join(SRC, 'components/chats/SessionPicker.tsx'), 'utf8');
  assert.match(picker, /<span className="session-phone-line">[\s\S]*?<bdi dir="ltr"[^>]*>/);
  const cut = body('pages/Chats.css', '.chats-page .session-phone-line > bdi');
  assert.match(cut, /text-overflow:\s*ellipsis/);
  assert.match(cut, /min-width:\s*0/);
  assert.match(body('pages/Chats.css', '.chats-page .session-phone-line'), /max-width:\s*100%/);
});

test('chart plots stay left to right on a right to left page', () => {
  assert.match(body('components/DashboardCharts.css', '.dashboard-charts .recharts-surface'), /direction:\s*ltr/);
});
