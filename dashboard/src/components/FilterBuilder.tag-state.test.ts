// The message-type and chat-kind filter values are a multi-select of tags. A screen reader must hear which tags are
// on, as it does for the house toggle groups.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import type { WebhookFilters } from '../services/api.ts';

let rtl: typeof import('@testing-library/react');
let FilterBuilder: (typeof import('./FilterBuilder.tsx'))['FilterBuilder'];

before(async () => {
  const { installJsdomGlobals } = await import('../test-helpers/jsdom.ts');
  await installJsdomGlobals();
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  ({ FilterBuilder } = await import('./FilterBuilder.tsx'));
});

afterEach(() => rtl.cleanup());

function Harness() {
  const [filters, setFilters] = useState<WebhookFilters | null>({
    conditions: [{ field: 'type', operator: 'is', value: ['image'] }],
  });
  return createElement(FilterBuilder, { filters, onChange: setFilters, chats: [] });
}

test('a selected message-type tag reports that it is selected, and an unselected one that it is not', () => {
  rtl.render(createElement(Harness));
  const image = rtl.screen.getByRole('button', { name: 'Image' });
  const video = rtl.screen.getByRole('button', { name: 'Video' });
  assert.equal(image.getAttribute('aria-pressed'), 'true', 'the selected Image tag exposes no selected state');
  assert.equal(video.getAttribute('aria-pressed'), 'false', 'the unselected Video tag exposes no state');
  rtl.fireEvent.click(video);
  assert.equal(rtl.screen.getByRole('button', { name: 'Video' }).getAttribute('aria-pressed'), 'true');
});
