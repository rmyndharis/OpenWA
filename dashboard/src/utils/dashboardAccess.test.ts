import '../test-helpers/register-hooks.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAccessDashboardPage, DASHBOARD_PAGE_CAPABILITIES } from './dashboardAccess.ts';

test('every dashboard page is visible with an empty capability blocklist', () => {
  for (const path of Object.keys(DASHBOARD_PAGE_CAPABILITIES)) {
    assert.equal(canAccessDashboardPage(path as keyof typeof DASHBOARD_PAGE_CAPABILITIES, []), true, path);
  }
});

test('a page is hidden when any capability its primary surface needs is blocked', () => {
  assert.equal(canAccessDashboardPage('/sessions', ['sessions:read']), false);
  assert.equal(canAccessDashboardPage('/chats', ['chats:read']), false);
  assert.equal(canAccessDashboardPage('/chats', ['messages:read']), false);
  assert.equal(canAccessDashboardPage('/message-tester', ['sessions:read']), false);
  assert.equal(canAccessDashboardPage('/message-tester', ['messages:send']), false);
  assert.equal(canAccessDashboardPage('/webhooks', ['messages:read']), true);
});
