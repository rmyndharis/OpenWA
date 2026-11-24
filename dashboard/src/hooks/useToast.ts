import { createContext, useContext } from 'react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  /** Stable, non-rendered key for de-duplicating recurring toasts. Independent of the (translated) title. */
  dedupeKey?: string;
}

export interface ToastActionsContextValue {
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

export interface ToastContextValue extends ToastActionsContextValue {
  toasts: Toast[];
}

export const ToastContext = createContext<ToastContextValue | null>(null);
export const ToastActionsContext = createContext<ToastActionsContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

export function useToastActions(): ToastActionsContextValue {
  const actions = useContext(ToastActionsContext);
  const full = useContext(ToastContext);
  if (actions) return actions;
  if (full) return full;
  throw new Error('useToastActions must be used within a ToastProvider');
}
