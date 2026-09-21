import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reconcileCandidateColumnPreferences, reorderCandidateColumnPreferences } from './candidateColumns.ts';

test('keeps visibility and position when a question answer key is renamed', () => {
  const available = [
    { id: 'name', kind: 'fixed' as const },
    { id: 'answer:beneficios', kind: 'answer' as const },
    { id: 'status', kind: 'fixed' as const },
  ];
  const configured = [
    { id: 'name', visible: true },
    { id: 'answer:benificios', visible: false },
    { id: 'status', visible: true },
  ];
  const aliases = new Map([['answer:benificios', 'answer:beneficios']]);

  assert.deepEqual(reconcileCandidateColumnPreferences(available, configured, aliases), [
    { id: 'name', visible: true },
    { id: 'answer:beneficios', visible: false },
    { id: 'status', visible: true },
  ]);
});

test('does not recreate a removed legacy column when its replacement is already configured', () => {
  const available = [
    { id: 'name', kind: 'fixed' as const },
    { id: 'answer:beneficios', kind: 'answer' as const },
  ];
  const configured = [
    { id: 'answer:beneficios', visible: false },
    { id: 'answer:benificios', visible: true },
    { id: 'name', visible: true },
  ];
  const aliases = new Map([['answer:benificios', 'answer:beneficios']]);

  assert.deepEqual(reconcileCandidateColumnPreferences(available, configured, aliases), [
    { id: 'answer:beneficios', visible: false },
    { id: 'name', visible: true },
  ]);
});

test('reorders a column by stable id while preserving visibility', () => {
  const configured = [
    { id: 'name', visible: true },
    { id: 'answer:email', visible: false },
    { id: 'status', visible: true },
  ];

  assert.deepEqual(reorderCandidateColumnPreferences(configured, 'status', 'name'), [
    { id: 'status', visible: true },
    { id: 'name', visible: true },
    { id: 'answer:email', visible: false },
  ]);
  assert.deepEqual(reorderCandidateColumnPreferences(configured, 'missing', 'name'), configured);
});
