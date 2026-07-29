import * as fs from 'fs';
import * as path from 'path';

/**
 * The queue dashboard is a middleware mount, not a Nest controller — so neither
 * global-route-fence-coverage.spec.ts nor the APP_GUARD pipeline can see it. Its auth fence
 * (BullBoardAuthMiddleware) only holds while the mount path in main.ts covers the exact path
 * BullBoardModule serves. A drift in any of the three literals (global prefix, module route,
 * middleware mount) silently re-opens the deployment-global mount to session-restricted keys —
 * or 404s the board — and no other test or CI step would catch it. This spec is that tripwire.
 */

function extractGlobalPrefix(appValidationSrc: string): string {
  const match = /setGlobalPrefix\(\s*'([^']+)'/.exec(appValidationSrc);
  if (!match) throw new Error('setGlobalPrefix literal not found in app-validation.ts');
  return match[1];
}

function extractBullBoardRoute(queueModuleSrc: string): string {
  const match = /BullBoardModule\.forRoot\(\{\s*route:\s*'([^']+)'/.exec(queueModuleSrc);
  if (!match) throw new Error('BullBoardModule route literal not found in queue.module.ts');
  return match[1];
}

function mountCoversRoute(mainSrc: string, prefix: string, route: string): boolean {
  return mainSrc.includes(`app.use('/${prefix}${route}'`);
}

describe('bull-board mount path tripwire', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.ts'), 'utf8');
  const queueModuleSrc = fs.readFileSync(path.join(__dirname, 'queue.module.ts'), 'utf8');
  const appValidationSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'app-validation.ts'), 'utf8');

  it('main.ts mounts the auth middleware on the exact path BullBoardModule serves', () => {
    const prefix = extractGlobalPrefix(appValidationSrc);
    const route = extractBullBoardRoute(queueModuleSrc);
    expect(mountCoversRoute(mainSrc, prefix, route)).toBe(true);
  });

  it('the check fails when any of the three literals drifts', () => {
    expect(mountCoversRoute(mainSrc, 'api', '/other/path')).toBe(false);
    expect(mountCoversRoute(mainSrc, 'wrongprefix', '/admin/queues')).toBe(false);
    expect(mountCoversRoute("app.use('/api/admin/queues', handler);", 'api', '/admin/queues')).toBe(true);
  });
});
