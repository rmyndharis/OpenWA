import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, Send, Smile, X } from 'lucide-react';
import { messageApi, type Chat, type MessageType } from '../../services/api';
import { type ChatMessageView } from '../../utils/chatMessages';
import { buildMediaSendPayload, buildOptimisticMetadata, quotedIdOf } from '../../utils/composerSend';
import { messagesQueryKey, useChatMessagesActions, upsertCachedMessage } from '../../hooks/useChatMessages';
import { useRole } from '../../hooks/useRole';
import { useToast } from '../../hooks/useToast';
import type { ScrollDirection } from '../../utils/scrollDecision';

// Map an attachment MIME type to the neutral MessageType for the optimistic outgoing bubble, so the
// placeholder matches what the backend will persist (e.g. a PDF is `document`, not `application`).
const messageTypeFromMime = (mimetype: string): MessageType => {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
};

// Client pre-check before base64-encoding an upload, same cap as the message tester: base64
// inflates ~1.33x, so ~18 MiB raw stays under the backend's default 25 MiB body limit and the
// pick fails here with a toast instead of OOMing the tab on the FileReader.
export const MEDIA_UPLOAD_MAX_BYTES = 18 * 1024 * 1024;

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

  const [sending, setSending] = useState<boolean>(false);
  // "[Image]" for a non-text message; an unexpected type still reads as itself rather than a raw key.
  // An `unknown` one quotes as "[Message]" on purpose: here it is a message, not a type category
  // (the chart and the webhook filter name it through messageTypeLabelKey instead).
  const typeLabel = (type: string) => `[${t(`chats.messageType.${type}`, { defaultValue: type })}]`;
  // Audio carries no caption on either engine, so text typed next to it is never sent with it.
  const attachmentIsAudio = attachment?.mimetype.startsWith('audio/') ?? false;

  const [showEmojiPicker, setShowEmojiPicker] = useState<boolean>(false);
  // Monotonic token invalidating an in-flight attachment FileReader: picking a second file (or
  // removing the attachment) before `onload` fires must win over the late-arriving bytes —
  // otherwise the slower read overwrites the newer pick. Same pattern as composeImageReadSeq.
  const attachmentReadSeq = useRef(0);

  // Leaving this conversation — switching to another chat, or unmounting when the room closes —
  // invalidates an in-flight read, so its late `onload` drops the bytes instead of staging them
  // against whichever chat is open by then. The attachment state itself lives in the page.
  useEffect(() => {
    return () => {
      attachmentReadSeq.current += 1;
    };
  }, [activeChat.id]);

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
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      setShowEmojiPicker(false);
    };
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => document.removeEventListener('keydown', dismissOnEscape, true);
  }, [showEmojiPicker]);

  // References
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  };

  // 7. Handle sending a message / media
  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!selectedSessionId || !activeChat || sending) return;

    const textToSend = messageInput.trim();
    if (!textToSend && !attachment) return;

    // Text that cannot travel with an audio file stays in the input to be sent as its own message.
    if (!attachmentIsAudio) setMessageInput('');
    setSending(true);

    const tempId = `temp_${Date.now()}`;
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
        status: 'sent',
      };
      upsertCachedMessage(queryClient, sendKey, reconciled, { dropId: tempId });

      // Update sidebar chat list (move active chat to the top with the new snippet)
      // Named by the type the bubble uses, not the MIME major type: a PDF is a document, not "application".
      const snippet = currentAttachment ? typeLabel(messageTypeFromMime(currentAttachment.mimetype)) : textToSend;
      const sentAt = Math.floor(Date.now() / 1000);
      onSent(selectedSessionId, activeChat.id, snippet, sentAt);
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
    } finally {
      setSending(false);
    }
  };

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
          <button className="btn-banner-close btn-remove-attachment" onClick={handleRemoveAttachment}>
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
              <button key={emoji} type="button" className="emoji-btn" onClick={() => handleEmojiClick(emoji)}>
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
                name:
                  replyingTo.direction === 'outgoing' ? t('chats.you') : activeChat.name || activeChat.id.split('@')[0],
              })}
            </div>
            <div className="replying-to-body">
              {replyingTo.type !== 'text' ? typeLabel(replyingTo.type) : replyingTo.body}
            </div>
          </div>
          <button className="btn-banner-close btn-close-reply" onClick={() => setReplyingTo(null)}>
            <X size={18} />
          </button>
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
            <input
              type="text"
              placeholder={
                canWrite
                  ? attachment && !attachmentIsAudio
                    ? t('chats.captionPlaceholder')
                    : t('chats.messagePlaceholder')
                  : t('chats.noPermission')
              }
              value={messageInput}
              onChange={e => setMessageInput(e.target.value)}
              disabled={!canWrite || sending}
              className="message-text-input"
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
            disabled={!canWrite || (!messageInput.trim() && !attachment) || sending}
            className="btn-send-message"
            aria-label={t('chats.send')}
            title={t('chats.send')}
          >
            {sending ? <Loader2 className="animate-spin" size={22} /> : <Send size={20} strokeWidth={2.25} />}
          </button>
        </form>
      </footer>
    </>
  );
}

export default ChatComposer;
