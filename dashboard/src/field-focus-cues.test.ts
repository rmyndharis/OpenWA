import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readAllSheets, type Rule } from './test-helpers/css-rules.ts';

// The scans in field-focus-hover.test.ts and field-border-contrast.test.ts read the focus rules that exist, so a rule
// that is deleted is not seen. This spec names every rule that draws a focus cue, so deleting one (or its cue) fails
// here. A rule added later has to be listed too: the second test finds it. A cue drawn only inside a forced-colors
// block is not listed: forced-colors.test.ts finds those.

const sheets = readAllSheets();

const none = (value: string | undefined): boolean => value === undefined || /^(?:none|0)\b/.test(value);
// What draws a focus cue: an outline, a ring or inset line in the focus (or error) colour, or the focus colour as a border.
const paintsCue = (body: string): boolean =>
  !none(decl(body, 'outline')) ||
  (!none(decl(body, 'box-shadow')) && /var\(--(?:focus-ring|error)\)|inset/.test(body)) ||
  /(?:^|;)\s*border(?:-[a-z-]+)?\s*:[^;]*var\(--focus-ring\)/.test(body);
const isFocusState = (selector: string): boolean =>
  /:focus(?:-visible|-within)?\b/.test(selector.replace(/:not\([^)]*\)/g, ''));

// [stylesheet, the selectors of the rules that draw a focus cue in it]
const FOCUS_CUES: [string, string[]][] = [
  ['components/CustomSelect.css', ['.custom-select-trigger:focus-visible']],
  [
    'components/FilterBuilder.css',
    ['.filter-row select:focus', ".filter-text input[type='text']:focus", '.chips-row .chips-text:focus'],
  ],
  ['components/GlobalSearch.css', ['.global-search-input:focus', '.global-search-hit:focus-visible']],
  ['components/Layout.css', ['.collapse-toggle:focus-visible']],
  ['components/PluginInstances.css', ['.plugin-instances textarea:focus']],
  ['components/chats/RoomSearch.css', ['.chats-page .room-search-input-wrap:focus-within']],
  [
    'index.css',
    [
      'button:focus-visible',
      'a:focus-visible',
      '[tabindex]:focus-visible',
      'select:focus',
      '.modal-body input:focus',
      "input[type='checkbox']:not(.toggle-switch input):focus-visible",
      "input[type='radio']:not(.toggle-switch input):focus-visible",
    ],
  ],
  [
    'pages/ApiKeys.css',
    ['.api-keys-page .modal-body > textarea:focus', '.api-keys-page .permission-search:focus-within'],
  ],
  [
    'pages/Chats.css',
    [
      '.chats-page .session-switcher-btn:focus-visible',
      '.chats-page .session-picker-search:focus-within',
      '.chats-page .session-picker-option:focus-visible',
      '.chats-page .session-picker-add:focus-visible',
      '.chats-page .chat-row-menu-popover button:focus-visible',
      '.chats-page .room-menu-popover button:focus-visible',
      '.chats-page .chat-search-input:focus-within',
      '.chats-page .chat-item-card:focus-visible',
      '.chats-page .chat-row-menu-trigger:focus-visible',
      '.chats-page .chat-dialog-form input:focus',
      '.chats-page .group-info-field input:focus',
      '.chats-page .group-info-field textarea:focus',
      '.chats-page .group-info-add input:focus',
      '.chats-page .search-clear:focus-visible',
      '.chats-page .new-group-name:focus',
      '.chats-page .message-bubble-container:focus-visible',
      '.chats-page .messages-loading-older.failed.retry:focus-visible',
      '.chats-page .message-input-pill:focus-within',
      '.chats-page .status-compose-modal textarea:focus',
      '.chats-page .status-compose-modal input:focus',
      ".chats-page .status-compose-modal input[type='text']:focus",
      ".chats-page .status-compose-modal input[type='url']:focus",
      '.chats-page .status-compose-modal select:focus',
      ".chats-page .status-compose-modal input[type='color']:focus",
    ],
  ],
  [
    'pages/Infrastructure.css',
    [
      '.infrastructure-page .radio-option:has(input:focus-visible)',
      '.infrastructure-page .form-group input:focus',
      '.infrastructure-page .form-group select:focus',
      '.infrastructure-page .toggle-switch input:focus-visible + .toggle-slider',
      '.infrastructure-page label:has(> .hidden-file-input:focus-visible)',
    ],
  ],
  [
    'pages/Login.css',
    [
      '.login-container .login-language:focus-within',
      '.login-container .input-wrapper input:focus',
      '.login-container .input-wrapper input.error:focus',
    ],
  ],
  ['pages/Logs.css', ['.logs-page .search-input:focus-within']],
  [
    'pages/MessageTester.css',
    [
      '.message-tester .form-group input:focus',
      '.message-tester .form-group select:focus',
      '.message-tester .form-group textarea:focus',
    ],
  ],
  ['pages/NumberChecker.css', ['.number-checker .nc-input:focus', '.number-checker .nc-textarea:focus']],
  [
    'pages/Plugins.css',
    [
      '.plugins-page .config-form .form-group input:focus',
      '.plugins-page .config-form .form-group select:focus',
      '.plugins-page .config-form .form-group textarea:focus',
      '.plugins-page .toggle-switch input:focus-visible + .toggle-slider',
      '.plugins-page .install-drop:has(input:focus-visible)',
      '.plugins-page .sessions-select:focus',
      '.plugins-page .catalog-search:focus-within',
    ],
  ],
  [
    'pages/Sessions.css',
    [
      '.sessions-page .search-input:focus-within',
      '.sessions-page .modal-body input:focus',
      '.sessions-page .toggle-switch input:focus-visible + .toggle-slider',
      ".sessions-page .proxy-form-section input[type='text']:focus",
    ],
  ],
  [
    'pages/Templates.css',
    [
      '.templates-page .templates-search:focus-within',
      '.templates-page .template-form input:focus',
      '.templates-page .template-form textarea:focus',
      '.templates-page .placeholder-list input:focus',
    ],
  ],
  [
    'pages/Webhooks.css',
    [
      '.webhooks-page .filter-badge-interactive:focus-visible',
      '.webhooks-page .toggle-switch input:focus-visible + .toggle-slider',
    ],
  ],
];

const cueRules = (file: string): Rule[] =>
  (sheets.get(file) ?? []).filter(rule => rule.media === '' && paintsCue(rule.body));

test('every listed focus rule exists and still draws its cue', () => {
  const missing = FOCUS_CUES.flatMap(([file, selectors]) =>
    selectors
      .filter(selector => !cueRules(file).some(rule => rule.selectors.includes(selector)))
      .map(selector => `${file}: ${selector}`),
  );
  assert.deepEqual(missing, []);
});

test('every focus rule that draws a cue is listed', () => {
  const listed = new Set(FOCUS_CUES.flatMap(([file, selectors]) => selectors.map(selector => `${file}: ${selector}`)));
  assert.ok(listed.size >= 70, 'the list shrank: a deleted rule has to be removed here on purpose');
  const unlisted = [...sheets.keys()].flatMap(file =>
    cueRules(file).flatMap(rule =>
      rule.selectors
        .filter(selector => isFocusState(selector) && !listed.has(`${file}: ${selector}`))
        .map(selector => `${file}: ${selector}`),
    ),
  );
  assert.deepEqual([...new Set(unlisted)], []);
});
