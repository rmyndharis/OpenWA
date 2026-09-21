import assert from 'node:assert/strict';
import test from 'node:test';
import { hasPointerDragStarted, workflowDragPreviewPosition } from './workflowDrag.ts';

test('starts only after the pointer movement threshold', () => {
  const origin = { startX: 100, startY: 100, offsetX: 20, offsetY: 10 };
  assert.equal(hasPointerDragStarted(origin, 103, 103), false);
  assert.equal(hasPointerDragStarted(origin, 106, 100), true);
});

test('keeps the dragged card attached to the original pointer offset', () => {
  const origin = { startX: 120, startY: 80, offsetX: 25, offsetY: 15 };
  assert.deepEqual(workflowDragPreviewPosition(origin, 300, 240), { x: 275, y: 225 });
});
