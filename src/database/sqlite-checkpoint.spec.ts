import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkpointOffThread } from './sqlite-checkpoint';

describe('checkpointOffThread', () => {
  it('rejects when there is no database file to checkpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owa-checkpoint-'));
    try {
      await expect(checkpointOffThread(join(dir, 'missing.sqlite'))).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
