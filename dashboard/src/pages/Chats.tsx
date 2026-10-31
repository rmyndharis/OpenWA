import { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { nextReconnectState } from '../utils/reconnectState';
import { applyIncomingToChatList, promoteChatWithSnippet } from '../utils/chatList';
import {
  applyChatListFilter,
  contactKey,
  phoneContactId,
  savedContactKeySet,
  filterChats,
  filterChannels,
  groupStatusesByContact,
  type ChatListFilter,
} from '../utils/chatFilters';
import {
  ArrowLeft,
  Loader2,
  Megaphone,
  CircleDashed,
  AlertCircle,
  MessageSquare,
  CircleEllipsis,
  Copy,
  PanelRight,
  X,
} from 'lucide-react';
import { useProfilePicture } from '../hooks/useProfilePicture';
import { useProfilePictures } from '../hooks/useProfilePictures';
import { useResolvedPhone, resolvedPhoneQuery, isResolvedPhoneHeld } from '../hooks/useResolvedPhone';
import { chatTitle, formatPhoneForDisplay } from '../utils/formatPhone';
import {
  sessionApi,
  messageApi,
  contactApi,
  asMessageType,
  type Session,
  type Chat,
  type ChatKind,
  type Channel,
  type SearchHit,
  type ContactStatusGroup,
} from '../services/api';
import {
  applyMessageEdit,
  mergeDeliveryStatus,
  mergeReactionSnapshot,
  findRevokedIndex,
  patchMatchingMessage,
  byMessageId,
  getMediaSrc,
  liveMessageMetadata,
  stripMentionDelimiters,
  unacknowledgedIncomingIds,
  type ChatMessageView,
  type MessageMedia,
} from '../utils/chatMessages';
import { useWebSocket } from '../hooks/useWebSocket';
import { createSessionFeedState, noteSessionFeedError, subscribeSessionFeed } from '../utils/sessionFeedSubscription';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { GlobalSearch } from '../components/GlobalSearch';
import {
  useChatMessages,
  useChatMessagesActions,
  messagesQueryKey,
  updateCachedMessages,
  cachedSessionThreads,
  flattenMessagePages,
  type MessagesData,
} from '../hooks/useChatMessages';
import { useChannelMessages } from '../hooks/useChannelMessages';
import { useContactStatuses } from '../hooks/useContactStatuses';
import { useChatScrollPosition } from '../hooks/useChatScrollPosition';
import { createTrailingCoalescer } from '../utils/trailingCoalescer';
import { createReloadCoalescer, type ReloadCoalescer } from '../utils/reloadCoalescer';
import { copyToClipboard } from '../utils/clipboard';
import { statusFontStyle } from '../utils/statusFonts';
import { isComposingKey } from '../utils/composition';
import MessageBody from '../components/chats/MessageBody';
import MediaLightbox, { type LightboxItem } from '../components/chats/MediaLightbox';
import ChatAvatar from '../components/chats/ChatAvatar';
import ChatSidebar from '../components/chats/ChatSidebar';
import NewChatPanel from '../components/chats/NewChatPanel';
import GroupInfoDialog from '../components/chats/GroupInfoDialog';
import { MuteChatDialog, SaveContactDialog, type MuteDuration } from '../components/chats/ChatDialogs';
import type { ChatRowActions } from '../components/chats/chatActionItems';
import { ChatActions } from '../components/chats/ChatRowMenu';
import { Modal } from '../components/Modal';
import ChatThread from '../components/chats/ChatThread';
import ChatComposer, { type StagedAttachment } from '../components/chats/ChatComposer';
import StatusMedia from '../components/chats/StatusMedia';
import StatusComposeModal from '../components/chats/StatusComposeModal';
import './Chats.css';

// Quiet window for coalescing mark-as-read RPCs (see markReadCoalescer below).
const MARK_READ_DEBOUNCE_MS = 750;
// Most messages the gateway takes in one read (MarkChatReadDto).
const MARK_READ_MESSAGE_IDS_MAX = 100;
const readKey = (sessionId: string, chatId: string) => `${sessionId}\u0000${chatId}`;

// How many privacy-id chats a typed number is looked for among, how many are asked about at once, and the least
// time between two such groups. The engine answers one id per request, so searching the whole list would cost a
// request for every chat in it. Only the newest chats are searched: an older conversation opens as a new chat, as
// it does for a number the list has no row for. Raise the cap, or have the gateway name the privacy id of a phone,
// if that proves too few. The gateway lets one client ask this route ten times a second, and a request it refuses
// reads as no phone, so a group of five follows the one before it by a second: half the rate it allows.
const LID_CHATS_SEARCHED = 30;
const LID_LOOKUPS_AT_ONCE = 5;
const LID_LOOKUP_GAP_MS = 1000;

// Longest one background chat-list walk may take before it is abandoned. A walk is a dozen small requests, and
// the gateway answers a stalled engine at 180 s, so this is far above a healthy walk and below that.
const BACKGROUND_RELOAD_DEADLINE_MS = 120_000;

// The image the media viewer shows: its key in the thread, and when its row was made (see `lightbox` below).
type ViewedImage = { key: string; createdAt: string };
const viewedImage = (m: ChatMessageView): ViewedImage => ({ key: m.waMessageId ?? m.id, createdAt: m.createdAt });

// mergeDeliveryStatus (forward-only delivery-tick merge) is shared with mergeOrAppend in utils/chatMessages
// so the WS append path and the ack path apply the exact same rule.

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
  // The backend emits `call` as a top-level field on the live `message.received` event (it's only
  // folded into `metadata` on the persisted/history path), so declare it here to carry it through.
  call?: { video: boolean; missed: boolean };
  /** Business prompt choices (Baileys); top-level on the live event, folded into metadata for the UI. */
  buttons?: Array<{ id: string; text: string }>;
  poll?: { name: string; options: string[]; allowMultipleAnswers: boolean };
  /** Edited before the gateway stored it; its `message.edited` came first, while no thread held it. */
  edited?: boolean;
  metadata?: ChatMessageView['metadata'];
  kind?: ChatKind;
  /** Group poster: `from` is the group JID, so `contact`/`author` identify who actually sent it. */
  contact?: { id?: string; name?: string; pushName?: string };
  author?: string;
}

// The confirmation dialog's copy for each destructive chat row action; its confirm button repeats the title.
const CONFIRM_TEXT = {
  leave: {
    title: 'chats.group.leave',
    question: 'chats.group.leaveConfirm',
    warning: 'chats.group.leaveWarning',
  },
  clear: {
    title: 'chats.rowActions.clear',
    question: 'chats.rowActions.clearConfirm',
    warning: 'chats.rowActions.clearWarning',
  },
  block: {
    title: 'chats.rowActions.block',
    question: 'chats.rowActions.blockConfirm',
    warning: 'chats.rowActions.blockWarning',
  },
  delete: {
    title: 'chats.rowActions.delete',
    question: 'chats.rowActions.deleteConfirm',
    warning: 'chats.rowActions.deleteWarning',
  },
} as const;

