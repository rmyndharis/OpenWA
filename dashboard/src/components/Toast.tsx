import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, XCircle, AlertCircle, Info, X } from 'lucide-react';
import './Toast.css';

type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  /** Stable, non-rendered key for de-duplicating recurring toasts. Independent of the (translated) title. */
  dedupeKey?: string;
}

// A toast id needs no cryptographic strength; crypto.randomUUID is undefined over plain HTTP on a LAN IP.
const createToastId = (): string => crypto.randomUUID?.() ?? `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// De-dupe sentinel for the "backend unreachable" toast. Kept separate from the displayed title so
// translating the title never silently breaks the de-dupe.
const CONNECTION_LOST_DEDUPE_KEY = 'connection-lost';

interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

interface ToastProviderProps {
  children: ReactNode;
}

export function ToastProvider({ children }: ToastProviderProps) {
  const { t } = useTranslation();
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = createToastId();
      const newToast = { ...toast, id };
      setToasts(prev => [...prev, newToast]);

      // Auto-remove after duration
      const duration = toast.duration ?? 4000;
      if (duration > 0) {
        setTimeout(() => removeToast(id), duration);
      }
    },
    [removeToast],
  );

  const success = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'success', title, message });
    },
    [addToast],
  );

  const error = useCallback(
    (title: string, message?: string) => {
      const isConnectionError =
        message?.toLowerCase().includes('failed to fetch') ||
        message?.toLowerCase().includes('networkerror') ||
        message?.toLowerCase().includes('http 502') ||
        message?.toLowerCase().includes('http 503') ||
        title.toLowerCase().includes('failed to fetch') ||
        title.toLowerCase().includes('networkerror');

      if (isConnectionError) {
        // De-dupe on the stable key (not the translated title) so a downed backend shows one toast.
        // The auto-dismiss timer is scheduled OUTSIDE the updater: state updaters must be
        // side-effect-free (React Strict Mode runs them twice, which would schedule two timers).
        // If this is a duplicate the id is never committed, so removeToast(id) later is a harmless no-op.
        const id = createToastId();
        setToasts(prev =>
          prev.some(t => t.dedupeKey === CONNECTION_LOST_DEDUPE_KEY)
            ? prev
            : [
                ...prev,
                {
                  id,
                  type: 'error',
                  dedupeKey: CONNECTION_LOST_DEDUPE_KEY,
                  title: t('toast.connectionLost.title'),
                  message: t('toast.connectionLost.message'),
                  duration: 6000,
                },
              ],
        );
        setTimeout(() => removeToast(id), 6000);
        return;
      }
      addToast({ type: 'error', title, message, duration: 6000 });
    },
    [addToast, removeToast, t],
  );

  const warning = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'warning', title, message });
    },
    [addToast],
  );

  const info = useCallback(
    (title: string, message?: string) => {
      addToast({ type: 'info', title, message });
    },
    [addToast],
  );

  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, success, error, warning, info }}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

const icons = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertCircle,
  info: Info,
};

interface ToastContainerProps {
  toasts: Toast[];
  removeToast: (id: string) => void;
}

function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  const { t } = useTranslation();
  return (
    // Persistent live region so screen readers announce toasts as they appear.
    <div className="toast-container" role="region" aria-live="polite" aria-atomic="false">
      {toasts.map(toast => {
        const Icon = icons[toast.type];
        return (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            role={toast.type === 'error' || toast.type === 'warning' ? 'alert' : 'status'}
          >
            <Icon className="toast-icon" size={20} />
            <div className="toast-content">
              <div className="toast-title">{toast.title}</div>
              {toast.message && <div className="toast-message">{toast.message}</div>}
            </div>
            <button className="toast-close" onClick={() => removeToast(toast.id)} aria-label={t('common.close')}>
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
