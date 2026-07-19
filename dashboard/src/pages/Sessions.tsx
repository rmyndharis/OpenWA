import { useState, useEffect, useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { Plus, QrCode, RefreshCw, Trash2, Eye, Loader2, Play, Square, Search, Filter, Skull } from 'lucide-react';
import { sessionApi, type Session } from '../services/api';
import { queryKeys } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../components/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRole } from '../hooks/useRole';
import { PageHeader } from '../components/PageHeader';
import { CustomSelect } from '../components/CustomSelect';
import { Modal } from '../components/Modal';
import './Sessions.css';

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));
  const toast = useToast();
  const { canWrite } = useRole();
  const queryClient = useQueryClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [qrData, setQrData] = useState<{ sessionId: string; sessionName: string; qrCode: string } | null>(null);
  const [pairingMode, setPairingMode] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [requestingPairing, setRequestingPairing] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [killConfirmId, setKillConfirmId] = useState<string | null>(null);

  const fetchSessions = useCallback(async (): Promise<Session[]> => {
    try {
      setLoading(true);
      const data = await sessionApi.list();
      setSessions(data);
      // Keep the shared React Query cache (read by the Dashboard via useSessionsQuery /
      // useSessionStatsQuery) in sync after this page's mutations reload local state — otherwise the
      // Dashboard shows stale session counts/status. This runs on every reload (mount / WS-failed /
      // mutation), which is harmless: the Sessions page holds no active observer on a ['sessions', …]
      // query, so invalidation only marks the shared cache stale (no refetch here, no loop) and the
      // Dashboard/other views refetch lazily on next mount. Prefix-matches every session-scoped key
      // (sessions, sessionStats, per-session groups/chats/templates).
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.create.errorDefault'));
      return [];
    } finally {
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

  const { isConnected, subscribe } = useWebSocket({
    onQRCode: useCallback((event: { sessionId: string; qrCode: string }) => {
      // Fill the open QR modal straight from the push — the REST endpoint 400s BY DESIGN until a QR
      // exists, so fetching it eagerly just spams the console with expected failures.
      setQrData(prev => (prev && prev.sessionId === event.sessionId ? { ...prev, qrCode: event.qrCode } : prev));
    }, []),
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        const prev = sessionsRef.current.find(s => s.id === event.sessionId);
        // Some engines double-signal one transition; only react to an ACTUAL status change so the toast
        // and the failed-refresh don't fire on every redundant envelope. Update the ref synchronously so
        // a duplicate arriving in the same tick (before the sync effect runs) is also caught.
        if (prev && prev.status === event.status) return;
        sessionsRef.current = sessionsRef.current.map(s =>
          s.id === event.sessionId ? { ...s, status: event.status as Session['status'] } : s,
        );
        setSessions(sessionsRef.current);
        if (event.status === 'ready') {
          toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
        } else if (event.status === 'disconnected') {
          toast.warning(t('sessions.toasts.disconnectedTitle'), t('sessions.toasts.disconnectedDesc'));
        } else if (event.status === 'failed') {
          // Refresh so the card picks up the lastError reason from the API.
          void fetchSessions();
          toast.error(t('sessions.toasts.failedTitle'), t('sessions.toasts.failedDesc'));
        }
      },
      [toast, t, fetchSessions],
    ),
  });

  // The gateway delivers events only to subscribed rooms; join the wildcard
  // session.status room so status changes for every session are received live.
  useEffect(() => {
    if (isConnected) {
      subscribe('*', ['session.status', 'session.qr']);
    }
  }, [isConnected, subscribe]);

  useEffect(() => {
    fetchSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          fetchSessions();
        }
      } catch {
        // Keep qrData alive so the polling interval keeps retrying until the QR
        // is ready. Only stop polling if the session itself has failed. 'authenticating' is included so
        // the modal (and the pairing-code panel mounted in it) survives the brief post-link handshake
        // instead of being torn down mid-pairing — it closes on the real 'ready'/'failed' transition.
        const updated = await sessionApi.get(sessionId).catch(() => null);
        const stillInitializing =
          updated && ['initializing', 'connecting', 'qr_ready', 'authenticating'].includes(updated.status);
        if (!stillInitializing) {
          setQrData(null);
          currentSessionName.current = '';
          fetchSessions();
        }
      }
    },
    [fetchSessions],
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

  const handleGeneratePairingCode = async () => {
    // Guard against a second concurrent request: the button is disabled while in flight, but the
    // input's Enter handler is not, so a rapid double-Enter would otherwise fire overlapping POSTs.
    if (requestingPairing) return;
    if (!qrData || !phoneNumber.trim()) return;
    if (!/^[0-9]{6,15}$/.test(phoneNumber.trim())) {
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

  const handleCreate = async () => {
    if (!newSessionName.trim()) return;
    try {
      setCreating(true);
      const newSession = await sessionApi.create(newSessionName);
      setSessions([...sessions, newSession]);
      setNewSessionName('');
      setShowCreateModal(false);
      toast.success(t('sessions.create.successTitle'), t('sessions.create.successDesc', { name: newSession.name }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('sessions.create.errorDefault');
      setError(msg);
      toast.error(t('sessions.create.errorTitle'), msg);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    try {
      await sessionApi.delete(id);
      setSessions(sessions.filter(s => s.id !== id));
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
    if (session && ['initializing', 'connecting', 'qr_ready'].includes(session.status)) {
      handleShowQR(id);
      return;
    }

    try {
      await sessionApi.start(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'connecting' } : s)));
      await fetchSessions();
      handleShowQR(id);
    } catch (err) {
      console.error('Failed to start:', err);
      const fresh = await fetchSessions();
      const current = fresh.find(s => s.id === id);
      if (current?.status !== 'ready') handleShowQR(id);
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

  const handleStop = async (id: string) => {
    try {
      await sessionApi.stop(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      if (qrData?.sessionId === id) setQrData(null);
    } catch (err) {
      console.error('Failed to stop:', err);
      fetchSessions();
    }
  };

  const handleForceKill = async (id: string) => {
    try {
      await sessionApi.forceKill(id);
      setSessions(sessions.map(s => (s.id === id ? { ...s, status: 'disconnected' } : s)));
      toast.success(t('sessions.forceKill.successTitle'), t('sessions.forceKill.success'));
    } catch (err) {
      console.error('Failed to force-kill:', err);
      toast.error(t('sessions.forceKill.failedTitle'), t('sessions.forceKill.failed'));
      fetchSessions();
    } finally {
      setKillConfirmId(null);
    }
  };

  const formatLastActive = (date?: string) => {
    if (!date) return t('common.never');
    const diff = Date.now() - new Date(date).getTime();
    if (diff < 60000) return t('common.justNow');
    if (diff < 3600000) return t('common.minAgo', { count: Math.floor(diff / 60000) });
    return new Date(date).toLocaleDateString();
  };

  const formatStatus = (status: string) => t(`sessionStatus.${status}`, { defaultValue: status });

  const filteredSessions = sessions.filter(s => {
    const matchesSearch =
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'active' && s.status === 'ready') ||
      (statusFilter === 'inactive' && ['created', 'idle', 'disconnected', 'failed'].includes(s.status)) ||
      (statusFilter === 'connecting' &&
        ['initializing', 'connecting', 'authenticating', 'qr_ready'].includes(s.status));
    return matchesSearch && matchesStatus;
  });

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
                disabled={
                  creating ||
                  !newSessionName.trim() ||
                  !/^[a-z0-9-]+$/.test(newSessionName) ||
                  newSessionName.length > 50 ||
                  sessions.some(s => s.name === newSessionName)
                }
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
          {newSessionName && !/^[a-z0-9-]+$/.test(newSessionName) && (
            <p className="input-error">{t('sessions.create.invalidChars')}</p>
          )}
          {newSessionName && newSessionName.length > 50 && (
            <p className="input-error">{t('sessions.create.tooLong', { length: newSessionName.length })}</p>
          )}
          {newSessionName &&
            /^[a-z0-9-]+$/.test(newSessionName) &&
            newSessionName.length <= 50 &&
            sessions.some(s => s.name === newSessionName) && (
              <p className="input-error">{t('sessions.create.duplicate')}</p>
            )}
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
                  onClick={() => {
                    setPairingMode(false);
                    setPairingError(null);
                  }}
                >
                  {t('sessions.pairing.tabQr')}
                </button>
                <button
                  role="tab"
                  aria-selected={pairingMode}
                  className={`pairing-tab-btn ${pairingMode ? 'active' : ''}`}
                  onClick={() => {
                    setPairingMode(true);
                    setPairingError(null);
                  }}
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
                      disabled={requestingPairing || !/^[0-9]{6,15}$/.test(phoneNumber.trim())}
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
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          setPairingCode(null);
                          setPhoneNumber('');
                        }}
                        style={{ width: '100%' }}
                      >
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

              {session.status === 'initializing' || session.status === 'connecting' || session.status === 'qr_ready' ? (
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
                  {session.status === 'failed' && session.lastError ? (
                    <div className="info-row session-error">
                      <span className="info-label">{t('sessions.card.error')}</span>
                      <span className="info-value error-text" title={session.lastError}>
                        {session.lastError}
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
                {canWrite &&
                (session.status === 'created' || session.status === 'idle' || session.status === 'disconnected') ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <Play size={16} />
                    {t('sessions.actions.start')}
                  </button>
                ) : canWrite && ['ready', 'initializing', 'connecting', 'qr_ready'].includes(session.status) ? (
                  <button className="btn-action" onClick={() => handleStop(session.id)}>
                    <Square size={16} />
                    {t('sessions.actions.stop')}
                  </button>
                ) : canWrite ? (
                  <button className="btn-action" onClick={() => handleStart(session.id)}>
                    <RefreshCw size={16} />
                    {t('sessions.actions.reconnect')}
                  </button>
                ) : null}
                {canWrite && (
                  <button className="btn-action danger" onClick={() => setDeleteConfirmId(session.id)}>
                    <Trash2 size={16} />
                    {t('sessions.actions.delete')}
                  </button>
                )}
                {canWrite && session.status === 'failed' && (
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
