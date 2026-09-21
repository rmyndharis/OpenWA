import {
  WwebjsLifecycle,
  type WwebjsLifecycleHost,
  PAIRING_CODE_MAX_ATTEMPTS,
  PAIRING_CODE_ATTEMPT_TIMEOUT_MS,
  PAIRING_CODE_RETRY_DELAY_MS,
} from './wwebjs-lifecycle';
import { EngineStatus } from '../interfaces/whatsapp-engine.interface';
import { EngineNotReadyError } from '../../common/errors/engine-not-ready.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import type { Client } from 'whatsapp-web.js';

/**
 * WhatsApp Web reloads the QR page while UNPAIRED, so a requestPairingCode can land mid-navigation and
 * either reject with "Execution context was destroyed" or hang until Puppeteer's protocol timeout.
 * The call now bounds each attempt and retries the navigation/timeout shapes while still at QR_READY,
 * so the dashboard gets a code instead of sitting on "Creating pairing code..." forever.
 */
function makeLifecycle(requestPairingCode: jest.Mock): WwebjsLifecycle {
  const host = {
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    config: { sessionId: 'sess', sessionDataPath: './data' },
  } as unknown as WwebjsLifecycleHost;
  const lc = new WwebjsLifecycle(host);
  lc.status = EngineStatus.QR_READY;
  lc.client = { requestPairingCode } as unknown as Client;
  return lc;
}

describe('requestPairingCode retries a mid-navigation page', () => {
  afterEach(() => jest.useRealTimers());

  it('rejects before the QR stage without touching the client', async () => {
    const requestPairingCode = jest.fn();
    const lc = makeLifecycle(requestPairingCode);
    lc.status = EngineStatus.INITIALIZING;
    await expect(lc.requestPairingCode('628111')).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(requestPairingCode).not.toHaveBeenCalled();
  });

  it('retries a navigation-destroyed context and returns the code once the page reboots', async () => {
    jest.useFakeTimers();
    const requestPairingCode = jest
      .fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'))
      .mockResolvedValueOnce('WXYZ1234');
    const lc = makeLifecycle(requestPairingCode);

    const pending = lc.requestPairingCode('628111');
    await jest.advanceTimersByTimeAsync(PAIRING_CODE_RETRY_DELAY_MS + 10);

    await expect(pending).resolves.toBe('WXYZ1234');
    expect(requestPairingCode).toHaveBeenCalledTimes(2);
  });

  // An exhausted budget is a transport failure, not a broken gateway: it answers 503 so a caller
  // knows the request is worth retrying, and carries the last attempt's reason as the detail.
  it('bounds a hanging attempt and gives up after the attempt budget', async () => {
    jest.useFakeTimers();
    const requestPairingCode = jest.fn().mockImplementation(() => new Promise<string>(() => undefined)); // never settles
    const lc = makeLifecycle(requestPairingCode);

    const pending = lc.requestPairingCode('628111');
    pending.catch(() => undefined); // the rejection is asserted below; avoid an unhandled rejection warning
    const total =
      PAIRING_CODE_MAX_ATTEMPTS * PAIRING_CODE_ATTEMPT_TIMEOUT_MS +
      (PAIRING_CODE_MAX_ATTEMPTS - 1) * PAIRING_CODE_RETRY_DELAY_MS +
      50;
    await jest.advanceTimersByTimeAsync(total);

    await expect(pending).rejects.toBeInstanceOf(EngineTransportError);
    await expect(pending).rejects.toThrow(/attempt timed out/i);
    expect(requestPairingCode).toHaveBeenCalledTimes(PAIRING_CODE_MAX_ATTEMPTS);
  });

  it('answers 503 for an exhausted budget', async () => {
    jest.useFakeTimers();
    const requestPairingCode = jest.fn().mockImplementation(() => new Promise<string>(() => undefined));
    const lc = makeLifecycle(requestPairingCode);

    const pending = lc.requestPairingCode('628111');
    const failure = pending.catch((err: unknown) => err);
    await jest.advanceTimersByTimeAsync(
      PAIRING_CODE_MAX_ATTEMPTS * PAIRING_CODE_ATTEMPT_TIMEOUT_MS +
        (PAIRING_CODE_MAX_ATTEMPTS - 1) * PAIRING_CODE_RETRY_DELAY_MS +
        50,
    );

    expect(((await failure) as EngineTransportError).getStatus()).toBe(503);
  });

  it('propagates a non-navigation failure on the first attempt (no wasted retries)', async () => {
    const requestPairingCode = jest.fn().mockRejectedValue(new Error('phone number is not registered on WhatsApp'));
    const lc = makeLifecycle(requestPairingCode);
    await expect(lc.requestPairingCode('628111')).rejects.toThrow(/not registered/);
    expect(requestPairingCode).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the session leaves the QR stage between attempts', async () => {
    jest.useFakeTimers();
    const requestPairingCode = jest
      .fn()
      .mockRejectedValue(new Error('Execution context was destroyed, most likely because of a navigation.'));
    const lc = makeLifecycle(requestPairingCode);

    const pending = lc.requestPairingCode('628111');
    pending.catch(() => undefined);
    lc.status = EngineStatus.READY; // linked while the first retry delay is pending
    await jest.advanceTimersByTimeAsync(PAIRING_CODE_RETRY_DELAY_MS + 10);

    await expect(pending).rejects.toBeInstanceOf(EngineNotReadyError);
    expect(requestPairingCode).toHaveBeenCalledTimes(1);
  });
});
