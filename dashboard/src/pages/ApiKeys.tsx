import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import {
  Plus,
  CopySimple,
  Check,
  Eye,
  EyeSlash,
  Trash,
  ArrowClockwise,
  Key,
  CircleNotch,
  WarningCircle,
} from '@phosphor-icons/react';
import type { ApiKey } from '../services/api';
import { apiKeyApi } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useApiKeysQuery, useCreateApiKeyMutation, useDeleteApiKeyMutation, useRevokeApiKeyMutation } from '../hooks/queries';
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

const roleNames = ['admin', 'operator', 'viewer'] as const;

export function ApiKeys() {
  const { t } = useTranslation();
  useDocumentTitle(t('apiKeys.title'));
  const { data: apiKeys = [], isLoading: loading } = useApiKeysQuery();
  const createMutation = useCreateApiKeyMutation();
  const deleteMutation = useDeleteApiKeyMutation();
  const revokeMutation = useRevokeApiKeyMutation();
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(new Set());
  const [showModal, setShowModal] = useState(false);
  const [newKey, setNewKey] = useState({ name: '', role: 'operator' });
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'revoke'; id: string; name: string } | null>(null);

  const handleCreate = async () => {
    if (!newKey.name) return;
    try {
      const created = await createMutation.mutateAsync({ name: newKey.name, role: newKey.role });
      setCreatedKey(created.apiKey || null);
      setNewKey({ name: '', role: 'operator' });
    } catch (err) {
      console.error('Failed to create:', err);
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to revoke:', err);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteMutation.mutateAsync(id);
    } catch (err) {
      console.error('Failed to delete:', err);
    }
  };

  const confirmAndExecute = () => {
    if (!confirmAction) return;
    if (confirmAction.type === 'delete') handleDelete(confirmAction.id);
    else handleRevoke(confirmAction.id);
    setConfirmAction(null);
  };

  const toggleKeyVisibility = (id: string) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyToClipboard = async (value: ApiKey | string, id: string) => {
    let text: string;
    if (typeof value === 'string') {
      text = value;
    } else {
      text = value.keyPrefix;
      try {
        const full = await apiKeyApi.get(value.id);
        if (full.apiKey) text = full.apiKey;
      } catch {
        // fall back to prefix
      }
    }
    const copied = (() => {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text);
        return true;
      }
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch {
        return false;
      }
    })();
    if (copied) {
      setCopied(id);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <CircleNotch size={32} className="animate-spin text-whatsapp-green" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="p-4 sm:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t('apiKeys.title')}</h1>
            <p className="text-muted-foreground mt-1">{t('apiKeys.subtitle')}</p>
          </div>
          <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={() => setShowModal(true)}>
            <Plus size={16} weight="bold" />
            {t('apiKeys.createBtn')}
          </Button>
        </header>

        <div>
          {apiKeys.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <Key size={64} weight="thin" />
              <h3 className="font-bold text-foreground text-sm">{t('apiKeys.empty.title')}</h3>
              <p className="text-sm">{t('apiKeys.empty.description')}</p>
            </div>
          ) : (
            <div>
              <div className="flex items-center px-3 py-2 text-xs font-bold text-muted-foreground uppercase tracking-wider">
                <span className="flex-1 min-w-0">{t('apiKeys.columns.name')}</span>
                <span className="w-[200px] shrink-0">{t('apiKeys.columns.key')}</span>
                <span className="w-[80px] shrink-0 text-center">{t('apiKeys.columns.role')}</span>
                <span className="w-[80px] shrink-0 text-center">{t('apiKeys.columns.status')}</span>
                <span className="hidden md:block w-[100px] shrink-0 text-center">{t('apiKeys.columns.lastUsed')}</span>
                <span className="w-[100px] shrink-0 text-right">{t('apiKeys.columns.actions')}</span>
              </div>
              {apiKeys.map(apiKey => (
                <div key={apiKey.id} className="flex items-center px-3 py-[10px] hover:bg-muted/50 transition-colors">
                  <span className="flex-1 min-w-0 text-sm font-medium truncate">{apiKey.name}</span>
                  <span className="w-[200px] shrink-0 flex items-center gap-1">
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono truncate max-w-[130px]">
                      {visibleKeys.has(apiKey.id) ? apiKey.keyPrefix + '...' : apiKey.keyPrefix + '****'}
                    </code>
                    <button onClick={() => { copyToClipboard(apiKey, apiKey.id); }} className="text-muted-foreground hover:text-foreground shrink-0" title={t('common.copy')}>
                      {copied === apiKey.id ? <Check size={14} weight="bold" className="text-whatsapp-green" /> : <CopySimple size={14} />}
                    </button>
                    <button onClick={() => toggleKeyVisibility(apiKey.id)} className="text-muted-foreground hover:text-foreground shrink-0">
                      {visibleKeys.has(apiKey.id) ? <EyeSlash size={14} /> : <Eye size={14} />}
                    </button>
                  </span>
                  <span className="w-[80px] shrink-0 text-center">
                    <Badge className={cn(
                      "text-[10px] font-bold uppercase border-none",
                      apiKey.role === 'admin' ? 'bg-whatsapp-green/10 text-whatsapp-green' :
                      apiKey.role === 'operator' ? 'bg-blue-500/10 text-blue-500' :
                      'bg-muted text-muted-foreground'
                    )}>
                      {apiKey.role}
                    </Badge>
                  </span>
                  <span className="w-[80px] shrink-0 text-center">
                    <Badge className={cn(
                      "text-[10px] font-bold uppercase border-none",
                      apiKey.isActive ? 'bg-whatsapp-green/10 text-whatsapp-green' : 'bg-destructive/10 text-destructive'
                    )}>
                      {apiKey.isActive ? t('apiKeys.statuses.active') : t('apiKeys.statuses.revoked')}
                    </Badge>
                  </span>
                  <span className="hidden md:block w-[100px] shrink-0 text-xs text-muted-foreground text-center">
                    {apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).toLocaleDateString() : t('common.never')}
                  </span>
                  <span className="w-[100px] shrink-0 flex items-center justify-end gap-1">
                    {apiKey.isActive && (
                      <Button variant="ghost" size="icon-sm"
                        onClick={() => setConfirmAction({ type: 'revoke', id: apiKey.id, name: apiKey.name })}
                        title={t('apiKeys.actions.revoke')}>
                        <ArrowClockwise size={14} />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm"
                      onClick={() => setConfirmAction({ type: 'delete', id: apiKey.id, name: apiKey.name })}
                      title={t('apiKeys.actions.delete')}>
                      <Trash size={14} />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg p-4 flex flex-col gap-3">
          <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">{t('apiKeys.rolesTitle')}</h3>
          <div className="flex flex-col gap-2">
            {roleNames.map(r => (
              <div key={r} className="flex items-center gap-3">
                <code className="text-xs font-bold text-foreground bg-background px-1.5 py-0.5 rounded w-20 shrink-0">{r}</code>
                <span className="text-sm text-muted-foreground">{t(`apiKeys.roleDescriptions.${r}`)}</span>
              </div>
            ))}
          </div>
        </div>

        <Dialog open={showModal} onOpenChange={v => { if (!v) { setShowModal(false); setCreatedKey(null); } }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{createdKey ? t('apiKeys.createdTitle') : t('apiKeys.modalTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {createdKey ? (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">{t('apiKeys.createdHint')}</p>
                  <div className="flex gap-2 items-center">
                    <code className="flex-1 p-3 bg-muted rounded-lg text-xs break-all">{createdKey}</code>
                    <Button size="icon" className="bg-whatsapp-green hover:bg-whatsapp-green/90 shrink-0 rounded-lg"
                      onClick={() => copyToClipboard(createdKey, 'modal')}>
                      {copied === 'modal' ? <Check size={16} weight="bold" /> : <CopySimple size={16} weight="bold" />}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-muted-foreground">{t('common.name')}</label>
                    <Input type="text" placeholder={t('apiKeys.namePlaceholder')}
                      value={newKey.name} onChange={e => setNewKey({ ...newKey, name: e.target.value })}
                      className="bg-muted border-none rounded-lg" />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-muted-foreground">{t('common.role')}</label>
                    <Select value={newKey.role} onValueChange={v => setNewKey({ ...newKey, role: v })}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('common.role')} />
                      </SelectTrigger>
                      <SelectContent>
                        {roleNames.map(r => (
                          <SelectItem key={r} value={r}>{t(`apiKeys.roles.${r}`)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
            {!createdKey && (
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowModal(false)} className="rounded-lg">{t('common.cancel')}</Button>
                <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg" onClick={handleCreate}>
                  {t('common.create')}
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>

        <Dialog open={!!confirmAction} onOpenChange={v => { if (!v) setConfirmAction(null); }}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>
                {confirmAction?.type === 'delete' ? t('apiKeys.confirm.deleteTitle') : t('apiKeys.confirm.revokeTitle')}
              </DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-4 py-4">
              <WarningCircle size={48} className="text-destructive" weight="fill" />
              <p className="text-sm text-muted-foreground text-center">
                {confirmAction && (
                  <Trans
                    i18nKey={confirmAction.type === 'delete' ? 'apiKeys.confirm.deleteMessage' : 'apiKeys.confirm.revokeMessage'}
                    values={{ name: confirmAction.name }}
                    components={{ strong: <strong /> }}
                  />
                )}
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmAction(null)} className="rounded-lg">{t('common.cancel')}</Button>
              <Button variant="destructive" onClick={confirmAndExecute} className="rounded-lg">
                {confirmAction?.type === 'delete' ? t('apiKeys.confirm.delete') : t('apiKeys.confirm.revoke')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </ScrollArea>
  );
}
