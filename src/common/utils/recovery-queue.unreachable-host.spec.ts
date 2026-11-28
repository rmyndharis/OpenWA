import { type DataSource } from 'typeorm';
import { markConnectFailures } from './db-errors';
import {
  RECOVERY_MAX_RECORD_FAILURES,
  RecoveryQueue,
  recoveryQueueOptions,
  type RecoveryLoss,
  type RecoveryRecord,
} from './recovery-queue';

/** What a socket raises when the database's host cannot be reached, as Node reports it. */
const unreachable = (code: string): Error =>
  Object.assign(new Error(`getaddrinfo ${code} openwa-db`), { code, syscall: 'getaddrinfo' });

/** The same error once the data connection failed to connect with it, which marks it as the database's. */
async function fromDataConnection(code: string): Promise<Error> {
  const driver = { obtainMasterConnection: () => Promise.reject(unreachable(code)) };
  markConnectFailures({ driver } as unknown as DataSource);
  return driver.obtainMasterConnection().catch((error: Error) => error);
}

describe('RecoveryQueue and a database host that cannot be reached', () => {
  let now: number;
  const queueOf = () =>
    new RecoveryQueue({ ...recoveryQueueOptions(false, 0), baseDelayMs: 1000, capDelayMs: 8000, now: () => now });
  const write = (refusal: Error): RecoveryRecord & { lostAs?: RecoveryLoss } => {
    const r: RecoveryRecord & { lostAs?: RecoveryLoss } = {
      lane: 'change',
      sessionId: 's1',
      since: now,
      bytes: () => 1,
      ageCapped: () => true,
      retry: () => Promise.reject(refusal),
      lost: reason => {
        r.lostAs = reason;
      },
    };
    return r;
  };

  beforeEach(() => {
    jest.useFakeTimers();
    now = 1_000_000;
  });
  afterEach(() => jest.useRealTimers());

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'])(
    'keeps a write the data connection could not reach the database for (%s)',
    async code => {
      const queue = queueOf();
      const kept = write(await fromDataConnection(code));
      queue.park('w', kept);

      for (let pass = 0; pass <= RECOVERY_MAX_RECORD_FAILURES; pass++) await queue.flush();

      expect(kept.lostAs).toBeUndefined();
      expect(queue.size).toBe(1);
    },
  );

  it('gives up on a write refused with the same code by another client, as a failure of its own', async () => {
    const queue = queueOf();
    const refused = write(unreachable('ENOTFOUND'));
    queue.park('w', refused);

    for (let pass = 0; pass < RECOVERY_MAX_RECORD_FAILURES; pass++) await queue.flush();

    expect(refused.lostAs).toBe('failures');
    expect(queue.size).toBe(0);
  });
});
