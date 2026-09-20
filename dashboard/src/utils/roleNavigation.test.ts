import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canManageHumanService,
  defaultAuthenticatedPath,
  defaultTalentPoolTab,
  isSidebarPathAllowed,
  isTalentPoolTabAllowed,
} from './roleNavigation.ts';

test('allows administrators and operators to manage human service availability', () => {
  assert.equal(canManageHumanService('admin'), true);
  assert.equal(canManageHumanService('operator'), true);
  assert.equal(canManageHumanService('viewer'), false);
  assert.equal(canManageHumanService(null), false);
});

test('limits the operator sidebar to chats and Central de Recrutamento', () => {
  assert.equal(isSidebarPathAllowed('operator', '/chats'), true);
  assert.equal(isSidebarPathAllowed('operator', '/talent-pool'), true);
  assert.equal(isSidebarPathAllowed('operator', '/recruitment-center'), true);
  for (const path of ['/', '/sessions', '/webhooks', '/templates', '/message-tester', '/logs']) {
    assert.equal(isSidebarPathAllowed('operator', path), false, path);
  }
  assert.equal(defaultAuthenticatedPath('operator'), '/recruitment-center');
});

test('limits operator tabs without reducing administrator access', () => {
  for (const tab of ['agenda', 'recruitment', 'candidates', 'tickets', 'notifications'] as const) {
    assert.equal(isTalentPoolTabAllowed('operator', tab), true, tab);
  }
  for (const tab of ['flows', 'diagram', 'privacy', 'settings'] as const) {
    assert.equal(isTalentPoolTabAllowed('operator', tab), false, tab);
    assert.equal(isTalentPoolTabAllowed('admin', tab), true, tab);
  }
  assert.equal(defaultTalentPoolTab('operator'), 'agenda');
  assert.equal(defaultTalentPoolTab('admin'), 'flows');
});
