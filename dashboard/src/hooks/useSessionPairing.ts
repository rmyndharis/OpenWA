import { useState, useEffect, useCallback, useRef } from 'react';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { sessionApi, type Session } from '../services/api';
import { isValidPairingPhone } from '../utils/sessionForm';

export interface QrData {
  sessionId: string;
  sessionName: string;
  qrCode: string;
}

export interface UseSessionPairingArgs {
  sessions: Session[];
  sessionsRef: RefObject<Session[]>;
  reloadSessions: () => Promise<Session[]>;
}

export interface SessionPairing {
  qrData: QrData | null;
  pairingMode: boolean;
  phoneNumber: string;
  pairingCode: string | null;
  requestingPairing: boolean;
  pairingError: string | null;
  setPhoneNumber: (value: string) => void;
  selectPairingTab: (mode: boolean) => void;
  handleChangeNumber: () => void;
  handleGeneratePairingCode: () => Promise<void>;
  handleShowQR: (id: string) => Promise<void>;
  handleCloseQRModal: () => void;
  applyQrPush: (event: { sessionId: string; qrCode: string }) => void;
  dismissQrForSession: (sessionId: string) => void;
}

/**
 * Owns the QR / pairing-code modal: the six state vars behind it, the poll-while-open effect, and
 * the handlers that drive it. `phoneNumber`/`pairingCode`/`pairingError` live HERE rather than in an
 * extracted panel component, because the panel renders only while `pairingMode` is true — a
 * component that unmounts on every QR<->Phone tab toggle would discard whatever the operator had
 * typed. `Sessions.test.ts` pins this exact case.
 *
 * `applyQrPush` and `dismissQrForSession` are both `useCallback(…, [])` built on the FUNCTIONAL
 * `setQrData` form: reading `qrData` directly would make each a dependency of `applySessionResponse`
 * (held by the page's stop/force-kill/unlink handlers), rotating its identity for a reason none of
 * those callers care about.
 */
