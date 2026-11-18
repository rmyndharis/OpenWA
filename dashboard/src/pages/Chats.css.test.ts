import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The clear button of the New chat panel's search field carried a class no stylesheet defined, so it rendered as
// a native grey button that was taller than the text beside it and grew the field when a character was typed.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'Chats.css'), 'utf8');
const panel = readFileSync(join(here, '..', 'components', 'chats', 'NewChatPanel.tsx'), 'utf8');

test('the new chat search clear button is a small icon button that does not grow the field', () => {
  assert.match(panel, /className="search-clear"/, 'the panel no longer renders the button this rule styles');
  const rule = /\.chats-page \.search-clear\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'no style for the search clear button');
  assert.match(rule[1], /border:\s*none/);
  assert.match(rule[1], /background:\s*transparent/);
  assert.match(rule[1], /width:\s*28px/);
  assert.match(rule[1], /height:\s*28px/);
  // Taller than the line of text it sits beside, so its block margin takes the difference back.
  assert.match(rule[1], /margin-block:\s*-0\.5rem/);
});

test('the active filter pill is heavier than the others, so it does not differ by colour alone', () => {
  const weight = (selector: string): number => {
    const rule = new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `no rule for ${selector}`);
    return Number(/font-weight:\s*(\d+)/.exec(rule[1])?.[1]);
  };
  assert.ok(
    weight('.chats-page .chat-filter-pill.active') > weight('.chats-page .chat-filter-pill'),
    'the active pill has the weight of the others',
  );
});

// Every rule body whose selector list names the selector, in order.
const rulesFor = (selector: string): string[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(',').some(s => s.trim() === selector))
    .map(m => m[2]);

test('the chat list header is as high as the room header, whatever minimum the dashboard header has', () => {
  const height = (selector: string): string | undefined =>
    rulesFor(selector)
      .map(body => /(?:^|;)\s*height:\s*([^;]+)/.exec(body)?.[1].trim())
      .find(Boolean);
  assert.equal(height('.chats-page .sidebar-header'), height('.chats-page .room-header'));
  // Layout.css styles .sidebar-header, the class this header shares, with min-height: 72px.
  const layout = readFileSync(join(here, '..', 'components', 'Layout.css'), 'utf8');
  assert.match(layout, /\.sidebar-header\s*\{[^}]*min-height:\s*72px/, 'the dashboard header no longer sets a minimum');
  assert.ok(
    rulesFor('.chats-page .sidebar-header').some(body => /min-height:\s*0[;\s]/.test(body)),
    'the dashboard minimum stretches the chat list header',
  );
});

test('the session picker is capped by the list column, so the layout never clips its last sessions or its link', () => {
  // .chats-layout clips what runs past it; the picker hung from the switcher had no cap but the list's own 360px.
  const declared = (selector: string, property: string): string | undefined =>
    rulesFor(selector)
      .map(body => new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1].trim())
      .filter(Boolean)
      .pop();
  assert.equal(declared('.chats-page .chats-layout', 'overflow'), 'hidden');
  assert.equal(declared('.chats-page .chats-sidebar', 'position'), 'relative');
  assert.equal(declared('.chats-page .session-switcher', 'position'), undefined, 'the switcher holds the picker');
  assert.equal(declared('.chats-page .session-picker', 'position'), 'absolute');
  assert.match(declared('.chats-page .session-picker', 'max-height') ?? '', /^calc\(100% - /);
  assert.equal(declared('.chats-page .session-picker', 'overflow'), 'hidden');
  assert.equal(declared('.chats-page .session-picker-list', 'overflow-y'), 'auto');
});

