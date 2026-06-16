import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  PencilSimple,
  Trash,
  Play,
  CircleNotch,
  WarningCircle,
  WebhooksLogo,
} from '@phosphor-icons/react';
import { webhookApi, type Webhook } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import {
  useWebhooksQuery,
  useSessionsQuery,
  useCreateWebhookMutation,
  useUpdateWebhookMutation,
  useDeleteWebhookMutation,
} from '../hooks/queries';
import { useToast } from '../components/Toast';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '../lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const availableEventNames = [
  'message.received',
  'message.sent',
  'message.ack',
  'message.failed',
  'message.revoked',
  'session.status',
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'group.join',
  'group.leave',
  'group.update',
  '*',
] as const;

const eventColors: Record<string, string> = {
  'message.received': 'bg-blue-500/10 text-blue-500',
  'message.sent': 'bg-whatsapp-green/10 text-whatsapp-green',
  'message.ack': 'bg-cyan-500/10 text-cyan-500',
  'message.failed': 'bg-destructive/10 text-destructive',
  'message.revoked': 'bg-orange-500/10 text-orange-500',
  'session.status': 'bg-purple-500/10 text-purple-500',
  'session.qr': 'bg-pink-500/10 text-pink-500',
  'session.authenticated': 'bg-emerald-500/10 text-emerald-500',
  'session.disconnected': 'bg-rose-500/10 text-rose-500',
  'group.join': 'bg-sky-500/10 text-sky-500',
  'group.leave': 'bg-orange-500/10 text-orange-500',
  'group.update': 'bg-teal-500/10 text-teal-500',
  '*': 'bg-muted text-muted-foreground',
};

