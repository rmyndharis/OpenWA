import { runWithRequestId, getRequestId } from './request-context';

describe('request-context', () => {
  it('getRequestId is undefined outside any run scope', () => {
    expect(getRequestId()).toBeUndefined();
  });

  it('getRequestId returns the id inside runWithRequestId', () => {
    runWithRequestId('req-abc', () => {
      expect(getRequestId()).toBe('req-abc');
    });
  });

  it('getRequestId is undefined again after the run scope exits', () => {
    runWithRequestId('req-abc', () => {
      // scope active
    });
    expect(getRequestId()).toBeUndefined();
  });

  it('propagates the id into async work awaited inside the scope', async () => {
    await runWithRequestId('req-abc', async () => {
      await Promise.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(getRequestId()).toBe('req-abc');
    });
  });

  it('restores the enclosing scope after a nested run exits', () => {
    runWithRequestId('outer', () => {
      runWithRequestId('inner', () => {
        expect(getRequestId()).toBe('inner');
      });
      expect(getRequestId()).toBe('outer');
    });
  });
});
