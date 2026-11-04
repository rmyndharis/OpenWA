import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Error text in dark mode lands on the card surface and on the 10 to 20 percent error tints that
// pills and danger buttons paint over it, so it has to clear WCAG AA (4.5:1) on the darkest of those.

const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'App.css'), 'utf8');

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]): number => {
  const [r, g, b] = c.map(v => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: number[], b: number[]): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const token = (block: string, name: string): string => {
  const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `${name} is not a hex colour in the block`);
  return value;
};
const blockAfter = (anchor: string): string => {
  const from = CSS.indexOf(anchor);
  assert.notEqual(from, -1, `App.css no longer contains "${anchor}"`);
  return CSS.slice(from, CSS.indexOf('}', from));
};

test('dark --error-text clears AA on every error tint it lands on, in both dark blocks', () => {
  const error = rgb(token(blockAfter(':root {'), '--error'));
  for (const anchor of ["[data-theme='dark'] {", ":root:not([data-theme='light']) {"]) {
    const block = blockAfter(anchor);
    const text = rgb(token(block, '--error-text'));
    const surface = rgb(token(block, '--bg-white'));
    for (const alpha of [0, 0.1, 0.12, 0.15, 0.18, 0.2]) {
      const bg = error.map((c, i) => c * alpha + surface[i] * (1 - alpha));
      const ratio = contrast(text, bg);
      assert.ok(ratio >= 4.5, `${anchor} --error-text is ${ratio.toFixed(2)}:1 on a ${alpha * 100}% error tint`);
    }
  }
});

// The chat page's own palette (pages/Chats.css): every text token against every surface it lands on, in the
// light set and both dark sets. Light --chat-panel is the app's white card, so it resolves through App.css.
const CHATS_CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pages', 'Chats.css'), 'utf8');
const chatBlock = (anchor: string): string => {
  const from = CHATS_CSS.indexOf(anchor);
  assert.notEqual(from, -1, `Chats.css no longer contains "${anchor}"`);
  return CHATS_CSS.slice(from, CHATS_CSS.indexOf('}', from));
};
// A dark set only lists what it changes (--chat-accent is one fill in every theme), so a token it leaves out is the
// light one.
const chatToken = (block: string, name: string): string =>
  block.match(new RegExp(`${name}:\\s*var\\(--bg-white\\)`))
    ? token(blockAfter(':root {'), '--bg-white')
    : new RegExp(`${name}:`).test(block)
      ? token(block, name)
      : chatToken(chatBlock('.chats-page {'), name);

const CHAT_TEXT_ON: Array<[string, string[]]> = [
  // The header fill is the group dialog's fields, whose placeholders are --chat-meta.
  ['--chat-meta', ['--chat-panel', '--chat-hover', '--chat-active', '--chat-bubble-in', '--chat-panel-header']],
  ['--chat-accent-text', ['--chat-panel', '--chat-hover', '--chat-active']],
  ['--chat-meta-out', ['--chat-bubble-out']],
  // The active filter pill and the group role chip, and the reply title on the composer banner.
  ['--chat-pill-active-text', ['--chat-pill-active-bg', '--chat-panel-header']],
  // Links in a message: the incoming blue is 4.07:1 on the light green and 3.74:1 on the dark one, so an outgoing
  // bubble has its own.
  ['--chat-link', ['--chat-bubble-in']],
  ['--chat-link-out', ['--chat-bubble-out']],
  // A group sender's name heads an incoming bubble in one of eight colours. One hex for both themes measured 3.92:1 at
  // worst on the light bubble and 2.44:1 on the dark one.
  ...Array.from({ length: 8 }, (_, i): [string, string[]] => [`--chat-sender-${i + 1}`, ['--chat-bubble-in']]),
];
const CHAT_ANCHORS = [
  '.chats-page {',
  "[data-theme='dark'] .chats-page {",
  ":root:not([data-theme='light']) .chats-page {",
];

for (const anchor of CHAT_ANCHORS) {
  test(`chat text clears AA on every surface it lands on (${anchor})`, () => {
    const block = chatBlock(anchor);
    for (const [text, surfaces] of CHAT_TEXT_ON) {
      for (const surface of surfaces) {
        const ratio = contrast(rgb(chatToken(block, text)), rgb(chatToken(block, surface)));
        assert.ok(ratio >= 4.5, `${anchor} ${text} is ${ratio.toFixed(2)}:1 on ${surface}`);
      }
    }
  });
}