export function useSessionPairing({ sessions, sessionsRef, reloadSessions }: UseSessionPairingArgs): SessionPairing {
  const { t } = useTranslation();
  const [qrData, setQrData] = useState<QrData | null>(null);
  const [pairingMode, setPairingMode] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [requestingPairing, setRequestingPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const qrRefreshInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentSessionName = useRef<string>('');

  const fetchQR = useCallback(
    async (sessionId: string) => {
      // Guard: if session is already connected, stop polling immediately. Read the ref (not `sessions`)
      // so fetchQR keeps a stable identity — otherwise the polling interval is torn down and restarted on
      // every sessions update.
      const currentSession = sessionsRef.current.find(s => s.id === sessionId);
      if (currentSession?.status === 'ready') {
        setQrData(null);
        currentSessionName.current = '';
        return;
      }
      // Poll only while a QR actually exists to refresh (qr_ready): before that the endpoint 400s
      // by design (the engine hasn't produced one), and the WS session.qr push covers first display.
      if (currentSession?.status !== 'qr_ready') return;
      try {
        const qr = await sessionApi.getQR(sessionId);
        setQrData({ sessionId, sessionName: currentSessionName.current, qrCode: qr.qrCode });
        if (qr.status === 'ready') {
          setQrData(null);
          currentSessionName.current = '';
          reloadSessions();
        }
      } catch {
        // Keep qrData alive so the polling interval keeps retrying until the QR
        // is ready. Only stop polling if the session itself has failed. 'authenticating' is included so
        // the modal (and the pairing-code panel mounted in it) survives the brief post-link handshake
        // instead of being torn down mid-pairing — it closes on the real 'ready'/'failed' transition.
        const updated = await sessionApi.get(sessionId).catch(() => null);
        const stillInitializing = updated && ['initializing', 'qr_ready', 'authenticating'].includes(updated.status);
        if (!stillInitializing) {
          setQrData(null);
          currentSessionName.current = '';
          reloadSessions();
        }
      }
    },
    [reloadSessions, sessionsRef],
  );

  useEffect(() => {
    if (qrData) {
      currentSessionName.current = qrData.sessionName;
      qrRefreshInterval.current = setInterval(() => {
        fetchQR(qrData.sessionId);
      }, 5000);
    }
    return () => {
      if (qrRefreshInterval.current) clearInterval(qrRefreshInterval.current);
    };
  }, [qrData, fetchQR]);

  const handleCloseQRModal = useCallback(() => {
    setQrData(null);
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
  }, []);

  // Shared by both pairing tabs: switching tabs always clears a stale error from the other tab.
  const selectPairingTab = useCallback((mode: boolean) => {
    setPairingMode(mode);
    setPairingError(null);
  }, []);

  const handleChangeNumber = useCallback(() => {
    setPairingCode(null);
    setPhoneNumber('');
  }, []);

  const handleGeneratePairingCode = async () => {
    // Guard against a second concurrent request: the button is disabled while in flight, but the
    // input's Enter handler is not, so a rapid double-Enter would otherwise fire overlapping POSTs.
    if (requestingPairing) return;
    if (!qrData || !phoneNumber.trim()) return;
    if (!isValidPairingPhone(phoneNumber)) {
      setPairingError(t('sessions.pairing.invalidPhone'));
      return;
    }
    try {
      setRequestingPairing(true);
      setPairingError(null);
      const res = await sessionApi.requestPairingCode(qrData.sessionId, phoneNumber.trim());
      setPairingCode(res.pairingCode);
    } catch (err) {
      setPairingError(err instanceof Error ? err.message : t('common.errorGeneric'));
    } finally {
      setRequestingPairing(false);
    }
  };

  const handleShowQR = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    // Nothing to show for an already-connected session.
    if (session?.status === 'ready') return;
    const sessionName = session?.name || '';
    // Reset any pairing sub-state from a previous open so a freshly opened modal never shows a
    // stale code/phone belonging to a different session.
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
    // Show loading state immediately so the modal opens and polling starts
    // even before Chromium has finished initializing.
    setQrData({ sessionId: id, sessionName, qrCode: '' });
    currentSessionName.current = sessionName;
    // Eager-fetch only when a QR already exists (qr_ready): before that the endpoint 400s BY DESIGN
    // (the engine hasn't produced one), and the WS session.qr push + gated 5s poll deliver it
    // without spamming the console with expected failures.
    if (session?.status === 'qr_ready') {
      try {
        const qr = await sessionApi.getQR(id);
        setQrData({ sessionId: id, sessionName, qrCode: qr.qrCode });
      } catch (err) {
        console.error('Failed to get QR:', err);
        // Do not clear qrData here — keep the loading modal open so the
        // polling interval (every 5 s) retries until the QR becomes available.
      }
    }
  };

  // Fill the open QR modal straight from the push — the REST endpoint 400s BY DESIGN until a QR
  // exists, so fetching it eagerly just spams the console with expected failures.
  const applyQrPush = useCallback((event: { sessionId: string; qrCode: string }) => {
    setQrData(prev => (prev && prev.sessionId === event.sessionId ? { ...prev, qrCode: event.qrCode } : prev));
  }, []);

  // Clear the modal when the session that owned it stops, so it never hangs on a disconnected
  // session's stale code. Functional form deliberately: reading `qrData` here would make it a
  // dependency everywhere this is held (the page's stop/force-kill/unlink handlers).
  const dismissQrForSession = useCallback((sessionId: string) => {
    setQrData(current => (current?.sessionId === sessionId ? null : current));
  }, []);

  return {
    qrData,
    pairingMode,
    phoneNumber,
    pairingCode,
    requestingPairing,
    pairingError,
    setPhoneNumber,
    selectPairingTab,
    handleChangeNumber,
    handleGeneratePairingCode,
    handleShowQR,
    handleCloseQRModal,
    applyQrPush,
    dismissQrForSession,
  };
}
