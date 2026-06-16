import { useState, useEffect, useCallback, useRef, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlass,
  PaperPlaneRight,
  CircleNotch,
  User,
  Users,
  WarningCircle,
  ChatCircleDots,
  Paperclip,
  Smiley,
  X,
  Check,
  Checks,
  Clock,
  DotsThreeVertical,
  CaretUp,
  CaretDown,
} from '@phosphor-icons/react';
import { sessionApi, messageApi, type Session, type Chat, type ChatMessage } from '../services/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../components/Toast';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Picker from '@emoji-mart/react';
import data from '@emoji-mart/data';
import { cn } from '../lib/utils';
import './Chats.css';

type MessageMedia = { mimetype: string; filename?: string; data?: string };

interface ChatMessageView extends ChatMessage {
  metadata?: {
    media?: MessageMedia;
    quotedMessage?: { id: string; body: string };
    reactions?: Record<string, string>;
  };
}

interface IncomingWsMessage {
  id: string;
  chatId: string;
  from: string;
  to: string;
  body: string;
  type: string;
  timestamp: number;
  fromMe?: boolean;
  media?: MessageMedia;
  quotedMessage?: { id: string; body: string };
  metadata?: ChatMessageView['metadata'];
}

const getMediaSrc = (media?: MessageMedia): string => {
  if (!media || !media.data) return '';
  if (media.data.startsWith('data:') || media.data.startsWith('http://') || media.data.startsWith('https://')) {
    return media.data;
  }
  return `data:${media.mimetype};base64,${media.data}`;
};

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { canWrite } = useRole();
  const toast = useToast();

  // Sessions list & active session
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [_loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'unread' | 'groups'>('all');

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [loadingMessages, setLoadingMessages] = useState<boolean>(false);
  const [messageInput, setMessageInput] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);

  // File attachments
  const [attachment, setAttachment] = useState<{
    file: File;
    base64: string;
    mimetype: string;
    filename: string;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);

  // Message search within conversation
  const [conversationSearchOpen, setConversationSearchOpen] = useState(false);
  const [conversationSearchQuery, setConversationSearchQuery] = useState('');
  const [conversationSearchIndex, setConversationSearchIndex] = useState(0);
  const [conversationSearchResults, setConversationSearchResults] = useState<number[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Profile pictures
  const [profilePics, setProfilePics] = useState<Record<string, string>>({});
  const profilePicsFetched = useRef(false);

  // References
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);

  // Drag-to-resize state
  const [chatListWidth, setChatListWidth] = useState(350);
  const [isDragging, setIsDragging] = useState(false);
  const chatListRef = useRef<HTMLDivElement>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(350);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.min(500, Math.max(280, dragStartWidth.current + delta));
      setChatListWidth(newWidth);
    };
    const handleMouseUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Emoji picker ref
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  // 1. Fetch available connected sessions on mount
  useEffect(() => {
    const loadSessions = async () => {
      try {
        setLoadingSessions(true);
        const list = await sessionApi.list();
        const readySessions = list.filter(s => s.status === 'ready');
        setSessions(readySessions);
        if (readySessions.length > 0) {
          setSelectedSessionId(readySessions[0].id);
        }
      } catch (err) {
        toast.error(t('chats.errors.loadSessions'), err instanceof Error ? err.message : undefined);
      } finally {
        setLoadingSessions(false);
      }
    };
    void loadSessions();
  }, [t, toast]);

  // 2. Fetch chats when active session changes
  const loadChats = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      try {
        setLoadingChats(true);
        profilePicsFetched.current = false;
        const data = await sessionApi.getChats(sessionId);
        const sorted = [...data].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        setChats(sorted);
        // Fetch profile pictures in background (concurrency-limited)
        const pics: Record<string, string> = {};
        const queue = sorted.slice(0, 30).map(c => c.id);
        let index = 0;
        const next = async () => {
          if (index >= queue.length) return;
          const chatId = queue[index++];
          try {
            const res = await sessionApi.getProfilePicture(sessionId, chatId);
            if (res.url) pics[chatId] = res.url;
          } catch {}
          await next();
        };
        await Promise.all(Array.from({ length: 5 }, () => next()));
        setProfilePics(prev => ({ ...prev, ...pics }));
        profilePicsFetched.current = true;
      } catch (err) {
        toast.error(t('chats.errors.loadChats'), err instanceof Error ? err.message : undefined);
        setChats([]);
      } finally {
        setLoadingChats(false);
      }
    },
    [t, toast],
  );

  useEffect(() => {
    if (selectedSessionId) {
      void loadChats(selectedSessionId);
      setActiveChat(null);
      setMessages([]);
      setAttachment(null);
      setPreviewUrl(null);
    }
  }, [selectedSessionId, loadChats]);

  const markChatRead = useCallback(
    (chatId: string) => {
      void sessionApi.markChatRead(selectedSessionId, chatId).catch(err => {
        toast.warning(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
      });
    },
    [selectedSessionId, t, toast],
  );

  // 3. WebSocket integration for real-time messages
  const handleIncomingMessage = useCallback(
    (event: { sessionId: string; message: Record<string, unknown> }) => {
      if (event.sessionId !== selectedSessionId) return;

      const newMsg = event.message as unknown as IncomingWsMessage;

      if (activeChat && newMsg.chatId === activeChat.id) {
        markChatRead(activeChat.id);

        const mappedMessage: ChatMessageView = {
          id: newMsg.id,
          waMessageId: newMsg.id,
          chatId: newMsg.chatId,
          from: newMsg.from,
          to: newMsg.to,
          body: newMsg.body,
          type: newMsg.type,
          direction: newMsg.fromMe ? 'outgoing' : 'incoming',
          status: 'sent',
          timestamp: newMsg.timestamp,
          createdAt: new Date(newMsg.timestamp * 1000).toISOString(),
          metadata: newMsg.metadata || {
            media: newMsg.media,
            quotedMessage: newMsg.quotedMessage,
          },
        };

        setMessages(prev => {
          if (prev.some(m => m.id === mappedMessage.id || m.waMessageId === mappedMessage.id)) {
            return prev;
          }
          return [...prev, mappedMessage];
        });
      }

      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === newMsg.chatId);
        if (chatIndex === -1) {
          void loadChats(selectedSessionId);
          return prevChats;
        }

        const updatedChats = [...prevChats];
        const targetChat = { ...updatedChats[chatIndex] };
        targetChat.lastMessage = newMsg.body;
        targetChat.timestamp = newMsg.timestamp;

        if (!newMsg.fromMe && (!activeChat || activeChat.id !== targetChat.id)) {
          targetChat.unreadCount = (targetChat.unreadCount || 0) + 1;
        }

        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(targetChat);
        return updatedChats;
      });
    },
    [selectedSessionId, activeChat, loadChats, markChatRead],
  );

  const handleIncomingMessageAck = useCallback(
    (event: { sessionId: string; messageId: string; ack: number }) => {
      if (event.sessionId !== selectedSessionId) return;

      setMessages(prev =>
        prev.map(msg => {
          if (msg.id === event.messageId || msg.waMessageId === event.messageId) {
            const statusMap: Record<number, ChatMessageView['status']> = {
              [-1]: 'failed',
              [0]: 'pending',
              [1]: 'sent',
              [2]: 'delivered',
              [3]: 'read',
              [4]: 'read',
            };
            return { ...msg, status: statusMap[event.ack] || msg.status };
          }
          return msg;
        }),
      );
    },
    [selectedSessionId],
  );

  const handleIncomingMessageReaction = useCallback(
    (event: { sessionId: string; messageId: string; reactions: Record<string, string> }) => {
      if (event.sessionId !== selectedSessionId) return;

      setMessages(prev =>
        prev.map(msg => {
          if (msg.id === event.messageId || msg.waMessageId === event.messageId) {
            const metadata = msg.metadata || {};
            return { ...msg, metadata: { ...metadata, reactions: event.reactions } };
          }
          return msg;
        }),
      );
    },
    [selectedSessionId],
  );

  const handleIncomingMessageRevoked = useCallback(
    (event: { sessionId: string; id: string; type: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      setMessages(prev =>
        prev.map(msg => {
          if (msg.id === event.id || msg.waMessageId === event.id) {
            return { ...msg, body: '', type: event.type };
          }
          return msg;
        }),
      );
    },
    [selectedSessionId],
  );

  const { isConnected, subscribe, unsubscribe } = useWebSocket({
    onMessage: handleIncomingMessage,
    onMessageAck: handleIncomingMessageAck,
    onMessageReaction: handleIncomingMessageReaction,
    onMessageRevoked: handleIncomingMessageRevoked,
  });

  useEffect(() => {
    if (selectedSessionId && isConnected) {
      subscribe(selectedSessionId, [
        'message.received',
        'message.sent',
        'message.ack',
        'message.reaction',
        'message.revoked',
      ]);
      return () => {
        unsubscribe(selectedSessionId);
      };
    }
  }, [selectedSessionId, isConnected, subscribe, unsubscribe]);

  // 4. Fetch message history for the selected chat
  const loadMessages = useCallback(
    async (chatId: string) => {
      if (!selectedSessionId || !chatId) return;
      try {
        setLoadingMessages(true);
        markChatRead(chatId);
        const data = await sessionApi.getChatMessages(selectedSessionId, chatId, 100);
        setMessages([...data.messages].reverse());
      } catch (err) {
        toast.error(t('chats.errors.loadMessages'), err instanceof Error ? err.message : undefined);
        setMessages([]);
      } finally {
        setLoadingMessages(false);
      }
    },
    [selectedSessionId, markChatRead, t, toast],
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // @ts-ignore
  const _handleReactMessage = async (msg: ChatMessageView, emoji: string) => {
    if (!selectedSessionId || !activeChat) return;

    const msgId = msg.waMessageId || msg.id;
    const currentReactions = msg.metadata?.reactions || {};
    const sessionPhone = sessions.find(s => s.id === selectedSessionId)?.phone || 'me';

    let alreadyReacted = false;
    for (const [sender, emo] of Object.entries(currentReactions)) {
      if ((sender === 'me' || sender.includes(sessionPhone)) && emo === emoji) {
        alreadyReacted = true;
        break;
      }
    }

    const emojiToSend = alreadyReacted ? '' : emoji;

    try {
      await messageApi.react(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        emoji: emojiToSend,
      });

      setMessages(prev =>
        prev.map(m => {
          if (m.id === msg.id || m.waMessageId === msg.id) {
            const metadata = m.metadata || {};
            const reactions = { ...(metadata.reactions || {}) };
            if (emojiToSend === '') {
              delete reactions['me'];
            } else {
              reactions['me'] = emojiToSend;
            }
            return { ...m, metadata: { ...metadata, reactions } };
          }
          return m;
        }),
      );
    } catch (err) {
      toast.error(t('chats.errors.react'), err instanceof Error ? err.message : undefined);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  // @ts-ignore
  const _handleDeleteMessage = async (msg: ChatMessageView) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;

    if (!window.confirm(t('chats.deleteConfirm'))) return;

    try {
      await messageApi.delete(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        forEveryone: true,
      });

      setMessages(prev =>
        prev.map(m => {
          if (m.id === msg.id || m.waMessageId === msg.id) {
            return { ...m, body: '', type: 'revoked' };
          }
          return m;
        }),
      );
    } catch (err) {
      toast.error(t('chats.errors.delete'), err instanceof Error ? err.message : undefined);
    }
  };

  useEffect(() => {
    if (activeChat) {
      void loadMessages(activeChat.id);
      setChats(prev => prev.map(c => (c.id === activeChat.id ? { ...c, unreadCount: 0 } : c)));
    } else {
      setMessages([]);
    }
  }, [activeChat, loadMessages]);

  // Fetch profile picture for the active chat
  useEffect(() => {
    if (!activeChat || !selectedSessionId) return;
    if (profilePics[activeChat.id]) return;
    sessionApi.getProfilePicture(selectedSessionId, activeChat.id).then(res => {
      if (res.url) setProfilePics(prev => ({ ...prev, [activeChat.id]: res.url }));
    }).catch(() => {});
  }, [activeChat?.id, selectedSessionId]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }

    const reader = new FileReader();
    reader.onload = event => {
      const dataUrl = event.target?.result as string;
      const base64Data = dataUrl.split(',')[1];
      setAttachment({ file, base64: base64Data, mimetype: file.type, filename: file.name });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleEmojiSelect = (emoji: { native: string }) => {
    setMessageInput(prev => prev + emoji.native);
    setShowEmojiPicker(false);
  };

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat || sending) return;

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    setMessageInput('');
    setSending(true);

    const tempId = `temp_${Date.now()}`;
    const tempMessage: ChatMessageView = {
      id: tempId,
      chatId: activeChat.id,
      from: 'me',
      to: activeChat.id,
      body: attachment
        ? attachment.mimetype.startsWith('image/') ||
          attachment.mimetype.startsWith('video/') ||
          attachment.mimetype.startsWith('audio/')
          ? textToSend
          : attachment.filename
        : textToSend,
      type: attachment ? attachment.mimetype.split('/')[0] : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: attachment
        ? {
            media: {
              mimetype: attachment.mimetype,
              filename: attachment.filename,
              data: attachment.base64,
            },
          }
        : replyingTo
          ? {
              quotedMessage: {
                id: replyingTo.waMessageId || replyingTo.id,
                body: replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body,
              },
            }
          : undefined,
    };

    setMessages(prev => [...prev, tempMessage]);

    const currentAttachment = attachment;
    const currentReplyingTo = replyingTo;
    handleRemoveAttachment();
    setReplyingTo(null);

    try {
      let result;

      if (currentAttachment) {
        let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
        const mime = currentAttachment.mimetype;
        if (mime.startsWith('image/')) mediaType = 'image';
        else if (mime.startsWith('video/')) mediaType = 'video';
        else if (mime.startsWith('audio/')) mediaType = 'audio';

        result = await messageApi.sendMedia(selectedSessionId, activeChat.id, mediaType, {
          base64: currentAttachment.base64,
          mimetype: currentAttachment.mimetype,
          filename: currentAttachment.filename,
          caption: mediaType !== 'audio' ? textToSend : undefined,
        });
      } else if (currentReplyingTo) {
        result = await messageApi.reply(selectedSessionId, {
          chatId: activeChat.id,
          quotedMessageId: currentReplyingTo.waMessageId || currentReplyingTo.id,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(selectedSessionId, activeChat.id, textToSend);
      }

      setMessages(prev =>
        prev.map(m =>
          m.id === tempId ? { ...m, id: result.messageId, waMessageId: result.messageId, status: 'sent' } : m,
        ),
      );

      setChats(prevChats => {
        const chatIndex = prevChats.findIndex(c => c.id === activeChat.id);
        if (chatIndex === -1) return prevChats;
        const updatedChats = [...prevChats];
        const target = { ...updatedChats[chatIndex] };
        target.lastMessage = currentAttachment
          ? `[${currentAttachment.mimetype.split('/')[0]}]`
          : textToSend;
        target.timestamp = Math.floor(Date.now() / 1000);
        updatedChats.splice(chatIndex, 1);
        updatedChats.unshift(target);
        return updatedChats;
      });
    } catch (err) {
      toast.error(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      setMessages(prev => prev.map(m => (m.id === tempId ? { ...m, status: 'failed' } : m)));
    } finally {
      setSending(false);
    }
  };

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatChatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    const today = new Date();
    if (date.toDateString() === today.toDateString()) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return t('chats.yesterday');
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const formatDateSeparator = (timestamp?: number) => {
    if (!timestamp) return '';
    const date = new Date(timestamp * 1000);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return date.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' });
  };

  // Conversation search
  useEffect(() => {
    if (!conversationSearchQuery.trim()) {
      setConversationSearchResults([]);
      setConversationSearchIndex(0);
      return;
    }
    const query = conversationSearchQuery.toLowerCase();
    const indices = messages
      .map((msg, i) => ({ msg, i }))
      .filter(({ msg }) => msg.body?.toLowerCase().includes(query))
      .map(({ i }) => i);
    setConversationSearchResults(indices);
    setConversationSearchIndex(0);
  }, [conversationSearchQuery, messages]);

  const handleConversationSearchNext = () => {
    if (conversationSearchResults.length === 0) return;
    const nextIndex = (conversationSearchIndex + 1) % conversationSearchResults.length;
    setConversationSearchIndex(nextIndex);
    const msgIndex = conversationSearchResults[nextIndex];
    const msg = messages[msgIndex];
    if (msg && messageRefs.current[msg.id]) {
      messageRefs.current[msg.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const handleConversationSearchPrev = () => {
    if (conversationSearchResults.length === 0) return;
    const prevIndex = (conversationSearchIndex - 1 + conversationSearchResults.length) % conversationSearchResults.length;
    setConversationSearchIndex(prevIndex);
    const msgIndex = conversationSearchResults[prevIndex];
    const msg = messages[msgIndex];
    if (msg && messageRefs.current[msg.id]) {
      messageRefs.current[msg.id]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  };

  const filteredChats = chats
    .filter(c => {
      const matchesSearch = c.name?.toLowerCase().includes(searchQuery.toLowerCase()) || c.id.toLowerCase().includes(searchQuery.toLowerCase());
      if (activeFilter === 'unread') return matchesSearch && (c.unreadCount || 0) > 0;
      if (activeFilter === 'groups') return matchesSearch && c.isGroup;
      return matchesSearch;
    });

  return (
    <div className="flex h-full w-full bg-background overflow-hidden">
      {/* MIDDLE COLUMN: Chat List */}
      <div ref={chatListRef} className="flex flex-col bg-background shrink-0" style={{ width: chatListWidth }}>
        <header className="p-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold text-foreground">{t('nav.chats')}</h1>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground hover:text-foreground hover:bg-muted">
                  <DotsThreeVertical size={20} weight="bold" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="bg-popover border-border">
                {sessions.map(s => (
                  <DropdownMenuItem 
                    key={s.id} 
                    onClick={() => setSelectedSessionId(s.id)}
                    className={cn(s.id === selectedSessionId && "text-whatsapp-green font-bold")}
                  >
                    {s.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <div className="relative">
            <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" size={18} />
            <Input
              placeholder={t('chats.searchPlaceholder')}
              className="pl-10 bg-muted border-none rounded-lg h-9 text-foreground placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-whatsapp-green"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="flex gap-2">
            {[
              { id: 'all', label: t('chats.filters.all') },
              { id: 'unread', label: t('chats.filters.unread') },
              { id: 'groups', label: t('chats.filters.groups') },
            ].map(filter => (
              <Badge
                key={filter.id}
                className={cn(
                  "cursor-pointer px-3 py-1 rounded text-xs font-medium transition-colors",
                  activeFilter === filter.id
                    ? "bg-whatsapp-green text-white hover:bg-whatsapp-green/90"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
                onClick={() => setActiveFilter(filter.id as any)}
              >
                {filter.label}
              </Badge>
            ))}
          </div>
        </header>

        <ScrollArea className="flex-1">
          {loadingChats ? (
            <div className="p-8 flex flex-col items-center gap-2 text-muted-foreground">
              <CircleNotch size={24} className="animate-spin" />
              <span className="text-sm">{t('chats.loadingChats')}</span>
            </div>
          ) : filteredChats.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              <span className="text-sm">{t('chats.empty')}</span>
            </div>
          ) : (
            <div className="flex flex-col">
              {filteredChats.map(chat => {
                const isActive = activeChat?.id === chat.id;
                return (
                  <div
                    key={chat.id}
                    className={cn(
                      "flex items-center gap-3 px-3 py-[10px] cursor-pointer transition-colors relative",
                      isActive ? "bg-muted" : "hover:bg-muted/50"
                    )}
                    onClick={() => setActiveChat(chat)}
                  >
                    <Avatar className="h-[49px] w-[49px]">
                      <AvatarImage src={profilePics[chat.id] || chat.profilePic} />
                      <AvatarFallback className="bg-muted text-muted-foreground text-sm">
                        {chat.isGroup ? <Users size={20} /> : <User size={20} />}
                      </AvatarFallback>
                    </Avatar>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-normal text-[17px] text-foreground truncate pr-2">{chat.name || chat.id.split('@')[0]}</span>
                        <span className={cn(
                          "text-[11px] whitespace-nowrap",
                          (chat.unreadCount || 0) > 0 ? "text-whatsapp-green" : "text-muted-foreground"
                        )}>
                          {formatChatTime(chat.timestamp)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-[2px]">
                        <span className="text-[13px] text-muted-foreground truncate flex-1">
                          {chat.lastMessage || t('chats.noMessageYet')}
                        </span>
                        {(chat.unreadCount || 0) > 0 && (
                          <div className="min-w-[20px] h-[20px] flex items-center justify-center bg-whatsapp-green text-white font-bold text-[11px] rounded-full px-[6px]">
                            {chat.unreadCount}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Resize Handle */}
      <div
        className="w-[5px] cursor-col-resize shrink-0 relative z-10 group -ml-[1px]"
        onMouseDown={(e) => {
          dragStartX.current = e.clientX;
          dragStartWidth.current = chatListWidth;
          setIsDragging(true);
        }}
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-[3px] bg-muted-foreground/0 group-hover:bg-muted-foreground/20 group-active:bg-muted-foreground/30 transition-colors" />
      </div>

      {/* RIGHT COLUMN: Conversation Area */}
      <main className="flex-1 flex flex-col relative overflow-hidden min-w-0">
        {activeChat ? (
          <>
            <header className="h-[60px] flex items-center justify-between px-4 z-10 bg-muted border-b border-transparent">
              <div className="flex items-center gap-3">
                <Avatar className="h-10 w-10">
                  <AvatarImage src={profilePics[activeChat.id] || activeChat.profilePic} />
                  <AvatarFallback className="bg-muted text-muted-foreground">
                    {activeChat.isGroup ? <Users size={18} /> : <User size={18} />}
                  </AvatarFallback>
                </Avatar>
                <div className="flex flex-col">
                  <span className="text-[17px] text-foreground font-normal">{activeChat.name || activeChat.id.split('@')[0]}</span>
                  <span className="text-[12px] text-muted-foreground">{activeChat.id}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "rounded-full transition-colors",
                    conversationSearchOpen
                      ? "text-whatsapp-green bg-whatsapp-green/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  onClick={() => {
                    setConversationSearchOpen(!conversationSearchOpen);
                    if (!conversationSearchOpen) {
                      setTimeout(() => searchInputRef.current?.focus(), 100);
                    } else {
                      setConversationSearchQuery('');
                      setConversationSearchResults([]);
                    }
                  }}
                >
                  <MagnifyingGlass size={20} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="rounded-full text-muted-foreground hover:text-foreground hover:bg-muted">
                      <DotsThreeVertical size={20} weight="bold" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="bg-popover border-border">
                    <DropdownMenuItem onClick={() => {
                      navigator.clipboard?.writeText(activeChat.id);
                      toast.success('Copied chat ID');
                    }}>
                      {t('chats.menu.copyId') || 'Copy Chat ID'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      if (window.confirm(t('chats.deleteConfirm') || 'Delete all messages?')) {
                        setMessages([]);
                      }
                    }}>
                      {t('chats.menu.clearMessages') || 'Clear Messages'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setActiveChat(null)}>
                      {t('chats.menu.closeChat') || 'Close Chat'}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </header>

            {/* Conversation search bar */}
            {conversationSearchOpen && (
              <div className="flex items-center gap-2 px-4 py-2 bg-muted/50">
                <MagnifyingGlass size={16} className="text-muted-foreground shrink-0" />
                <input
                  ref={searchInputRef}
                  value={conversationSearchQuery}
                  onChange={e => setConversationSearchQuery(e.target.value)}
                  placeholder="Search in conversation..."
                  className="flex-1 h-8 bg-transparent border-none text-foreground placeholder:text-muted-foreground text-[13px] outline-none"
                />
                {conversationSearchResults.length > 0 && (
                  <span className="text-[12px] text-muted-foreground whitespace-nowrap">
                    {conversationSearchIndex + 1} of {conversationSearchResults.length}
                  </span>
                )}
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground" onClick={handleConversationSearchPrev}>
                  <CaretUp size={14} />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground" onClick={handleConversationSearchNext}>
                  <CaretDown size={14} />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 rounded-full text-muted-foreground hover:text-foreground" onClick={() => {
                  setConversationSearchOpen(false);
                  setConversationSearchQuery('');
                  setConversationSearchResults([]);
                }}>
                  <X size={14} />
                </Button>
              </div>
            )}

            <ScrollArea className="flex-1 relative bg-card">
              <div className="absolute inset-0 pointer-events-none bg-[url('/whatsapp-light-background.png')] dark:opacity-[0.08] opacity-[0.06] bg-repeat bg-[length:auto]" />
              
              <div className="flex flex-col px-[60px] py-4 gap-[2px] relative min-h-full">
                {loadingMessages ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
                    <CircleNotch size={32} className="animate-spin text-whatsapp-green" />
                    <span className="text-sm font-medium">{t('chats.loadingMessages')}</span>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-4 text-muted-foreground">
                    <ChatCircleDots size={64} weight="thin" />
                    <span className="text-sm">{t('chats.noMessagesInChat')}</span>
                  </div>
                ) : (
                  messages.map((msg, index) => {
                    const isMe = msg.direction === 'outgoing';
                    const isRevoked = msg.type === 'revoked';
                    const showAvatar = !isMe && activeChat.isGroup && (index === 0 || messages[index - 1].from !== msg.from);
                    const showDateSep = index === 0 || formatDateSeparator(msg.timestamp) !== formatDateSeparator(messages[index - 1]?.timestamp);
                    const isSearchMatch = conversationSearchResults.includes(index);
                    const isSearchActive = isSearchMatch && conversationSearchResults[conversationSearchIndex] === index;

                    return (
                      <Fragment key={msg.id}>
                        {showDateSep && (
                          <div className="flex justify-center my-2">
                            <div className="bg-muted text-muted-foreground text-[12px] px-3 py-1 rounded shadow-sm">
                              {formatDateSeparator(msg.timestamp)}
                            </div>
                          </div>
                        )}
                        <div
                          ref={el => { messageRefs.current[msg.id] = el; }}
                          className={cn(
                            "flex w-full group message-row",
                            isMe ? "justify-end" : "justify-start"
                          )}
                        >
                          {!isMe && activeChat.isGroup && (
                            <div className="w-8 mr-2 flex-shrink-0 self-end">
                              {showAvatar && (
                                <Avatar className="h-8 w-8 mb-[2px]">
                                  <AvatarFallback className="text-[10px] bg-muted text-muted-foreground">{msg.from.slice(0, 2)}</AvatarFallback>
                                </Avatar>
                              )}
                            </div>
                          )}
                          
                          <div className={cn(
                            "relative max-w-[65%] px-[9px] py-[6px] shadow-sm text-[14px] leading-[19px] transition-all",
                            isMe 
                              ? "bg-whatsapp-green text-white rounded-lg rounded-tr-none" 
                              : "bg-muted text-foreground rounded-lg rounded-tl-none",
                            isRevoked && "italic opacity-70",
                            isSearchActive && "ring-2 ring-whatsapp-green ring-offset-2 ring-offset-background"
                          )}>
                            {/* Sender name for group incoming */}
                            {!isMe && activeChat.isGroup && showAvatar && (
                              <div className="text-[12px] font-bold text-whatsapp-green mb-1">{msg.from.split('@')[0]}</div>
                            )}

                            {/* Quote/Reply */}
                            {msg.metadata?.quotedMessage && (
                              <div className="mb-1.5 pl-2 border-l-[3px] border-whatsapp-green">
                                <div className="text-[12px] font-bold text-whatsapp-green">{t('chats.you')}</div>
                                <div className="text-[12px] text-muted-foreground truncate">{msg.metadata.quotedMessage.body}</div>
                              </div>
                            )}

                            {/* Media */}
                            {msg.type !== 'text' && !isRevoked && msg.metadata?.media && (
                              <div className="mb-1.5 rounded-md overflow-hidden bg-black/10">
                                {msg.type === 'image' && (
                                  <img src={getMediaSrc(msg.metadata.media)} alt="media" className="max-w-full h-auto rounded" />
                                )}
                                {msg.type === 'video' && (
                                  <video src={getMediaSrc(msg.metadata.media)} controls className="max-w-full rounded" />
                                )}
                                {msg.type === 'audio' && (
                                  <audio src={getMediaSrc(msg.metadata.media)} controls className="w-full" />
                                )}
                                {msg.type === 'document' && (
                                  <a href={getMediaSrc(msg.metadata.media)} download className="p-2 flex items-center gap-2 hover:bg-black/10 transition-colors text-foreground/80">
                                    <Paperclip size={18} />
                                    <span className="truncate text-[13px]">{msg.metadata.media.filename}</span>
                                  </a>
                                )}
                              </div>
                            )}

                            <div className="break-words">
                              {isRevoked ? t('chats.messageDeleted') : msg.body}
                            </div>

                            <div className="flex items-center justify-end gap-1 -mb-[2px]">
                              <span className="text-[11px] text-muted-foreground/70">
                                {formatTime(msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000))}
                              </span>
                              {isMe && !isRevoked && (
                                <span className="flex items-center">
                                  {msg.status === 'pending' && <Clock size={11} className="text-muted-foreground/70" />}
                                  {msg.status === 'sent' && <Check size={11} className="text-muted-foreground/70" weight="bold" />}
                                  {msg.status === 'delivered' && <Checks size={13} className="text-muted-foreground/70" weight="bold" />}
                                  {msg.status === 'read' && <Checks size={13} className="text-[#53bdeb]" weight="bold" />}
                                  {msg.status === 'failed' && <WarningCircle size={11} weight="fill" className="text-destructive" />}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </Fragment>
                    );
                  })
                )}
                <div ref={chatBottomRef} />
              </div>
            </ScrollArea>

            {/* Input Bar */}
            <footer className="relative px-4 pt-[10px] pb-[6px] bg-muted">
              {replyingTo && (
                <div className="mb-2 pl-3 pr-2 py-2 bg-muted rounded-lg flex items-center justify-between border-l-4 border-whatsapp-green animate-in">
                  <div className="flex flex-col min-w-0">
                    <span className="text-[11px] font-bold text-whatsapp-green">
                      {replyingTo.direction === 'outgoing' ? t('chats.you') : activeChat.name}
                    </span>
                    <span className="text-[13px] text-muted-foreground truncate">
                      {replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body}
                    </span>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground" onClick={() => setReplyingTo(null)}>
                    <X size={14} />
                  </Button>
                </div>
              )}

              {attachment && (
                <div className="mb-2 px-3 py-2 bg-muted rounded-lg flex items-center gap-3 animate-in">
                  <div className="h-10 w-10 bg-whatsapp-green/20 rounded flex items-center justify-center text-whatsapp-green">
                    {attachment.mimetype.startsWith('image/') ? <img src={previewUrl!} className="h-full w-full object-cover rounded" /> : <Paperclip size={20} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-foreground font-medium truncate">{attachment.filename}</div>
                    <div className="text-[11px] text-muted-foreground">{(attachment.file.size / 1024).toFixed(1)} KB</div>
                  </div>
                  <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground" onClick={handleRemoveAttachment}>
                    <X size={16} />
                  </Button>
                </div>
              )}

              {/* Emoji picker */}
              {showEmojiPicker && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowEmojiPicker(false)} />
                  <div className="absolute bottom-full mb-1 z-50 flex justify-center w-full pointer-events-none">
                    <div ref={emojiPickerRef} className="pointer-events-auto">
                      <Picker
                        data={data}
                        set="native"
                        onEmojiSelect={handleEmojiSelect}
                        theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
                        previewPosition="none"
                        skinTonePosition="none"
                        perLine={8}
                        maxFrequentRows={2}
                        autoFocus={true}
                      />
                    </div>
                  </div>
                </>
              )}

              <form onSubmit={handleSend} className="flex items-center gap-2 pb-1">
                <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
                
                <Button 
                  type="button" 
                  variant="ghost" 
                  size="icon" 
                  className="rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
                  onClick={triggerFileSelect}
                  disabled={!canWrite || sending}
                >
                  <Paperclip size={22} weight="regular" />
                </Button>

                <Button 
                  type="button" 
                  variant="ghost" 
                  size="icon" 
                  className={cn(
                    "rounded-full transition-colors",
                    showEmojiPicker
                      ? "text-whatsapp-green bg-whatsapp-green/10"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  )}
                  onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                  disabled={!canWrite || sending}
                >
                  <Smiley size={22} weight="regular" />
                </Button>

                <div className="flex-1 relative">
                  <Input
                    value={messageInput}
                    onChange={e => setMessageInput(e.target.value)}
                    placeholder={canWrite ? t('chats.messagePlaceholder') : t('chats.noPermission')}
                    disabled={!canWrite || sending}
                    className="bg-background border-0 rounded-lg py-[9px] px-3 text-foreground placeholder:text-muted-foreground text-[15px] focus-visible:ring-1 focus-visible:ring-whatsapp-green"
                  />
                </div>

                <Button 
                  type="submit" 
                  disabled={!canWrite || (!messageInput.trim() && !attachment) || sending}
                  className="rounded-full bg-whatsapp-green hover:bg-whatsapp-green/90 text-white h-11 w-11 p-0 flex-shrink-0"
                >
                  {sending ? <CircleNotch size={20} className="animate-spin" /> : <PaperPlaneRight size={22} weight="fill" />}
                </Button>
              </form>
            </footer>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-card">
            <div className="mb-8">
              <img src="/openwa_logo.webp" alt="OpenWA" className="h-16 w-16 mx-auto opacity-40" />
            </div>
            <h2 className="text-[28px] font-light text-foreground/80 mb-2">{t('chats.placeholderTitle')}</h2>
            <p className="max-w-md text-[14px] text-muted-foreground">{t('chats.placeholderDesc')}</p>
            <div className="flex items-center gap-2 mt-10 text-muted-foreground/50 text-[12px]">
              End-to-end encrypted
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