test('the room menu is capped by the room, so the layout never clips its last entries on a short window', () => {
  // Hung from its button the menu had no cap, and at 740 by 360 it ran 190px past the layout's bottom edge.
  const declared = (selector: string, property: string): string | undefined =>
    rulesFor(selector)
      .map(body => new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1].trim())
      .filter(Boolean)
      .pop();
  assert.equal(declared('.chats-page .room-container', 'position'), 'relative');
  assert.equal(declared('.chats-page .room-menu', 'position'), undefined, 'the menu button holds the menu');
  assert.equal(declared('.chats-page .room-header', 'position'), undefined, 'the header holds the menu');
  assert.equal(declared('.chats-page .room-menu-popover', 'position'), 'absolute');
  assert.match(declared('.chats-page .room-menu-popover', 'max-height') ?? '', /^calc\(100% - /);
  assert.equal(declared('.chats-page .room-menu-popover', 'overflow-y'), 'auto');
  // Placed under the header and at the menu button's end edge: the header's end padding, the contact panel button
  // and the gap between the two.
  assert.equal(declared('.chats-page .room-header', 'height'), '64px');
  assert.match(declared('.chats-page .room-header', 'padding-inline') ?? '', / 0\.75rem$/);
  assert.equal(declared('.chats-page .room-header-actions', 'gap'), '0.25rem');
  assert.equal(declared('.chats-page .icon-btn', 'width'), '40px');
  assert.equal(declared('.chats-page .room-menu-popover', 'inset-inline-end'), 'calc(0.75rem + 40px + 0.25rem)');
  assert.match(declared('.chats-page .room-menu-popover', 'top') ?? '', /^calc\(64px /);
});

test('the page gives up the phone bar under the query that draws it, so 768px keeps its full height', () => {
  const layout = readFileSync(join(here, '..', 'components', 'Layout.tsx'), 'utf8');
  const mobile = /const MOBILE_QUERY = '([^']+)'/.exec(layout)?.[1];
  assert.ok(mobile, 'Layout.tsx no longer names its phone query');
  const offset = /@media ([^{]+)\{\s*\.chats-page\s*\{\s*height:\s*calc\(100dvh - 3\.5rem\)/.exec(css);
  assert.ok(offset, 'the page no longer takes the phone bar off its height');
  assert.equal(offset[1].trim(), mobile);
});

test('the room is never narrower than its composer, so the emoji button cannot slide under the send button', () => {
  const value = (selector: string, property: string): string => {
    const found = rulesFor(selector)
      .map(body => new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1].trim())
      .filter((v): v is string => Boolean(v))
      .pop();
    assert.ok(found, `${selector} sets no ${property}`);
    return found;
  };
  const px = (length: string): number => {
    const m = /^(-?[\d.]+)(px|rem)?$/.exec(length);
    assert.ok(m && (m[2] || Number(m[1]) === 0), `${length} is not a px or rem length`);
    return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  };
  // Each side of a padding-inline: one value is both, two are the start and the end.
  const sides = (shorthand: string): number => {
    const parts = shorthand.split(/\s+/).map(px);
    return parts.length === 1 ? 2 * parts[0] : parts[0] + parts[1];
  };
  const pill = '.chats-page .message-input-pill';
  const floor =
    sides(value('.chats-page .room-input-footer', 'padding-inline')) +
    2 * px(value('.chats-page .input-form', 'gap')) +
    px(value('.chats-page .btn-input-accessory', 'width')) +
    sides(value(pill, 'padding-inline')) +
    2 * px(value(pill, 'border').split(/\s+/)[0]) +
    px(value(pill, 'gap')) +
    px(value(`${pill} .message-text-input`, 'min-width')) +
    px(value('.chats-page .btn-input-accessory.inside', 'width')) +
    px(value('.chats-page .btn-send-message', 'width'));
  assert.ok(px(value('.chats-page .chats-room', 'min-width')) >= floor, `the composer needs ${floor}px`);
  // The list column is what gives way when the room needs the width.
  assert.notEqual(value('.chats-page .chats-sidebar', 'flex-shrink'), '0');
});

// The last value a selector's own rules give a property.
const declared = (selector: string, property: string): string => {
  const found = rulesFor(selector)
    .map(body => new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`).exec(body)?.[1].trim())
    .filter((v): v is string => Boolean(v))
    .pop();
  assert.ok(found, `${selector} sets no ${property}`);
  return found;
};

test('a one-line message field is centred on the buttons beside it, and a longer one grows away from them', () => {
  const pill = '.chats-page .message-input-pill';
  const field = `${pill} .message-text-input`;
  // The field grows upwards: the form and the pill keep their buttons at its last line.
  assert.equal(declared('.chats-page .input-form', 'align-items'), 'flex-end');
  assert.equal(declared(pill, 'align-items'), 'flex-end');
  const pillHeight = parseFloat(declared(pill, 'min-height'));
  const inside = pillHeight - 2 * parseFloat(declared(pill, 'border'));
  const lineHeight = declared(field, 'line-height');
  // One line of text and its padding fill the inside of the pill exactly, so the text sits on the pill's middle.
  assert.equal(declared(field, 'padding-block'), `calc((${inside}px - ${lineHeight}em) / 2)`);
  // Each button is lifted by half of what the pill is higher than it is: centred on one line, and the same
  // distance from the bottom edge beside several.
  const lift = (selector: string, room: number) =>
    assert.equal(
      parseFloat(declared(selector, 'margin-block-end')),
      (room - parseFloat(declared(selector, 'height'))) / 2,
      selector,
    );
  lift('.chats-page .btn-input-accessory', pillHeight);
  lift('.chats-page .btn-input-accessory.inside', inside);
  assert.equal(parseFloat(declared('.chats-page .btn-send-message', 'height')), pillHeight);
  // The field stops at whole lines, five of them, and scrolls from there.
  assert.equal(declared(field, 'max-height'), `calc(${inside}px + 4 * ${lineHeight}em)`);
  assert.equal(declared(field, 'overflow-y'), 'auto');
});

test('the placeholder of the message field stays on one line', () => {
  // A textarea wraps its placeholder, and the wrapped lines count in the height the field is given: where the
  // placeholder did not fit (a phone, the room beside the contact panel) the empty field was two lines high.
  const placeholder = rulesFor('.chats-page .message-text-input::placeholder').join(';');
  assert.match(placeholder, /white-space:\s*nowrap/);
  assert.match(placeholder, /overflow:\s*hidden/);
  assert.match(placeholder, /text-overflow:\s*ellipsis/);
});

test('the template list scrolls inside its picker, and has one highlight', () => {
  // The picker's first line and its close button stay in place while the arrow keys walk a long list.
  const composer = readFileSync(join(here, '..', 'components', 'chats', 'ChatComposer.tsx'), 'utf8');
  assert.match(composer, /className="slash-template-head"/);
  assert.match(composer, /className="btn-banner-close btn-close-slash"/);
  assert.match(composer, /className="slash-template-list"/);
  assert.equal(declared('.chats-page .slash-template-list', 'overflow-y'), 'auto');
  assert.ok(declared('.chats-page .slash-template-list', 'max-height'));
  const picker = rulesFor('.chats-page .composer-banner.slash-template-picker').join(';');
  assert.doesNotMatch(picker, /overflow|max-height/);
  // The pointer moves the same highlight the arrow keys do. A hover style of its own marks a second row.
  assert.ok(rulesFor('.chats-page .slash-template-item.active').length > 0);
  assert.equal(rulesFor('.chats-page .slash-template-item:hover').length, 0);
});

test('the band that swaps the panes beside the expanded navigation has no lower edge a zoomed width falls through', () => {
  // With a 768px maximum below it, a 769px minimum left 768.5px, a zoomed width, matched by neither.
  const band = /@media ([^{]+)\{\s*\.main-content:not\(\.expanded\) \.chats-page \.chats-sidebar\s*\{/.exec(css);
  assert.ok(band, 'the band no longer swaps the panes beside the expanded navigation');
  assert.doesNotMatch(band[1], /min-width/);
  assert.match(band[1], /max-width:\s*889px/);
});

test('forced colours draw an edge around every message bubble, whose fill and shadow they drop', () => {
  // The bubbles have no border of their own: under forced colours each one was the page colour on the page colour.
  assert.doesNotMatch(rulesFor('.chats-page .message-bubble')[0], /(?:^|;)\s*border:/);
  const forced = [...css.matchAll(/@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
  assert.match(forced, /\.chats-page \.message-bubble\s*\{[^}]*border:\s*1px solid CanvasText/);
});