export function Webhooks() {
  const { t } = useTranslation();
  useDocumentTitle(t('webhooks.title'));
  const { canWrite } = useRole();
  const { data: webhooks = [], isLoading: loadingWebhooks } = useWebhooksQuery();
  const { data: sessions = [] } = useSessionsQuery();
  const loading = loadingWebhooks;
  const createMutation = useCreateWebhookMutation();
  const updateMutation = useUpdateWebhookMutation();
  const deleteMutation = useDeleteWebhookMutation();
  const toast = useToast();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; id: string; url: string } | null>(null);
  const [editWebhook, setEditWebhook] = useState<Webhook | null>(null);
  const [newWebhook, setNewWebhook] = useState({ url: '', events: ['message.received'], sessionId: '' });
  const [testingId, setTestingId] = useState<string | null>(null);

  const eventDescription = (name: string) => {
    if (name === '*') return t('webhooks.eventDescriptions.all');
    return t(`webhooks.eventDescriptions.${name}`, { defaultValue: name });
  };

  const handleCreate = async () => {
    if (!newWebhook.url || !newWebhook.sessionId) return;
    try {
      await createMutation.mutateAsync({
        sessionId: newWebhook.sessionId,
        url: newWebhook.url,
        events: newWebhook.events,
      });
      setShowCreateModal(false);
      setNewWebhook({ url: '', events: ['message.received'], sessionId: '' });
      toast.success(t('webhooks.toasts.created'));
    } catch (err) {
      toast.error(t('webhooks.toasts.createFailed', { message: err instanceof Error ? err.message : t('common.unknownError') }));
    }
  };

  const confirmDelete = (sessionId: string, id: string, url: string) => {
    setDeleteTarget({ sessionId, id, url });
    setShowDeleteModal(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteMutation.mutateAsync({ sessionId: deleteTarget.sessionId, id: deleteTarget.id });
      setShowDeleteModal(false);
      setDeleteTarget(null);
      toast.success(t('webhooks.toasts.deleted'));
    } catch (err) {
      toast.error(t('webhooks.toasts.deleteFailed', { message: err instanceof Error ? err.message : t('common.unknownError') }));
    }
  };

  const handleTest = async (sessionId: string, id: string) => {
    setTestingId(id);
    try {
      const result = await webhookApi.test(sessionId, id);
      if (result.success) {
        toast.success(t('webhooks.toasts.testOk', { status: result.statusCode }));
      } else {
        toast.error(t('webhooks.toasts.testFailed', { message: result.error || `Status ${result.statusCode}` }));
      }
    } catch (err) {
      toast.error(t('webhooks.toasts.testError', { message: err instanceof Error ? err.message : t('common.unknownError') }));
    } finally {
      setTestingId(null);
    }
  };

  const openEdit = (webhook: Webhook) => {
    setEditWebhook({ ...webhook });
    setShowEditModal(true);
  };

  const handleEdit = async () => {
    if (!editWebhook) return;
    try {
      await updateMutation.mutateAsync({
        sessionId: editWebhook.sessionId,
        id: editWebhook.id,
        data: { url: editWebhook.url, events: editWebhook.events, active: editWebhook.active },
      });
      setShowEditModal(false);
      setEditWebhook(null);
      toast.success(t('webhooks.toasts.updated'));
    } catch (err) {
      toast.error(t('webhooks.toasts.updateFailed', { message: err instanceof Error ? err.message : t('common.unknownError') }));
    }
  };

  const toggleEditEvent = (event: string) => {
    if (!editWebhook) return;
    setEditWebhook({
      ...editWebhook,
      events: editWebhook.events.includes(event)
        ? editWebhook.events.filter(e => e !== event)
        : [...editWebhook.events, event],
    });
  };

  const toggleNewEvent = (event: string) => {
    setNewWebhook(prev => ({
      ...prev,
      events: prev.events.includes(event) ? prev.events.filter(e => e !== event) : [...prev.events, event],
    }));
  };

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
            <h1 className="text-3xl font-bold tracking-tight">{t('webhooks.title')}</h1>
            <p className="text-muted-foreground mt-1">{t('webhooks.subtitle')}</p>
          </div>
          {canWrite && (
            <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={() => setShowCreateModal(true)}>
              <Plus size={16} weight="bold" />
              {t('webhooks.addWebhook')}
            </Button>
          )}
        </header>

        {webhooks.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
            <WebhooksLogo size={64} weight="thin" />
            <h3 className="font-bold text-foreground text-sm">{t('webhooks.empty.title')}</h3>
            <p className="text-sm">{t('webhooks.empty.description')}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {webhooks.map((webhook, idx) => {
              const sessionName = sessions.find(s => s.id === webhook.sessionId)?.name || webhook.sessionId.substring(0, 12);
              return (
                <div key={webhook.id} className={cn(
                  "px-3 py-[10px] hover:bg-muted/50 transition-colors",
                  idx < webhooks.length - 1 && "border-b border-border"
                )}>
                  <div className="flex items-start justify-between gap-3">
                    <code className="text-sm font-mono text-foreground break-all flex-1 min-w-0">{webhook.url}</code>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="icon-sm"
                        onClick={() => handleTest(webhook.sessionId, webhook.id)}
                        disabled={testingId === webhook.id}
                        title={t('webhooks.actions.test')}>
                        {testingId === webhook.id ? <CircleNotch size={14} className="animate-spin" /> : <Play size={14} />}
                      </Button>
                      {canWrite && (
                        <>
                          <Button variant="ghost" size="icon-sm"
                            onClick={() => openEdit(webhook)}
                            title={t('webhooks.actions.edit')}>
                            <PencilSimple size={14} />
                          </Button>
                          <Button variant="ghost" size="icon-sm"
                            onClick={() => confirmDelete(webhook.sessionId, webhook.id, webhook.url)}
                            title={t('webhooks.actions.delete')}>
                            <Trash size={14} />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-1.5">
                    <span>{t('webhooks.columns.session')}: <span className="font-medium text-foreground">{sessionName}</span></span>
                    <span>{t('webhooks.columns.status')}:
                      <Badge className={cn(
                        "ml-1 text-[10px] font-bold uppercase border-none",
                        webhook.active ? 'bg-whatsapp-green/10 text-whatsapp-green' : 'bg-muted text-muted-foreground'
                      )}>
                        {webhook.active ? t('common.active') : t('common.inactive')}
                      </Badge>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {webhook.events.map((event: string) => (
                      <span key={event} className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", eventColors[event] || 'bg-muted text-muted-foreground')}>
                        {event}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('webhooks.available')}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {availableEventNames.map(name => (
              <div key={name} className="flex items-center gap-2">
                <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0", eventColors[name] || 'bg-muted text-muted-foreground')}>{name}</span>
                <span className="text-xs text-muted-foreground">{eventDescription(name)}</span>
              </div>
            ))}
          </div>
        </div>

        <Dialog open={showCreateModal} onOpenChange={v => { if (!v) setShowCreateModal(false); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('webhooks.createTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-muted-foreground">{t('webhooks.session')}</label>
                <Select value={newWebhook.sessionId}
                  onValueChange={v => setNewWebhook({ ...newWebhook, sessionId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={t('webhooks.selectSession')} />
                  </SelectTrigger>
                  <SelectContent>
                    {sessions.map(s => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-muted-foreground">{t('common.url')}</label>
                <Input type="url" placeholder="https://..." value={newWebhook.url}
                  onChange={e => setNewWebhook({ ...newWebhook, url: e.target.value })}
                  className="bg-muted border-none rounded-lg" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-bold text-muted-foreground">{t('webhooks.events')}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {availableEventNames.map(name => (
                      <button key={name} type="button"
                        onClick={() => toggleNewEvent(name)}
                        className={cn(
                          "text-xs px-2 py-1 rounded transition-all font-medium",
                          newWebhook.events.includes(name)
                            ? eventColors[name] || 'bg-whatsapp-green/10 text-whatsapp-green'
                            : (eventColors[name] || 'bg-muted text-muted-foreground') + ' opacity-40 hover:opacity-100'
                        )}>
                        {name}
                      </button>
                    ))}
                  </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setShowCreateModal(false)} className="rounded-lg">{t('common.cancel')}</Button>
              <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={handleCreate}>
                {t('common.create')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showEditModal} onOpenChange={v => { if (!v) { setShowEditModal(false); setEditWebhook(null); } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{t('webhooks.editTitle')}</DialogTitle>
            </DialogHeader>
            {editWebhook && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground">{t('common.url')}</label>
                  <Input type="url" value={editWebhook.url}
                    onChange={e => setEditWebhook({ ...editWebhook, url: e.target.value })}
                    className="bg-muted border-none rounded-lg" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground">{t('webhooks.events')}</label>
                  <div className="flex flex-wrap gap-1.5">
                    {availableEventNames.map(name => (
                      <button key={name} type="button"
                        onClick={() => toggleEditEvent(name)}
                        className={cn(
                          "text-xs px-2 py-1 rounded transition-all font-medium",
                          editWebhook.events.includes(name)
                            ? eventColors[name] || 'bg-whatsapp-green/10 text-whatsapp-green'
                            : (eventColors[name] || 'bg-muted text-muted-foreground') + ' opacity-40 hover:opacity-100'
                        )}>
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs font-bold text-muted-foreground">{t('common.status')}</span>
                  </div>
                  <label className="relative inline-flex h-5 w-9 cursor-pointer items-center">
                    <input type="checkbox" className="peer sr-only" checked={editWebhook.active}
                      onChange={e => setEditWebhook({ ...editWebhook, active: e.target.checked })} />
                    <span className="absolute inset-0 rounded-full bg-muted-foreground/30 transition-colors peer-checked:bg-whatsapp-green" />
                    <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                  </label>
                </div>
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => { setShowEditModal(false); setEditWebhook(null); }} className="rounded-lg">{t('common.cancel')}</Button>
              <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={handleEdit}>
                {t('webhooks.saveChanges')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showDeleteModal} onOpenChange={v => { if (!v) { setShowDeleteModal(false); setDeleteTarget(null); } }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('webhooks.deleteTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <WarningCircle size={48} className="text-destructive" weight="fill" />
              <p className="text-sm text-muted-foreground text-center">{t('webhooks.deleteConfirm')}</p>
              {deleteTarget && (
                <code className="w-full p-3 bg-muted rounded-lg text-xs break-all">{deleteTarget.url}</code>
              )}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => { setShowDeleteModal(false); setDeleteTarget(null); }} className="rounded-lg">{t('common.cancel')}</Button>
              <Button variant="destructive" onClick={handleDelete} className="rounded-lg">{t('common.delete')}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
