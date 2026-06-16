import { useState, useEffect, useCallback, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Plus, QrCode, ArrowClockwise, Trash, Eye, CircleNotch, Play, Stop, MagnifyingGlass, WarningCircle } from '@phosphor-icons/react';
import { sessionApi, type Session } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../components/Toast';
import { useWebSocket } from '../hooks/useWebSocket';
import { useRole } from '../hooks/useRole';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '../lib/utils';

const statusColors: Record<string, string> = {
  created: 'bg-teal-500/10 text-teal-600',
  idle: 'bg-violet-500/10 text-violet-600',
  initializing: 'bg-amber-500/10 text-amber-600',
  connecting: 'bg-amber-500/10 text-amber-600',
  qr_ready: 'bg-blue-500/10 text-blue-600',
  authenticating: 'bg-purple-500/10 text-purple-600',
  ready: 'bg-whatsapp-green/10 text-whatsapp-green',
  disconnected: 'bg-orange-500/10 text-orange-600',
  failed: 'bg-red-500/10 text-red-600',
};

export function Sessions() {
  const { t } = useTranslation();
  useDocumentTitle(t('sessions.title'));
  const toast = useToast();
  const { canWrite } = useRole();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');
  const [creating, setCreating] = useState(false);
  const [qrData, setQrData] = useState<{ sessionId: string; sessionName: string; qrCode: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const fetchSessions = useCallback(async () => {
    try {
      setLoading(true);
      const data = await sessionApi.list();
      setSessions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('sessions.create.errorDefault'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const { isConnected, subscribe } = useWebSocket({
    onSessionStatus: useCallback(
      (event: { sessionId: string; status: string }) => {
        setSessions(prev =>
          prev.map(s => (s.id === event.sessionId ? { ...s, status: event.status as Session['status'] } : s)),
        );
        if (event.status === 'ready') {
          toast.success(t('sessions.toasts.readyTitle'), t('sessions.toasts.readyDesc'));
        } else if (event.status === 'disconnected') {
          toast.warning(t('sessions.toasts.disconnectedTitle'), t('sessions.toasts.disconnectedDesc'));
        } else if (event.status === 'failed') {
          void fetchSessions();
          toast.error(t('sessions.toasts.failedTitle'), t('sessions.toasts.failedDesc'));
        }
      },
      [toast, t, fetchSessions],
    ),
  });

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

  const fetchQR = useCallback(async (sessionId: string) => {
    try {
      const qr = await sessionApi.getQR(sessionId);
      setQrData({ sessionId, sessionName: currentSessionName.current, qrCode: qr.qrCode });
      if (qr.status === 'ready') {
        setQrData(null);
        currentSessionName.current = '';
        fetchSessions();
      }
    } catch {
      const currentSession = await sessionApi.get(sessionId).catch(() => null);
      const stillInitializing = currentSession &&
        ['initializing', 'connecting', 'qr_ready', 'authenticating'].includes(currentSession.status);
      if (!stillInitializing) {
        setQrData(null);
        currentSessionName.current = '';
        fetchSessions();
      }
    }
  }, []);

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
        session ? t('sessions.delete.successDescNamed', { name: session.name }) : t('sessions.delete.successDescGeneric'),
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
      await fetchSessions();
      if (err instanceof Error && err.message.includes('already started')) {
        handleShowQR(id);
      }
    }
  };

  const handleShowQR = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    const sessionName = session?.name || '';
    setQrData({ sessionId: id, sessionName, qrCode: '' });
    currentSessionName.current = sessionName;
    try {
      const qr = await sessionApi.getQR(id);
      setQrData({ sessionId: id, sessionName, qrCode: qr.qrCode });
    } catch (err) {
      console.error('Failed to get QR:', err);
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
      (statusFilter === 'inactive' && ['created', 'idle', 'disconnected'].includes(s.status)) ||
      (statusFilter === 'connecting' && ['initializing', 'connecting', 'qr_ready', 'authenticating'].includes(s.status));
    return matchesSearch && matchesStatus;
  });

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <CircleNotch size={32} className="animate-spin text-whatsapp-green" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="p-4 sm:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t('sessions.title')}</h1>
            <p className="text-muted-foreground mt-1">{t('sessions.subtitle')}</p>
          </div>
          {canWrite && (
            <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={() => setShowCreateModal(true)}>
              <Plus size={16} weight="bold" />
              {t('sessions.newSession')}
            </Button>
          )}
        </header>

        <div className="flex items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              type="text"
              placeholder={t('sessions.searchPlaceholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="bg-muted border-0 rounded-lg pl-9"
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('sessions.filter.all')}</SelectItem>
              <SelectItem value="active">{t('sessions.filter.active')}</SelectItem>
              <SelectItem value="inactive">{t('sessions.filter.inactive')}</SelectItem>
              <SelectItem value="connecting">{t('sessions.filter.connecting')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error && (
          <div className="flex items-center gap-2 bg-destructive/10 text-destructive px-4 py-3 rounded-lg text-sm">
            <WarningCircle size={18} weight="fill" />
            {error}
          </div>
        )}

        {filteredSessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <QrCode size={64} weight="thin" />
            <h3 className="font-bold text-foreground text-sm">{t('sessions.empty.title')}</h3>
            <p className="text-sm">{t('sessions.empty.description')}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filteredSessions.map((session, idx) => (
              <div key={session.id} className={cn(
                "px-3 py-[10px] hover:bg-muted/50 transition-colors",
                idx < filteredSessions.length - 1 && "border-b border-border"
              )}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={cn(
                      "w-9 h-9 rounded-full flex items-center justify-center shrink-0",
                      session.status === 'ready' ? 'bg-whatsapp-green/10' : 'bg-muted'
                    )}>
                      <QrCode size={18} className={session.status === 'ready' ? 'text-whatsapp-green' : 'text-muted-foreground'} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-foreground truncate">{session.name}</span>
                        <Badge className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium border-0", statusColors[session.status] || 'bg-muted text-muted-foreground')}>
                          {formatStatus(session.status)}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                        <span>{session.phone || '—'}</span>
                        <span className="font-mono">{session.id.substring(0, 12)}...</span>
                        <span>{t('sessions.card.lastActive')}: {formatLastActive(session.lastActive)}</span>
                      </div>
                      {session.status === 'failed' && session.lastError && (
                        <p className="text-xs text-destructive mt-0.5 truncate" title={session.lastError}>
                          {session.lastError}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setSelectedSession(session)}
                      className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                    >
                      <Eye size={14} />
                      {t('sessions.actions.view')}
                    </button>
                    {canWrite && (
                      ['created', 'idle', 'disconnected'].includes(session.status) ? (
                        <button
                          onClick={() => handleStart(session.id)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-whatsapp-green hover:bg-whatsapp-green/10 transition-colors"
                        >
                          <Play size={14} weight="fill" />
                          {t('sessions.actions.start')}
                        </button>
                      ) : ['ready', 'initializing', 'connecting', 'qr_ready', 'authenticating'].includes(session.status) ? (
                        <button
                          onClick={() => handleStop(session.id)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-destructive hover:bg-destructive/10 transition-colors"
                        >
                          <Stop size={14} weight="fill" />
                          {t('sessions.actions.stop')}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleStart(session.id)}
                          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                        >
                          <ArrowClockwise size={14} />
                          {t('sessions.actions.reconnect')}
                        </button>
                      )
                    )}
                    {canWrite && (
                      <button
                        onClick={() => setDeleteConfirmId(session.id)}
                        className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <Trash size={14} />
                        {t('sessions.actions.delete')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Create Modal */}
        <Dialog open={showCreateModal} onOpenChange={v => { if (!v) setShowCreateModal(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('sessions.create.title')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-muted-foreground">{t('sessions.create.label')}</label>
                <Input
                  type="text"
                  placeholder={t('sessions.create.placeholder')}
                  value={newSessionName}
                  onChange={e => {
                    const value = e.target.value.toLowerCase().replace(/\s+/g, '-');
                    setNewSessionName(value);
                  }}
                  onKeyDown={e => e.key === 'Enter' && handleCreate()}
                  className="bg-muted border-0 rounded-lg"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  <Trans i18nKey="sessions.create.hint" components={{ code: <code className="bg-muted px-1 rounded text-[10px] font-mono" /> }} />
                </p>
                {newSessionName && !/^[a-z0-9-]+$/.test(newSessionName) && (
                  <p className="text-xs text-destructive font-medium">{t('sessions.create.invalidChars')}</p>
                )}
                {newSessionName && newSessionName.length > 50 && (
                  <p className="text-xs text-destructive font-medium">{t('sessions.create.tooLong', { length: newSessionName.length })}</p>
                )}
                {newSessionName &&
                  /^[a-z0-9-]+$/.test(newSessionName) &&
                  newSessionName.length <= 50 &&
                  sessions.some(s => s.name === newSessionName) && (
                  <p className="text-xs text-destructive font-medium">{t('sessions.create.duplicate')}</p>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" className="rounded-lg" onClick={() => setShowCreateModal(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg"
                onClick={handleCreate}
                disabled={
                  creating ||
                  !newSessionName.trim() ||
                  !/^[a-z0-9-]+$/.test(newSessionName) ||
                  newSessionName.length > 50 ||
                  sessions.some(s => s.name === newSessionName)
                }
              >
                {creating ? <CircleNotch size={16} className="animate-spin" /> : t('common.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* QR Modal */}
        <Dialog open={!!qrData} onOpenChange={v => { if (!v) setQrData(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('sessions.qr.title')}</DialogTitle>
              {qrData && <p className="text-sm text-muted-foreground">{qrData.sessionName}</p>}
            </DialogHeader>
            <div className="flex flex-col items-center gap-4">
              {qrData?.qrCode ? (
                <>
                  <img src={qrData.qrCode} alt="QR" className="max-w-[280px] rounded-lg" />
                  <div className="w-full bg-muted rounded-lg p-3 flex flex-col gap-2 text-sm">
                    <p className="text-muted-foreground"><Trans i18nKey="sessions.qr.step1" components={{ strong: <strong className="text-foreground" /> }} /></p>
                    <p className="text-muted-foreground"><Trans i18nKey="sessions.qr.step2" components={{ strong: <strong className="text-foreground" /> }} /></p>
                    <p className="text-muted-foreground"><Trans i18nKey="sessions.qr.step3" components={{ strong: <strong className="text-foreground" /> }} /></p>
                  </div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ArrowClockwise size={14} className="animate-spin" />
                    {t('sessions.qr.autoRefresh')}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center gap-3 py-8">
                  <CircleNotch size={48} className="animate-spin text-whatsapp-green" />
                  <p className="text-sm text-muted-foreground">{t('sessions.qr.generating')}</p>
                </div>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {/* Details Modal */}
        <Dialog open={!!selectedSession} onOpenChange={v => { if (!v) setSelectedSession(null); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('sessions.details.title')}</DialogTitle>
            </DialogHeader>
            {selectedSession && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('sessions.details.name')}</span>
                  <span className="text-sm text-foreground font-medium">{selectedSession.name}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('sessions.details.status')}</span>
                  <Badge className={cn("w-fit text-[10px] px-1.5 py-0.5 rounded font-medium border-0", statusColors[selectedSession.status] || 'bg-muted text-muted-foreground')}>
                    {formatStatus(selectedSession.status)}
                  </Badge>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('sessions.details.sessionId')}</span>
                  <code className="text-sm text-foreground bg-muted px-2 py-1 rounded font-mono">{selectedSession.id}</code>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('sessions.details.phone')}</span>
                  <span className="text-sm text-foreground">{selectedSession.phone || t('sessions.details.phoneNone')}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('sessions.details.created')}</span>
                  <span className="text-sm text-foreground">{new Date(selectedSession.createdAt).toLocaleString()}</span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('sessions.details.lastActive')}</span>
                  <span className="text-sm text-foreground">
                    {selectedSession.lastActive ? new Date(selectedSession.lastActive).toLocaleString() : t('common.never')}
                  </span>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" className="rounded-lg" onClick={() => setSelectedSession(null)}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete Confirm Modal */}
        <Dialog open={!!deleteConfirmId} onOpenChange={v => { if (!v) setDeleteConfirmId(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('sessions.delete.title')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-foreground">
                <Trans
                  i18nKey="sessions.delete.message"
                  values={{ name: sessions.find(s => s.id === deleteConfirmId)?.name }}
                  components={{ strong: <strong /> }}
                />
              </p>
              <p className="text-xs text-muted-foreground">{t('sessions.delete.warning')}</p>
            </div>
            <DialogFooter>
              <Button variant="outline" className="rounded-lg" onClick={() => setDeleteConfirmId(null)}>
                {t('common.cancel')}
              </Button>
              <Button variant="destructive" className="rounded-lg" onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}>
                {t('common.delete')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
