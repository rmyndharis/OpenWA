import { useEffect, useRef, useState } from 'react';
import { infraApi } from '../services/api';
import { restartPollAttempts } from '../utils/restartPoll';

// One readiness request is given this long before it counts as a failed attempt and the next one is made; the
// elapsed deadline of the whole wait is still what ends it.
const READINESS_ATTEMPT_TIMEOUT_MS = 5000;
// The restart request can take a while (a first-time enable pulls an image before it answers), but not forever:
// the restarting view has no close button.
const RESTART_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// 'unknown': a proxy answered in the gateway's place (a 504, a Cloudflare 52x, or a 502 with no gateway
// code), or the restart request was given up on without an answer, so whether the restart went through
// cannot be told.
export type RestartStatus = 'idle' | 'restarting' | 'waiting' | 'success' | 'error' | 'unknown';

export interface RestartOpenRequest {
  profiles: string[];
  // The built-in profiles to stop: the restart stops each one the new config does not start.
  running: string[];
  dbSwitch: boolean;
  storageSwitch: boolean;
}

export interface RestartFlow {
  showRestartModal: boolean;
  restartCountdown: number;
  /** The countdown's starting value, the server's estimate once it answers; the progress bar's 100%. */
  restartTotal: number;
  restartStatus: RestartStatus;
  /** The server's reason when it refused the restart; shown in place of the generic error text. */
  restartError: string | null;
  /** Services the server reported it could not start or stop; the page does not reload over them. */
  restartWarnings: string[];
  pendingProfiles: string[];
  runningProfiles: string[];
  /** What Restart Now asks the server to stop: the running profiles the new config does not start. */
  profilesToRemove: string[];
  dbSwitch: boolean;
  storageSwitch: boolean;
  open: (req: RestartOpenRequest) => void;
  close: () => void;
  start: () => void;
}

/**
 * Owns the post-save restart modal: the show/countdown/status state machine, the pending/running
 * profile pair that drives `infraApi.restart(...)`, and the db/storage-switch flags the modal's
 * data-loss warning reads (#488). `open()` is the single entry point a caller (the page's save
 * `onSaved`) uses to hand over a fresh save result.
 *
 * The running set is taken from the caller on every open, not carried over from an earlier save: the
 * page reloads after each restart, so an earlier save is usually not there, and when it is, it says
 * what that save wanted rather than what is running.
 */