test('a group sender is named in the eight palette colours measured above, not in a hex of its own', () => {
  const thread = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/chats/ChatThread.tsx'), 'utf8');
  assert.match(thread, /const SENDER_COLORS = 8;/);
  assert.match(thread, /return `var\(--chat-sender-\$\{\(Math\.abs\(hash\) % SENDER_COLORS\) \+ 1\}\)`;/);
  assert.match(thread, /<div className="message-sender" style=\{\{ color: senderColor\(/);
});

const chatRule = (selector: string): string => {
  const css = CHATS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').some(s => s.trim() === selector)) return m[2];
  }
  assert.fail(`Chats.css has no ${selector} rule`);
};

test('the group dialog fields draw their placeholders in the chat meta token, not --text-muted', () => {
  // --text-muted is 4.24:1 on the light --chat-panel-header the fields are filled with.
  assert.match(chatRule('.chats-page .group-info-field textarea'), /background:\s*var\(--chat-panel-header\)/);
  for (const field of ['.group-info-field input', '.group-info-field textarea', '.group-info-add input']) {
    assert.match(chatRule(`.chats-page ${field}::placeholder`), /color:\s*var\(--chat-meta\)/, field);
  }
});

test('the outgoing bubble draws its links in their own token, and a quote its links in the same tokens', () => {
  assert.match(chatRule('.chats-page .message-bubble.outgoing .message-text a'), /color:\s*var\(--chat-link-out\)/);
  assert.match(chatRule('.chats-page .quote-body a'), /color:\s*var\(--chat-link\)/);
  assert.match(chatRule('.chats-page .message-bubble.outgoing .quote-body a'), /color:\s*var\(--chat-link-out\)/);
});

// The accent fill is one green in every theme. The New group check mark sits on it, and the group dialog's tile draws
// its glyph on a gradient from a lighter green into it: as graphics each needs 3:1 on every colour under it.
test('the glyphs drawn on the accent fill clear 3:1 on it, and on both ends of the group tile gradient', () => {
  const accent = rgb(chatToken(chatBlock('.chats-page {'), '--chat-accent'));
  const check = chatRule('.chats-page .select-check.checked');
  assert.match(check, /background:\s*var\(--chat-accent\)/);
  const tile = chatRule('.chats-page .group-info-tile');
  const light = /background:\s*linear-gradient\(135deg, (#[0-9a-f]{6}), var\(--chat-accent\)\)/.exec(tile)?.[1];
  assert.ok(light, 'the group tile is no longer the gradient this test measures');
  for (const [name, rule, fills] of [
    ['check mark', check, [accent]],
    ['group tile', tile, [rgb(light), accent]],
  ] as const) {
    const glyph = /(?:^|;)\s*color:\s*(#[0-9a-f]{6})/.exec(rule)?.[1];
    assert.ok(glyph, `the ${name} sets no glyph colour of its own`);
    for (const fill of fills) {
      const ratio = contrast(rgb(glyph), fill);
      assert.ok(ratio >= 3, `the ${name} glyph is ${ratio.toFixed(2)}:1 on its fill`);
    }
  }
});

// The muted lines a bubble holds are --chat-meta in an incoming one. On the dark outgoing green that token is 3.27:1,
// and 2.87:1 on a quote there, so each line has an outgoing rule in --chat-meta-out, which the tests above measure.
const BUBBLE_META = [
  '.message-edited',
  '.message-time',
  '.message-quote-box',
  '.message-masked',
  '.message-media-omitted',
  '.message-bubble.revoked-type .message-text',
];

test('every muted line inside an outgoing bubble draws in the outgoing token', () => {
  for (const line of BUBBLE_META) {
    const incoming = line.startsWith('.message-bubble') ? line : `.message-bubble ${line}`;
    assert.match(chatRule(`.chats-page ${line}`), /color:\s*var\(--chat-meta\)/, `${line} is no longer --chat-meta`);
    const outgoing = incoming.replace('.message-bubble', '.message-bubble.outgoing');
    assert.match(chatRule(`.chats-page ${outgoing}`), /color:\s*var\(--chat-meta-out\)/, outgoing);
  }
});

// The pill green is also drawn on tints the rules mix from two tokens: the prompt buttons in an incoming bubble (the
// dark button measured 4.22:1 in the old green) with their hover and chosen states, and the admin badge in the group
// dialog. Each fill is read from its rule, so a stronger tint has to keep the text readable too.
const PILL_TEXT_FILLS = [
  '.chats-page .chat-filter-pill.active',
  '.chats-page .group-info-role',
  '.chats-page .group-info-badge.admin',
  '.chats-page .message-prompt-button',
  '.chats-page .message-prompt-button:hover:not(:disabled)',
  '.chats-page .message-prompt-button.selected',
];

// The accent text is drawn on a tint the same way, in the session switcher's avatar. A quote in a bubble mixes the
// bubble text with transparent, so its fill is that tint over the bubble it sits in, named third.
const TEXT_FILLS: Array<[string, string[], string?]> = [
  ['--chat-pill-active-text', PILL_TEXT_FILLS],
  ['--chat-accent-text', ['.chats-page .session-avatar']],
  ['--chat-meta', ['.chats-page .message-quote-box'], '--chat-bubble-in'],
  ['--chat-meta-out', ['.chats-page .message-quote-box'], '--chat-bubble-out'],
  // A link in a quote: the outgoing blue measured 4.30:1 on the quote in both the light and the dark green.
  ['--chat-link', ['.chats-page .message-quote-box'], '--chat-bubble-in'],
  ['--chat-link-out', ['.chats-page .message-quote-box'], '--chat-bubble-out'],
];

for (const anchor of CHAT_ANCHORS) {
  test(`chat text clears AA on every tinted fill it is drawn on (${anchor})`, () => {
    const block = chatBlock(anchor);
    for (const [token, selectors, under] of TEXT_FILLS) {
      const text = rgb(chatToken(block, token));
      for (const selector of selectors) {
        const fill = /(?:^|;)\s*background:\s*([^;]+)/.exec(chatRule(selector))?.[1].trim();
        assert.ok(fill, `${selector} paints no background`);
        const plain = /^var\((--[\w-]+)\)$/.exec(fill);
        const mixed = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, (?:var\((--[\w-]+)\)|transparent)\)$/.exec(fill);
        assert.ok(plain || mixed, `${selector} paints ${fill}, which this test cannot resolve`);
        const base = mixed?.[3] ?? under;
        assert.ok(plain || base, `${selector} mixes with transparent, and the table names no surface under it`);
        const surface = plain
          ? rgb(chatToken(block, plain[1]))
          : rgb(chatToken(block, mixed![1])).map(
              (c, i) => c * (Number(mixed![2]) / 100) + rgb(chatToken(block, base!))[i] * (1 - Number(mixed![2]) / 100),
            );
        const ratio = contrast(text, surface);
        assert.ok(ratio >= 4.5, `${anchor} ${token} is ${ratio.toFixed(2)}:1 on ${selector}`);
      }
    }
  });
}

// The pairs below are the ones the stylesheets build from these tokens and from two literal bubble greens.
const PAGES = join(dirname(fileURLToPath(import.meta.url)), 'pages');
const read = (file: string): string => readFileSync(join(PAGES, file), 'utf8');
const LIGHT = ':root {';
const DARK = "[data-theme='dark'] {";
// A visitor on a dark OS with no stored theme has no data-theme at all (every first visit, and the signed-out
// Login page): they get this block, not DARK, so every dark ratio is checked against both.
const DARK_MEDIA = ":root:not([data-theme='light']) {";
const DARKS = [DARK, DARK_MEDIA];
const valueOf = (block: string, name: string): string => {
  const raw = block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  assert.ok(raw, `${name} is not set in the block`);
  const alias = /^var\((--[\w-]+)\)$/.exec(raw);
  return alias ? valueOf(blockAfter(LIGHT), alias[1]) : raw;
};
const hexOf = (block: string, name: string): string => {
  const value = valueOf(block, name);
  assert.match(value, /^#[0-9a-f]{6}$/i, `${name} is ${value}`);
  return value;
};
const mix = (over: number[], alpha: number, under: number[]): number[] =>
  over.map((c, i) => c * alpha + under[i] * (1 - alpha));

test('--text-muted placeholders clear AA on every input surface in both themes', () => {
  assert.match(
    CSS,
    /input::placeholder,\s*textarea::placeholder\s*\{[^}]*color:\s*var\(--text-muted\)[^}]*opacity:\s*1/,
  );
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    const text = rgb(hexOf(block, '--text-muted'));
    for (const surface of ['--bg-white', '--bg-light']) {
      const ratio = contrast(text, rgb(hexOf(block, surface)));
      assert.ok(ratio >= 4.5, `${anchor} --text-muted on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

// The chat page paints its bubbles from its own palette (--chat-bubble-out), in the light set and both dark sets. The
// time is text and holds 4.5:1; the delivery ticks are drawn as icons (lucide's Check and CheckCheck in ChatThread),
// so they hold the 3:1 of a graphic, and delivered and read also differ in aria-label and title.
test('time stamps and read ticks on the outgoing bubble clear their ratios in every theme', () => {
  assert.match(chatRule('.chats-page .message-bubble.outgoing .message-time'), /color:\s*var\(--chat-meta-out\)/);
  assert.match(chatRule('.chats-page .message-status-icon.read'), /color:\s*var\(--chat-tick-read\)/);
  assert.match(chatRule('.chats-page .message-status-icon'), /color:\s*var\(--chat-meta\)/);
  const thread = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/chats/ChatThread.tsx'), 'utf8');
  assert.match(thread, /read:\s*<CheckCheck\b/, 'the read tick is no longer an icon, so it needs 4.5:1');
  for (const anchor of CHAT_ANCHORS) {
    const block = chatBlock(anchor);
    const bubble = rgb(chatToken(block, '--chat-bubble-out'));
    const time = contrast(rgb(chatToken(block, '--chat-meta-out')), bubble);
    assert.ok(time >= 4.5, `${anchor} time stamp ${time.toFixed(2)}:1`);
    for (const tick of ['--chat-tick-read', '--chat-meta']) {
      const ratio = contrast(rgb(chatToken(block, tick)), bubble);
      assert.ok(ratio >= 3, `${anchor} ${tick} tick ${ratio.toFixed(2)}:1`);
    }
  }
});

// The session status mark is the one sign in the switcher that the open session dropped. Against the panel-coloured
// ring around it each state holds the 3:1 of a graphic (the base green and amber were 2.28:1 and 2.15:1 on white), and
// the states differ in shape too, not by colour alone: a dot, a ring and a square. Forced colours keep the shapes.
test('the session status mark clears 3:1 against its ring in every theme and tells its states apart by shape', () => {
  const ready = chatRule('.chats-page .session-status-dot');
  const pending = chatRule('.chats-page .session-status-dot.pending');
  const down = chatRule('.chats-page .session-status-dot.down');
  assert.match(ready, /border:\s*2px solid var\(--chat-panel\)/);
  assert.match(ready, /border-radius:\s*50%/);
  assert.match(pending, /background:\s*var\(--chat-panel\)/, 'the pending mark is not hollow');
  assert.match(down, /border-radius:\s*[0-4]px/, 'the down mark is not square');
  const marks = [
    /background:\s*var\((--[\w-]+)\)/.exec(ready)?.[1],
    /box-shadow:\s*inset 0 0 0 2px var\((--[\w-]+)\)/.exec(pending)?.[1],
    /background:\s*var\((--[\w-]+)\)/.exec(down)?.[1],
  ];
  for (const [chatAnchor, appAnchor] of [
    [CHAT_ANCHORS[0], LIGHT],
    [CHAT_ANCHORS[1], DARK],
    [CHAT_ANCHORS[2], DARK_MEDIA],
  ]) {
    const ring = rgb(chatToken(chatBlock(chatAnchor), '--chat-panel'));
    for (const mark of marks) {
      assert.ok(mark, 'a status mark is no longer drawn in a token');
      const ratio = contrast(rgb(hexOf(blockAfter(appAnchor), mark)), ring);
      assert.ok(ratio >= 3, `${chatAnchor} ${mark} is ${ratio.toFixed(2)}:1 against the ring`);
    }
  }
  const forced = /@media \(forced-colors: active\)\s*\{([\s\S]*?)\n\}/.exec(CHATS_CSS)?.[1] ?? '';
  assert.match(forced, /\.session-status-dot[^{]*\{[^}]*forced-color-adjust:\s*none[^}]*background:\s*CanvasText/);
  assert.match(forced, /\.session-status-dot\.pending\s*\{[^}]*background:\s*Canvas;[^}]*inset 0 0 0 2px CanvasText/);
});

// A picture-less avatar shows the chat's kind as a glyph in its tone (components/chats/ChatAvatar.tsx): in light mode
// on the tone's pastel, in dark mode on the tone mixed into the dark panel. Orange measured 2.67:1 on its pastel and
// violet 2.96:1 on its dark mix.
test('every avatar tone draws its glyph at 3:1 or more on its fill, in light and dark', () => {
  const avatar = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/chats/ChatAvatar.tsx'), 'utf8');
  const tones = /AVATAR_TONES = \[([^\]]+)\]/.exec(avatar)?.[1].match(/[a-z]+/g) ?? [];
  assert.ok(tones.length >= 6, 'ChatAvatar.tsx no longer lists its tones');
  const darkMix = (anchor: string): [number, string] => {
    const rule = new RegExp(
      `${anchor.replace(/[.[\]()'*]/g, '\\$&')}[^{]*\\{[^}]*background:\\s*color-mix\\(in srgb, currentColor (\\d+)%, (#[0-9a-f]{6})\\)`,
    ).exec(CHATS_CSS);
    assert.ok(rule, `no dark tone fill under ${anchor}`);
    return [Number(rule[1]) / 100, rule[2]];
  };
  const darks = [
    darkMix("[data-theme='dark'] .chats-page .chat-avatar[class*='avatar-tone-']"),
    darkMix(":root:not([data-theme='light']) .chats-page .chat-avatar[class*='avatar-tone-']"),
  ];
  for (const tone of tones) {
    const rule = chatRule(`.chats-page .avatar-tone-${tone}`);
    const glyph = rgb(/color:\s*(#[0-9a-f]{6})/i.exec(rule)?.[1] ?? '');
    const pastel = rgb(/background:\s*(#[0-9a-f]{6})/i.exec(rule)?.[1] ?? '');
    const light = contrast(glyph, pastel);
    assert.ok(light >= 3, `${tone} glyph is ${light.toFixed(2)}:1 on its pastel`);
    for (const [alpha, panel] of darks) {
      const dark = contrast(glyph, mix(glyph, alpha, rgb(panel)));
      assert.ok(dark >= 3, `${tone} glyph is ${dark.toFixed(2)}:1 on its dark fill`);
    }
  }
});

test('the action required pill clears 4.5:1 on its tint in the dark theme, with one tint on both pages', () => {
  const tints = [
    ['Sessions.css', '.sessions-page .status-pill.action_required'],
    ['Dashboard.css', '.dashboard .status-pill.action_required'],
  ].map(([file, selector]) => {
    const rule = new RegExp(
      `${selector.replace(/[.]/g, '\\.')}[^{]*\\{[^}]*background:\\s*rgba\\(245,\\s*158,\\s*11,\\s*([\\d.]+)\\)`,
    ).exec(read(file));
    assert.ok(rule, `${file} has no amber tint for ${selector}`);
    return Number(rule[1]);
  });
  assert.equal(tints[0], tints[1], 'the same status is tinted differently on the two pages');
  // The tint is the base amber (--warning) over the card; the text is --warning-text, which keeps the base value in dark.
  for (const anchor of DARKS) {
    const block = blockAfter(anchor);
    const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--warning')), tints[0], rgb(hexOf(block, '--bg-white')));
    const ratio = contrast(rgb(hexOf(block, '--warning-text')), tint);
    assert.ok(ratio >= 4.5, `${anchor} amber text on a ${tints[0]} tint is ${ratio.toFixed(2)}:1`);
  }
});

// The detail modal repeats the status as a badge beside its own "Status" label, on the 10 percent tint every other
// status badge has (--warning-text is 5.02:1 on it over white) rather than the card pill's 22 percent (4.57:1).
test('the action required badge in the session details clears 4.5:1 on its tint in every theme', () => {
  const rule =
    /\.sessions-page \.status-badge\.action_required\s*\{[^}]*background:\s*rgba\(245,\s*158,\s*11,\s*([\d.]+)\)/.exec(
      read('Sessions.css'),
    );
  assert.ok(rule, 'Sessions.css has no amber tint for the action required badge');
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    for (const surface of ['--bg-white', '--bg-light']) {
      const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--warning')), Number(rule[1]), rgb(hexOf(block, surface)));
      const ratio = contrast(rgb(hexOf(block, '--warning-text')), tint);
      assert.ok(ratio >= 4.5, `${anchor} badge text on ${rule[1]} over ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

// A status badge, pill or hover state paints a translucent tint of its own hue behind a text twin. The twins have to hold
// on the heaviest tint any rule paints over white (error 15 percent, success 18, warning 22), not only on the 10
// percent one: a rule with a heavier tint needs a darker twin, or a lighter tint.
const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });

test('every status text twin clears 4.5:1 on the translucent fill its own rule paints over white', () => {
  const root = dirname(fileURLToPath(import.meta.url));
  const light = blockAfter(LIGHT);
  const white = rgb(hexOf(light, '--bg-white'));
  let checked = 0;
  const offenders: string[] = [];
  for (const file of cssFiles(root)) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const color = /(?:^|;)\s*color:\s*var\((--(?:error|success|warning|primary)-text)\)/.exec(rule[2]);
      const fill = /(?:^|;)\s*background(?:-color)?:\s*rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rule[2]);
      if (!color || !fill) continue;
      checked++;
      const tint = mix([Number(fill[1]), Number(fill[2]), Number(fill[3])], Number(fill[4]), white);
      const ratio = contrast(rgb(hexOf(light, color[1])), tint);
      if (ratio < 4.5) {
        offenders.push(
          `${file.slice(root.length + 1)}: ${rule[1].trim()} ${color[1]} ${ratio.toFixed(2)}:1 on ${fill[4]}`,
        );
      }
    }
  }
  assert.ok(checked > 40, `the scan saw ${checked} rules`);
  assert.deepEqual(offenders, []);
});

// A badge inside a tinted card sits on both tints: the Not Registered badge paints 15 percent red over the 4 percent red
// of its result card, which leaves --error-text at 4.38:1 where the pair over plain white measured 4.57:1.
test('the Not Registered badge clears 4.5:1 on its tint over the tint of its result card', () => {
  const css = read('NumberChecker.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const alphaOf = (selector: string): number => {
    const rule = new RegExp(
      `${selector.replace(/[.]/g, '\\.')}\\s*\\{[^}]*background:\\s*rgba\\(239,\\s*68,\\s*68,\\s*([\\d.]+)\\)`,
    ).exec(css);
    assert.ok(rule, `NumberChecker.css has no red tint for ${selector}`);
    return Number(rule[1]);
  };
  const badge = alphaOf('.number-checker .nc-status-badge.unregistered');
  const card = alphaOf('.number-checker .nc-result-card.not-found');
  const light = blockAfter(LIGHT);
  const red = rgb(hexOf(light, '--error'));
  // The result card sits in .nc-card, which is --bg-white.
  const tint = mix(red, badge, mix(red, card, rgb(hexOf(light, '--bg-white'))));
  const ratio = contrast(rgb(hexOf(light, '--error-text')), tint);
  assert.ok(ratio >= 4.5, `--error-text on the badge over the card is ${ratio.toFixed(2)}:1`);
});

// WCAG 2.2 SC 1.4.11 asks 3:1 of a keyboard focus indicator against what it is drawn on: the page and card surfaces
// and the soft brand tint of a focused menu entry or search hit. The brand fill measured 1.98:1 on white.
test('the focus ring clears 3:1 on every surface it is drawn on, in both themes', () => {
  assert.match(CSS, /--focus-ring:\s*var\(--primary-text\)/);
  for (const [anchor, tint] of [
    [LIGHT, 0.12],
    [DARK, 0.18],
    [DARK_MEDIA, 0.18],
  ] as const) {
    const block = blockAfter(anchor);
    const ring = rgb(hexOf(block, '--primary-text'));
    for (const surface of ['--bg-white', '--bg-light']) {
      const bg = rgb(hexOf(block, surface));
      const soft = mix(rgb(hexOf(blockAfter(LIGHT), '--primary')), tint, bg);
      for (const [name, fill] of [
        ['the surface', bg],
        ['the soft tint over it', soft],
      ] as const) {
        const ratio = contrast(ring, fill);
        assert.ok(ratio >= 3, `${anchor} ring on ${name} of ${surface} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
});

// The enabled badge of a plugin instance paints --primary-soft, so its text is the brand green twin: --success-text is
// a different green, and on the 18 percent tint of the dark theme it measured 4.48:1.
test('the enabled badge of a plugin instance clears 4.5:1 on its tint in every theme', () => {
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/PluginInstances.css'), 'utf8');
  const rule =
    /\.plugin-instances \.pi-badge\.on\s*\{[^}]*background:\s*var\(--primary-soft\);[^}]*color:\s*var\((--[\w-]+)\)/.exec(
      css,
    );
  assert.ok(rule, 'PluginInstances.css no longer paints the enabled badge on --primary-soft');
  for (const [anchor, alpha] of [
    [LIGHT, 0.12],
    [DARK, 0.18],
    [DARK_MEDIA, 0.18],
  ] as const) {
    const block = blockAfter(anchor);
    for (const surface of ['--bg-white', '--bg-light']) {
      const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--primary')), alpha, rgb(hexOf(block, surface)));
      const ratio = contrast(rgb(hexOf(block, rule[1])), tint);
      assert.ok(ratio >= 4.5, `${anchor} ${rule[1]} on the badge over ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('the search match and the Number Checker highlight pill clear AA in both themes', () => {
  const search = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'components/GlobalSearch.css'), 'utf8');
  const mark =
    /\.global-search-hit-snippet mark\s*\{[^}]*background:\s*var\((--[\w-]+)\);[^}]*?color:\s*(#[0-9a-f]{6})/i.exec(
      search,
    );
  assert.ok(mark, 'GlobalSearch.css no longer styles the match with a hex colour on a token fill');
  const pill =
    /\.nc-format-pill\.highlight\s*\{[^}]*background:\s*rgba\(37,\s*211,\s*102,\s*([\d.]+)\)[^}]*?color:\s*var\((--[\w-]+)\)/.exec(
      read('NumberChecker.css'),
    );
  assert.ok(pill, 'NumberChecker.css no longer styles the highlight pill with a token colour');
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    // The amber fill is the same in both themes, so the dark text on it must hold in both.
    const onAmber = contrast(rgb(mark[2]), rgb(hexOf(blockAfter(LIGHT), mark[1])));
    assert.ok(onAmber >= 4.5, `${anchor} match text on the amber is ${onAmber.toFixed(2)}:1`);
    const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--primary')), Number(pill[1]), rgb(hexOf(block, '--bg-white')));
    const onTint = contrast(rgb(hexOf(block, pill[2])), tint);
    assert.ok(onTint >= 4.5, `${anchor} pill text on the green tint is ${onTint.toFixed(2)}:1`);
  }
});

// Opacity over --text-muted is a second fade on a colour that already sits at 4.5:1: at 0.7 it is 2.72:1.
test('text that uses --text-muted is not faded again with opacity', () => {
  const components = join(dirname(fileURLToPath(import.meta.url)), 'components');
  const sources: [string, string, string][] = [
    ['Layout.css', readFileSync(join(components, 'Layout.css'), 'utf8'), '.brand-version'],
    // The raw chat id, faded in the old room header, is in the contact panel now.
    ['Chats.css', read('Chats.css'), '.chats-page .contact-info-list dd.mono bdi'],
    ['Chats.css', read('Chats.css'), '.chats-page .chat-item-snippet .no-message'],
    ['Infrastructure.css', read('Infrastructure.css'), '.infrastructure-page .form-group small'],
    ['Infrastructure.css', read('Infrastructure.css'), '.infrastructure-page .toggle-info small'],
  ];
  for (const [file, css, selector] of sources) {
    const rule = new RegExp(`(?:^|})\\s*${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(
      css.replace(/\/\*[\s\S]*?\*\//g, ''),
    );
    assert.ok(rule, `${file} has no ${selector} rule`);
    assert.doesNotMatch(rule[1], /opacity:/, `${file} ${selector} fades its text`);
  }
});

test('muted text on a tinted row uses --text-secondary, which clears AA on the tint in both themes', () => {
  // The chat list rows are no tint: the active one is the opaque --chat-active, on which the chat text tests above
  // check the time and the preview (--chat-meta) in every theme. Those are the tokens the row draws them in, and no
  // rule for the active row paints them in another.
  assert.match(chatRule('.chats-page .chat-item-card.active'), /background:\s*var\(--chat-active\)/);
  assert.match(chatRule('.chats-page .chat-item-time'), /(?:^|;)\s*color:\s*var\(--chat-meta\)/);
  assert.match(chatRule('.chats-page .chat-item-snippet'), /(?:^|;)\s*color:\s*var\(--chat-meta\)/);
  assert.match(chatRule('.chats-page .chat-item-card.unread .chat-item-time'), /color:\s*var\(--chat-accent-text\)/);
  const repainted = [...CHATS_CSS.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => /\.active\b[^,]*\.chat-item-(?:time|snippet)/.test(m[1]) && /(?:^|;)\s*color:/.test(m[2]))
    .map(m => m[1].trim());
  assert.deepEqual(
    repainted,
    [],
    'the active row paints its time or preview in a token the tests above do not measure',
  );
  // [stylesheet, selector, tint alpha in light, tint alpha in dark, surface under the tint]
  const rules: [string, string, number, number, string][] = [
    // The selected template row is --primary-soft: 12 percent in light, 18 percent in dark.
    ['Templates.css', '.templates-page .template-list-item.selected .template-list-meta', 0.12, 0.18, '--bg-light'],
    // The focused search hit is --primary-soft over the results panel, which is --bg-white.
    [
      '../components/GlobalSearch.css',
      '.global-search-hit:focus-visible .global-search-hit-meta',
      0.12,
      0.18,
      '--bg-white',
    ],
  ];
  for (const [file, selector, light, dark, surface] of rules) {
    const rule = new RegExp(`${selector.replace(/[.]/g, '\\.')}[^{]*\\{[^}]*color:\\s*var\\((--[\\w-]+)\\)`).exec(
      read(file),
    );
    assert.ok(rule, `${file} has no colour for ${selector}`);
    assert.equal(rule[1], '--text-secondary', `${file} ${selector}`);
    for (const [anchor, alpha] of [
      [LIGHT, light],
      [DARK, dark],
      [DARK_MEDIA, dark],
    ] as const) {
      const block = blockAfter(anchor);
      const tint = mix(rgb(hexOf(blockAfter(LIGHT), '--primary')), alpha, rgb(hexOf(block, surface)));
      const ratio = contrast(rgb(hexOf(block, '--text-secondary')), tint);
      assert.ok(ratio >= 4.5, `${anchor} ${selector} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test('the batch badge uses --info, which clears the twins range on its tint in both themes', () => {
  const rule = /\.batch-badge\.pending,\s*\.message-tester \.batch-badge\.processing\s*\{[^}]*color:\s*([^;]+);/.exec(
    read('MessageTester.css'),
  );
  assert.ok(rule, 'MessageTester.css no longer styles the pending badge');
  assert.equal(rule[1].trim(), 'var(--info)');
  for (const anchor of [LIGHT, ...DARKS]) {
    const block = blockAfter(anchor);
    // The batch panel is --bg-light; the badge paints 12 percent of the blue over it.
    const tint = mix([59, 130, 246], 0.12, rgb(hexOf(block, '--bg-light')));
    const ratio = contrast(rgb(hexOf(block, '--info')), tint);
    assert.ok(ratio >= 4.29, `${anchor} --info on the batch badge is ${ratio.toFixed(2)}:1 (the raw blue was 3.08:1)`);
  }
});
