import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decl, readRules } from './test-helpers/css-rules.ts';

// A box that rings on :focus-within holds a control that must not draw a cue of its own beside the ring (the catalog search
// field and the sidebar search boxes switch the field's own cue off). The sign-in language box holds a custom select whose
// trigger draws a 2px outline under keyboard focus, so a keyboard user sees two nested frames around one control.

test('the sign-in language box rings once: its select trigger draws no outline of its own under keyboard focus', () => {
  const login = readRules(new URL('./pages/Login.css', import.meta.url));
  const select = readRules(new URL('./components/CustomSelect.css', import.meta.url));
  const box = login.find(r => r.media === '' && r.selectors.includes('.login-container .login-language:focus-within'));
  assert.ok(box, 'the language box no longer rings on :focus-within: drop this check');
  assert.match(decl(box.body, 'box-shadow') ?? '', /^0 0 0 1px var\(--focus-ring\)/);
  const trigger = select.find(r => r.media === '' && r.selectors.includes('.custom-select-trigger:focus-visible'));
  assert.ok(trigger, 'the select trigger no longer has a :focus-visible rule: drop this check');
  assert.match(decl(trigger.body, 'outline') ?? '', /var\(--focus-ring\)/);
  const override = login.find(
    r =>
      r.media === '' &&
      r.selectors.some(
        s => /\.login-language\b/.test(s) && /\.custom-select-trigger\b/.test(s) && /:focus-visible\b/.test(s),
      ) &&
      /^(?:none|0)\b/.test(decl(r.body, 'outline') ?? ''),
  );
  assert.ok(
    override,
    'the box ring and the trigger outline are both drawn under keyboard focus: two cues for one control',
  );
});
