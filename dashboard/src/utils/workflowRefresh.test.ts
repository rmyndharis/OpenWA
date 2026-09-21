import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  shouldPollWorkflowTab,
  WORKFLOW_AGENDA_REFRESH_MS,
  WORKFLOW_HUMAN_TICKETS_REFRESH_MS,
  WorkflowRequestGate,
} from './workflowRefresh.ts';

test('does not poll while a workflow editor can contain unsaved input', () => {
  assert.equal(shouldPollWorkflowTab('flows'), false);
  assert.equal(shouldPollWorkflowTab('diagram'), false);
  assert.equal(shouldPollWorkflowTab('settings'), false);
});

test('ignores an old response arriving after the latest response', async () => {
  const gate = new WorkflowRequestGate();
  const old = gate.begin();
  const latest = gate.begin();
  let displayed = '';
  await Promise.resolve().then(() => {
    if (latest()) displayed = 'new session';
  });
  await Promise.resolve().then(() => {
    if (old()) displayed = 'old session';
  });
  assert.equal(displayed, 'new session');
});

test('invalidating requests on navigation or unmount prevents late updates', () => {
  const gate = new WorkflowRequestGate();
  const old = gate.begin();
  gate.invalidate();
  assert.equal(old(), false);
  assert.equal(gate.begin()(), true);
  assert.equal(old(), false);
});

test('keeps operational views refreshed', () => {
  assert.equal(shouldPollWorkflowTab('agenda'), true);
  assert.equal(shouldPollWorkflowTab('candidates'), true);
  assert.equal(shouldPollWorkflowTab('tickets'), true);
  assert.equal(shouldPollWorkflowTab('privacy'), true);
});

test('refreshes the agenda quickly enough to show WhatsApp bookings without reloading the page', () => {
  assert.equal(WORKFLOW_AGENDA_REFRESH_MS, 5_000);
});

test('refreshes human tickets quickly enough to surface new activity without reloading', () => {
  assert.equal(WORKFLOW_HUMAN_TICKETS_REFRESH_MS, 5_000);
});
