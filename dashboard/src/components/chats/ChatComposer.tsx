import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Send, Smile, X } from 'lucide-react';
import { messageApi, type Chat, type MessageType } from '../../services/api';
import { type ChatMessageView } from '../../utils/chatMessages';
import { chatTitle } from '../../utils/formatPhone';
import { buildMediaSendPayload, buildOptimisticMetadata, quotedIdOf } from '../../utils/composerSend';
import { messagesQueryKey, useChatMessagesActions, upsertCachedMessage } from '../../hooks/useChatMessages';
import { useTemplatesQuery } from '../../hooks/queries';
import { useRole } from '../../hooks/useRole';
import { useToast } from '../../hooks/useToast';
import type { ScrollDirection } from '../../utils/scrollDecision';
import { MEDIA_UPLOAD_MAX_BYTES } from '../../utils/mediaUpload';
import { BULK_CAPTION_MAX_LENGTH, captionLength } from '../../utils/bulkMedia';
import { isComposingKey } from '../../utils/composition';
import {
  filterTemplatesBySlash,
  firstPlaceholder,
  placeholderTokens,
  isSlashDraft,
  normalizeTemplateName,
  renderTemplateText,
  slashDraftFilter,
  type SlashTemplate,
} from '../../utils/templateSlash';

// The gateway's bound on the text of a send and of a reply, MESSAGE_TEXT_MAX_LENGTH in
// src/modules/message/dto/send-message.dto.ts. A caption is bounded at BULK_CAPTION_MAX_LENGTH, as SendMediaMessageDto
// bounds it.
const MESSAGE_TEXT_MAX_LENGTH = 4096;

// Rows the `/name` picker lists; past it, a line says that more templates match.
const SLASH_ROWS = 8;

// A template's text as the field holds it: a textarea reads every line break as a line feed.
const insertedText = (template: SlashTemplate): string => renderTemplateText(template).replace(/\r\n?/g, '\n');

// The message field is as tall as its draft (a template joins header, body and footer with blank lines) and stops
// at the CSS max-height, where it scrolls. To be measured it is one line high for a moment. The pill around it keeps
// its height meanwhile: a composer that shrank with the field would lend its room to the thread above, and a thread
// at its bottom is clamped off it by that layout, on every key typed in a draft of several lines.
function fitToDraft(field: HTMLTextAreaElement): void {
  const pill = field.parentElement;
  if (pill) pill.style.minHeight = `${pill.offsetHeight}px`;
  field.style.height = 'auto';
  const next = field.scrollHeight;
  if (next > 0) field.style.height = `${next}px`;
  if (pill) pill.style.minHeight = '';
}

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
const messageTypeFromMime = (mimetype: string): MessageType => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

/** A picked-but-unsent file, staged until send, removal, or a move to another chat. */
export interface StagedAttachment {
  file: File;
  base64: string;
  mimetype: string;
  filename: string;
}

interface ChatComposerProps {
  selectedSessionId: string;
  activeChat: Chat;
  replyingTo: ChatMessageView | null;
  setReplyingTo: Dispatch<SetStateAction<ChatMessageView | null>>;
  onMessageAppended: (direction: ScrollDirection) => void;
  /** Moves the chat to the top of the sidebar, if `sessionId` is still the session on screen. */
  onSent: (sessionId: string, chatId: string, snippet: string, sentAt: number) => void;
  /** A send was confirmed: the placeholder `tempId` is now the thread row keyed `key` (its waMessageId ?? id). */
  onSendConfirmed?: (tempId: string, key: string) => void;
  /** A send was refused: `text` is what it took from the field of the thread (`sessionId`, `chatId`) it was typed in. */
  onSendFailed?: (sessionId: string, chatId: string, text: string) => void;
  messageInput: string;
  setMessageInput: Dispatch<SetStateAction<string>>;
  attachment: StagedAttachment | null;
  setAttachment: Dispatch<SetStateAction<StagedAttachment | null>>;
  previewUrl: string | null;
  setPreviewUrl: Dispatch<SetStateAction<string | null>>;
}

