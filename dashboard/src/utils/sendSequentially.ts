export interface SequentialSendFailure<T> {
  target: T;
  error: string;
  status?: number;
}

export interface SequentialSendResult<T> {
  sent: number;
  failures: SequentialSendFailure<T>[];
  notAttempted: T[];
  stoppedBy?: 'abort' | 'refusal';
}

export interface SequentialSendOptions {
  delayMs: number;
  signal?: AbortSignal;
  stopOn?: (err: unknown) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (current: number, total: number) => void;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish);
  });
}

function toFailure<T>(target: T, err: unknown): SequentialSendFailure<T> {
  const status = (err as { status?: unknown } | null)?.status;
  const error = err instanceof Error ? err.message : String(err);
  return typeof status === 'number' ? { target, error, status } : { target, error };
}

export async function sendSequentially<T>(
  targets: readonly T[],
  send: (target: T) => Promise<void>,
  { delayMs, signal, stopOn, sleep = wait, onProgress }: SequentialSendOptions,
): Promise<SequentialSendResult<T>> {
  const failures: SequentialSendFailure<T>[] = [];
  let sent = 0;
  for (const [index, target] of targets.entries()) {
    if (index > 0) await sleep(delayMs, signal);
    if (signal?.aborted) return { sent, failures, notAttempted: targets.slice(index), stoppedBy: 'abort' };
    onProgress?.(index + 1, targets.length);
    try {
      await send(target);
      sent += 1;
    } catch (err) {
      failures.push(toFailure(target, err));
      if (stopOn?.(err)) return { sent, failures, notAttempted: targets.slice(index + 1), stoppedBy: 'refusal' };
    }
  }
  return { sent, failures, notAttempted: [] };
}
