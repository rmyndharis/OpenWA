import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import {
  Plus,
  QrCode,
  RefreshCw,
  Trash2,
  Eye,
  Loader2,
  Play,
  Square,
  Search,
  Filter,
  Skull,
  Unlink,
} from 'lucide-react';
import { sessionApi, type Session, type AccountRestriction } from '../services/api';
import { queryKeys } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  canForceKillSession,
  canUnlinkSession,
  classifyUnlinkError,
  isSessionStarted,
  replaceSession,
} from '../utils/sessionActions';
import { invalidateSessionQueries, reconcileSessionCache } from '../utils/sessionMutation';
import { canCreateSession, filterSessions, isValidPairingPhone, sessionNameIssues } from '../utils/sessionForm';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { useSessionPairing } from '../hooks/useSessionPairing';
import type { TFunction } from 'i18next';
import { useSessionFeed } from '../hooks/useSessionFeed';
import { useSessionCreateForm } from '../hooks/useSessionCreateForm';
import { PageHeader } from '../components/PageHeader';
import { CustomSelect } from '../components/CustomSelect';
import { Modal } from '../components/Modal';
import './Sessions.css';

/**
 * The hover title for a restriction: the engine's own cause token, plus when enforcement ends if
 * WhatsApp said. The visible label stays the translated kind — `code` is a raw upstream token
 * (`TOS_BLOCK`, `BIZ_QUALITY`) that is searchable but not readable, so it belongs in the tooltip.
 */
