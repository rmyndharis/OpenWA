import * as fs from 'fs';
import * as path from 'path';

/**
 * The queue dashboard is a raw Express mount (see bull-board-mount.ts), not a Nest
 * controller — so neither global-route-fence-coverage.spec.ts nor the APP_GUARD pipeline
 * can see it. Its auth fence only holds while main.ts calls mountBullBoard after init and
 * the base path stays aligned with BULL_BOARD_BASE_PATH. This spec is that tripwire.
 */

function extractBullBoardBasePath(mountSrc: string): string {
  const match = /export const BULL_BOARD_BASE_PATH = '([^']+)'/.exec(mountSrc);
  if (!match) throw new Error('BULL_BOARD_BASE_PATH literal not found in bull-board-mount.ts');
  return match[1];
}

describe('bull-board mount path tripwire', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.ts'), 'utf8');
  const mountSrc = fs.readFileSync(path.join(__dirname, 'bull-board-mount.ts'), 'utf8');
  const configureAppSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'configure-app.ts'), 'utf8');

  it('main.ts mounts Bull Board after init via mountBullBoard', () => {
    expect(mainSrc.includes('await app.init()')).toBe(true);
    expect(mainSrc.includes('mountBullBoard(app, bullBoardAuth)')).toBe(true);
    expect(extractBullBoardBasePath(mountSrc)).toBe('/api/admin/queues');
  });

  it('SPA catch-all excludes /admin/queues so it cannot shadow a mis-mounted board', () => {
    expect(configureAppSrc.includes("req.path.startsWith('/admin/queues')")).toBe(true);
  });

  it('queue.module no longer uses BullBoardModule.forRoot (broken on Nest11+Express5)', () => {
    const queueModuleSrc = fs.readFileSync(path.join(__dirname, 'queue.module.ts'), 'utf8');
    expect(queueModuleSrc.includes('BullBoardModule')).toBe(false);
  });
});
