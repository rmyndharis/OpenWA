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
  dismissQrForSession: (sessionId: string, onlyIfBlank?: boolean) => void;
  clearQrCodeForSession: (sessionId: string) => void;
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
  // Bumped whenever the modal opens, closes or is dismissed. A pairing-code request is not cancelled
  // by any of those, so its answer is applied only while the modal it was sent from is still the one
  // on screen: not in a modal since opened for another session, nor in the same session's modal reset
  // to a blank form.
  const pairingGen = useRef(0);
  // QR snapshots belong to one modal visit and cannot replace a newer read or push.
  const qrVisit = useRef<{ sessionId: string | null; requested: number; applied: number }>({
    sessionId: null,
    requested: 0,
    applied: 0,
  });

  useEffect(
    () => () => {
      qrVisit.current = { sessionId: null, requested: 0, applied: 0 };
      pairingGen.current += 1;
    },
    [],
  );

  const fetchQR = useCallback(
    async (sessionId: string) => {
      const visit = qrVisit.current;
      if (visit.sessionId !== sessionId) return;
      const request = ++visit.requested;
      const isCurrent = () => qrVisit.current === visit && request >= visit.applied;
      // Guard: if session is already connected, stop polling immediately. Read the ref (not `sessions`)
      // so fetchQR keeps a stable identity — otherwise the polling interval is torn down and restarted on
      // every sessions update.
      const currentSession = sessionsRef.current.find(s => s.id === sessionId);
      if (currentSession?.status === 'ready') {
        qrVisit.current = { sessionId: null, requested: 0, applied: 0 };
        setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
        return;
      }
      // Poll only while a QR actually exists to refresh (qr_ready): before that the endpoint 400s
      // by design (the engine hasn't produced one), and the WS session.qr push covers first display.
      if (currentSession?.status !== 'qr_ready') return;
      try {
        const qr = await sessionApi.getQR(sessionId);
        if (!isCurrent()) return;
        visit.applied = request;
        setQrData(cur => (cur?.sessionId === sessionId ? { ...cur, qrCode: qr.qrCode } : cur));
        if (qr.status === 'ready') {
          qrVisit.current = { sessionId: null, requested: 0, applied: 0 };
          setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
          reloadSessions();
        }
      } catch {
        if (!isCurrent()) return;
        // Keep qrData alive so the polling interval keeps retrying until the QR
        // is ready. Only stop polling if the session itself has failed. 'authenticating' is included so
        // the modal (and the pairing-code panel mounted in it) survives the brief post-link handshake
        // instead of being torn down mid-pairing — it closes on the real 'ready'/'failed' transition.
        let updated: Session | null = null;
        try {
          updated = await sessionApi.get(sessionId);
        } catch (error) {
          // A status read that got no answer (the network, a proxy dropping it, a gateway restart) or a
          // refusal for rate or a server fault says nothing about the session: keep the modal, and a
          // half-typed phone number with it, for the next poll. Only a refusal that names the session
          // (404, 403) lets it close.
          const status = (error as { status?: number }).status;
          if (status === undefined || status === 429 || status >= 500) return;
        }
        if (!isCurrent()) return;
        visit.applied = request;
        const stillInitializing = updated && ['initializing', 'qr_ready', 'authenticating'].includes(updated.status);
        if (!stillInitializing) {
          qrVisit.current = { sessionId: null, requested: 0, applied: 0 };
          setQrData(cur => (cur?.sessionId === sessionId ? null : cur));
          reloadSessions();
        }
      }
    },
    [reloadSessions, sessionsRef],
  );

  useEffect(() => {
    if (qrData) {
      qrRefreshInterval.current = setInterval(() => {
        fetchQR(qrData.sessionId);
      }, 5000);
    }
    return () => {
      if (qrRefreshInterval.current) clearInterval(qrRefreshInterval.current);
    };
  }, [qrData, fetchQR]);

  const handleCloseQRModal = useCallback(() => {
    pairingGen.current += 1;
    qrVisit.current = { sessionId: null, requested: 0, applied: 0 };
    setRequestingPairing(false);
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
    const gen = pairingGen.current;
    try {
      setRequestingPairing(true);
      setPairingError(null);
      const res = await sessionApi.requestPairingCode(qrData.sessionId, phoneNumber.trim());
      if (gen === pairingGen.current) setPairingCode(res.pairingCode);
    } catch (err) {
      if (gen === pairingGen.current) setPairingError(err instanceof Error ? err.message : t('common.errorGeneric'));
    } finally {
      if (gen === pairingGen.current) setRequestingPairing(false);
    }
  };

  const handleShowQR = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    // Nothing to show for an already-connected session.
    if (session?.status === 'ready') return;
    const sessionName = session?.name || '';
    // Reset any pairing sub-state from a previous open so a freshly opened modal never shows a
    // stale code/phone belonging to a different session.
    pairingGen.current += 1;
    const visit = { sessionId: id, requested: 0, applied: 0 };
    qrVisit.current = visit;
    setPairingMode(false);
    setPhoneNumber('');
    setPairingCode(null);
    setPairingError(null);
    setRequestingPairing(false);
    // Show loading state immediately so the modal opens and polling starts
    // even before Chromium has finished initializing.
    setQrData({ sessionId: id, sessionName, qrCode: '' });
    // Eager-fetch only when a QR already exists (qr_ready): before that the endpoint 400s BY DESIGN
    // (the engine hasn't produced one), and the WS session.qr push + gated 5s poll deliver it
    // without spamming the console with expected failures.
    if (session?.status === 'qr_ready') {
      const request = ++visit.requested;
      try {
        const qr = await sessionApi.getQR(id);
        if (qrVisit.current !== visit || request < visit.applied) return;
        visit.applied = request;
        setQrData(cur => (cur?.sessionId === id ? { ...cur, qrCode: qr.qrCode } : cur));
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
    if (qrVisit.current.sessionId !== event.sessionId) return;
    qrVisit.current = { sessionId: event.sessionId, requested: 0, applied: 0 };
    setQrData(prev => (prev && prev.sessionId === event.sessionId ? { ...prev, qrCode: event.qrCode } : prev));
  }, []);

  // Clear the modal when the session that owned it stops, so it never hangs on a disconnected
  // session's stale code. Functional form deliberately: reading `qrData` here would make it a
  // dependency everywhere this is held (the page's stop/force-kill/unlink handlers).
  //
  // `onlyIfBlank` is for the one caller that decides asynchronously: the disconnect handler blanks
  // the code, asks the server whether an engine is still registered, and closes the modal on the
  // answer. A reconnect can complete inside that window and push a fresh code, and closing then
  // would throw away a code that works. The guard proves only that the modal is blank right now,
  // not that it is still the same modal that was blanked. That is enough: the only other way to be
  // blank is a modal still loading its first code, for a session the answer just said has no engine,
  // and closing that one is right too. A code arriving AFTER the answer is not covered, and cannot
  // be from here; the modal is gone by then and the operator reopens it from the card.
  const dismissQrForSession = useCallback((sessionId: string, onlyIfBlank = false) => {
    if (qrVisit.current.sessionId === sessionId) {
      qrVisit.current = { sessionId, requested: 0, applied: 0 };
    }
    setQrData(current => {
      if (current?.sessionId !== sessionId) return current;
      if (onlyIfBlank && current.qrCode) return current;
      pairingGen.current += 1;
      return null;
    });
  }, []);

  // Blank the displayed code while keeping the modal open, for a disconnect whose engine is still
  // registered (an engine-internal reconnect): the code on screen was minted by a connection that is
  // now gone, so scanning it cannot work. The modal falls back to its loading state, and the poll
  // fills it again once the session is back at `qr_ready` with a fresh code. A pairing code shown
  // in the modal was requested on that connection too and goes with it; the number stays, for a new
  // request once the session waits to be linked again.
  const clearQrCodeForSession = useCallback((sessionId: string) => {
    if (qrVisit.current.sessionId === sessionId) {
      qrVisit.current = { sessionId, requested: 0, applied: 0 };
      setPairingCode(null);
    }
    setQrData(current => (current?.sessionId === sessionId ? { ...current, qrCode: '' } : current));
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
    clearQrCodeForSession,
  };
}