function restrictionTitle(restriction: AccountRestriction, t: TFunction): string {
  const parts = [t(`sessions.restriction.${restriction.kind}`), restriction.code];
  if (restriction.expiresAt) {
    parts.push(t('sessions.restriction.until', { date: new Date(restriction.expiresAt).toLocaleString() }));
  }
  return parts.join(' · ');
}

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));
  const toast = useToast();
  const { canWrite } = useRole();
  const queryClient = useQueryClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  // The full-page spinner belongs to the FIRST load only (see fetchSessions).
  const initialLoadDone = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);
  const [unlinkConfirmId, setUnlinkConfirmId] = useState<string | null>(null);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    try {
      // Background refetches — a websocket push, a mutation reloading the list — would otherwise
      // replace the whole page with a spinner for the length of a round-trip, so a restriction
      // arriving on a live page reads as a full reload.
      if (!initialLoadDone.current) setLoading(true);
      const data = await sessionApi.list();
      setSessions(data);
      // Keep the shared React Query cache (read by the Dashboard via useSessionsQuery /
      // useSessionStatsQuery) in sync after this page's mutations reload local state — otherwise the
      // Dashboard shows stale session counts/status. This runs on every reload (mount / WS-failed /
      // mutation), which is harmless: the Sessions page holds no active observer on a ['sessions', …]
      // query, so invalidation only marks the shared cache stale (no refetch here, no loop) and the
      // Dashboard/other views refetch lazily on next mount. Prefix-matches every session-scoped key
      // (sessions, sessionStats, per-session groups/chats/templates).
      void invalidateSessionQueries(queryClient, queryKeys.sessions);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.create.errorDefault'));
      return [];
    } finally {
      initialLoadDone.current = true;
      setLoading(false);
    }
  }, [t, queryClient]);

  // Mirror the latest sessions in a ref so the WS handler can compare against the current status without
  // depending on `sessions` (which would churn the callback identity and re-subscribe the socket). Kept
  // in sync with every state update (fetch / create / delete / WS) via the effect below.
  const sessionsRef = useRef<Session[]>([]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const {
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
  } = useSessionPairing({ sessions, sessionsRef, reloadSessions: fetchSessions });

  const { showCreateModal, setShowCreateModal, newSessionName, setNewSessionName, creating, handleCreate } =
    useSessionCreateForm({
      onCreated: newSession => {
        // Functional append: never capture a stale `sessions` (a WS or fetch between the await and the
        // setState would otherwise drop a row). Then invalidate the prefix so stats/groups/chats refresh.
        setSessions(current => [...current, newSession]);
        void invalidateSessionQueries(queryClient, queryKeys.sessions);
      },
      onFailed: msg => setError(msg),
    });

  // Reconcile the LOCAL view with an authoritative Session response. The previous handlers discarded
  // the response and fabricated `{ status: 'disconnected' }`, losing phone:null, timestamps, and other
  // server-owned fields; this keeps the card and the selected-session modal byte-for-byte with the
  // server. Functional updates (no captured stale `sessions`) feed both the list and the selected row,
  // and the shared cache is reconciled + invalidated so sibling views refetch. The QR modal is cleared
  // (via the pairing hook's dismisser) when the session that owned it stops, so it never hangs on a
  // disconnected session's stale code.
  const applySessionResponse = useCallback(
    async (updated: Session) => {
      sessionsRef.current = replaceSession(sessionsRef.current, updated);
      setSessions(sessionsRef.current);
      setSelectedSession(current => (current?.id === updated.id ? updated : current));
      dismissQrForSession(updated.id);
      await reconcileSessionCache(queryClient, queryKeys.sessions, updated);
    },
    [queryClient, dismissQrForSession],
  );

  useSessionFeed({
    sessions,
    sessionsRef,
    onQRCode: applyQrPush,
    // The badge renders from the server projection (`session.restriction`), and a restriction can
    // arrive with no status transition at all (the Baileys reachout timelock rides a connect
    // probe) — so the push is purely a refetch signal.
    onSessionRestriction: useCallback(() => {
      void fetchSessions();
    }, [fetchSessions]),
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        const prev = sessionsRef.current.find(s => s.id === event.sessionId);
        // Some engines double-signal one transition; only react to an ACTUAL status change so the toast
        // and the failed-refresh don't fire on every redundant envelope. Update the ref synchronously so
        // a duplicate arriving in the same tick (before the sync effect runs) is also caught.
        if (prev && prev.status === event.status) return;
        // Drop `engineLoaded` alongside the status patch: it is server-owned live state the status
        // envelope does not carry, so keeping the previous value would pair a fresh status with a
        // stale engine answer and the card could offer Start to a running session (or Unlink to one
        // with no engine). Clearing it makes isSessionStarted fall back to the status set until an
        // authoritative response arrives — and for `disconnected`, where that fallback is knowingly
        // wrong, the branch below refetches.
        sessionsRef.current = sessionsRef.current.map(s =>
          s.id === event.sessionId ? { ...s, status: event.status as Session['status'], engineLoaded: undefined } : s,
        );
        setSessions(sessionsRef.current);
        // Mark the shared session queries stale so sibling views refetch — but ONLY on a real
        // transition (the dedup guard above already swallows the redundant double-signals, so this
        // does not re-invalidate on duplicate envelopes).
        void invalidateSessionQueries(queryClient, queryKeys.sessions);
        if (event.status === 'ready') {
          toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
        } else if (event.status === 'disconnected') {
          // Refresh so the card picks up `engineLoaded` from the API. `disconnected` is the one status
          // that means two different things — an engine still registered through its automatic
          // reconnect backoff, or a session stopped with no engine at all — and only the server can
          // say which, so the offered actions must not be guessed from the status here.
          void fetchSessions();
          toast.warning(t('sessions.toasts.disconnectedTitle'), t('sessions.toasts.disconnectedDesc'));
        } else if (event.status === 'action_required') {
          // Refresh so the card picks up the lastError reason (what the operator must do) from the API.
          void fetchSessions();
          toast.warning(t('sessions.toasts.actionRequiredTitle'), t('sessions.toasts.actionRequiredDesc'));
        } else if (event.status === 'failed') {
          // Refresh so the card picks up the lastError reason from the API.
          void fetchSessions();
          toast.error(t('sessions.toasts.failedTitle'), t('sessions.toasts.failedDesc'));
        }
      },
      [toast, t, fetchSessions, queryClient],
    ),
  });

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    try {
      await sessionApi.delete(id);
      // Functional removal (no stale `sessions` capture), then invalidate the prefix.
      setSessions(current => current.filter(s => s.id !== id));
      await invalidateSessionQueries(queryClient, queryKeys.sessions);
      toast.success(
        t('sessions.delete.successTitle'),
        session
          ? t('sessions.delete.successDescNamed', { name: session.name })
          : t('sessions.delete.successDescGeneric'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.delete.errorDefault');
      console.error('Failed to delete:', err);
      toast.error(t('sessions.delete.errorTitle'), msg);
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleStart = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (session && ['initializing', 'qr_ready'].includes(session.status)) {
      handleShowQR(id);
      return;
    }

    try {
      // Use the authoritative response instead of fabricating a status. The old code wrote a local
      // `status: 'connecting'` — a value the gateway never emits — while keeping every other field
      // from before the start, which now includes `engineLoaded` and would leave the card offering
      // Start for a session that just acquired an engine.
      const started = await sessionApi.start(id);
      setSessions(current => replaceSession(current, started));
      await fetchSessions();
      handleShowQR(id);
    } catch (err) {
      console.error('Failed to start:', err);
      // A credential teardown for this name is still settling — the backend fails closed with 409 +
      // SESSION_NAME_TEARDOWN_PENDING. It is retryable, so warn with the server message and do NOT
      // open a QR modal (there is no engine to scan yet). Any other start error keeps the existing
      // authoritative reload + QR fallback behavior.
      const code = (err as { code?: string } | null | undefined)?.code;
      if (code === 'SESSION_NAME_TEARDOWN_PENDING') {
        const msg = err instanceof Error && err.message ? err.message : t('sessions.start.teardownPending');
        toast.warning(t('sessions.start.teardownPendingTitle'), msg);
        await fetchSessions();
        return;
      }
      const fresh = await fetchSessions();
      const current = fresh.find(s => s.id === id);
      if (current?.status !== 'ready') handleShowQR(id);
    }
  };

  const handleStop = async (id: string) => {
    try {
      const updated = await sessionApi.stop(id);
      await applySessionResponse(updated);
    } catch (err) {
      console.error('Failed to stop:', err);
      // The error response carries no Session body, so re-fetch the authoritative state — phone:null
      // and the real status come from the list endpoint, not the error envelope.
      await fetchSessions();
    }
  };

  const handleForceKill = async (id: string) => {
    try {
      const updated = await sessionApi.forceKill(id);
      await applySessionResponse(updated);
      toast.success(t('sessions.forceKill.successTitle'), t('sessions.forceKill.success'));
    } catch (err) {
      console.error('Failed to force-kill:', err);
      toast.error(t('sessions.forceKill.failedTitle'), t('sessions.forceKill.failed'));
      await fetchSessions();
    } finally {
      setKillConfirmId(null);
    }
  };

  const handleUnlink = async (id: string) => {
    // Guard against a second concurrent request: the button is disabled while in flight, but a
    // rapid double-click would otherwise fire overlapping logouts and race the teardown tracking.
    if (unlinkingId) return;
    setUnlinkingId(id);
    try {
      const updated = await sessionApi.logout(id);
      await applySessionResponse(updated);
      toast.success(t('sessions.unlink.successTitle'), t('sessions.unlink.success'));
    } catch (err) {
      console.error('Failed to unlink:', err);
      // The error response carries no Session body, so re-fetch authoritative state regardless of
      // how we classify the toast — phone:null/status come from the list endpoint.
      await fetchSessions();
      if (classifyUnlinkError(err) === 'incomplete') {
        // 502 + SESSION_LOGOUT_INCOMPLETE — the session stopped locally but the unlink operation is
        // incomplete. Surface the server's specific message/retry guidance as a warning, not an error.
        const msg = err instanceof Error && err.message ? err.message : t('sessions.unlink.incomplete');
        toast.warning(t('sessions.unlink.incompleteTitle'), msg);
      } else {
        // A reverse-proxy 502 (bare or JSON without the exact code) may never have reached the
        // gateway, so nothing was stopped — generic failure, not retry guidance.
        toast.error(t('sessions.unlink.failedTitle'), t('sessions.unlink.failed'));
      }
    } finally {
      setUnlinkConfirmId(null);
      setUnlinkingId(null);
    }
  };

  const formatLastActive = (date?: string | null) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  const filteredSessions = filterSessions(sessions, searchQuery, statusFilter);
  const existingSessionNames = sessions.map(s => s.name);
  // Empty is a disabled button, not a message: the form stays quiet until the user types something.
  const nameIssues = newSessionName ? sessionNameIssues(newSessionName, existingSessionNames) : [];

  if (loading) {
    return (
      <div
        className="sessions-page"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}
      >
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  return (
    <div className="sessions-page">
      <PageHeader
        title={t('sessions.title')}
        subtitle={t('sessions.subtitle')}
        actions={
          canWrite && (
            <button className="btn-primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={18} />
              {t('sessions.newSession')}
            </button>
          )
        }
      />

      <div className="filters-bar">
        <div className="search-input">
          <Search size={18} />
          <input
            type="text"
            placeholder={t('sessions.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="filter-group">
          <Filter size={16} />
          <CustomSelect
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: t('sessions.filter.all') },
              { value: 'active', label: t('sessions.filter.active') },
              { value: 'inactive', label: t('sessions.filter.inactive') },
              { value: 'connecting', label: t('sessions.filter.connecting') },
            ]}
          />
        </div>
      </div>

      {error && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.12)',
            padding: '1rem',
            borderRadius: '8px',
            color: 'var(--error)',
            marginBottom: '1rem',
          }}
        >
          {error}
        </div>
      )}

      {showCreateModal && (
        <Modal
          open
          onClose={() => setShowCreateModal(false)}
          title={t('sessions.create.title')}
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={handleCreate}
                disabled={creating || !canCreateSession(newSessionName, existingSessionNames)}
              >
                {creating ? <Loader2 className="animate-spin" size={16} /> : t('common.create')}
              </button>
            </>
          }
        >
          <label>{t('sessions.create.label')}</label>
          <input
            type="text"
            placeholder={t('sessions.create.placeholder')}
            value={newSessionName}
            onChange={e => {
              const value = e.target.value.toLowerCase().replace(/\s+/g, '-');
              setNewSessionName(value);
            }}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
          />
          <p className="input-hint">
            <Trans i18nKey="sessions.create.hint" components={{ code: <code /> }} />
          </p>
          {nameIssues.includes('format') && <p className="input-error">{t('sessions.create.invalidChars')}</p>}
          {nameIssues.includes('too-long') && (
            <p className="input-error">{t('sessions.create.tooLong', { length: newSessionName.length })}</p>
          )}
          {nameIssues.includes('duplicate') && <p className="input-error">{t('sessions.create.duplicate')}</p>}
        </Modal>
      )}

      {qrData && (
        <Modal
          open
          onClose={handleCloseQRModal}
          className="qr-modal"
          closeLabel={t('common.close')}
          title={
            <span className="modal-title">
              {pairingMode ? t('sessions.pairing.tabPhone') : t('sessions.qr.title')}
              <span className="session-name">{qrData.sessionName}</span>
            </span>
          }
        >
          <div style={{ textAlign: 'center' }}>
            {!pairingCode && (
              <div className="pairing-tabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={!pairingMode}
                  className={`pairing-tab-btn ${!pairingMode ? 'active' : ''}`}
                  onClick={() => selectPairingTab(false)}
                >
                  {t('sessions.pairing.tabQr')}
                </button>
                <button
                  role="tab"
                  aria-selected={pairingMode}
                  className={`pairing-tab-btn ${pairingMode ? 'active' : ''}`}
                  onClick={() => selectPairingTab(true)}
                >
                  {t('sessions.pairing.tabPhone')}
                </button>
              </div>
            )}

            {!pairingMode ? (
              // QR Code Content
              qrData.qrCode ? (
                <>
                  <img src={qrData.qrCode} alt="QR" style={{ maxWidth: '280px', borderRadius: '12px' }} />
                  <div className="qr-instructions">
                    <p className="qr-step">
                      <Trans i18nKey="sessions.qr.step1" components={{ strong: <strong /> }} />
                    </p>
                    <p className="qr-step">
                      <Trans i18nKey="sessions.qr.step2" components={{ strong: <strong /> }} />
                    </p>
                    <p className="qr-step">
                      <Trans i18nKey="sessions.qr.step3" components={{ strong: <strong /> }} />
                    </p>
                  </div>
                  <p className="qr-auto-refresh">
                    <RefreshCw size={14} className="spin-slow" /> {t('sessions.qr.autoRefresh')}
                  </p>
                </>
              ) : (
                <div style={{ padding: '2rem' }}>
                  <Loader2 className="animate-spin" size={48} />
                  <p>{t('sessions.qr.generating')}</p>
                </div>
              )
            ) : (
              // Pairing Code Content
              <div className="pairing-container" role="tabpanel">
                {pairingError && <div className="pairing-error">{pairingError}</div>}

                {!pairingCode ? (
                  <div className="pairing-form">
                    <label htmlFor="pairing-phone" className="pairing-label">
                      {t('sessions.pairing.phoneLabel')}
                    </label>
                    <input
                      id="pairing-phone"
                      className="pairing-input"
                      type="tel"
                      inputMode="numeric"
                      maxLength={15}
                      placeholder={t('sessions.pairing.phonePlaceholder')}
                      value={phoneNumber}
                      onChange={e => setPhoneNumber(e.target.value.replace(/\D/g, ''))}
                      onKeyDown={e => e.key === 'Enter' && handleGeneratePairingCode()}
                    />
                    <p className="input-hint" style={{ marginBottom: '1.5rem' }}>
                      {t('sessions.pairing.phoneHint')}
                    </p>
                    <button
                      className="btn-primary"
                      onClick={handleGeneratePairingCode}
                      disabled={requestingPairing || !isValidPairingPhone(phoneNumber)}
                      style={{ width: '100%', justifyContent: 'center' }}
                    >
                      {requestingPairing ? (
                        <>
                          <Loader2 className="animate-spin" size={16} />
                          <span style={{ marginLeft: '0.5rem' }}>{t('sessions.pairing.generating')}</span>
                        </>
                      ) : (
                        t('sessions.pairing.generateButton')
                      )}
                    </button>
                  </div>
                ) : (
                  <>
                    <label style={{ display: 'block', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {t('sessions.pairing.codeLabel')}
                    </label>
                    <div className="pairing-code-display">
                      {pairingCode.substring(0, 4)} - {pairingCode.substring(4)}
                    </div>

                    <div className="qr-instructions">
                      <p className="pairing-instructions-title">{t('sessions.pairing.instructions')}</p>
                      <p className="qr-step">
                        <Trans i18nKey="sessions.pairing.step1" components={{ strong: <strong /> }} />
                      </p>
                      <p className="qr-step">
                        <Trans i18nKey="sessions.pairing.step2" components={{ strong: <strong /> }} />
                      </p>
                      <p className="qr-step">
                        <Trans i18nKey="sessions.pairing.step3" components={{ strong: <strong /> }} />
                      </p>
                      <p className="qr-step">
                        <Trans i18nKey="sessions.pairing.step4" components={{ strong: <strong /> }} />
                      </p>
                    </div>

                    <div style={{ marginTop: '1.5rem' }}>
                      <button className="btn-secondary" onClick={handleChangeNumber} style={{ width: '100%' }}>
                        {t('sessions.pairing.changeNumber')}
                      </button>
                    </div>

                    <p className="qr-auto-refresh">
                      <RefreshCw size={14} className="spin-slow" /> {t('sessions.pairing.waitingConnection')}
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </Modal>
      )}

      {selectedSession && (
        <Modal
          open
          onClose={() => setSelectedSession(null)}
          title={t('sessions.details.title')}
          closeLabel={t('common.close')}
          footer={
            <button className="btn-secondary" onClick={() => setSelectedSession(null)}>
              {t('common.close')}
            </button>
          }
        >
          <div className="detail-grid">
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.name')}</span>
              <span className="detail-value">{selectedSession.name}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.status')}</span>
              <span className={`status-badge ${selectedSession.status}`}>{formatStatus(selectedSession.status)}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.sessionId')}</span>
              <span className="detail-value mono">{selectedSession.id}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.phone')}</span>
              <span className="detail-value">{selectedSession.phone || t('sessions.details.phoneNone')}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.created')}</span>
              <span className="detail-value">{new Date(selectedSession.createdAt).toLocaleString()}</span>
            </div>
            <div className="detail-item">
              <span className="detail-label">{t('sessions.details.lastActive')}</span>
              <span className="detail-value">
                {selectedSession.lastActive ? new Date(selectedSession.lastActive).toLocaleString() : t('common.never')}
              </span>
            </div>
          </div>
        </Modal>
      )}

      {deleteConfirmId && (
        <Modal
          open
          onClose={() => setDeleteConfirmId(null)}
          title={t('sessions.delete.title')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setDeleteConfirmId(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => handleDelete(deleteConfirmId)}>
                {t('common.delete')}
              </button>
            </>
          }
        >
          <p>
            <Trans
              i18nKey="sessions.delete.message"
              values={{ name: sessions.find(s => s.id === deleteConfirmId)?.name }}
              components={{ strong: <strong /> }}
            />
          </p>
          <p className="text-muted">{t('sessions.delete.warning')}</p>
        </Modal>
      )}

      {killConfirmId && (
        <Modal
          open
          onClose={() => setKillConfirmId(null)}
          title={t('sessions.forceKill.title')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setKillConfirmId(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => handleForceKill(killConfirmId)}>
                {t('sessions.forceKill.confirm')}
              </button>
            </>
          }
        >
          <p>
            <Trans
              i18nKey="sessions.forceKill.message"
              values={{ name: sessions.find(s => s.id === killConfirmId)?.name }}
              components={{ strong: <strong /> }}
            />
          </p>
          <p className="text-muted">{t('sessions.forceKill.warning')}</p>
        </Modal>
      )}

      {unlinkConfirmId && (
        <Modal
          open
          onClose={() => setUnlinkConfirmId(null)}
          title={t('sessions.unlink.title')}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setUnlinkConfirmId(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-danger"
                onClick={() => handleUnlink(unlinkConfirmId)}
                disabled={unlinkingId !== null}
              >
                {t('sessions.unlink.confirm')}
              </button>
            </>
          }
        >
          <p>
            <Trans
              i18nKey="sessions.unlink.message"
              values={{ name: sessions.find(s => s.id === unlinkConfirmId)?.name }}
              components={{ strong: <strong /> }}
            />
          </p>
          <p className="text-muted">{t('sessions.unlink.warning')}</p>
        </Modal>
      )}

      <div className="sessions-grid">
        {filteredSessions.length === 0 ? (
          <div className="empty-state">
            <QrCode size={48} />
            <h3>{t('sessions.empty.title')}</h3>
            <p>{t('sessions.empty.description')}</p>
          </div>
        ) : (
          filteredSessions.map(session => (
            <div key={session.id} className="session-card">
              <div className="card-header">
                <h3 title={session.name}>{session.name}</h3>
                <span className={`status-pill ${session.status}`}>{formatStatus(session.status)}</span>
              </div>

              {session.status === 'initializing' || session.status === 'qr_ready' ? (
                <div className="qr-placeholder">
                  <QrCode size={80} className="qr-icon" />
                  <p>{session.status === 'qr_ready' ? t('sessions.qr.scanToConnect') : t('sessions.qr.preparing')}</p>
                  <button
                    className="btn-sm"
                    onClick={() => handleShowQR(session.id)}
                    disabled={session.status !== 'qr_ready'}
                  >
                    {session.status === 'qr_ready' ? t('sessions.qr.showQr') : t('sessions.qr.loading')}
                  </button>
                </div>
              ) : (
                <div className="session-info">
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.phone')}</span>
                    <span className="info-value">{session.phone || '—'}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.sessionId')}</span>
                    <span className="info-value mono">{session.id.substring(0, 12)}</span>
                  </div>
                  <div className="info-row">
                    <span className="info-label">{t('sessions.card.lastActive')}</span>
                    <span className="info-value">{formatLastActive(session.lastActive)}</span>
                  </div>
                  {(session.status === 'failed' || session.status === 'action_required') && session.lastError ? (
                    <div className="info-row session-error">
                      <span className="info-label">{t('sessions.card.error')}</span>
                      <span className="info-value error-text" title={session.lastError}>
                        {session.lastError}
                      </span>
                    </div>
                  ) : null}
                  {/* Not gated on status, unlike the error above: a reachout timelock applies to a
                      session that is perfectly `ready`, and hiding it behind a status would make it
                      invisible exactly when the operator needs it. */}
                  {session.restriction ? (
                    <div className="info-row session-restriction">
                      <span className="info-label">{t('sessions.card.restriction')}</span>
                      <span className="info-value restriction-text" title={restrictionTitle(session.restriction, t)}>
                        {t(`sessions.restriction.${session.restriction.kind}`)}
                      </span>
                    </div>
                  ) : null}
                </div>
              )}

              <div className="card-actions">
                <button className="btn-action" onClick={() => setSelectedSession(session)}>
                  <Eye size={16} />
                  {t('sessions.actions.view')}
                </button>
                {canWrite && isSessionStarted(session) ? (
                  <button className="btn-action" onClick={() => handleStop(session.id)}>
                    <Square size={16} />
                    {t('sessions.actions.stop')}
                  </button>
                ) : canWrite && (session.status === 'created' || session.status === 'disconnected') ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <Play size={16} />
                    {t('sessions.actions.start')}
                  </button>
                ) : canWrite ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <RefreshCw size={16} />
                    {t('sessions.actions.reconnect')}
                  </button>
                ) : null}
                {canUnlinkSession(session, canWrite) && (
                  <button className="btn-action danger" onClick={() => setUnlinkConfirmId(session.id)}>
                    <Unlink size={16} />
                    {t('sessions.actions.unlink')}
                  </button>
                )}
                {canWrite && (
                  <button className="btn-action danger" onClick={() => setDeleteConfirmId(session.id)}>
                    <Trash2 size={16} />
                    {t('sessions.actions.delete')}
                  </button>
                )}
                {canForceKillSession(session, canWrite) && (
                  <button className="btn-action danger" onClick={() => setKillConfirmId(session.id)}>
                    <Skull size={16} />
                    {t('sessions.actions.killStuck')}
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