export function Chats() {
  const { t } = useTranslation();
  useDocumentTitle(t('nav.chats'));
  const { error: showErrorToast, warning: showWarningToast, success: showSuccessToast } = useToast();
  const { canWrite, engineType } = useRole();

  // Sessions list & active session
  // Every listed session, ready or not: the switcher shows the others with their state.
  const [listedSessions, setListedSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  // The list as last applied, for a status frame to look a session up in. readSessions sets it with the list, not
  // after the render: a status in the same turn as the list's answer must already find its session there.
  const listedSessionsRef = useRef(listedSessions);
  useEffect(() => {
    listedSessionsRef.current = listedSessions;
  });
  // The sessions that can be opened, and the open one while it is down, so the switcher still shows it. Derived
  // rather than kept beside the list: a copy filtered through the selection's ref dropped a session selected in the
  // same turn as a list read answered, before the ref caught up.
  const sessions = useMemo(
    () => listedSessions.filter(s => s.status === 'ready' || s.id === selectedSessionId),
    [listedSessions, selectedSessionId],
  );
  // The session on screen, for requests that answer later to check they still belong to it (synced below, with the
  // socket's refs).
  const selectedSessionRef = useRef(selectedSessionId);
  const [loadingSessions, setLoadingSessions] = useState<boolean>(true);

  // Chats list
  const [chats, setChats] = useState<Chat[]>([]);
  const [loadingChats, setLoadingChats] = useState<boolean>(false);
  // Why the list on screen is not the session's: its last foreground read failed. A list that could not be read
  // is told apart from one that is empty, which the sidebar alone would render the same way.
  const [chatsFailure, setChatsFailure] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [chatFilter, setChatFilter] = useState<ChatListFilter>('all');

  // The new-chat panel replaces the sidebar lists while open; the contact panel (below, with the open chat) sits
  // beside the room, and the room's overflow menu drops from its header.
  const [showNewChat, setShowNewChat] = useState<boolean>(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState<boolean>(false);
  const roomMenuRef = useRef<HTMLDivElement | null>(null);
  const roomMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The group whose info dialog is open, from its row's menu or from the open room's.
  const [groupDialogChat, setGroupDialogChat] = useState<Chat | null>(null);
  // A destructive row action awaiting confirmation, and the one whose request is out. A dialog is busy only
  // while its own request is: the answer of a dialog dismissed meanwhile (Escape, the overlay) neither
  // disables nor closes the next one, so these are compared by identity, never cleared unconditionally.
  const [confirmAction, setConfirmAction] = useState<{
    kind: 'leave' | 'clear' | 'delete' | 'block';
    chat: Chat;
  } | null>(null);
  const [confirmRunning, setConfirmRunning] = useState<typeof confirmAction>(null);
  const confirmBusy = confirmAction !== null && confirmRunning === confirmAction;
  // The archive view of the Chats tab, the chats whose mute or contact dialog is open, and the chat whose
  // mute or contact request is out.
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [muteDialogChat, setMuteDialogChat] = useState<Chat | null>(null);
  const [contactDialogChat, setContactDialogChat] = useState<Chat | null>(null);
  const [dialogRunning, setDialogRunning] = useState<Chat | null>(null);
  // The session a menu has opened on, which is when its entries need that session's address book (see contactsQuery).
  // Keyed by session, and cleared while rendering the switch: an effect would land a render after the new session is
  // selected, when its address book has already been asked for.
  const [menuOpenedFor, setMenuOpenedFor] = useState<string>('');
  if (menuOpenedFor !== '' && menuOpenedFor !== selectedSessionId) setMenuOpenedFor('');

  // Selected chat & message history
  const [activeChat, setActiveChat] = useState<Chat | null>(null);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  // Only the contact id is state — the open group is derived from groupedStatuses at render, so a
  // refetch (window focus, post-compose) flows straight into the open viewer instead of leaving it
  // pinned to the snapshot captured at click time. A group that disappears (all items expired)
  // simply closes the viewer.
  const [activeStatusContactId, setActiveStatusContactId] = useState<string | null>(null);

  // The room whose contact panel is open, by session and chat. The panel belongs to that room and closes with it, on
  // a session switch and when another chat opens: the next room would otherwise open with it, and below 1200px it
  // covers the thread. Cleared while rendering, as menuOpenedFor is.
  const [contactInfoFor, setContactInfoFor] = useState<string>('');
  const openRoomKey = activeChat ? readKey(selectedSessionId, activeChat.id) : '';
  if (contactInfoFor !== '' && contactInfoFor !== openRoomKey) setContactInfoFor('');
  const showContactInfo = contactInfoFor !== '' && contactInfoFor === openRoomKey;
  const contactInfoLabel = activeChat?.isGroup ? t('chats.group.info') : t('chats.contactInfo');
  // Closing the panel unmounts its close button, so focus goes back to the button that toggles it.
  const contactToggleRef = useRef<HTMLButtonElement | null>(null);
  const closeContactInfo = () => {
    setContactInfoFor('');
    contactToggleRef.current?.focus();
  };

  // Chats/Channels/Status tab selection. Switching tabs closes whatever conversation is open so a
  // press on another tab doesn't leave a Chats-tab room rendered underneath a Channels/Status list.
  const [activeTab, setActiveTab] = useState<'chats' | 'channels' | 'status'>('chats');
  const switchTab = useCallback((tab: 'chats' | 'channels' | 'status') => {
    setActiveTab(tab);
    setActiveChat(null);
    setActiveChannel(null);
    setActiveStatusContactId(null);
  }, []);

  // Channels tab: only whatsapp-web.js implements channel listing/reading — Baileys throws 501 for
  // both, so the query is gated off entirely (never fired) rather than left to fail per-request.
  // The engine comes from the sign-in validate response, which every role can read.
  const channelsSupported = engineType === 'whatsapp-web.js';
  const channelsQuery = useQuery({
    queryKey: ['channels', selectedSessionId],
    queryFn: () => sessionApi.getSubscribedChannels(selectedSessionId!),
    enabled: Boolean(selectedSessionId) && channelsSupported && activeTab === 'channels',
  });
  const channelMessages = useChannelMessages(selectedSessionId, activeChannel?.id ?? null);

  // Status tab: both engines expose stored status content, so this query isn't engine-gated (unlike
  // channelsQuery above) — but it is tab-gated the same way, so selecting a session on another tab
  // doesn't fire a background /status fetch nobody is looking at.
  const statusesQuery = useContactStatuses(selectedSessionId, activeTab === 'status');

  // A channel feed opens at its newest post, mirroring the chat room's initial scroll. The pane is
  // also keyed by channel id, so switching channels remounts the feed instead of reusing the DOM
  // (and its stale scroll offset) of the previous channel.
  const channelFeedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = channelFeedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeChannel?.id, channelMessages.data]);

  // --- Status compose modal ---
  // The page owns only the open flag (its trigger sits in the sidebar header below); the form
  // itself — state, contacts query, submit — is components/chats/StatusComposeModal.
  const [composeOpen, setComposeOpen] = useState<boolean>(false);

  const {
    data: messages = [],
    isLoading: loadingMessages,
    isError: messagesError,
    hasNextPage: hasMoreMessages,
    isFetchingNextPage: loadingOlderMessages,
    fetchNextPage,
  } = useChatMessages(
    selectedSessionId,
    activeChat?.id ?? null,
    // Baileys has no live per-chat history read and answers 501 to it; any other or unknown engine is asked.
    engineType !== 'baileys',
  );
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const queryClient = useQueryClient();

  // The media viewer holds the message it shows by the key the thread merges by (waMessageId ?? id, kept when a refetch
  // swaps a live row for its stored one), never by list position: the image list is rebuilt from the live thread. An
  // image still being sent is held under its placeholder's temp_ id, and ChatComposer reports the real key once the
  // send is confirmed (an echo of the send can restamp the row's createdAt before the page draws it). A viewer
  // opened on the placeholder after that report finds the confirmed row by the placeholder's createdAt, which the
  // composer spreads into it.
  const [lightbox, setLightbox] = useState<ViewedImage | null>(null);

  const [replyingTo, setReplyingTo] = useState<ChatMessageView | null>(null);
  // The open room's draft text lives here (not in ChatComposer) so it survives closing and reopening the room. Each
  // thread keeps its own (see the drafts effect below): text carried into another chat would be sent to it.
  const [messageInput, setMessageInput] = useState<string>('');
  // The staged attachment lives here for the same reason the draft text does: ChatComposer unmounts when the room
  // closes, which would silently discard a picked file. It is dropped when a DIFFERENT chat is opened (see the effect
  // below): a file that follows the user into another conversation can be sent to the wrong recipient.
  const [attachment, setAttachment] = useState<StagedAttachment | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Revoke the object URL created for an image-attachment preview once it is replaced or cleared.
  // The cleanup runs with the previous value on every change, so this single effect covers all
  // paths (new file, remove, send, chat switch) — otherwise each preview leaks a blob held for the
  // lifetime of the document. It lives here, not in ChatComposer: revoking on the composer's
  // unmount would hand a reopened room a dead blob URL for an attachment that is still staged.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  // Drop a staged attachment and a staged reply when the user moves to a DIFFERENT chat. Closing the
  // room (`activeChat` → null) deliberately keeps them, so close/reopen is a lossless round trip; only
  // an actual change of conversation clears. A reply carried across would quote the previous chat's
  // message, text and sender included, into the new one. The composer invalidates its in-flight
  // FileReader on the same transition, so a late read cannot re-stage the file against the new chat.
  const lastRoomIdRef = useRef<string | null>(null);
  useEffect(() => {
    const current = activeChat?.id ?? null;
    if (current === null) return;
    const previous = lastRoomIdRef.current;
    lastRoomIdRef.current = current;
    if (previous === null || previous === current) return;
    setAttachment(null);
    setPreviewUrl(null);
    setReplyingTo(null);
  }, [activeChat]);

  // Each thread, by session and chat, keeps the text typed into it. Opening another one, in this session or another,
  // puts the composer's text away under the thread it was typed in and brings back the one of the thread opened;
  // closing the room and reopening it changes nothing. A layout effect, so the next room is never drawn with the text of
  // the last one.
  const draftsRef = useRef(new Map<string, string>());
  const draftKeyRef = useRef<string | null>(null);
  const openChatId = activeChat?.id;
  useLayoutEffect(() => {
    if (openChatId === undefined) return;
    const key = readKey(selectedSessionId, openChatId);
    const previous = draftKeyRef.current;
    if (previous === key) return;
    draftKeyRef.current = key;
    if (previous !== null && messageInput !== '') draftsRef.current.set(previous, messageInput);
    setMessageInput(draftsRef.current.get(key) ?? '');
    draftsRef.current.delete(key);
  }, [selectedSessionId, openChatId, messageInput]);

  // Per-chat scroll-position memory + auto-scroll heuristic.
  // Pass `messages.length > 0` as the loaded signal: it stays stable once the
  // chat has any message (doesn't toggle per append) and covers both the
  // first-fetch resolution and a WS-driven first message on a previously-empty
  // chat. `loadingMessages` alone would miss the latter case.
  // The position is kept per thread, so the key carries the session: a group both numbers belong to has one chat
  // id and two threads, and the offset read in one is not a place in the other.
  const {
    containerRef: messagesContainerRef,
    onMessageAppended,
    onMediaLoad,
    measureMedia,
    onOlderMessagesRequested,
  } = useChatScrollPosition(
    activeChat ? `${selectedSessionId}:${activeChat.id}` : null,
    messages.length > 0,
    loadingOlderMessages,
  );

  const handleLoadOlderMessages = useCallback(() => {
    onOlderMessagesRequested();
    void fetchNextPage();
  }, [fetchNextPage, onOlderMessagesRequested]);

  // Batch profile-picture fetch for the visible chat list — ONE request for the whole sidebar
  // (per-row queries burst the per-IP throttle into 429s). Sorted-key cached 1h; rows fall back
  // to the generic icon for ids that resolve null.
  const chatIds = useMemo(() => chats.map(c => c.id), [chats]);
  const listPics = useProfilePictures(selectedSessionId || undefined, chatIds);

  // Profile-picture fetch for the active room (cached 1h by useProfilePicture; TanStack Query
  // dedupes, so other components querying the same key share this slice).
  const activePp = useProfilePicture(selectedSessionId || undefined, activeChat?.id);

  // Header phone line. Local formatting handles @c.us ids offline; for anything else personal
  // (notably @lid privacy ids, which are NOT phones and must never be formatted as one) resolve
  // the real number through the engine — cached a day, and only fired when local formatting failed.
  const activePhoneDisplay = activeChat ? formatPhoneForDisplay(activeChat.id) : null;
  const needsPhoneResolution = Boolean(activeChat && activeChat.kind === 'individual' && !activePhoneDisplay);
  const resolvedPhoneQ = useResolvedPhone(
    needsPhoneResolution ? selectedSessionId || undefined : undefined,
    needsPhoneResolution ? activeChat?.id : undefined,
  );
  const activePhoneText =
    activePhoneDisplay ?? (resolvedPhoneQ.data ? formatPhoneForDisplay(resolvedPhoneQ.data) : null);
  // An unnamed chat is titled by its number when one is known, never by the bare digits of its id (a @lid's are no
  // phone). Shown, that number is isolated left to right, as it is under a name.
  const activeChatTitle = activeChat ? activeChat.name || activePhoneText || activeChat.id.split('@')[0] : '';
  const activeChatTitleText =
    activeChat && !activeChat.name && activePhoneText ? <bdi dir="ltr">{activePhoneText}</bdi> : activeChatTitle;

  // The list loaders below reach the translator and the error toast through a ref, not as
  // dependencies: both change identity on a language switch, which re-ran the session load (it
  // reselected the first session) and, through loadChats, the session-reset effect (it closed the
  // open chat and dropped a staged file or reply).
  const loadErrorRef = useRef({ t, showErrorToast });
  useEffect(() => {
    loadErrorRef.current = { t, showErrorToast };
  });
  const showLoadError = useCallback((key: string, err: unknown) => {
    const current = loadErrorRef.current;
    current.showErrorToast(current.t(key), err instanceof Error ? err.message : undefined);
  }, []);

  // 1. Fetch available connected sessions on mount. A failed read is not "no connected sessions": the gateway may
  // simply be restarting, so the page says it could not read them and offers the read again.
  const [sessionsFailure, setSessionsFailure] = useState<string | null>(null);
  // Every read of the session list goes through here and is numbered: an answer is applied only if no read sent
  // after it has been, since the read at load can answer after a relist a status frame started and would put back
  // the states from before it. An answer that is dropped, or fails, after a newer one was applied resolves to that
  // newer list. A selected session the list no longer holds was deleted, so it counts as none selected: the first
  // ready session is opened, or none, and the session effect clears what belonged to it.
  const sessionReadsRef = useRef({ sent: 0, applied: 0, list: [] as Session[] });
  const readSessions = useCallback(async (): Promise<Session[]> => {
    const reads = sessionReadsRef.current;
    const request = ++reads.sent;
    let list: Session[];
    try {
      list = await sessionApi.list();
    } catch (err) {
      if (request < reads.applied) return reads.list;
      throw err;
    }
    if (request < reads.applied) return reads.list;
    reads.applied = request;
    reads.list = list;
    listedSessionsRef.current = list;
    setSessionsFailure(null);
    setListedSessions(list);
    const firstReady = list.find(s => s.status === 'ready')?.id ?? '';
    setSelectedSessionId(selected => (list.some(s => s.id === selected) ? selected : firstReady));
    return list;
  }, []);
  const loadSessions = useCallback(async () => {
    try {
      setLoadingSessions(true);
      setSessionsFailure(null);
      await readSessions();
    } catch (err) {
      setSessionsFailure(err instanceof Error ? err.message : '');
    } finally {
      setLoadingSessions(false);
    }
  }, [readSessions]);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  // 2. Fetch chats when active session changes. A session switch does not cancel the list still
  // loading for the session left behind, so an answer for any session but the latest call's is
  // dropped, or it would put that account's chats under the selected session. Within one session an
  // answer is dropped only once a newer one has landed: dropping every answer a newer call overtook
  // left a burst of realtime refetches with no list at all, each miss firing the next refetch.
  // A realtime refetch runs in the background, keeping the current list on screen.
  const chatsLoadsRef = useRef(new Set<AbortController>());
  const chatsRequestRef = useRef(0);
  const chatsAppliedRef = useRef(0);
  const chatsSessionRef = useRef('');
  // The session whose list `chats` holds, which a switch leaves on screen until the new list lands.
  const listedSessionRef = useRef('');
  // The newest request number out when a live frame last moved each chat's row. A send stamps its row
  // with the browser clock, so only this, not a newer timestamp, shows a row changed after a refetch left.
  const liveRowsRef = useRef(new Map<string, number>());
  // The same stamp for the page's own changes to a row (a pin, an archive, a mute, a mark as unread, a rename),
  // with what each changed: a refetch asked for before the change answers with the flags from before it, and
  // keeps these over them. One that was asked for after the change already carries it, so it drops the entry.
  const patchedRowsRef = useRef(new Map<string, { request: number; patch: Partial<Chat> }>());
  const rememberPatch = useCallback((chatId: string, patch: Partial<Chat>) => {
    const held = patchedRowsRef.current.get(chatId);
    patchedRowsRef.current.set(chatId, { request: chatsRequestRef.current, patch: { ...held?.patch, ...patch } });
  }, []);
  // A chat the page deleted, with the newest request number out then. A list asked for at or before that still
  // holds the chat and would bring it back; one asked for after it is as good as the engine's own answer.
  const deletedRowsRef = useRef(new Map<string, number>());
  // A chat this page has read shows nothing unread, and a reload asked for before the read keeps it so. That also
  // replaces a Mark as unread still remembered for the chat, which the read has undone. A session switch leaves the
  // open chat the previous account's for one render, and that account's row must not be remembered for this one.
  const markRowRead = useCallback(
    (chatId: string) => {
      if (listedSessionRef.current !== selectedSessionId) return;
      rememberPatch(chatId, { unreadCount: 0 });
      setChats(prev => prev.map(c => (c.id === chatId ? { ...c, unreadCount: 0 } : c)));
    },
    [rememberPatch, selectedSessionId],
  );
  const loadChats = useCallback(
    async (
      sessionId: string,
      { background = false, signal }: { background?: boolean; signal?: AbortSignal } = {},
    ): Promise<boolean> => {
      if (!sessionId) return false;
      const controller = new AbortController();
      // The caller's own deadline ends this load the way a session switch does.
      const abortWithCaller = () => controller.abort();
      if (signal?.aborted) abortWithCaller();
      else signal?.addEventListener('abort', abortWithCaller, { once: true });
      chatsLoadsRef.current.add(controller);
      const request = ++chatsRequestRef.current;
      chatsSessionRef.current = sessionId;
      const stale = () =>
        controller.signal.aborted || sessionId !== chatsSessionRef.current || request < chatsAppliedRef.current;
      // A stale answer for the session still selected was overtaken by a newer list that has applied,
      // so this session's list on screen is as fresh as this call's would have been.
      const overtaken = () => !controller.signal.aborted && sessionId === chatsSessionRef.current;
      try {
        if (!background) {
          setLoadingChats(true);
          setChatsFailure(null);
        }
        const data = await sessionApi.getChats(sessionId, controller.signal);
        if (stale()) return overtaken();
        chatsAppliedRef.current = request;
        setChatsFailure(null);
        // A live frame can move a row past the snapshot a background refetch was built from while it is
        // out. That row is kept, or its preview and unread badge would roll back until the next message.
        const moved = (id: string) => (liveRowsRef.current.get(id) ?? 0) >= request;
        // The page's own changes this snapshot predates. Read before the updater, which React may run later.
        const patches = new Map<string, Partial<Chat>>();
        for (const [id, entry] of patchedRowsRef.current) {
          if (entry.request >= request) patches.set(id, entry.patch);
          else patchedRowsRef.current.delete(id);
        }
        const gone = new Set<string>();
        for (const [id, deletedAt] of deletedRowsRef.current) {
          if (deletedAt >= request) gone.add(id);
          else deletedRowsRef.current.delete(id);
        }
        const listed = data.filter(c => !gone.has(c.id));
        const merge = background && listedSessionRef.current === sessionId;
        listedSessionRef.current = sessionId;
        setChats(prev => {
          const live = new Map(merge ? prev.map(c => [c.id, c] as const) : []);
          const fetchedIds = new Set(listed.map(c => c.id));
          const rows = [...listed, ...prev.filter(c => merge && moved(c.id) && !fetchedIds.has(c.id))];
          return rows
            .map(c => {
              const row = live.get(c.id);
              // A row a live frame moved already carries the page's changes and what the frame added.
              if (row && moved(c.id) && (row.timestamp || 0) > (c.timestamp || 0)) return row;
              const patch = patches.get(c.id);
              return patch ? { ...c, ...patch } : c;
            })
            .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        });
        return true;
      } catch (err) {
        if (stale()) return overtaken();
        // A background refetch only refreshes summaries: keep the list it would have replaced.
        if (background) return false;
        setChatsFailure(err instanceof Error ? err.message : '');
        listedSessionRef.current = sessionId;
        setChats([]);
        return false;
      } finally {
        signal?.removeEventListener('abort', abortWithCaller);
        chatsLoadsRef.current.delete(controller);
        // Only the call that raised the spinner clears it: a background refetch settling first would
        // otherwise uncover the previous session's list while the switch's own load is still out.
        if (!background && !controller.signal.aborted && sessionId === chatsSessionRef.current) setLoadingChats(false);
      }
    },
    [],
  );

  // A reload walks every page of the list, and each live event the sidebar cannot apply locally asks for
  // one, so a burst of them must not start a walk apiece: per session one runs at a time and whatever
  // arrives meanwhile shares a single trailing reload (utils/reloadCoalescer). Foreground loads stay out of
  // it. The session effect below drops the trailing reload on a switch or unmount: started after one, it
  // would point chatsSessionRef back at the session left and strand the new session's own list. A walk
  // that never answers is abandoned at BACKGROUND_RELOAD_DEADLINE_MS, or every later trigger, the reconnect
  // refresh included, would wait behind it.
  const backgroundReloadsRef = useRef(new Map<string, ReloadCoalescer>());
  const reloadChatsInBackground = useCallback(
    (sessionId: string): Promise<boolean> => {
      const reloads = backgroundReloadsRef.current;
      let reload = reloads.get(sessionId);
      if (!reload) {
        reload = createReloadCoalescer(signal => loadChats(sessionId, { background: true, signal }), {
          deadlineMs: BACKGROUND_RELOAD_DEADLINE_MS,
        });
        reloads.set(sessionId, reload);
      }
      return reload.run();
    },
    [loadChats],
  );

  // A send resolves after the await, possibly once another session's list is on screen. That list can
  // hold a chat with the same id (a group or contact both accounts share), so the promote only applies
  // to the session the send started in.
  const promoteSentChat = useCallback((sessionId: string, chatId: string, snippet: string, sentAt: number) => {
    if (sessionId !== chatsSessionRef.current) return;
    setChats(prev => promoteChatWithSnippet(prev, chatId, snippet, sentAt));
  }, []);

  useEffect(() => {
    const loads = chatsLoadsRef.current;
    const reloads = backgroundReloadsRef.current;
    // A session deleted while it was open leaves none selected when no other is ready: what belonged to it is
    // cleared all the same, with no list to load in its place.
    if (selectedSessionId) void loadChats(selectedSessionId);
    setActiveChat(null);
    setActiveChannel(null);
    setActiveStatusContactId(null);
    // A staged attachment or reply belongs to a chat in the session being left, so it is dropped here
    // rather than carried across — the close/reopen round trip that preserves it is scoped to a
    // single session. Clearing previewUrl runs the revoke effect's cleanup; the composer
    // unmounts with the closed room and invalidates its own in-flight FileReader.
    setAttachment(null);
    setPreviewUrl(null);
    setReplyingTo(null);
    lastRoomIdRef.current = null;
    // The new-chat panel lists the address book of the session being left, and an open group dialog
    // edits a group through it.
    setShowNewChat(false);
    setGroupDialogChat(null);
    setConfirmAction(null);
    setMuteDialogChat(null);
    setContactDialogChat(null);
    setShowArchived(false);
    return () => {
      for (const controller of loads) controller.abort();
      loads.clear();
      for (const reload of reloads.values()) reload.cancel();
    };
  }, [selectedSessionId, loadChats]);

  // Coalesce mark-as-read RPCs per chat: every incoming message in the visible chat raises a
  // read event, and a per-event POST sprays the gateway into 429s. One trailing call per chat
  // after a quiet window carries the same effect.
  // A chat marked unread takes no automatic read until it is opened again, and Mark as unread waits for a
  // read already sent: otherwise a read queued from the open room lands after the unread and undoes it.
  // Keyed by session and chat, since a session switch still flushes the previous session's reads.
  // A read due while the tab is hidden is withheld, since nobody has seen what it would acknowledge: it goes out
  // when the tab is visible again (see sendWithheldRead).
  const [readsInFlight] = useState(() => new Map<string, Promise<void>>());
  const [keptUnread] = useState(() => new Set<string>());
  const [withheldReads] = useState(() => new Set<string>());
  // Baileys acknowledges the messages a read names, and without any only the newest one it holds. A read names the
  // incoming messages of the thread that an earlier read has not acknowledged (the ones it named, per chat).
  const [acknowledged] = useState(() => new Map<string, Set<string>>());
  // The read the gateway last acknowledged for the chat on screen (see the effect that zeroes its row).
  const [readAck, setReadAck] = useState<{ sessionId: string; chatId: string } | null>(null);
  const markReadCoalescer = useMemo(
    () =>
      createTrailingCoalescer<string>(chatId => {
        const key = readKey(selectedSessionId, chatId);
        if (document.visibilityState === 'hidden') {
          withheldReads.add(key);
          return;
        }
        let named: string[] = [];
        if (engineType === 'baileys') {
          const thread = queryClient.getQueryData<MessagesData>(messagesQueryKey(selectedSessionId, chatId));
          named = unacknowledgedIncomingIds(
            thread ? flattenMessagePages(thread) : [],
            acknowledged.get(key) ?? new Set(),
            MARK_READ_MESSAGE_IDS_MAX,
          );
        }
        const read = sessionApi.markChatRead(selectedSessionId, chatId, named).then(
          result => {
            if (!result.success) return;
            // The chat still open has nothing unread now (see the effect on readAck).
            setReadAck({ sessionId: selectedSessionId, chatId });
            if (named.length === 0) return;
            const sent = acknowledged.get(key) ?? new Set<string>();
            for (const id of named) sent.add(id);
            acknowledged.set(key, sent);
          },
          err => {
            showWarningToast(t('chats.errors.markRead'), err instanceof Error ? err.message : undefined);
          },
        );
        readsInFlight.set(key, read);
        void read.finally(() => {
          if (readsInFlight.get(key) === read) readsInFlight.delete(key);
        });
      }, MARK_READ_DEBOUNCE_MS),
    [selectedSessionId, t, showWarningToast, readsInFlight, withheldReads, acknowledged, engineType, queryClient],
  );

  // Flush pending trailing calls on unmount / session switch: the mark-as-read POST is
  // fire-and-forget (a failure only raises a warning toast), so firing on the way out is safe —
  // and dropping the pending call would leave the last messages of a quickly-exited chat unread.
  // The flush closure still references the PREVIOUS session on a session switch, which is exactly
  // where those queued reads belong. Logout removes the key before the page unmounts, though: a
  // read flushed then goes out keyless and its 401 reloads the login form, so drop it instead.
  useEffect(
    () => () => {
      if (sessionStorage.getItem('openwa_api_key')) markReadCoalescer.flush();
      else markReadCoalescer.cancel();
    },
    [markReadCoalescer],
  );

  // Marking a chat read is an operator write; a read-only key would only collect 403 toasts.
  // A session switch rebuilds the coalescer for the new session one render before the open chat is
  // cleared, so until the new session's list is on screen the open chat is still the previous
  // account's and nothing is marked read.
  const markChatRead = useCallback(
    (chatId: string) => {
      if (keptUnread.has(readKey(selectedSessionId, chatId))) return;
      if (canWrite && listedSessionRef.current === selectedSessionId) markReadCoalescer.call(chatId);
    },
    [markReadCoalescer, canWrite, selectedSessionId, keptUnread],
  );

  // 3. WebSocket integration for real-time messages
  // Synced in a layout effect: a socket frame handled after the list commits but before passive
  // effects flush would otherwise see the previous list, miss the chat and refetch the whole list.
  const chatsRef = useRef(chats);
  const activeChatIdRef = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    chatsRef.current = chats;
    activeChatIdRef.current = activeChat?.id;
    selectedSessionRef.current = selectedSessionId;
  });
  // A request that settles after the page is left no longer finds the chat open, so its follow-ups
  // (the reconnect mark-as-read) do nothing.
  useEffect(
    () => () => {
      activeChatIdRef.current = undefined;
    },
    [],
  );

  // A list asked for before a read reached the gateway still counts what came before it, so once the gateway has
  // acknowledged the read the row of the chat still open is zeroed through the remembered patches, which keep the
  // zero over such a list. A chat that was left in the meantime keeps whatever count it has gathered since.
  useEffect(() => {
    if (readAck && canWrite && readAck.sessionId === selectedSessionId && readAck.chatId === activeChat?.id) {
      markRowRead(readAck.chatId);
    }
  }, [readAck, canWrite, selectedSessionId, activeChat?.id, markRowRead]);

  // The read withheld from a hidden tab is sent when the tab is visible again, if its chat is still the open one.
  useEffect(() => {
    const sendWithheldRead = () => {
      if (document.visibilityState === 'hidden') return;
      const open = activeChatIdRef.current;
      const withheld = open !== undefined && withheldReads.has(readKey(selectedSessionId, open));
      withheldReads.clear();
      if (!withheld) return;
      markChatRead(open);
      // The messages that came while the tab was hidden are counted unread by any list reloaded meanwhile, and
      // are read now: the row says so, as it does when the chat is opened.
      if (canWrite) markRowRead(open);
    };
    document.addEventListener('visibilitychange', sendWithheldRead);
    return () => document.removeEventListener('visibilitychange', sendWithheldRead);
  }, [selectedSessionId, markChatRead, markRowRead, canWrite, withheldReads]);

  const handleIncomingMessage = useCallback(
    (event: { sessionId: string; message: Record<string, unknown> }) => {
      if (event.sessionId !== selectedSessionId) return;

      const newMsg = event.message as unknown as IncomingWsMessage;
      if (
        cachedSessionThreads(
          queryClient,
          event.sessionId,
          m => m.chatId === newMsg.chatId && byMessageId(newMsg.id)(m) && m.type === 'revoked',
        ).length
      ) {
        return;
      }

      const mappedMessage: ChatMessageView = {
        id: newMsg.id,
        waMessageId: newMsg.id,
        chatId: newMsg.chatId,
        // For a group post `from` is the group JID, so the sender's name is carried on `contact`.
        // Persisted rows keep the same value in `chatName`; normalize both to one field for the thread.
        chatName: newMsg.contact?.pushName ?? newMsg.contact?.name,
        author: newMsg.author,
        from: newMsg.from,
        to: newMsg.to,
        body: newMsg.body,
        type: asMessageType(newMsg.type),
        direction: newMsg.fromMe ? 'outgoing' : 'incoming',
        status: 'sent',
        timestamp: newMsg.timestamp,
        createdAt: new Date(newMsg.timestamp * 1000).toISOString(),
        metadata: liveMessageMetadata(newMsg),
        kind: newMsg.kind,
      };

      // A message the thread already holds merges into its row and adds none (the echo of a send after its response,
      // a message delivered twice), so the scroll heuristic below is not told to expect one.
      const addsRow =
        cachedSessionThreads(queryClient, event.sessionId, m => m.chatId === newMsg.chatId && byMessageId(newMsg.id)(m))
          .length === 0;

      // Always write to the React Query cache for this message's session — keeps non-active chats
      // up to date so re-opening them shows fresh data without a refetch.
      appendMessage(event.sessionId, newMsg.chatId, mappedMessage);

      // If the message belongs to the currently visible chat, mark-as-read and run the scroll heuristic. Own-account
      // messages (the phone, an API client, an automation) follow a reader at the bottom like any other; a send from
      // this page scrolled through the composer, and its echo finds the reader there already.
      if (activeChat && newMsg.chatId === activeChat.id) {
        markChatRead(activeChat.id);
        if (addsRow) onMessageAppended('incoming');
      }

      // Update sidebar chat list. Whether the chat is missing is decided against the list on screen,
      // never inside the updater: React double-invokes updaters under StrictMode, and it may defer
      // one to the next render, so a flag set in there was still false when read here and a chat the
      // sidebar does not list never appeared.
      const listOptions = {
        // Only a chat this key marks read is exempt from the unread count (see markChatRead).
        activeChatId: canWrite ? activeChat?.id : undefined,
        // A location message's body is the (multi-KB) base64 map thumbnail; show a label instead.
        locationLabel: `📍 ${t('chats.media.location')}`,
      };
      liveRowsRef.current.set(newMsg.chatId, chatsRequestRef.current);
      const { needsSidebarRefetch } = applyIncomingToChatList(chatsRef.current, newMsg, listOptions);
      setChats(prevChats => applyIncomingToChatList(prevChats, newMsg, listOptions).chats);
      if (needsSidebarRefetch) {
        void reloadChatsInBackground(selectedSessionId);
      }
    },
    [
      selectedSessionId,
      activeChat,
      canWrite,
      reloadChatsInBackground,
      markChatRead,
      appendMessage,
      onMessageAppended,
      queryClient,
      t,
    ],
  );

  const handleIncomingMessageAck = useCallback(
    (event: { sessionId: string; messageId: string; status: ChatMessageView['status'] }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Acks can arrive for any cached chat under this session, so every thread is checked.
      for (const [key, thread] of cachedSessionThreads(queryClient, event.sessionId, byMessageId(event.messageId))) {
        const target = thread.find(byMessageId(event.messageId));
        if (!target) continue;
        // Backend now sends the neutral delivery status directly (no engine-specific ack codes).
        // Merge forward-only so an out-of-order/replayed lower ack can't downgrade the tick.
        const nextStatus = mergeDeliveryStatus(target.status, event.status) ?? target.status;
        if (nextStatus === target.status) continue;
        updateCachedMessages(queryClient, key, list =>
          patchMatchingMessage(list, event.messageId, m => ({ ...m, status: nextStatus })),
        );
      }
    },
    [selectedSessionId, queryClient],
  );

  const handleIncomingMessageReaction = useCallback(
    (event: { sessionId: string; messageId: string; reactions?: Record<string, string> }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Reactions update `metadata.reactions` while preserving `metadata.media` / `metadata.quotedMessage`,
      // so we must read the prior message and deep-merge — `updateMessage`'s shallow merge would clobber
      // the rest of metadata.
      //
      // The absent-vs-empty distinction on `reactions` is mergeReactionSnapshot's job; it is a named
      // function so the behaviour is covered by a test, because nothing here is.
      for (const [key] of cachedSessionThreads(queryClient, event.sessionId, byMessageId(event.messageId))) {
        updateCachedMessages(queryClient, key, list =>
          patchMatchingMessage(list, event.messageId, m =>
            m.type === 'revoked'
              ? m
              : {
                  ...m,
                  metadata: {
                    ...(m.metadata || {}),
                    reactions: mergeReactionSnapshot(m.metadata?.reactions, event.reactions),
                  },
                },
          ),
        );
      }
    },
    [selectedSessionId, queryClient],
  );

  const handleIncomingMessageRevoked = useCallback(
    (event: { sessionId: string; id: string; revokedId?: string; chatId: string; type: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      // Walk every cached chat under this session, find the deleted message and zero it — the
      // backend emits an empty body; the localized "deleted" label is rendered below. Matching is
      // in findRevokedIndex: the event carries two candidate ids and wwebjs's `id` alone can miss.
      const revoked = (m: ChatMessageView): boolean => findRevokedIndex([m], event) !== -1;
      let matchedCachedMessage = false;
      let revokedLastMessage = false;
      for (const [key, thread] of cachedSessionThreads(queryClient, event.sessionId, revoked)) {
        matchedCachedMessage = true;
        // The sidebar previews the newest row, so only deleting that one changes it.
        if (key[2] === event.chatId && findRevokedIndex(thread, event) === thread.length - 1) {
          revokedLastMessage = true;
        }
        updateCachedMessages(queryClient, key, list => {
          const idx = findRevokedIndex(list, event);
          if (idx === -1) return list;
          const next = list.slice();
          next[idx] = { ...next[idx], body: '', type: asMessageType(event.type), metadata: undefined };
          return next;
        });
      }
      if (revokedLastMessage) {
        setChats(previous =>
          previous.map(chat =>
            chat.id === event.chatId ? { ...chat, lastMessage: '', lastMessageType: 'revoked' } : chat,
          ),
        );
      } else if (!matchedCachedMessage) {
        // No cached thread proves whether the deleted message was the chat's newest; refresh the
        // summaries, as an edit does.
        void reloadChatsInBackground(selectedSessionId);
      }
    },
    [selectedSessionId, queryClient, reloadChatsInBackground],
  );

  const handleIncomingMessageEdited = useCallback(
    (event: { sessionId: string; messageId: string; chatId: string; body: string }) => {
      if (event.sessionId !== selectedSessionId) return;

      let matchedCachedMessage = false;
      let editedLastMessage = false;
      for (const [key, thread] of cachedSessionThreads(queryClient, event.sessionId, byMessageId(event.messageId))) {
        // Position is asked of the merged thread, never of a page: pages carry only a fraction of
        // the chat each, so "is this the last message" is only ever answerable from the whole thing.
        const editedIndex = thread.findIndex(byMessageId(event.messageId));
        if (editedIndex === -1 || thread[editedIndex].type === 'revoked') continue;
        matchedCachedMessage = true;
        updateCachedMessages(queryClient, key, list => applyMessageEdit(list, event));

        // Only editing the newest row changes the sidebar preview. Confirm the thread belongs to
        // the event chat before touching that summary.
        if (key[2] === event.chatId && editedIndex === thread.length - 1) editedLastMessage = true;
      }
      if (editedLastMessage) {
        setChats(previous =>
          previous.map(chat => (chat.id === event.chatId ? { ...chat, lastMessage: event.body } : chat)),
        );
      } else if (!matchedCachedMessage) {
        // The chat may never have been opened, so there is no message cache from which to prove
        // whether this was its latest row. Refresh summaries instead of guessing and overwriting the
        // sidebar with the body of an older edited message.
        void reloadChatsInBackground(selectedSessionId);
      }
    },
    [selectedSessionId, queryClient, reloadChatsInBackground],
  );

  // A contact's new story lands here instead of in the message pipeline; invalidate the statuses
  // query so the Status tab refetches live. A disabled query (another tab active) just goes stale
  // and refetches on open — no background fetch either way.
  const handleStatusReceived = useCallback(
    (event: { sessionId: string }) => {
      queryClient.invalidateQueries({ queryKey: ['contact-statuses', event.sessionId] });
    },
    [queryClient],
  );

  // The session switcher shows every session's state and lets only a ready one be picked, so both lists
  // follow the live session feed the Sessions page uses (the '*' room, or one room per listed session for
  // a session-scoped key) instead of the read at mount alone. The open session stays selectable when it
  // drops, so the page does not switch away under the operator.
  const sessionFeedRef = useRef(createSessionFeedState());
  const [sessionFeedError, setSessionFeedError] = useState<string | null>(null);
  // A session created after the list was read reports a status the list has no row for. The list is read again,
  // which brings its name and number along; a status that arrives while that read is out asks for one more after it,
  // since the read may have been answered before the change.
  const relistRef = useRef({ running: false, again: false });
  const relistSessions = useCallback(async () => {
    const relist = relistRef.current;
    if (relist.running) {
      relist.again = true;
      return;
    }
    relist.running = true;
    try {
      do {
        relist.again = false;
        await readSessions();
      } while (relist.again);
    } catch {
      // The next status event, the page being shown again, or a search hit in that session, reads the list again.
    } finally {
      relist.running = false;
    }
  }, [readSessions]);
  // A deleted session sends no frame of its own: a running one reports disconnected while its row still exists, and
  // one that was not running reports nothing. Coming back to the page reads the list again, so a session deleted
  // from another tab or by another client is not kept open.
  useEffect(() => {
    const relistWhenShown = () => {
      if (document.visibilityState !== 'hidden') void relistSessions();
    };
    document.addEventListener('visibilitychange', relistWhenShown);
    return () => document.removeEventListener('visibilitychange', relistWhenShown);
  }, [relistSessions]);
  const handleSessionStatus = useCallback(
    (event: { sessionId: string; status: string }) => {
      if (!listedSessionsRef.current.some(session => session.id === event.sessionId)) {
        void relistSessions();
        return;
      }
      const status = event.status as Session['status'];
      const withStatus = (session: Session) => (session.id === event.sessionId ? { ...session, status } : session);
      setListedSessions(prev => prev.map(withStatus));
      // loadSessions selects the first ready session; when every session was down at load nothing is selected, so
      // the first one that connects is (the switcher would be blank and the list empty otherwise).
      if (status === 'ready') setSelectedSessionId(selected => selected || event.sessionId);
      // A session that connects has its number and push name written as it does, which the status frame does not
      // carry, so the list is read again. A read already out may have been answered before this change, so it is
      // followed by one more.
      if (status === 'ready' || relistRef.current.running) void relistSessions();
    },
    [relistSessions],
  );
  // Only the '*' refusal is kept: frames handled before a render keep the last, and another error must not hide it.
  const handleServerError = useCallback((frame: { code: string }) => {
    if (frame.code === 'FORBIDDEN_SESSION') setSessionFeedError(frame.code);
  }, []);

  // The events object must be referentially stable: useWebSocket re-registers its socket handler
  // on every identity change, so an inline literal would tear down and re-attach per render.
  const wsEvents = useMemo(
    () => ({
      onSessionStatus: handleSessionStatus,
      onServerError: handleServerError,
      onMessage: handleIncomingMessage,
      onMessageAck: handleIncomingMessageAck,
      onMessageReaction: handleIncomingMessageReaction,
      onMessageRevoked: handleIncomingMessageRevoked,
      onMessageEdited: handleIncomingMessageEdited,
      onStatusReceived: handleStatusReceived,
    }),
    [
      handleSessionStatus,
      handleServerError,
      handleIncomingMessage,
      handleIncomingMessageAck,
      handleIncomingMessageReaction,
      handleIncomingMessageRevoked,
      handleIncomingMessageEdited,
      handleStatusReceived,
    ],
  );
  const { isConnected, connectionFailed, reconnect, subscribe, unsubscribe, rejoins } = useWebSocket(wsEvents);

  // A session-scoped key may not join '*': fall back to one subscription per listed session.
  useEffect(() => {
    if (sessionFeedError && noteSessionFeedError(sessionFeedRef.current, sessionFeedError)) {
      subscribeSessionFeed(
        { subscribe },
        sessionFeedRef.current,
        listedSessionsRef.current.map(session => session.id),
      );
    }
  }, [sessionFeedError, subscribe]);

  // Join the feed on connect and for every listed session. A reconnect lands on a fresh socket, and a
  // session switch leaves every room of the session left behind, its feed room included, so both make the
  // listed sessions subscribable again.
  const listedSessionIds = listedSessions.map(session => session.id).join(',');
  useEffect(() => {
    if (!isConnected) {
      sessionFeedRef.current.subscribedIds.clear();
      return;
    }
    subscribeSessionFeed({ subscribe }, sessionFeedRef.current, listedSessionIds ? listedSessionIds.split(',') : []);
  }, [isConnected, subscribe, listedSessionIds, selectedSessionId]);

  // A transient WebSocket gap means message.received/ack/revoke/status events were missed. On a
  // reconnect (isConnected false→true after a prior connect), refresh what the gap left stale; the
  // threads are refreshed by the subscribe effect below, which runs on every connect. A failed feed
  // counts as a gap even if it never connected, so the banner's retry refreshes too. The transition
  // logic is unit-tested in utils/reconnectState. A subscribe the gateway joined only on a retry missed
  // its room's events the same way, with no reconnect, so it refreshes the same, the open thread too.
  const reconnectHadConnected = useRef(false);
  const reconnectWasDisconnected = useRef(false);
  const rejoinsSeen = useRef(0);
  const activeChatId = activeChat?.id;
  useEffect(() => {
    const decision = nextReconnectState({
      isConnected,
      hadConnected: reconnectHadConnected.current,
      wasDisconnected: reconnectWasDisconnected.current,
      connectionFailed,
    });
    reconnectHadConnected.current = decision.hadConnected;
    reconnectWasDisconnected.current = decision.wasDisconnected;
    const rejoined = rejoins !== rejoinsSeen.current;
    rejoinsSeen.current = rejoins;
    if (rejoined && selectedSessionId)
      void queryClient.invalidateQueries({ queryKey: ['messages', selectedSessionId] });
    if (decision.invalidate || rejoined) {
      // Statuses are live now (status.received): a story posted during the socket gap would
      // otherwise stay invisible until a focus refetch.
      queryClient.invalidateQueries({ queryKey: ['contact-statuses', selectedSessionId] });
      // So is a session.status frame: a session that connected or dropped during the gap is read from the list.
      void relistSessions();
      // The sidebar list is local state, so previews, unread counts and chats started during the gap
      // only show after a refetch. Background mode keeps the current list on screen meanwhile.
      // The open chat's gap messages are read on screen, so once the refetch has applied this session's
      // list and the chat is still open, mark it read and zero its row, since the snapshot still counts
      // them (the same rule a live frame and opening a chat follow). An applied list also means the engine
      // answers again: after a backend restart it may still be starting, and a read sent then fails. When
      // another reload is already out, this call is answered by the trailing one, which starts after the
      // gap. A refetch that failed, or a session switch, sends nothing; a chat the user left keeps its
      // count.
      const readChatId = canWrite ? activeChatId : undefined;
      void reloadChatsInBackground(selectedSessionId).then(applied => {
        if (!applied || !readChatId || activeChatIdRef.current !== readChatId) return;
        markChatRead(readChatId);
        markRowRead(readChatId);
      });
    }
  }, [
    isConnected,
    connectionFailed,
    rejoins,
    selectedSessionId,
    queryClient,
    reloadChatsInBackground,
    activeChatId,
    canWrite,
    markChatRead,
    markRowRead,
    relistSessions,
  ]);

  // The threads cache at staleTime: Infinity, and this session's events were not delivered while
  // another session was selected or the page was away. Mark them stale on a mount or a session switch
  // so the open one refetches and the others do when opened, with or without a live feed (a
  // chat-restricted key gets only its chats' message events).
  useEffect(() => {
    if (selectedSessionId) void queryClient.invalidateQueries({ queryKey: ['messages', selectedSessionId] });
  }, [selectedSessionId, queryClient]);

  useEffect(() => {
    if (selectedSessionId && isConnected) {
      const sessionFeed = sessionFeedRef.current;
      subscribe(selectedSessionId, [
        'message.received',
        'message.sent',
        'message.ack',
        'message.reaction',
        'message.revoked',
        'message.edited',
        'status.received',
      ]);
      // Events sent while the socket was down were not delivered: after a reconnect, a cached thread
      // may miss some. Mark them stale the same way.
      void queryClient.invalidateQueries({ queryKey: ['messages', selectedSessionId] });
      return () => {
        unsubscribe(selectedSessionId);
        // Leaving the session's rooms leaves its feed room too, so the feed effect joins it again.
        sessionFeed.subscribedIds.delete(selectedSessionId);
      };
    }
  }, [selectedSessionId, isConnected, subscribe, unsubscribe, queryClient]);

  // 4. Message history is fetched by useChatMessages (React Query). The active-chat side effects
  // (mark-as-read + clear sidebar unread badge) live in a small effect below.

  const handleReactMessage = async (msg: ChatMessageView, emoji: string) => {
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

      // Deep-merge metadata.reactions so existing media / quotedMessage on metadata survive.
      const key = messagesQueryKey(selectedSessionId, activeChat.id);
      updateCachedMessages(queryClient, key, old =>
        old.map(m => {
          if (m.type !== 'revoked' && (m.id === msg.id || m.waMessageId === msg.id)) {
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
      showErrorToast(t('chats.errors.react'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleDeleteMessage = async (msg: ChatMessageView) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;

    if (!window.confirm(t('chats.deleteConfirm'))) return;

    try {
      await messageApi.delete(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        forEveryone: true,
      });

      updateMessage(selectedSessionId, activeChat.id, msg.id, { body: '', type: 'revoked', metadata: undefined });
    } catch (err) {
      showErrorToast(t('chats.errors.delete'), err instanceof Error ? err.message : undefined);
    }
  };

  const handleClickButton = async (msg: ChatMessageView, button: { id: string; text: string }) => {
    if (!selectedSessionId || !activeChat) return;
    const msgId = msg.waMessageId || msg.id;
    try {
      await messageApi.clickButton(selectedSessionId, {
        chatId: activeChat.id,
        messageId: msgId,
        buttonId: button.id,
        text: button.text,
      });
    } catch (err) {
      showErrorToast(t('chats.errors.clickButton'), err instanceof Error ? err.message : undefined);
      throw err;
    }
  };

  // Side effects when the active chat changes: mark-as-read on the gateway + clear sidebar unread badge.
  // The message-history fetch is driven by useChatMessages; scroll restoration is driven by
  // useChatScrollPosition (both keyed off activeChat?.id, the latter with the session too). Deliberately keying
  // off `activeChat?.id` (not the whole object) so a sidebar reshuffle that mutates the activeChat instance
  // doesn't re-fire the mark-as-read RPC for the same chat.
  useEffect(() => {
    if (!activeChat) return;
    // Opening a chat is what reads it again after Mark as unread.
    keptUnread.delete(readKey(selectedSessionId, activeChat.id));
    markChatRead(activeChat.id);
    // A read-only key sends no mark-as-read, so the chat stays unread on the gateway; clearing the
    // badge here would only have the next chat-list load bring it back.
    if (canWrite) markRowRead(activeChat.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, markChatRead, canWrite]);

  // On Baileys the read of an opened chat falls due before its thread has loaded, so it names no message. Once
  // the thread is there the chat is read again, naming what it holds (the coalescer merges the two when close).
  useEffect(() => {
    if (activeChat && engineType === 'baileys' && !loadingMessages && messages.length > 0) {
      markChatRead(activeChat.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChat?.id, loadingMessages, engineType]);

  // The number check answers a phone id, while a contact that moved to privacy-id addressing keeps its conversation
  // under its @lid. Finds the id the list holds that conversation under: the same phone spelled another way, else
  // the @lid chat the engine resolves to that phone. The engine's answers share the room header's cache.
  const findListedChat = useCallback(
    async (phoneId: string): Promise<string | null> => {
      const sessionId = selectedSessionRef.current;
      const spelled = chatsRef.current.find(c => contactKey(c.id) === contactKey(phoneId));
      if (spelled) return spelled.id;
      const phone = phoneId.split('@')[0].replace(/\D/g, '');
      const privacyChats = chatsRef.current
        .filter(c => c.kind === 'individual' && c.id.endsWith('@lid'))
        .slice(0, LID_CHATS_SEARCHED);
      let lastAskedAt = 0;
      for (let i = 0; i < privacyChats.length; i += LID_LOOKUPS_AT_ONCE) {
        const batch = privacyChats.slice(i, i + LID_LOOKUPS_AT_ONCE);
        // A group the page already holds answers for goes ahead at once; only one that reaches the gateway waits.
        if (batch.some(c => !isResolvedPhoneHeld(queryClient, sessionId, c.id))) {
          const wait = lastAskedAt + LID_LOOKUP_GAP_MS - Date.now();
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
          if (selectedSessionRef.current !== sessionId) return null;
          lastAskedAt = Date.now();
        }
        const phones = await Promise.all(
          batch.map(c => queryClient.fetchQuery(resolvedPhoneQuery(sessionId, c.id)).catch(() => null)),
        );
        if (selectedSessionRef.current !== sessionId) return null;
        const hit = batch.find((_, j) => phones[j]?.replace(/\D/g, '') === phone);
        if (hit) return hit.id;
      }
      return null;
    },
    [queryClient],
  );

  // --- Global search: jump to a hit's chat (and best-effort scroll to the message) ---
  // A cross-session hit switches session, which asynchronously reloads the chats list — so the
  // target chat may not be available at click time. pendingHitRef carries the intent across that
  // async gap: the chat-select effect picks it up once the list lands, and the scroll effect runs
  // once the messages have rendered. `opened` marks a hit whose chat has been opened, so the user
  // leaving that chat before its thread renders drops the hit instead of being sent back into it.
  // `resolving` marks a hit whose chat is being looked up (see findHitChat), so the effect below does not ask again.
  const pendingHitRef = useRef<{
    sessionId: string;
    chatId: string;
    waMessageId: string;
    opened?: boolean;
    resolving?: boolean;
  } | null>(null);
  // Bumped with every hit, so a hit in the chat already open still re-runs the scroll effect, where
  // every other state it sets is unchanged and React skips the render.
  const [hitSeq, setHitSeq] = useState(0);

  // The listed chat a hit was found in. A stored row keeps the chat id it was written with, which can be another
  // spelling of a listed chat: an API send to the raw `@s.whatsapp.net` form, or to the phone of a contact the list
  // holds under its @lid. The thread read takes those as one chat, and so does this.
  const findHitChat = useCallback(
    async (chatId: string): Promise<Chat | undefined> => {
      const listed = chatsRef.current.find(c => c.id === chatId);
      if (listed || !phoneContactId(chatId)) return listed;
      const id = await findListedChat(chatId).catch(() => null);
      return id === null ? undefined : chatsRef.current.find(c => c.id === id);
    },
    [findListedChat],
  );

  // Opens a hit's chat and keeps the hit under the id the list holds the chat by, which is what the scroll below and
  // the effect that drops a hit the user left compare the open chat with. A hit whose chat is not found in the list (only
  // the newest LID_CHATS_SEARCHED privacy-id chats are asked for their phone) is dropped with a notice, so the click is
  // not left without an answer.
  const openHitChat = useCallback(
    (pending: { sessionId: string; waMessageId: string }, chat: Chat | undefined) => {
      if (!chat) {
        pendingHitRef.current = null;
        showWarningToast(t('chats.errors.searchHitChatNotListed'));
        return;
      }
      if (chat.kind === 'channel') {
        // Channels render their own read-only list on the Channels tab, not via activeChat — the
        // hit's message-highlight is intentionally dropped here since that pane has no per-message scroll target.
        switchTab('channels');
        pendingHitRef.current = null;
        return;
      }
      setActiveTab(chat.kind === 'status' ? 'status' : 'chats');
      setActiveChat(chat);
      setActiveChannel(null);
      setActiveStatusContactId(null);
      pendingHitRef.current = {
        sessionId: pending.sessionId,
        chatId: chat.id,
        waMessageId: pending.waMessageId,
        opened: true,
      };
      // The chat may be the open one under another spelling, where nothing else changes.
      setHitSeq(n => n + 1);
    },
    [switchTab, showWarningToast, t],
  );

  const handleSearchHit = useCallback(
    async (hit: SearchHit) => {
      // Search covers stored messages of every session, but the page can only open a ready one, and
      // its list is read on mount. A session missing from it is looked up again, since it may have
      // connected since; one that still is not ready is refused rather than selected with no chats.
      if (hit.sessionId !== selectedSessionId && !sessions.some(s => s.id === hit.sessionId && s.status === 'ready')) {
        let listed: Session[];
        try {
          listed = await readSessions();
        } catch (err) {
          showLoadError('chats.errors.loadSessions', err);
          return;
        }
        if (!listed.some(s => s.id === hit.sessionId && s.status === 'ready')) {
          pendingHitRef.current = null;
          showWarningToast(t('chats.errors.searchHitSessionNotReady'));
          return;
        }
      }
      const sameSession = hit.sessionId === selectedSessionId;
      // Only a list that landed for the hit's session can say whether it holds the chat. One still loading, or still
      // the previous session's, leaves the hit to the effect below, which resolves it once the list lands.
      const listReady = sameSession && !loadingChats && listedSessionRef.current === hit.sessionId;
      // A list that failed to load says nothing about the chat, and its banner already answers the click.
      if (listReady && chatsFailure !== null) {
        pendingHitRef.current = null;
        return;
      }
      const pending = {
        sessionId: hit.sessionId,
        chatId: hit.chatId,
        waMessageId: hit.waMessageId,
        resolving: listReady,
      };
      pendingHitRef.current = pending;
      setHitSeq(n => n + 1);
      if (!sameSession) {
        // Switching session triggers loadChats; the effect below selects the chat once the list lands.
        setSelectedSessionId(hit.sessionId);
        return;
      }
      if (!listReady) return;
      const openBefore = activeChatIdRef.current;
      const chat = await findHitChat(hit.chatId);
      // A newer hit, a session switch, or a chat the user opened while the lookup ran takes over from this one.
      if (pendingHitRef.current !== pending || activeChatIdRef.current !== openBefore) return;
      openHitChat(pending, chat);
    },
    [
      selectedSessionId,
      sessions,
      loadingChats,
      chatsFailure,
      readSessions,
      showLoadError,
      showWarningToast,
      t,
      findHitChat,
      openHitChat,
    ],
  );

  // After a session switch the chats list reloads — pick up the pending chat once it appears.
  // While the switch's list is loading, `chats` still holds the previous session's list, which can
  // list the same id (a shared group or contact) as a Chat object from the other account. A hit whose
  // chat the session's list lacks, or whose session the user left, is dropped: it would otherwise open
  // on its own once a later list holds that id.
  useEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending) return;
    if (pending.sessionId !== selectedSessionId || (pending.opened && activeChat?.id !== pending.chatId)) {
      pendingHitRef.current = null;
      return;
    }
    if (loadingChats || listedSessionRef.current !== pending.sessionId || activeChat?.id === pending.chatId) return;
    if (pending.resolving) return;
    // The session's list failed to load: its banner answers, and the chat cannot be said to be missing from it.
    if (chatsFailure !== null) {
      pendingHitRef.current = null;
      return;
    }
    const resolving = { ...pending, resolving: true };
    pendingHitRef.current = resolving;
    const openBefore = activeChatIdRef.current;
    void findHitChat(pending.chatId).then(chat => {
      if (pendingHitRef.current !== resolving || activeChatIdRef.current !== openBefore) return;
      openHitChat(pending, chat);
    });
  }, [chats, loadingChats, chatsFailure, activeChat, selectedSessionId, findHitChat, openHitChat]);

  // Best-effort scroll to the hit message. Runs as a layout effect (after useChatScrollPosition's
  // own restore on the same commit) so it overrides the bottom/saved jump with no visible flash.
  // Degrades silently to session+chat selection when the element isn't present — the message is
  // still visible in the conversation. Until the hit's session has its list on screen, the open chat
  // still belongs to the session being left, even when it has the hit's chat id.
  useLayoutEffect(() => {
    const pending = pendingHitRef.current;
    if (!pending || listedSessionRef.current !== pending.sessionId || activeChat?.id !== pending.chatId) return;
    if (loadingMessages || messages.length === 0) return;
    const container = messagesContainerRef.current;
    if (container) {
      try {
        const el = container.querySelector(`[data-wa-message-id="${pending.waMessageId}"]`);
        if (el instanceof HTMLElement) el.scrollIntoView({ block: 'center' });
      } catch {
        // Unexpected chars in the id made the selector invalid — ignore.
      }
    }
    pendingHitRef.current = null;
  }, [activeChat, loadingMessages, messages, messagesContainerRef, hitSeq]);

  // Helper formats. The list time follows WhatsApp's ladder, so the list scans the way operators
  // expect: the clock for today, "Yesterday", the weekday within the last week, else a short date.
  // Times and dates follow the browser's locale, as on the other pages.
  const formatChatTime = useCallback(
    (timestamp?: number) => {
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
      const weekAgo = new Date(today);
      weekAgo.setHours(0, 0, 0, 0);
      weekAgo.setDate(weekAgo.getDate() - 6);
      if (date >= weekAgo) {
        return date.toLocaleDateString([], { weekday: 'long' });
      }
      return date.toLocaleDateString([], {
        weekday: 'short',
        day: '2-digit',
        month: 'short',
        ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
      });
    },
    [t],
  );

  // One search box drives all three tabs; each matches on its own fields. Plain consts (not useMemo)
  // because chats/channelsQuery.data/statusesQuery.data are already stable, query-cached references,
  // so re-filtering on every render is cheap. See utils/chatFilters for the two status orderings.
  // The quick filter narrows the Chats tab further. Archived chats are their own view, as in WhatsApp,
  // except while searching, which finds a chat wherever it is; pinned chats lead the main list.
  // Whether a 1:1 chat's contact is saved comes from the address book (`isMyContact`), not from its
  // display name: Baileys names an unsaved contact by its bare push name too. Undefined until it loads.
  // Reading it walks every contact, and the engine answers each page from all of them, so it is read only when
  // something needs it: the Unknown filter, or a chat menu (its Save or Rename entry, and the dialog behind it).
  const contactsQuery = useQuery({
    queryKey: ['contacts', selectedSessionId],
    queryFn: () => contactApi.list(selectedSessionId),
    enabled: Boolean(selectedSessionId) && (menuOpenedFor === selectedSessionId || chatFilter === 'unknown'),
    staleTime: 5 * 60 * 1000,
    // contactApi.list already retried a throttled page; another attempt would walk every page again.
    retry: false,
    // Coming back to the tab does not walk it again, except after a read that failed.
    refetchOnWindowFocus: query => query.state.status === 'error',
  });
  const savedContactKeys = useMemo(() => savedContactKeySet(contactsQuery.data), [contactsQuery.data]);
  // A read that failed with nothing earlier to go by. The retry's own read is pending again, so the failure is
  // told by the query's error count rather than its status, which keeps the Retry button on screen throughout.
  const contactsFailed =
    chatFilter === 'unknown' && contactsQuery.data === undefined && contactsQuery.errorUpdateCount > 0;

  const searching = searchQuery.trim() !== '';
  const searchedChats = filterChats(chats, searchQuery);
  const archivedCount = filterChats(chats, '').filter(c => c.archived).length;
  const shownChats = applyChatListFilter(
    searching ? searchedChats : searchedChats.filter(c => c.archived === showArchived),
    chatFilter,
    savedContactKeys,
  );
  const filteredChats = showArchived
    ? shownChats
    : [...shownChats.filter(c => c.pinned), ...shownChats.filter(c => !c.pinned)];

  // Open a chat picked in the new-chat panel. A chat with no history is not in the engine's list, so
  // it is added to the sidebar locally until the first message, or the next list load, settles it.
  // The filter and search are cleared so the opened chat is visible in the list. A chat the panel found
  // through another session (a lookup that answered after a switch) is dropped: opening it here would
  // send the next message through the wrong account.
  const handleOpenNewChat = (chat: Chat, sessionId: string) => {
    if (sessionId !== selectedSessionRef.current) return;
    const existing = chats.find(c => c.id === chat.id);
    if (!existing) setChats(prev => [chat, ...prev]);
    setActiveTab('chats');
    setActiveChannel(null);
    setActiveStatusContactId(null);
    setActiveChat(existing ?? chat);
    setShowNewChat(false);
    setChatFilter('all');
    setSearchQuery('');
  };

  // Chat row actions. Everything but the info views is an operator route, so a read-only key gets only those.
  //
  // Every action is bound to the session it started in. Two sessions can list the same chat id (a group
  // both accounts are in), and a request that answers after a switch changed only the session it went to:
  // its result must not land on the list or the open chat of the session now selected.
  const stillOn = (sessionId: string) => sessionId === selectedSessionRef.current;

  const renameChat = useCallback(
    (sessionId: string, chatId: string, name: string) => {
      if (sessionId !== selectedSessionRef.current) return;
      rememberPatch(chatId, { name });
      setChats(prev => prev.map(c => (c.id === chatId ? { ...c, name } : c)));
      setActiveChat(prev => (prev?.id === chatId ? { ...prev, name } : prev));
    },
    [rememberPatch],
  );

  // Several chat routes answer HTTP 200 with `{ success: false }` when the engine declined to act (WhatsApp
  // keeps at most three chats pinned; Baileys cannot clear or delete a chat it knows no last message of),
  // which is a failure here: nothing changed, so nothing local changes either.
  const expectSuccess = (result: { success: boolean }) => {
    if (!result.success) throw new Error(t('chats.rowActions.declined'));
  };
  const failWith = (key: string) => (err: unknown) =>
    showErrorToast(t(key), err instanceof Error ? err.message : undefined);

  const patchChat = (sessionId: string, chatId: string, patch: Partial<Chat>) => {
    if (!stillOn(sessionId)) return;
    rememberPatch(chatId, patch);
    setChats(prev => prev.map(c => (c.id === chatId ? { ...c, ...patch } : c)));
    setActiveChat(prev => (prev?.id === chatId ? { ...prev, ...patch } : prev));
  };

  const handleMarkUnread = async (chat: Chat) => {
    const sessionId = selectedSessionId;
    const key = readKey(sessionId, chat.id);
    keptUnread.add(key);
    markReadCoalescer.drop(chat.id);
    try {
      await readsInFlight.get(key);
      expectSuccess(await sessionApi.markChatUnread(sessionId, chat.id));
      if (!stillOn(sessionId)) return;
      // A negative count is how the list shows a chat marked unread (a badge with no number).
      patchChat(sessionId, chat.id, { unreadCount: -1 });
      if (activeChatIdRef.current === chat.id) setActiveChat(null);
    } catch (err) {
      keptUnread.delete(key);
      failWith('chats.rowActions.markUnreadFailed')(err);
    }
  };

  // The blocklist decides whether a 1:1 chat offers Block or Unblock. Only a key that can act on it reads it.
  const blockedQuery = useQuery({
    queryKey: ['contacts-blocked', selectedSessionId],
    queryFn: () => contactApi.listBlocked(selectedSessionId),
    enabled: Boolean(selectedSessionId) && canWrite,
    staleTime: 60_000,
    retry: false,
  });
  const isBlocked = (chat: Chat) =>
    (blockedQuery.data ?? []).some(id => id === chat.id || id.split('@')[0] === chat.id.split('@')[0]);

  // The address book is keyed by phone number, so a contact can be saved only under a phone-based id: the
  // chat's own when it has one, else, for the open chat, the number the engine resolved for its @lid. The
  // digits of a @lid are no phone number and are never used as one.
  const addressbookIdOf = (chat: Chat): string | null =>
    phoneContactId(chat.id) ??
    (chat.id === activeChat?.id && resolvedPhoneQ.data ? `${resolvedPhoneQ.data.replace(/\D/g, '')}@c.us` : null);

  const handleTogglePin = (chat: Chat) => {
    const sessionId = selectedSessionId;
    return sessionApi
      .pinChat(sessionId, chat.id, !chat.pinned)
      .then(expectSuccess)
      .then(() => patchChat(sessionId, chat.id, { pinned: !chat.pinned }))
      .catch(failWith(chat.pinned ? 'chats.rowActions.unpinFailed' : 'chats.rowActions.pinFailed'));
  };

  const handleToggleArchive = (chat: Chat) => {
    const sessionId = selectedSessionId;
    return sessionApi
      .archiveChat(sessionId, chat.id, !chat.archived)
      .then(expectSuccess)
      .then(() => {
        showSuccessToast(t(chat.archived ? 'chats.rowActions.unarchived' : 'chats.rowActions.archived'));
        patchChat(sessionId, chat.id, { archived: !chat.archived });
      })
      .catch(failWith('chats.rowActions.archiveFailed'));
  };

  const MUTE_FOREVER = Date.UTC(2100, 0, 1);
  const handleMute = async (chat: Chat, duration: MuteDuration | null) => {
    const sessionId = selectedSessionId;
    const until =
      duration === null
        ? null
        : duration === 'always'
          ? MUTE_FOREVER
          : Date.now() + (duration === '8h' ? 8 * 3_600_000 : 7 * 86_400_000);
    setDialogRunning(chat);
    try {
      expectSuccess(await sessionApi.muteChat(sessionId, chat.id, until));
      // The list reports an indefinite mute as expiry 0.
      patchChat(sessionId, chat.id, {
        muted: until !== null,
        muteExpiration: until === null ? undefined : duration === 'always' ? 0 : until,
      });
      setMuteDialogChat(open => (open === chat ? null : open));
    } catch (err) {
      failWith('chats.rowActions.muteFailed')(err);
    } finally {
      setDialogRunning(running => (running === chat ? null : running));
    }
  };

  const handleSaveContact = async (chat: Chat, firstName: string, lastName: string) => {
    const sessionId = selectedSessionId;
    const contactId = addressbookIdOf(chat);
    if (!contactId) return;
    setDialogRunning(chat);
    try {
      expectSuccess(await contactApi.upsert(sessionId, contactId, firstName, lastName || undefined));
      showSuccessToast(t('chats.rowActions.contactSaved'));
      void queryClient.invalidateQueries({ queryKey: ['contacts', sessionId] });
      renameChat(sessionId, chat.id, [firstName, lastName].filter(Boolean).join(' '));
      setContactDialogChat(open => (open === chat ? null : open));
    } catch (err) {
      failWith('chats.rowActions.contactSaveFailed')(err);
    } finally {
      setDialogRunning(running => (running === chat ? null : running));
    }
  };

  const handleUnblock = (chat: Chat) => {
    const sessionId = selectedSessionId;
    return contactApi
      .unblock(sessionId, chat.id)
      .then(expectSuccess)
      .then(() => {
        showSuccessToast(t('chats.rowActions.unblocked', { name: chatTitle(chat) }));
        return queryClient.invalidateQueries({ queryKey: ['contacts-blocked', sessionId] });
      })
      .catch(failWith('chats.rowActions.blockFailed'));
  };

  const isSavedContact = (chat: Chat) => savedContactKeys?.has(contactKey(chat.id)) ?? false;

  const rowActions: ChatRowActions = {
    // Only what a key that can write offers reads the address book (Save or Rename); a read-only menu has no such entry.
    onMenuOpen: canWrite ? () => setMenuOpenedFor(selectedSessionId) : undefined,
    onGroupInfo: setGroupDialogChat,
    onContactInfo: chat => {
      setActiveTab('chats');
      setActiveChat(chat);
      setContactInfoFor(readKey(selectedSessionId, chat.id));
    },
    onSaveContact: canWrite ? setContactDialogChat : undefined,
    canSaveContact: chat => addressbookIdOf(chat) !== null,
    isSavedContact,
    onTogglePin: canWrite ? chat => void handleTogglePin(chat) : undefined,
    onMute: canWrite ? chat => (chat.muted ? void handleMute(chat, null) : setMuteDialogChat(chat)) : undefined,
    onToggleArchive: canWrite ? chat => void handleToggleArchive(chat) : undefined,
    onMarkUnread: canWrite ? chat => void handleMarkUnread(chat) : undefined,
    onLeaveGroup: canWrite ? chat => setConfirmAction({ kind: 'leave', chat }) : undefined,
    onToggleBlock: canWrite
      ? chat => (isBlocked(chat) ? void handleUnblock(chat) : setConfirmAction({ kind: 'block', chat }))
      : undefined,
    onClear: canWrite ? chat => setConfirmAction({ kind: 'clear', chat }) : undefined,
    onDelete: canWrite ? chat => setConfirmAction({ kind: 'delete', chat }) : undefined,
    isBlocked,
  };

  // Leaving a group, clearing a chat and deleting one all run from the confirmation dialog. On success the
  // dialog closes; on a failure, a declined one included, it stays open, so the action can be tried again.
  // A switch closes the dialog, and a request that answers after it changes nothing on the new session.
  const runConfirmedAction = async () => {
    if (!confirmAction) return;
    const started = confirmAction;
    const { kind, chat } = started;
    const sessionId = selectedSessionId;
    const name = chatTitle(chat);
    setConfirmRunning(started);
    try {
      if (kind === 'leave') {
        expectSuccess(await sessionApi.leaveGroup(sessionId, chat.id));
        showSuccessToast(t('chats.group.left', { name }));
        if (stillOn(sessionId)) void loadChats(sessionId, { background: true });
      } else if (kind === 'block') {
        expectSuccess(await contactApi.block(sessionId, chat.id));
        showSuccessToast(t('chats.rowActions.blocked', { name }));
        await queryClient.invalidateQueries({ queryKey: ['contacts-blocked', sessionId] });
      } else if (kind === 'clear') {
        expectSuccess(await sessionApi.clearChatMessages(sessionId, chat.id));
        showSuccessToast(t('chats.rowActions.cleared', { name }));
        patchChat(sessionId, chat.id, { lastMessage: '', unreadCount: 0 });
        // The thread cache holds the messages just deleted; the next open reads the empty chat.
        await queryClient.invalidateQueries({ queryKey: messagesQueryKey(sessionId, chat.id) });
      } else {
        expectSuccess(await sessionApi.deleteChat(sessionId, chat.id));
        showSuccessToast(t('chats.rowActions.deleted', { name }));
        if (stillOn(sessionId)) {
          deletedRowsRef.current.set(chat.id, chatsRequestRef.current);
          setChats(prev => prev.filter(c => c.id !== chat.id));
        }
        queryClient.removeQueries({ queryKey: messagesQueryKey(sessionId, chat.id) });
      }
      if (!stillOn(sessionId)) return;
      if ((kind === 'leave' || kind === 'delete') && activeChatIdRef.current === chat.id) setActiveChat(null);
      setConfirmAction(open => (open === started ? null : open));
    } catch (err) {
      const failed =
        kind === 'leave'
          ? 'chats.group.leaveFailed'
          : kind === 'block'
            ? 'chats.rowActions.blockFailed'
            : kind === 'clear'
              ? 'chats.rowActions.clearFailed'
              : 'chats.rowActions.deleteFailed';
      failWith(failed)(err);
    } finally {
      setConfirmRunning(running => (running === started ? null : running));
    }
  };

  // Closes the room menu from inside it, leaving focus on its button instead of the entry that unmounts.
  const closeRoomMenu = () => {
    setRoomMenuOpen(false);
    roomMenuTriggerRef.current?.focus();
  };

  const handleCopyChatId = async () => {
    if (!activeChat) return;
    // The house helper: over plain HTTP on a LAN address navigator.clipboard does not exist.
    if (await copyToClipboard(activeChat.id)) showSuccessToast(t('chats.chatIdCopied'));
    else showErrorToast(t('chats.copyFailed'));
  };

  // The overflow menu closes on a press outside it, on Escape, and with the chat it belongs to. Escape
  // is taken in the capture phase and marked handled, like the emoji picker's, so the page's own
  // handler below leaves the room open.
  useEffect(() => {
    setRoomMenuOpen(false);
  }, [activeChat?.id]);
  useEffect(() => {
    if (!roomMenuOpen) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!roomMenuRef.current?.contains(event.target as Node)) setRoomMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isComposingKey(event) || event.defaultPrevented) return;
      event.preventDefault();
      closeRoomMenu();
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [roomMenuOpen]);
  // The channels zero-state ("not subscribed to any channels") stays keyed on the UNFILTERED list
  // below, so a non-matching search renders an empty list rather than claiming there are none.
  const filteredChannels = filterChannels(channelsQuery.data ?? [], searchQuery);
  const groupedStatuses: ContactStatusGroup[] = groupStatusesByContact(statusesQuery.data ?? [], searchQuery);

  // The open status group, derived — see the activeStatusContactId declaration.
  const activeStatusGroup = activeStatusContactId
    ? (groupedStatuses.find(g => g.contact.id === activeStatusContactId) ?? null)
    : null;

  // The pane heading truncates with an ellipsis, so the untruncated text has to reach the tooltip.
  const activeStatusTitle = activeStatusGroup
    ? (activeStatusGroup.contact.name ?? activeStatusGroup.contact.pushName ?? activeStatusGroup.contact.id)
    : '';

  // Same open-at-newest behavior for the status viewer pane, keyed off the active contact and its
  // item list. Declared after activeStatusGroup: the viewer follows refetches because the deps are
  // the derived group's items, not a click-time snapshot.
  const statusFeedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = statusFeedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeStatusGroup?.contact.id, activeStatusGroup?.items]);

  // Escape closes the open view and returns to the list. Anything that owns the key already keeps
  // it: a modal (Modal renders role="dialog" only while open) and the language menu (role="menu")
  // are skipped here, and so is the media viewer, whose library renders its own role="dialog"
  // portal and closes itself on Escape. A handler that called preventDefault, or a composition
  // still being committed by an IME, is left alone for the same reason.
  useEffect(() => {
    const closeOpenViewOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (activeStatusContactId !== null) setActiveStatusContactId(null);
      else if (activeChannel) setActiveChannel(null);
      else if (activeChat && showContactInfo) {
        setContactInfoFor('');
        contactToggleRef.current?.focus();
      } else if (activeChat) setActiveChat(null);
      else if (showNewChat) setShowNewChat(false);
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', closeOpenViewOnEscape);
    return () => document.removeEventListener('keydown', closeOpenViewOnEscape);
  }, [activeStatusContactId, activeChannel, activeChat, showContactInfo, showNewChat]);

  // Image and sticker media items for the lightbox, in render order (an archived sticker opens in its own viewer
  // too, see ArchivedMediaPreview). `getMediaSrc` reconstructs a usable src
  // from either a base64 payload or a URL — the ChatMessageView shape stores both in `data`.
  const imageMessages = useMemo(
    () => messages.filter(m => (m.type === 'image' || m.type === 'sticker') && Boolean(getMediaSrc(m.metadata?.media))),
    [messages],
  );
  const imageMedia = useMemo<LightboxItem[]>(
    () =>
      imageMessages.map(m => ({
        id: m.id,
        url: getMediaSrc(m.metadata?.media),
        alt: m.body || m.metadata?.media?.filename || '',
        filename: m.metadata?.media?.filename,
        senderName: undefined,
        timestamp: formatChatTime(m.timestamp || Math.floor(new Date(m.createdAt).getTime() / 1000)),
      })),
    [imageMessages, formatChatTime],
  );
  const lightboxIndex =
    lightbox === null
      ? -1
      : imageMessages.findIndex(
          m =>
            (m.waMessageId ?? m.id) === lightbox.key ||
            (lightbox.key.startsWith('temp_') && m.direction === 'outgoing' && m.createdAt === lightbox.createdAt),
        );
  // An image that left the thread (deleted for everyone, its payload dropped) closes the viewer for good: a key kept
  // would open it again by itself once the image came back. A confirmed send moves the viewer to the row's real key.
  useEffect(() => {
    if (lightbox === null) return;
    const shown = lightboxIndex < 0 ? null : viewedImage(imageMessages[lightboxIndex]);
    if (shown?.key !== lightbox.key) setLightbox(shown);
  }, [lightbox, lightboxIndex, imageMessages]);

  return (
    <div className="chats-page">
      {/* The page header gave way to the full-height layout; its title stays for screen readers. */}
      <h1 className="visually-hidden">{t('nav.chats')}</h1>
      {/* Real-time connection permanently dropped — let the user re-establish it instead of
          silently showing stale chats. */}
      {connectionFailed && (
        <div className="chats-reconnect-banner" role="alert">
          <AlertCircle size={16} />
          <span>{t('common.disconnected')}</span>
          <button className="btn-secondary" onClick={reconnect}>
            {t('common.refresh')}
          </button>
        </div>
      )}

      {chatsFailure !== null && !loadingChats && (
        <div className="chats-reconnect-banner" role="alert">
          <AlertCircle size={16} />
          <span>
            {t('chats.errors.loadChats')}
            {chatsFailure && ` (${chatsFailure})`}
          </span>
          <button className="btn-secondary" onClick={() => void loadChats(selectedSessionId)}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {loadingSessions ? (
        <div className="chats-loading-container">
          <Loader2 className="animate-spin" size={32} />
          <p>{t('common.loading')}</p>
        </div>
      ) : sessionsFailure !== null ? (
        <div className="chats-error-state" role="alert">
          <AlertCircle size={48} className="text-warn" />
          <h3>{t('chats.errors.loadSessions')}</h3>
          {sessionsFailure && <p>{sessionsFailure}</p>}
          <button className="btn-secondary" onClick={() => void loadSessions()}>
            {t('common.retry')}
          </button>
        </div>
      ) : sessions.length === 0 ? (
        <div className="chats-error-state">
          <AlertCircle size={48} className="text-warn" />
          <h3>{t('chats.noSessionsTitle')}</h3>
          <p>
            <Trans i18nKey="chats.noSessionsDesc">
              Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat feature.
            </Trans>
          </p>
        </div>
      ) : (
        <div
          className={`chats-layout ${activeChat || activeChannel || activeStatusGroup ? 'has-active-chat' : ''} ${
            activeChat && showContactInfo ? 'has-contact-info' : ''
          }`}
        >
          {/* LEFT SIDEBAR: session & chat rooms */}
          <ChatSidebar
            sessions={sessions}
            pickerSessions={listedSessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={setSelectedSessionId}
            activeTab={activeTab}
            onSwitchTab={switchTab}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onComposeStatus={() => setComposeOpen(true)}
            formatChatTime={formatChatTime}
            messageSearch={
              canWrite ? <GlobalSearch currentSessionId={selectedSessionId} onHit={handleSearchHit} /> : null
            }
            onNewChat={canWrite ? () => setShowNewChat(true) : undefined}
            newChatPanel={
              canWrite && showNewChat ? (
                <NewChatPanel
                  sessionId={selectedSessionId}
                  onOpenChat={handleOpenNewChat}
                  findListedChat={findListedChat}
                  onClose={() => setShowNewChat(false)}
                />
              ) : null
            }
            chatsTab={{
              // Unknown is decided by the address book: until it loads the list would claim no chat matches, and
              // when it cannot be read the list says so instead.
              loading:
                loadingChats ||
                (chatFilter === 'unknown' && Boolean(selectedSessionId) && contactsQuery.isPending && !contactsFailed),
              filterError: contactsFailed
                ? { retrying: contactsQuery.isFetching, onRetry: () => void contactsQuery.refetch() }
                : undefined,
              chats: filteredChats,
              filter: chatFilter,
              onFilterChange: setChatFilter,
              rowActions,
              archive: { count: archivedCount, showing: showArchived, onToggle: () => setShowArchived(v => !v) },
              activeChatId: activeChat?.id,
              pictures: listPics.data,
              onSelectChat: setActiveChat,
            }}
            channelsTab={{
              engineLoading: engineType === null,
              supported: channelsSupported,
              query: channelsQuery,
              channels: filteredChannels,
              activeChannelId: activeChannel?.id,
              onSelectChannel: setActiveChannel,
            }}
            statusTab={{
              loading: statusesQuery.isLoading,
              error: statusesQuery.isError,
              groups: groupedStatuses,
              activeContactId: activeStatusContactId,
              onSelectContact: setActiveStatusContactId,
            }}
          />

          {/* RIGHT VIEW: active chat room */}
          <div className="chats-room">
            {activeChat ? (
              <div className="room-container">
                <h2 className="visually-hidden">{activeChatTitle}</h2>
                {/* Room header */}
                <header className="room-header">
                  <button className="room-back" onClick={() => setActiveChat(null)} aria-label={t('common.back')}>
                    <ArrowLeft size={20} />
                  </button>
                  {/* The contact itself opens the info panel, as in WhatsApp. */}
                  <button
                    type="button"
                    className="room-contact"
                    onClick={() => setContactInfoFor(showContactInfo ? '' : openRoomKey)}
                    title={contactInfoLabel}
                    aria-expanded={showContactInfo}
                  >
                    <ChatAvatar
                      chatId={activeChat.id}
                      pictureUrl={activePp.data}
                      kind={activeChat.kind}
                      size="sm"
                      // Signed CDN URLs rotate every few hours; refetch the slice on a stale load.
                      onImageError={() => activePp.refetch()}
                    />
                    <span className="room-contact-info">
                      <span className="room-contact-name">{activeChatTitleText}</span>
                      {/* Personal chats show the prettified phone number — local formatting for
                          @c.us ids, engine-resolved for @lid privacy ids (which are NOT phones and
                          must never be formatted as one). Only under a saved name: an unnamed chat's
                          title already is the number. The raw JID is in the contact panel. */}
                      {activePhoneText && activeChat.name && (
                        <span className="room-contact-phone" title={activePhoneText}>
                          <bdi dir="ltr">{activePhoneText}</bdi>
                        </span>
                      )}
                    </span>
                  </button>

                  <div className="room-header-actions">
                    <div className="room-menu" ref={roomMenuRef}>
                      <button
                        ref={roomMenuTriggerRef}
                        type="button"
                        className={`icon-btn room-menu-trigger ${roomMenuOpen ? 'active' : ''}`}
                        onClick={() => {
                          if (activeChat.kind === 'individual') rowActions.onMenuOpen?.();
                          setRoomMenuOpen(open => !open);
                        }}
                        title={t('chats.moreActions')}
                        aria-label={t('chats.moreActions')}
                        aria-expanded={roomMenuOpen}
                      >
                        <CircleEllipsis size={22} />
                      </button>
                      {/* A disclosure of plain buttons, not role="menu": it keeps no roving focus or arrow
                          keys, and the role would promise them. */}
                      {roomMenuOpen && (
                        <div className="room-menu-popover">
                          {/* The row's actions, then what only an open room needs. The chat comes from the list,
                              which opening it, a reload and the page's own actions keep current, not from the
                              snapshot taken when its row was clicked. */}
                          <ChatActions
                            chat={chats.find(c => c.id === activeChat.id) ?? activeChat}
                            actions={rowActions}
                            onPicked={closeRoomMenu}
                          />
                          <hr />
                          <button
                            type="button"
                            onClick={() => {
                              closeRoomMenu();
                              void handleCopyChatId();
                            }}
                          >
                            <Copy size={16} />
                            {t('chats.copyChatId')}
                          </button>
                          <button type="button" onClick={() => setActiveChat(null)}>
                            <X size={16} />
                            {t('chats.closeChat')}
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      ref={contactToggleRef}
                      type="button"
                      className={`icon-btn ${showContactInfo ? 'active' : ''}`}
                      onClick={() => setContactInfoFor(showContactInfo ? '' : openRoomKey)}
                      title={contactInfoLabel}
                      aria-label={contactInfoLabel}
                      aria-pressed={showContactInfo}
                    >
                      <PanelRight size={22} />
                    </button>
                  </div>
                </header>

                {/* Messages body (list, media, reactions, scroll-to-bottom) — components/chats/ChatThread. */}
                <ChatThread
                  sessionId={selectedSessionId}
                  activeChat={activeChat}
                  messages={messages}
                  loadingMessages={loadingMessages}
                  messagesError={messagesError}
                  messagesContainerRef={messagesContainerRef}
                  hasMoreMessages={Boolean(hasMoreMessages)}
                  loadingOlderMessages={loadingOlderMessages}
                  onLoadOlderMessages={handleLoadOlderMessages}
                  onMediaLoad={onMediaLoad}
                  measureMedia={measureMedia}
                  onOpenImage={messageId => {
                    const opened = imageMessages.find(m => m.id === messageId);
                    if (opened) setLightbox(viewedImage(opened));
                  }}
                  onReply={setReplyingTo}
                  onReact={handleReactMessage}
                  onDelete={handleDeleteMessage}
                  onClickButton={handleClickButton}
                />

                {/* Composer: attachment preview, emoji panel, reply banner, input bar —
                    components/chats/ChatComposer. */}
                <ChatComposer
                  selectedSessionId={selectedSessionId}
                  activeChat={activeChat}
                  replyingTo={replyingTo}
                  setReplyingTo={setReplyingTo}
                  onMessageAppended={onMessageAppended}
                  onSent={promoteSentChat}
                  onSendConfirmed={(tempId, key) => setLightbox(v => (v?.key === tempId ? { ...v, key } : v))}
                  messageInput={messageInput}
                  setMessageInput={setMessageInput}
                  attachment={attachment}
                  setAttachment={setAttachment}
                  previewUrl={previewUrl}
                  setPreviewUrl={setPreviewUrl}
                />
              </div>
            ) : activeChannel ? (
              // Read-only channel pane: no send footer, reactions, delete, reply, or markChatRead —
              // subscribed channels are a broadcast feed, not a two-way conversation.
              <div key={activeChannel.id} className="channel-room">
                <header className="chats-room-header">
                  <button className="room-back" onClick={() => setActiveChannel(null)} aria-label={t('common.back')}>
                    <ArrowLeft size={20} />
                  </button>
                  <Megaphone size={20} />
                  <h2 title={activeChannel.name}>{activeChannel.name}</h2>
                </header>
                <div className="messages-list" ref={channelFeedRef}>
                  {channelMessages.isLoading ? (
                    <div className="messages-loading">
                      <Loader2 className="animate-spin" size={32} />
                      <span>{t('chats.loadingMessages')}</span>
                    </div>
                  ) : channelMessages.error ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.loadMessagesError')}</span>
                    </div>
                  ) : (channelMessages.data ?? []).length === 0 ? (
                    <div className="messages-empty">
                      <MessageSquare size={32} />
                      <span>{t('chats.noMessagesInChat')}</span>
                    </div>
                  ) : (
                    (channelMessages.data ?? []).map(m => (
                      <div key={m.id} className="message-bubble incoming">
                        {/* whatsapp-web.js flags a post's media but gives no URL for it. */}
                        {m.hasMedia &&
                          (m.mediaUrl ? (
                            <img className="channel-media" src={m.mediaUrl} alt="" />
                          ) : (
                            <span className="status-media-placeholder">{t('chats.status.mediaUnavailable')}</span>
                          ))}
                        {m.body && <MessageBody text={stripMentionDelimiters(m.body)} className="message-text" />}
                        <span className="message-time">{formatChatTime(m.timestamp)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : activeStatusGroup ? (
              // Read-only status viewer: no send footer, reactions, delete, reply, or markChatRead —
              // statuses are ephemeral broadcast posts, not a two-way conversation.
              <div key={activeStatusGroup.contact.id} className="channel-room">
                <header className="chats-room-header">
                  <button
                    className="room-back"
                    onClick={() => setActiveStatusContactId(null)}
                    aria-label={t('common.back')}
                  >
                    <ArrowLeft size={20} />
                  </button>
                  <CircleDashed size={20} />
                  <h2 title={activeStatusTitle}>{activeStatusTitle}</h2>
                </header>
                <div className="messages-list" ref={statusFeedRef}>
                  {activeStatusGroup.items.map(item => (
                    <div
                      key={item.id}
                      className="message-bubble incoming"
                      // A text status keeps the look it was posted with: background colour (white
                      // text like WhatsApp) and the closest generic font family we have for the
                      // proprietary WhatsApp font slots.
                      style={
                        item.type === 'text' && (item.backgroundColor || item.font)
                          ? {
                              ...(item.backgroundColor ? { backgroundColor: item.backgroundColor, color: '#fff' } : {}),
                              ...statusFontStyle(item.font),
                            }
                          : undefined
                      }
                    >
                      {item.mediaUrl && (
                        <StatusMedia
                          sessionId={selectedSessionId || null}
                          statusId={item.id}
                          type={item.type === 'video' ? 'video' : item.type === 'voice' ? 'audio' : 'image'}
                        />
                      )}
                      {item.caption && (
                        <MessageBody text={stripMentionDelimiters(item.caption)} className="message-text" />
                      )}
                      <span className="message-time">
                        {formatChatTime(Math.floor(new Date(item.timestamp).getTime() / 1000))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="chats-room-placeholder">
                <MessageSquare size={80} className="placeholder-icon" />
                <h2>{t('chats.placeholderTitle')}</h2>
                <p>{t('chats.placeholderDesc')}</p>
              </div>
            )}
          </div>

          {/* Contact panel beside the room, toggled from its header. */}
          {activeChat && showContactInfo && (
            <aside className="contact-info-panel" aria-label={contactInfoLabel}>
              <header className="contact-info-header">
                {/* Opening the panel takes focus into it: below 1200px it covers the room, the button that opened it
                    and the stops after it. Closing it returns focus to the toggle. */}
                <button
                  type="button"
                  className="icon-btn"
                  onClick={closeContactInfo}
                  aria-label={t('common.close')}
                  title={t('common.close')}
                  autoFocus
                >
                  <X size={20} />
                </button>
                <span>{contactInfoLabel}</span>
              </header>
              <div className="contact-info-body">
                <ChatAvatar
                  chatId={activeChat.id}
                  pictureUrl={activePp.data}
                  kind={activeChat.kind}
                  size="lg"
                  onImageError={() => activePp.refetch()}
                />
                <h3>{activeChatTitleText}</h3>
                {/* The number goes under a name only; an unnamed chat's title already is the number. */}
                {(activeChat.name || !activePhoneText) && (
                  <p className="contact-info-sub">
                    {activePhoneText ? (
                      <bdi dir="ltr">{activePhoneText}</bdi>
                    ) : activeChat.isGroup ? (
                      t('chats.groupSubtitle')
                    ) : (
                      t('chats.privateContactSubtitle')
                    )}
                  </p>
                )}
                <dl className="contact-info-list">
                  {activePhoneText && (
                    <>
                      <dt>{t('chats.phone')}</dt>
                      <dd>
                        <bdi dir="ltr">{activePhoneText}</bdi>
                      </dd>
                    </>
                  )}
                  {/* Raw JID preserved for the technical case (the gateway speaks JIDs everywhere:
                      webhooks, message rows, lid resolution). */}
                  <dt>{t('chats.chatId')}</dt>
                  <dd className="mono">
                    {/* Isolated left to right, as the room header once did: in an RTL page the bidi algorithm
                        would otherwise move "@c.us" to the other end of the id. */}
                    <bdi dir="ltr" title={activeChat.id}>
                      {activeChat.id}
                    </bdi>
                    <button
                      type="button"
                      className="icon-btn small"
                      onClick={() => void handleCopyChatId()}
                      title={t('chats.copyChatId')}
                      aria-label={t('chats.copyChatId')}
                    >
                      <Copy size={14} />
                    </button>
                  </dd>
                </dl>
              </div>
            </aside>
          )}
        </div>
      )}

      <MediaLightbox
        items={imageMedia}
        index={lightboxIndex < 0 ? null : lightboxIndex}
        onClose={() => setLightbox(null)}
        onNavigate={i => {
          const shown = imageMessages[i];
          if (shown) setLightbox(viewedImage(shown));
        }}
      />

      {groupDialogChat && sessions.some(s => s.id === selectedSessionId) && (
        <GroupInfoDialog
          session={sessions.find(s => s.id === selectedSessionId)!}
          group={groupDialogChat}
          onClose={() => setGroupDialogChat(null)}
          onRenamed={renameChat}
        />
      )}

      {confirmAction && (
        <Modal
          open
          onClose={() => setConfirmAction(null)}
          title={t(CONFIRM_TEXT[confirmAction.kind].title)}
          className="confirm-modal"
          closeLabel={t('common.close')}
          footer={
            <>
              <button className="btn-secondary" onClick={() => setConfirmAction(null)} disabled={confirmBusy}>
                {t('common.cancel')}
              </button>
              <button className="btn-danger" onClick={() => void runConfirmedAction()} disabled={confirmBusy}>
                {confirmBusy ? (
                  <Loader2 className="animate-spin" size={16} />
                ) : (
                  t(CONFIRM_TEXT[confirmAction.kind].title)
                )}
              </button>
            </>
          }
        >
          <p>{t(CONFIRM_TEXT[confirmAction.kind].question, { name: chatTitle(confirmAction.chat) })}</p>
          <p className="text-muted">{t(CONFIRM_TEXT[confirmAction.kind].warning)}</p>
        </Modal>
      )}

      {muteDialogChat && (
        <MuteChatDialog
          chat={muteDialogChat}
          busy={dialogRunning === muteDialogChat}
          onMute={duration => void handleMute(muteDialogChat, duration)}
          onClose={() => setMuteDialogChat(null)}
        />
      )}

      {contactDialogChat && (
        <SaveContactDialog
          chat={contactDialogChat}
          saved={isSavedContact(contactDialogChat)}
          busy={dialogRunning === contactDialogChat}
          onSave={(first, last) => void handleSaveContact(contactDialogChat, first, last)}
          onClose={() => setContactDialogChat(null)}
        />
      )}

      {composeOpen && (
        <StatusComposeModal
          sessionId={selectedSessionId}
          onClose={() => setComposeOpen(false)}
          onPosted={() => statusesQuery.refetch()}
        />
      )}
    </div>
  );
}
