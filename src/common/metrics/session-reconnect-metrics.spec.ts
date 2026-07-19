import {
  incrementSessionReconnectAttempts,
  getSessionReconnectAttemptsTotal,
  incrementSessionReconnectLoopAlerts,
  getSessionReconnectLoopAlertsTotal,
} from './session-reconnect-metrics';

describe('session-reconnect-metrics', () => {
  it('monotonically increments the reconnect-attempts total', () => {
    const before = getSessionReconnectAttemptsTotal();
    incrementSessionReconnectAttempts();
    incrementSessionReconnectAttempts();
    expect(getSessionReconnectAttemptsTotal()).toBe(before + 2);
  });

  it('reconnect-attempts total never decreases', () => {
    const a = getSessionReconnectAttemptsTotal();
    incrementSessionReconnectAttempts();
    const b = getSessionReconnectAttemptsTotal();
    expect(b).toBeGreaterThan(a);
  });

  it('monotonically increments the loop-alerts total', () => {
    const before = getSessionReconnectLoopAlertsTotal();
    incrementSessionReconnectLoopAlerts();
    incrementSessionReconnectLoopAlerts();
    expect(getSessionReconnectLoopAlertsTotal()).toBe(before + 2);
  });

  it('loop-alerts total never decreases', () => {
    const a = getSessionReconnectLoopAlertsTotal();
    incrementSessionReconnectLoopAlerts();
    const b = getSessionReconnectLoopAlertsTotal();
    expect(b).toBeGreaterThan(a);
  });

  it('tracks attempts and alerts independently', () => {
    const attemptsBefore = getSessionReconnectAttemptsTotal();
    const alertsBefore = getSessionReconnectLoopAlertsTotal();
    incrementSessionReconnectAttempts();
    expect(getSessionReconnectLoopAlertsTotal()).toBe(alertsBefore);
    incrementSessionReconnectLoopAlerts();
    expect(getSessionReconnectAttemptsTotal()).toBe(attemptsBefore + 1);
  });
});
