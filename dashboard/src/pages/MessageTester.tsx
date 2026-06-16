import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PaperPlaneRight, CheckCircle, XCircle, CircleNotch } from '@phosphor-icons/react';
import { messageApi } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useSessionsQuery, useSessionGroupsQuery } from '../hooks/queries';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '../lib/utils';

interface ApiResponse {
  success: boolean;
  messageId?: string;
  timestamp: string;
  error?: string;
}

const messageTypes = ['text', 'image', 'video', 'audio', 'document'] as const;

export function MessageTester() {
  const { t } = useTranslation();
  useDocumentTitle(t('messageTester.title'));
  const { canWrite } = useRole();
  const { data: allSessions = [], isLoading: loadingSessions } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  const [session, setSession] = useState('');
  const [recipient, setRecipient] = useState('');
  const [recipientType, setRecipientType] = useState<'personal' | 'group'>('personal');
  const [selectedGroup, setSelectedGroup] = useState('');
  const [messageType, setMessageType] = useState<typeof messageTypes[number]>('text');
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);

  const { data: groups = [], isLoading: loadingGroups } = useSessionGroupsQuery(session, recipientType === 'group');

  useEffect(() => {
    if (sessions.length > 0 && !session) setSession(sessions[0].id);
  }, [sessions, session]);

  useEffect(() => {
    if (groups.length > 0 && !selectedGroup) setSelectedGroup(groups[0].id);
    if (recipientType !== 'group') setSelectedGroup('');
  }, [groups, selectedGroup, recipientType]);

  const handleSend = async () => {
    const targetId = recipientType === 'group' ? selectedGroup : recipient;
    if (!session || !targetId) return;
    setIsLoading(true);
    setResponse(null);

    const chatId = recipientType === 'group' ? targetId : targetId.replace(/[^0-9]/g, '') + '@c.us';

    try {
      let result;
      if (messageType === 'text') {
        result = await messageApi.sendText(session, chatId, content);
      } else if (messageType === 'image') {
        result = await messageApi.sendImage(session, chatId, mediaUrl, content);
      } else if (messageType === 'video') {
        result = await messageApi.sendVideo(session, chatId, mediaUrl, content);
      } else if (messageType === 'audio') {
        result = await messageApi.sendAudio(session, chatId, mediaUrl);
      } else {
        result = await messageApi.sendDocument(session, chatId, mediaUrl, content);
      }

      setResponse({
        success: !!result.messageId,
        messageId: result.messageId,
        timestamp: result.timestamp ? new Date(result.timestamp * 1000).toISOString() : new Date().toISOString(),
      });
    } catch (err) {
      setResponse({
        success: false,
        timestamp: new Date().toISOString(),
        error: err instanceof Error ? err.message : t('messageTester.sendFailed'),
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (loadingSessions) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <CircleNotch size={32} className="animate-spin text-whatsapp-green" />
      </div>
    );
  }

  return (
    <ScrollArea className="h-full bg-background">
      <div className="p-4 sm:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
        <header>
          <h1 className="text-3xl font-bold tracking-tight">{t('messageTester.title')}</h1>
          <p className="text-muted-foreground mt-1">{t('messageTester.subtitle')}</p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="flex flex-col gap-6">
            <div>
              <h2 className="text-sm font-bold text-foreground mb-4">{t('messageTester.compose')}</h2>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground">{t('messageTester.session')}</label>
                  <Select value={session} onValueChange={setSession}>
                    <SelectTrigger className="bg-muted border-none rounded-lg">
                      <SelectValue placeholder={t('messageTester.noReadySessions')} />
                    </SelectTrigger>
                    <SelectContent>
                      {sessions.map(s => (
                        <SelectItem key={s.id} value={s.id}>{s.name} ({s.phone || t('messageTester.sessionOptionPhoneNone')})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground">{t('messageTester.recipientType')}</label>
                  <div className="flex gap-1 p-1 bg-muted rounded-lg w-fit">
                    {(['personal', 'group'] as const).map(type => (
                      <button key={type} onClick={() => setRecipientType(type)}
                        className={cn("px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                          recipientType === type ? 'bg-whatsapp-green text-white' : 'text-muted-foreground hover:text-foreground'
                        )}>
                        {t(`messageTester.${type}`)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground">
                    {recipientType === 'group' ? t('messageTester.selectGroup') : t('messageTester.recipientPhone')}
                  </label>
                  {recipientType === 'group' ? (
                    <>
                      <Select value={selectedGroup} onValueChange={setSelectedGroup} disabled={loadingGroups || groups.length === 0}>
                        <SelectTrigger className="bg-muted border-none rounded-lg">
                          <SelectValue placeholder={loadingGroups ? t('messageTester.loadingGroups') : t('messageTester.noGroupsFound')} />
                        </SelectTrigger>
                        <SelectContent>
                          {groups.map(g => (
                            <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <span className="text-[11px] text-muted-foreground">{t('messageTester.selectGroupHint')}</span>
                    </>
                  ) : (
                    <>
                      <Input value={recipient} onChange={e => setRecipient(e.target.value)} placeholder="+62812345678" className="bg-muted border-none rounded-lg" />
                      <span className="text-[11px] text-muted-foreground">{t('messageTester.phoneHint')}</span>
                    </>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-bold text-muted-foreground">{t('messageTester.messageType')}</label>
                  <div className="flex flex-wrap gap-1 p-1 bg-muted rounded-lg">
                    {messageTypes.map(type => (
                      <button key={type} onClick={() => setMessageType(type)}
                        className={cn("px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors",
                          messageType === type ? 'bg-whatsapp-green text-white' : 'text-muted-foreground hover:text-foreground'
                        )}>
                        {t(`messageTester.types.${type}`)}
                      </button>
                    ))}
                  </div>
                </div>

                {messageType === 'text' ? (
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-bold text-muted-foreground">{t('messageTester.messageContent')}</label>
                    <textarea value={content} onChange={e => setContent(e.target.value)}
                      placeholder={t('messageTester.messagePlaceholder')} rows={5}
                      className="w-full bg-muted border-none rounded-lg p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none focus-visible:ring-1 focus-visible:ring-whatsapp-green" />
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-bold text-muted-foreground">{t('messageTester.mediaUrl')}</label>
                      <Input value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} placeholder="https://example.com/file.jpg" className="bg-muted border-none rounded-lg" />
                    </div>
                    {messageType !== 'audio' && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-bold text-muted-foreground">
                          {messageType === 'document' ? t('messageTester.filename') : t('messageTester.caption')} ({t('common.optional')})
                        </label>
                        <Input value={content} onChange={e => setContent(e.target.value)}
                          placeholder={messageType === 'document' ? t('messageTester.filenamePlaceholder') : t('messageTester.captionPlaceholder')}
                          className="bg-muted border-none rounded-lg" />
                      </div>
                    )}
                  </>
                )}

                <Button className="bg-whatsapp-green hover:bg-whatsapp-green/90 rounded-lg w-full"
                  onClick={handleSend}
                  disabled={!canWrite || isLoading || !session || (recipientType === 'group' ? !selectedGroup : !recipient)}>
                  {isLoading ? <CircleNotch size={18} className="animate-spin" /> : <PaperPlaneRight size={18} weight="bold" />}
                  {isLoading ? t('messageTester.sending') : canWrite ? t('messageTester.send') : t('messageTester.viewOnly')}
                </Button>
              </div>
            </div>
          </div>

          <div>
            <h2 className="text-sm font-bold text-foreground mb-4">{t('messageTester.responseTitle')}</h2>
            {response ? (
              <div className="bg-muted rounded-lg p-4 flex flex-col gap-4">
                <div className={cn("flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium",
                  response.success ? 'bg-whatsapp-green/10 text-whatsapp-green' : 'bg-destructive/10 text-destructive'
                )}>
                  {response.success ? <CheckCircle size={18} weight="fill" /> : <XCircle size={18} weight="fill" />}
                  <span>{response.success ? t('messageTester.successLabel') : t('messageTester.failedLabel')}</span>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex justify-between py-1.5 text-sm">
                    <span className="text-muted-foreground">{t('messageTester.response.timestamp')}</span>
                    <span className="font-mono text-xs">{response.timestamp}</span>
                  </div>
                  {response.messageId && (
                    <div className="flex justify-between py-1.5 text-sm">
                      <span className="text-muted-foreground">{t('messageTester.response.messageId')}</span>
                      <span className="font-mono text-xs truncate max-w-[200px]">{response.messageId}</span>
                    </div>
                  )}
                  {response.error && (
                    <div className="flex justify-between py-1.5 text-sm">
                      <span className="text-muted-foreground">{t('messageTester.response.error')}</span>
                      <span className="text-xs text-destructive max-w-[200px] truncate">{response.error}</span>
                    </div>
                  )}
                </div>
                <pre className="p-3 bg-background rounded-md text-xs overflow-x-auto">{JSON.stringify(response, null, 2)}</pre>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground bg-muted rounded-lg">
                <PaperPlaneRight size={48} weight="thin" />
                <p className="text-sm mt-4">{t('messageTester.responseEmpty')}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