// The composer half of the chat room: attachment preview, emoji panel, reply banner, and the input
// bar with the whole optimistic-send flow. `replyingTo` is shared with the thread (its reply action
// sets it), and `messageInput` plus the staged attachment live in the page so a draft survives
// closing the room; everything else is local.
function ChatComposer({
  selectedSessionId,
  activeChat,
  replyingTo,
  setReplyingTo,
  onMessageAppended,
  onSent,
  onSendConfirmed,
  onSendFailed,
  messageInput,
  setMessageInput,
  attachment,
  setAttachment,
  previewUrl,
  setPreviewUrl,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const { canWrite } = useRole();
  const { error: showErrorToast } = useToast();
  const { appendMessage, updateMessage } = useChatMessagesActions();
  const queryClient = useQueryClient();

  const [sendingByThread, setSendingByThread] = useState<Record<string, number>>({});
  const activeThreadKey = selectedSessionId && activeChat?.id ? `${selectedSessionId}\0${activeChat.id}` : '';
  const sending = Boolean(activeThreadKey && (sendingByThread[activeThreadKey] ?? 0) > 0);
  // "[Image]" for a non-text message; an unexpected type still reads as itself rather than a raw key.
  // An `unknown` one quotes as "[Message]" on purpose: here it is a message, not a type category
  // (the chart and the webhook filter name it through messageTypeLabelKey instead).
  const typeLabel = (type: string) => `[${t(`chats.messageType.${type}`, { defaultValue: type })}]`;
  // Audio carries no caption on either engine, so text typed next to it is never sent with it.
  const attachmentIsAudio = attachment?.mimetype.startsWith('audio/') ?? false;
  // The text a send carries is held to the gateway's bound, counted as it counts (an astral character is one), before
  // the send instead of by a refusal.
  const textLength = captionLength(messageInput.trim());
  const textMax = attachment ? BULK_CAPTION_MAX_LENGTH : MESSAGE_TEXT_MAX_LENGTH;
  const textTooLong = !attachmentIsAudio && textLength > textMax;

  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);
  // Highlight in the `/name` template picker (ArrowUp/Down). Reset whenever the draft changes.
  const [slashHighlight, setSlashHighlight] = useState(0);
  // The draft the picker is closed for: the one Escape or its close button dismissed it on, or the text an insert
  // left in the field. The draft itself rather than a flag, so that a template whose text is one slash word
  // (`/start`) does not open the picker again and can be sent; any other draft opens it.
  const [slashClosedFor, setSlashClosedFor] = useState<string | null>(null);
  // Where the first placeholder of the template just inserted is, to be selected once the field holds the text.
  const [unfilled, setUnfilled] = useState<{ start: number; end: number } | null>(null);
  // The picker belongs to the field: its keys are handled there, so it is offered only while the field has focus.
  const [fieldFocused, setFieldFocused] = useState(false);
  const slashListId = useId();
  // Monotonic token invalidating an in-flight attachment FileReader: picking a second file (or
  // removing the attachment) before `onload` fires must win over the late-arriving bytes —
  // otherwise the slower read overwrites the newer pick. Same pattern as composeImageReadSeq.
  const attachmentReadSeq = useRef(0);
  const tempSeqRef = useRef(0);

  // Session templates power `/hola`-style shortcuts in the composer (Templates page is the editor).
  const templatesQuery = useTemplatesQuery(selectedSessionId, canWrite && !!selectedSessionId);
  const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);
  const templatesLoading = templatesQuery.isLoading && templates.length === 0;
  const templatesFailed = templatesQuery.isError && templates.length === 0;
  // A slash draft the picker was not closed for. Send acts on it wherever focus is, as a press on the Send button
  // takes focus from the field first; the picker itself is drawn only while the field has focus.
  const slashActive = canWrite && !attachment && isSlashDraft(messageInput) && messageInput !== slashClosedFor;
  const slashOpen = slashActive && fieldFocused;
  const slashFound = useMemo(
    () =>
      slashActive && !templatesLoading && !templatesFailed
        ? filterTemplatesBySlash(templates, slashDraftFilter(messageInput), SLASH_ROWS + 1)
        : [],
    [slashActive, templatesLoading, templatesFailed, templates, messageInput],
  );
  const slashMatches = slashFound.slice(0, SLASH_ROWS);
  const slashIndex = slashMatches.length === 0 ? -1 : Math.min(slashHighlight, slashMatches.length - 1);
  // The list is offered: only then is the field a combobox, as a textarea takes no role but its own otherwise.
  const slashListed = slashOpen && slashMatches.length > 0;
  const slashOptionId = (index: number) => `${slashListId}-opt-${index}`;
  useEffect(() => {
    setSlashHighlight(0);
    // The picker was closed for one draft: any other drops that, so the same word typed again later is offered.
    setSlashClosedFor(closed => (closed === messageInput ? closed : null));
  }, [messageInput]);
  // The session's templates as the field holds them, and every placeholder they write.
  const templateTexts = useMemo(() => templates.map(insertedText), [templates]);
  const templateTokens = useMemo(() => new Set(templateTexts.flatMap(placeholderTokens)), [templateTexts]);
  // A template's placeholder is still in the text that would go out, and the composer says so. Audio carries no
  // text. Read from the draft, not remembered from the insert, so the draft of a room closed and opened again, or
  // of a chat come back to, is treated the same.
  const placeholderLeft = useMemo(
    () => !attachmentIsAudio && placeholderTokens(messageInput).some(token => templateTokens.has(token)),
    [attachmentIsAudio, templateTokens, messageInput],
  );
  // A template exactly as it was inserted is not sent: the Enter that follows an insert is a slip, not a decision.
  // Once the operator has edited it the text is theirs to send, with the notice still up while a placeholder is.
  const templateUnfilled = placeholderLeft && templateTexts.includes(messageInput);

  // Escape dismisses the emoji picker instead of closing the conversation behind it.
  //
  // On `document`, and in the capture phase, because neither alternative works: the picker is a div
  // with no tabIndex, so an onKeyDown on it fires only when focus is already inside, and after the
  // toggle button is clicked focus is on the button, outside. Capture also puts this ahead of the
  // page's own Escape handler whatever order the two listeners were registered in, so the
  // preventDefault below is what the page reads, and the room stays open without the picker having
  // to advertise a role it does not implement.
  //
  // It still yields to a surface layered ABOVE it. The picker can stay open while the media viewer
  // or a menu is opened over it, and taking the key there would dismiss the picker underneath
  // instead of the thing the operator is looking at. Same test the page's own handler uses, so the
  // three agree on who owns Escape.
  useEffect(() => {
    if (!showEmojiPicker) return;
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isComposingKey(event) || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      setShowEmojiPicker(false);
      // A key pressed on an emoji button: the button leaves with the panel, and the focus goes to the field.
      if (document.activeElement?.closest('.chats-emoji-picker')) textInputRef.current?.focus();
    };
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => document.removeEventListener('keydown', dismissOnEscape, true);
  }, [showEmojiPicker]);

  // References
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  // How a button of the composer was last pressed: the pointerdown's pointerType ('touch' for a tap), '' after a key.
  const pressRef = useRef('');
  const press = {
    onPointerDown: (e: ReactPointerEvent) => {
      pressRef.current = e.pointerType;
    },
    onKeyDown: () => {
      pressRef.current = '';
    },
  };
  // A button that closes with the focus on it hands the focus to the field, so that what is typed next goes there. Not
  // after a tap: a focused field raises a phone's keyboard.
  const focusField = () => {
    if (pressRef.current !== 'touch') textInputRef.current?.focus();
  };

  // Leaving this conversation — switching to another chat, or unmounting when the room closes —
  // invalidates an in-flight read, so its late `onload` drops the bytes instead of staging them
  // against whichever chat is open by then. The attachment state itself lives in the page.
  useEffect(() => {
    setShowEmojiPicker(false);
    return () => {
      attachmentReadSeq.current += 1;
    };
  }, [selectedSessionId, activeChat.id]);

  useLayoutEffect(() => {
    if (textInputRef.current) fitToDraft(textInputRef.current);
  }, [messageInput]);

  // The same draft wraps onto more or fewer lines when the field changes width (the window, the contact panel).
  useEffect(() => {
    const field = textInputRef.current;
    if (!field || typeof ResizeObserver === 'undefined') return undefined;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fitToDraft(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  // A room reopened on a kept draft mounts the field with its caret before the text; typing continues after it.
  // Setting the selection moves no focus.
  useLayoutEffect(() => {
    const field = textInputRef.current;
    field?.setSelectionRange(field.value.length, field.value.length);
  }, []);

  // Typing replaces the first placeholder of the template that was just inserted.
  useLayoutEffect(() => {
    if (unfilled) textInputRef.current?.setSelectionRange(unfilled.start, unfilled.end);
  }, [unfilled]);

  // Popular emojis
  const popularEmojis = [
    '😀',
    '😂',
    '👍',
    '❤️',
    '🔥',
    '👏',
    '🙏',
    '🎉',
    '💡',
    '🤔',
    '😅',
    '😍',
    '😊',
    '😭',
    '😎',
    '😜',
    '🚀',
    '✨',
  ];

  // 5. Handle file selection & base64 conversion
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file after a rejection or removal
    if (!file) return;

    // Reject before base64-encoding: an oversized pick would inflate ~1.33x into the backend body
    // cap, and the 413 only applies after the whole body is uploaded — surface the toast now.
    if (file.size > MEDIA_UPLOAD_MAX_BYTES) {
      showErrorToast(t('chats.errors.fileTooLarge'));
      return;
    }

    // The pick replaces any staged file now, so a send while it is read cannot send the one it replaced.
    // Not handleRemoveAttachment: bumping the read sequence would discard this read too.
    setAttachment(null);
    if (file.type.startsWith('image/')) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl(null);
    }

    const myRead = ++attachmentReadSeq.current;
    const reader = new FileReader();
    reader.onload = event => {
      // A newer pick, a removal, or an unmount since the read started supersedes these bytes.
      if (attachmentReadSeq.current !== myRead) return;
      const dataUrl = event.target?.result as string;
      const base64Data = dataUrl.split(',')[1];
      // A file the browser has no MIME mapping for has type '', which the gateway refuses for base64;
      // the generic type sends it as a document, the gateway's own default.
      setAttachment({
        file,
        base64: base64Data,
        mimetype: file.type || 'application/octet-stream',
        filename: file.name,
      });
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveAttachment = () => {
    attachmentReadSeq.current += 1; // an in-flight read must not resurrect the removed attachment
    setAttachment(null);
    setPreviewUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const triggerFileSelect = () => {
    fileInputRef.current?.click();
  };

  const handleEmojiClick = (emoji: string) => {
    setMessageInput(prev => prev + emoji);
    setShowEmojiPicker(false);
    focusField();
  };

  const insertSlashTemplate = (template: SlashTemplate) => {
    // The placeholder is selected by its offset in the text as the field holds it.
    const text = insertedText(template);
    setMessageInput(text);
    setSlashClosedFor(text);
    setUnfilled(firstPlaceholder(text));
    textInputRef.current?.focus();
  };

  // 7. Handle sending a message / media
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat) return;

    // Ahead of the in-flight guard: a slash draft is resolved while an earlier message is still on its way.
    if (slashActive) {
      // Until the list has loaded nobody knows whether the draft names a template, so it is neither sent nor
      // resolved. The field takes focus, where the picker says so, when the Send button was what was pressed.
      if (templatesLoading) {
        textInputRef.current?.focus();
        return;
      }
      // The highlighted row is the template, including after ArrowDown moved off a name that also matches the
      // draft. Insert it; the operator sends with the next Enter or the Send button. A draft the picker does
      // not resolve (`/start`, or a list that failed to load) is sent as typed.
      if (slashIndex >= 0) {
        insertSlashTemplate(slashMatches[slashIndex]);
        return;
      }
    }

    if (sending || textTooLong || templateUnfilled) return;

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    // With focus in the composer form, the field takes it before the Send button disables (it does once the text is
    // cleared): the browser drops focus from a disabled control to the page, and the next message would be typed
    // nowhere. Skipped when focus is outside the form, or when the Send button was last pressed by a tap: a tap focuses
    // the button in Chromium, and a focused field raises a phone's keyboard.
    const field = textInputRef.current;
    if (pressRef.current !== 'touch' && field?.form?.contains(document.activeElement)) field.focus();

    // Text that cannot travel with an audio file stays in the input to be sent as its own message.
    if (!attachmentIsAudio) setMessageInput('');
    const threadKey = activeThreadKey;
    setSendingByThread(prev => ({ ...prev, [threadKey]: (prev[threadKey] ?? 0) + 1 }));

    const tempId = `temp_${Date.now()}_${++tempSeqRef.current}`;
    // Mirrors the body the gateway stores: image and video keep only the caption, and a document its caption
    // or else its filename. Audio stores none; its filename stands in here because the thread hides a body
    // equal to it.
    const tempMessage: ChatMessageView = {
      id: tempId,
      chatId: activeChat.id,
      from: 'me',
      to: activeChat.id,
      body: !attachment
        ? textToSend
        : attachment.mimetype.startsWith('image/') || attachment.mimetype.startsWith('video/')
          ? textToSend
          : attachment.mimetype.startsWith('audio/')
            ? attachment.filename
            : textToSend || attachment.filename,
      type: attachment ? messageTypeFromMime(attachment.mimetype) : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: buildOptimisticMetadata(attachment, replyingTo, typeLabel),
    };

    appendMessage(selectedSessionId, activeChat.id, tempMessage);
    onMessageAppended('outgoing');

    const currentAttachment = attachment;
    const currentReplyingTo = replyingTo;
    // Clear only a file that is being sent: a pick still being read stages once it lands, so it is not
    // silently dropped by text sent in the meantime.
    if (currentAttachment) handleRemoveAttachment();
    setReplyingTo(null);

    try {
      let result;

      if (currentAttachment) {
        let mediaType: 'image' | 'video' | 'audio' | 'document' = 'document';
        const mime = currentAttachment.mimetype;
        if (mime.startsWith('image/')) mediaType = 'image';
        else if (mime.startsWith('video/')) mediaType = 'video';
        else if (mime.startsWith('audio/')) mediaType = 'audio';

        // A reply that carries an attachment takes this branch, so the quote has to travel with the
        // media — the `else if` below never sees it.
        result = await messageApi.sendMedia(
          selectedSessionId,
          activeChat.id,
          mediaType,
          buildMediaSendPayload(currentAttachment, mediaType !== 'audio' ? textToSend : undefined, currentReplyingTo),
        );
      } else if (currentReplyingTo) {
        result = await messageApi.reply(selectedSessionId, {
          chatId: activeChat.id,
          quotedMessageId: quotedIdOf(currentReplyingTo)!,
          text: textToSend,
        });
      } else {
        result = await messageApi.sendText(selectedSessionId, activeChat.id, textToSend);
      }

      // Race guard: the realtime `message.sent` echo can arrive before this response and already
      // append the message by its real WA id (the dedup at receive time misses because the
      // optimistic placeholder still carries the temp id). If so, fold the placeholder INTO the
      // echo's row via mergeOrAppend instead of just dropping it — the echo may carry no media
      // payload (a Baileys API send echoes only a marker), so dropping the placeholder would erase
      // the attachment's base64 and leave a bare "📎 Media" bubble until the next refetch.
      //
      // An engine that cannot read the sent id back answers '', which as a key would fold every such
      // send into one bubble. The row keeps a unique local id instead, without the temp_ prefix: the
      // gateway did store it, so it counts toward the next page's offset like any other DB row.
      const sendKey = messagesQueryKey(selectedSessionId, activeChat.id);
      const reconciled: ChatMessageView = {
        ...tempMessage,
        id: result.messageId || tempId.replace(/^temp_/, 'sent_'),
        waMessageId: result.messageId || undefined,
        // The row sorts and is labelled by this; merged into an echo that came first, it would otherwise fall back to
        // the browser clock in createdAt, which stays the placeholder's (the media viewer finds the row by it).
        timestamp: result.timestamp,
        status: 'sent',
      };
      upsertCachedMessage(queryClient, sendKey, reconciled, { dropId: tempId });
      onSendConfirmed?.(tempId, reconciled.waMessageId ?? reconciled.id);

      // Update sidebar chat list (move active chat to the top with the new snippet)
      // Named by the type the bubble uses, not the MIME major type: a PDF is a document, not "application".
      const snippet = currentAttachment ? typeLabel(messageTypeFromMime(currentAttachment.mimetype)) : textToSend;
      const sentAt = Math.floor(Date.now() / 1000);
      onSent(selectedSessionId, activeChat.id, snippet, sentAt);
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
      // The field was emptied as Send was pressed (text next to audio was left in it).
      if (textToSend && !attachmentIsAudio) onSendFailed?.(selectedSessionId, activeChat.id, messageInput);
    } finally {
      setSendingByThread(prev => {
        const nextCount = (prev[threadKey] ?? 0) - 1;
        if (nextCount > 0) return { ...prev, [threadKey]: nextCount };
        const next = { ...prev };
        delete next[threadKey];
        return next;
      });
    }
  };

  // Enter sends. Shift+Enter breaks the line. While the template picker is open, Escape only dismisses it.
  // Arrow keys move the highlight; Tab does not select, so it can leave the field. A key something else took (the
  // Escape that closed the emoji panel) is left alone.
  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingKey(event.nativeEvent) || event.defaultPrevented) return;
    if (slashOpen && event.key === 'Escape') {
      event.preventDefault();
      setSlashClosedFor(messageInput);
      return;
    }
    if (slashListed && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = (slashIndex + step + slashMatches.length) % slashMatches.length;
      setSlashHighlight(next);
      // The list is taller than its box: the row the keys moved to is brought into it.
      document.getElementById(slashOptionId(next))?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      // A key held down repeats: its first press may have inserted a template, which the repeat would send.
      if (!event.repeat) void handleSend();
    }
  };

  const slashStatus = templatesLoading
    ? t('chats.slash.loading')
    : templatesFailed
      ? t('chats.slash.loadError')
      : slashMatches.length === 0
        ? t('chats.slash.empty')
        : '';

  return (
    <>
      {/* Composer extras: the attachment, emoji and reply panels stack above the input bar. */}
      {attachment && (
        <div className="composer-banner attachment-preview-banner">
          {previewUrl ? (
            <img src={previewUrl} alt={attachment.filename} className="preview-thumbnail" />
          ) : (
            <div className="preview-file-icon">📎</div>
          )}
          <div className="preview-file-info">
            <span className="preview-filename">{attachment.filename}</span>
            <span className="preview-filesize">({(attachment.file.size / 1024).toFixed(1)} KB)</span>
          </div>
          <button
            className="btn-banner-close btn-remove-attachment"
            {...press}
            onClick={() => {
              handleRemoveAttachment();
              focusField();
            }}
            aria-label={t('messageTester.removeFile')}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {showEmojiPicker && (
        // No role="menu" here: these are plain buttons with no menuitem roles, no roving focus and
        // no arrow-key navigation, so claiming the role would promise a keyboard contract the panel
        // does not keep. Escape is handled on document instead, see the effect above.
        <div className="composer-banner chats-emoji-picker">
          <div className="emoji-grid">
            {popularEmojis.map(emoji => (
              <button
                key={emoji}
                type="button"
                className="emoji-btn"
                {...press}
                onClick={() => handleEmojiClick(emoji)}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {replyingTo && (
        <div className="composer-banner replying-preview-banner">
          <div className="replying-preview-content">
            <div className="replying-to-title">
              {t('chats.replyingTo', {
                name: replyingTo.direction === 'outgoing' ? t('chats.you') : chatTitle(activeChat),
              })}
            </div>
            <div className="replying-to-body">
              {replyingTo.type !== 'text' ? typeLabel(replyingTo.type) : replyingTo.body}
            </div>
          </div>
          <button
            className="btn-banner-close btn-close-reply"
            {...press}
            onClick={() => {
              setReplyingTo(null);
              focusField();
            }}
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/* `/name` shortcuts: the highlighted template is inserted, then sent like any other message. A press in the
          panel leaves focus in the field, which the panel closes without. */}
      {slashOpen && (
        <div className="composer-banner slash-template-picker" onMouseDown={event => event.preventDefault()}>
          <div className="slash-template-head">
            {slashListed && (
              <span className="slash-template-hint" id={`${slashListId}-hint`}>
                {t('chats.slash.hint')}
              </span>
            )}
            <span className={slashStatus ? 'slash-template-empty' : undefined} role="status">
              {slashStatus}
            </span>
            <button
              type="button"
              className="btn-banner-close btn-close-slash"
              onClick={() => setSlashClosedFor(messageInput)}
              aria-label={t('chats.slash.close')}
            >
              <X size={18} />
            </button>
          </div>
          {slashListed && (
            <div className="slash-template-list" id={slashListId} role="listbox" aria-label={t('chats.slash.title')}>
              {slashMatches.map((template, index) => (
                <div
                  key={template.id}
                  id={slashOptionId(index)}
                  role="option"
                  aria-selected={index === slashIndex}
                  className={`slash-template-item${index === slashIndex ? ' active' : ''}`}
                  // Not on entering the row: a list the arrow keys scroll puts another row under a pointer at rest.
                  onMouseMove={() => setSlashHighlight(index)}
                  onMouseDown={event => {
                    if (event.button === 0) insertSlashTemplate(template);
                  }}
                >
                  <span className="slash-template-name">/{normalizeTemplateName(template.name)}</span>
                  <span className="slash-template-preview">{renderTemplateText(template)}</span>
                </div>
              ))}
            </div>
          )}
          {slashFound.length > SLASH_ROWS && <div className="slash-template-more">{t('chats.slash.more')}</div>}
        </div>
      )}

      {/* Message input bar */}
      <footer className="room-input-footer">
        <form onSubmit={handleSend} className="input-form">
          <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />

          <button
            type="button"
            onClick={triggerFileSelect}
            disabled={!canWrite || sending}
            className="btn-input-accessory"
            title={t('chats.attachTitle')}
            aria-label={t('chats.attachTitle')}
          >
            <Plus size={24} />
          </button>

          {/* The text field and the emoji toggle share one pill, as in WhatsApp. */}
          <div className="message-input-pill">
            <textarea
              rows={1}
              role={slashListed ? 'combobox' : undefined}
              aria-expanded={slashListed ? true : undefined}
              aria-controls={slashListed ? slashListId : undefined}
              aria-activedescendant={slashListed ? slashOptionId(slashIndex) : undefined}
              aria-autocomplete={slashListed ? 'list' : undefined}
              aria-describedby={slashListed ? `${slashListId}-hint` : undefined}
              placeholder={
                canWrite
                  ? attachment && !attachmentIsAudio
                    ? t('chats.captionPlaceholder')
                    : !attachment && templates.length > 0
                      ? t('chats.slash.placeholder')
                      : t('chats.messagePlaceholder')
                  : t('chats.noPermission')
              }
              value={messageInput}
              onChange={e => setMessageInput(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              onFocus={() => setFieldFocused(true)}
              onBlur={() => setFieldFocused(false)}
              // Never disabled by a send: it holds focus through it, and handleSend refuses a second send meanwhile.
              disabled={!canWrite}
              ref={textInputRef}
              className="message-text-input"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowEmojiPicker(!showEmojiPicker)}
              disabled={!canWrite || sending}
              className={`btn-input-accessory inside ${showEmojiPicker ? 'active' : ''}`}
              title={t('chats.emojiTitle')}
              aria-label={t('chats.emojiTitle')}
            >
              <Smile size={22} />
            </button>
          </div>

          <button
            type="submit"
            disabled={!canWrite || (!messageInput.trim() && !attachment) || sending || textTooLong || templateUnfilled}
            {...press}
            className="btn-send-message"
            aria-label={t('chats.send')}
            title={t('chats.send')}
          >
            {sending ? <Loader2 className="animate-spin" size={22} /> : <Send size={20} strokeWidth={2.25} />}
          </button>
        </form>
        {/* Kept mounted, unstyled while empty: a live region inserted with its text is often not announced. */}
        <span className={textTooLong || placeholderLeft ? 'input-hint' : undefined} role="status">
          {textTooLong
            ? t('common.fieldTooLong', { max: textMax, count: textLength })
            : placeholderLeft
              ? t('chats.slash.needsVars')
              : ''}
        </span>
      </footer>
    </>
  );
}

export default ChatComposer;
