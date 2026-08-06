/**
 * Boot-env contract for the e2e family: setup-e2e.ts (a jest setupFile) re-runs before every
 * suite in the worker, so each suite must boot with queue and Redis off regardless of what an
 * earlier suite in the same worker left in process.env — queue-on.e2e-spec.ts mutates
 * REDIS_ENABLED at module load and can't restore it when it self-skips. Run alone this passes
 * trivially; its regression value is in a shared-worker run after queue-on (or with a dirty
 * ambient env), where a missing reset shows up as REDIS_ENABLED !== 'false' here.
 */
describe('e2e boot environment', () => {
  it('boots with queue and Redis disabled', () => {
    expect(process.env.QUEUE_ENABLED).toBe('false');
    expect(process.env.REDIS_ENABLED).toBe('false');
  });
});
