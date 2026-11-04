import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { contactApi } from '../services/api';
import { isGatewayRefusal } from '../utils/groupSelection';
import { useToast } from '../hooks/useToast';
import {
  IDLE_RUN,
  NumberCheckContext,
  batchStopMessage,
  type CheckResultItem,
  type NumberCheckContextType,
  type NumberCheckRun,
} from '../hooks/useNumberCheck';

// Mounted outside the routes and inside the signed-in tree: leaving the Number Checker page does not stop a run,
// and a logout unmounts this, which ends the run and drops its rows before another key can sign in.
export function NumberCheckProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const [run, setRun] = useState<NumberCheckRun>(IDLE_RUN);
  // Every await in a run re-checks this, so Stop, a newer run and the unmount all end a run the same way.
  const runIdRef = useRef(0);
  // Set at once, where `run.running` only changes on the next render: a second Start in the same tick is refused.
  const runningRef = useRef(false);

  useEffect(() => {
    const runRef = runIdRef;
    return () => {
      runRef.current++;
    };
  }, []);

  const update = (patch: Partial<NumberCheckRun>) => setRun(prev => ({ ...prev, ...patch }));

  const start: NumberCheckContextType['start'] = async (numbers, session, delay) => {
    if (runningRef.current || numbers.length === 0) return;
    runningRef.current = true;
    const runId = ++runIdRef.current;
    setRun({ ...IDLE_RUN, running: true, session, numbers, delay, progress: { current: 0, total: numbers.length } });

    const results: CheckResultItem[] = [];
    let refusedWith: number | undefined;

    for (let i = 0; i < numbers.length; i++) {
      if (runIdRef.current !== runId) return;

      const num = numbers[i];
      try {
        const res = await contactApi.checkNumber(session, num);
        if (runIdRef.current !== runId) return;

        const item: CheckResultItem = {
          ...res,
          status: res.exists ? 'registered' : 'unregistered',
          error: null,
          timestamp: new Date().toISOString(),
        };
        results.push(item);
        update({ results: [...results] });
      } catch (err) {
        if (runIdRef.current !== runId) return;

        const errorMsg = err instanceof Error ? err.message : t('numberChecker.toast.lookupFailed');
        results.push({
          number: num,
          exists: false,
          whatsappId: null,
          status: 'failed',
          error: errorMsg,
          timestamp: new Date().toISOString(),
        });
        update({ results: [...results] });

        // The gateway keeps refusing this route for the rest of its window, a stopped session or an unreachable
        // gateway fails every later number too, so each would only become a false "Failed" row (and spend more
        // of the limit). A 403 is the key itself being refused the route (a role, session or chat restriction),
        // which no number changes.
        const status = (err as { status?: number }).status;
        if (isGatewayRefusal(err) || status === 403) {
          // A rejected fetch carries no status: the gateway never answered.
          refusedWith = status ?? 0;
          update({ progress: { current: i + 1, total: numbers.length } });
          break;
        }
      }

      if (runIdRef.current !== runId) return;
      update({ progress: { current: i + 1, total: numbers.length } });

      if (i < numbers.length - 1 && delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay));
        if (runIdRef.current !== runId) return;
      }
    }

    if (runIdRef.current !== runId) return;
    runningRef.current = false;
    const stopped =
      refusedWith === undefined ? null : { status: refusedWith, attempted: results.length, total: numbers.length };
    update({ running: false, session: '', stopped });
    if (stopped) {
      toast.error(t('numberChecker.bulk.stoppedTitle'), batchStopMessage(t, stopped));
      return;
    }
    if (results.every(r => r.status === 'failed')) {
      toast.error(t('numberChecker.toast.checkFailed'), results[results.length - 1].error ?? undefined);
      return;
    }
    toast.success(t('numberChecker.toast.completed', { count: results.length }));
  };

  const stop = () => {
    runIdRef.current++;
    runningRef.current = false;
    update({ running: false, session: '' });
  };

  return <NumberCheckContext.Provider value={{ ...run, start, stop }}>{children}</NumberCheckContext.Provider>;
}