export function useRestartFlow(): RestartFlow {
  const [showRestartModal, setShowRestartModal] = useState(false);
  const [restartCountdown, setRestartCountdown] = useState(0);
  const [restartTotal, setRestartTotal] = useState(30);
  const [restartStatus, setRestartStatus] = useState<RestartStatus>('idle');
  const [restartError, setRestartError] = useState<string | null>(null);
  const [restartWarnings, setRestartWarnings] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<{ pending: string[]; running: string[] }>({
    pending: [],
    running: [],
  });
  // Set when the just-saved config changes the DB or storage backend vs what's running, so the restart
  // modal can warn that the new backend starts empty and offer a data backup before switching (#488).
  const [dbSwitch, setDbSwitch] = useState(false);
  const [storageSwitch, setStorageSwitch] = useState(false);

  // Every pending health-poll timeout and the countdown interval are tracked so an unmount (navigating
  // away mid-restart) cancels them instead of letting them fire setState on a dead component. The
  // trailing window.location.reload() on success is kept — a restart that already completed is meant
  // to reload the page.
  // mountedRef stops what an unmount cannot clear: a restart answer or a readiness check still in
  // flight would otherwise arm a new interval or poll after the cleanup ran, and that poll could end
  // by reloading whatever page the operator moved on to. Set in the effect body, not the initializer,
  // so StrictMode's dev unmount/remount leaves it true.
  const pollTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(false);
  const readinessControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const pollTimeouts = pollTimeoutsRef.current;
    return () => {
      mountedRef.current = false;
      readinessControllerRef.current?.abort();
      for (const handle of pollTimeouts) clearTimeout(handle);
      pollTimeouts.clear();
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    };
  }, []);

  const schedulePollTimeout = (fn: () => void, ms: number) => {
    if (!mountedRef.current) return;
    const handle = setTimeout(() => {
      pollTimeoutsRef.current.delete(handle);
      fn();
    }, ms);
    pollTimeoutsRef.current.add(handle);
  };

  const stopCountdown = () => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  };

  const open = ({
    profiles: pending,
    running,
    dbSwitch: nextDbSwitch,
    storageSwitch: nextStorageSwitch,
  }: RestartOpenRequest) => {
    setProfiles({ pending, running });
    setDbSwitch(nextDbSwitch);
    setStorageSwitch(nextStorageSwitch);
    setShowRestartModal(true);
  };

  // Dismissal is only offered in the idle state — while a restart is running there is deliberately
  // no way to close the progress view. Shared by the modal's onClose and the "Later" button; both
  // only ever fire while idle, since "Later" is rendered exclusively inside the idle branch.
  const close = () => {
    if (restartStatus === 'idle') setShowRestartModal(false);
  };

  const checkServerHealth = (estimatedTime: number | undefined, hasWarnings: boolean, controller: AbortController) => {
    let attempts = 0;
    const maxAttempts = restartPollAttempts(estimatedTime);
    const isCurrent = () =>
      mountedRef.current && readinessControllerRef.current === controller && !controller.signal.aborted;
    const settle = (status: 'success' | 'error') => {
      if (!isCurrent()) return false;
      controller.abort();
      clearTimeout(deadline);
      pollTimeoutsRef.current.delete(deadline);
      stopCountdown();
      setRestartCountdown(0);
      setRestartStatus(status);
      return true;
    };
    // Elapsed time also bounds a request or response body that never finishes.
    const deadline = setTimeout(() => settle('error'), maxAttempts * 1000);
    pollTimeoutsRef.current.add(deadline);

    const check = async () => {
      if (!isCurrent()) return;
      // Each attempt has its own signal, so one that hangs is given up on and counted, and the wait goes on.
      const attempt = new AbortController();
      const abortAttempt = () => attempt.abort();
      controller.signal.addEventListener('abort', abortAttempt, { once: true });
      const timer = setTimeout(abortAttempt, READINESS_ATTEMPT_TIMEOUT_MS);
      pollTimeoutsRef.current.add(timer);
      try {
        await infraApi.healthCheck(attempt.signal);
        if (!settle('success')) return;
        // With warnings on screen the operator reloads by hand, after reading them.
        if (!hasWarnings) {
          schedulePollTimeout(() => {
            if (readinessControllerRef.current === controller) window.location.reload();
          }, 2000);
        }
      } catch {
        if (!isCurrent()) return;
        attempts++;
        if (attempts < maxAttempts) schedulePollTimeout(check, 1000);
        else settle('error');
      } finally {
        clearTimeout(timer);
        pollTimeoutsRef.current.delete(timer);
        controller.signal.removeEventListener('abort', abortAttempt);
      }
    };

    schedulePollTimeout(check, 3000);
  };

  const profilesToRemove = profiles.running.filter(p => !profiles.pending.includes(p));

  const start = async () => {
    readinessControllerRef.current?.abort();
    const controller = new AbortController();
    readinessControllerRef.current = controller;
    const isCurrent = () =>
      mountedRef.current && readinessControllerRef.current === controller && !controller.signal.aborted;
    for (const handle of pollTimeoutsRef.current) clearTimeout(handle);
    pollTimeoutsRef.current.clear();
    stopCountdown();
    setRestartStatus('restarting');
    setRestartCountdown(30);
    setRestartTotal(30);

    // Kept outside the try: the poll deadline is derived from it, and the restart call is expected to
    // fail sometimes (the server may go down before it answers).
    let estimatedTime: number | undefined;
    let warnings: string[] = [];
    const request = new AbortController();
    const abortRequest = () => request.abort();
    controller.signal.addEventListener('abort', abortRequest, { once: true });
    const requestTimer = setTimeout(abortRequest, RESTART_REQUEST_TIMEOUT_MS);
    pollTimeoutsRef.current.add(requestTimer);
    try {
      const response = await infraApi.restart(profiles.pending, profilesToRemove, request.signal);
      if (!isCurrent()) return;
      estimatedTime = response.estimatedTime;
      if (response.estimatedTime) {
        setRestartCountdown(response.estimatedTime);
        setRestartTotal(response.estimatedTime);
      }
      warnings = [...(response.orchestration?.errors ?? []), ...(response.removal?.errors ?? [])];
      setRestartWarnings(warnings);
    } catch (err) {
      if (!isCurrent()) return;
      // Given up on after its bound: the server awaits its container work before it answers and shuts down, so it
      // may still restart. Not a failure, and not something the poll below could settle: the old process answers.
      if (request.signal.aborted) {
        stopCountdown();
        setRestartCountdown(0);
        setRestartStatus('unknown');
        return;
      }
      // An HTTP status (a proxy 503 included) means no shutdown was confirmed and the old
      // process may still be serving, so a readiness poll would report a restart that never happened.
      // Only a status-less network failure is the expected sign of the server going down mid-answer.
      const failure = err as { status?: unknown; code?: unknown } | null;
      if (typeof failure?.status === 'number') {
        stopCountdown();
        setRestartCountdown(0);
        // A 502, a 504 or a Cloudflare 520-527 the gateway did not stamp with a code is a proxy answering in
        // the gateway's place: a timeout, or an upstream connection that failed or dropped. The client cannot
        // tell which, and the request may still be running (a first-time enable pulls an image before the
        // restart), so this is neither a refusal nor something a readiness poll can settle: the old process
        // answers.
        const { status } = failure;
        if (failure.code === undefined && (status === 502 || status === 504 || (status >= 520 && status <= 527))) {
          setRestartStatus('unknown');
          return;
        }
        setRestartError(err instanceof Error ? err.message : String(err));
        setRestartStatus('error');
        return;
      }
    } finally {
      clearTimeout(requestTimer);
      pollTimeoutsRef.current.delete(requestTimer);
      controller.signal.removeEventListener('abort', abortRequest);
    }
    if (!isCurrent()) return;

    setRestartStatus('waiting');
    stopCountdown();
    countdownIntervalRef.current = setInterval(() => {
      setRestartCountdown(prev => {
        if (prev <= 1) {
          stopCountdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    checkServerHealth(estimatedTime, warnings.length > 0, controller);
  };

  return {
    showRestartModal,
    restartCountdown,
    restartTotal,
    restartStatus,
    restartError,
    restartWarnings,
    pendingProfiles: profiles.pending,
    runningProfiles: profiles.running,
    profilesToRemove,
    dbSwitch,
    storageSwitch,
    open,
    close,
    start,
  };
}
