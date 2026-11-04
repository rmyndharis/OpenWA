import { createContext, useContext } from 'react';
import type { TFunction } from 'i18next';
import type { CheckNumberResponse } from '../services/api';

export type CheckStatus = 'registered' | 'unregistered' | 'failed';

export interface CheckResultItem extends CheckNumberResponse {
  status: CheckStatus;
  error?: string | null;
  avatarUrl?: string | null;
  // ISO instant of the check: the CSV carries it as is, the tables show the time of day.
  timestamp: string;
}

export interface BatchStop {
  // 0 when the lookup got no HTTP answer at all.
  status: number;
  attempted: number;
  total: number;
}

// What each stopping status means, so a single unanswered lookup is not reported as the gateway refusing.
// The check route answers 400 only for a session that is not started, the same condition as a 409.
const STOP_REASON_KEYS: Record<number, string> = {
  400: 'numberChecker.stopped.reason409',
  409: 'numberChecker.stopped.reason409',
  429: 'numberChecker.stopped.reason429',
  503: 'numberChecker.stopped.reason503',
};

// `attempted` counts the lookup that stopped the run, which is the last one sent; only the rest were never sent.
export function batchStopMessage(t: TFunction, { status, attempted, total }: BatchStop): string {
  if (status === 0) return t('numberChecker.stopped.noAnswer', { attempted, total });
  const reason = t(STOP_REASON_KEYS[status] ?? 'numberChecker.stopped.reasonOther');
  const unsent = total - attempted;
  return unsent > 0
    ? t('numberChecker.stopped.partial', { reason, status, attempted, total, count: unsent })
    : t('numberChecker.stopped.last', { reason, status });
}

export const DEFAULT_BATCH_DELAY = 1000;

// The bulk run and its rows. They live above the routes so that leaving the page neither ends the run nor drops
// the rows; the page only shows them.
export interface NumberCheckRun {
  running: boolean;
  // The session a running run is bound to, '' otherwise.
  session: string;
  // What the last run was started with, so a page opened again can show it.
  numbers: string[];
  delay: number;
  results: CheckResultItem[];
  progress: { current: number; total: number };
  stopped: BatchStop | null;
}

export const IDLE_RUN: NumberCheckRun = {
  running: false,
  session: '',
  numbers: [],
  delay: DEFAULT_BATCH_DELAY,
  results: [],
  progress: { current: 0, total: 0 },
  stopped: null,
};

export interface NumberCheckContextType extends NumberCheckRun {
  // Ignored while a run is going.
  start: (numbers: string[], session: string, delay: number) => Promise<void>;
  stop: () => void;
}

export const NumberCheckContext = createContext<NumberCheckContextType | undefined>(undefined);

export function useNumberCheck(): NumberCheckContextType {
  const context = useContext(NumberCheckContext);
  if (context === undefined) {
    throw new Error('useNumberCheck must be used within a NumberCheckProvider');
  }
  return context;
}
