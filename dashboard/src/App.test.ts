import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyTalentPoolPath } from './utils/legacyRoutes.ts';

test('legacy recruitment redirect preserves the complete query string', () => {
  assert.equal(
    legacyTalentPoolPath('?aba=candidates&sessionId=session-1'),
    '/recruitment-center?aba=candidates&sessionId=session-1',
  );
});
