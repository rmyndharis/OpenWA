export interface SequentialSendFailure<T> {
  target: T;
  error: string;
}

export interface SequentialSendResult<T> {
  sent: number;
  failures: SequentialSendFailure<T>[];
}

export interface SequentialSendOptions {
  delayMs: number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (current: number, total: number) => void;
}

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function sendSequentially<T>(
  targets: readonly T[],
  send: (target: T) => Promise<void>,
  { delayMs, sleep = wait, onProgress }: SequentialSendOptions,
): Promise<SequentialSendResult<T>> {
  const failures: SequentialSendFailure<T>[] = [];
  let sent = 0;
  for (const [index, target] of targets.entries()) {
    if (index > 0) await sleep(delayMs);
    onProgress?.(index + 1, targets.length);
    try {
      await send(target);
      sent += 1;
    } catch (err) {
      failures.push({ target, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { sent, failures };
}
