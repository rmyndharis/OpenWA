import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, Paperclip, Send, Smile, X } from 'lucide-react';
import { messageApi, type Chat, type MessageType } from '../../services/api';
import { type ChatMessageView } from '../../utils/chatMessages';
import { promoteChatWithSnippet } from '../../utils/chatList';
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
const MEDIA_UPLOAD_MAX_BYTES = 18 * 1024 * 1024;

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
  setChats: Dispatch<SetStateAction<Chat[]>>;
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
  setChats,
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
      setAttachment({ file, base64: base64Data, mimetype: file.type, filename: file.name });
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
      type: attachment ? messageTypeFromMime(attachment.mimetype) : 'text',
      direction: 'outgoing',
      status: 'pending',
      createdAt: new Date().toISOString(),
      metadata: buildOptimisticMetadata(attachment, replyingTo),
    };

    appendMessage(selectedSessionId, activeChat.id, tempMessage);
    onMessageAppended('outgoing');

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
      const sendKey = messagesQueryKey(selectedSessionId, activeChat.id);
      const reconciled: ChatMessageView = {
        ...tempMessage,
        id: result.messageId,
        waMessageId: result.messageId,
        status: 'sent',
      };
      upsertCachedMessage(queryClient, sendKey, reconciled, { dropId: tempId });

      // Update sidebar chat list (move active chat to the top with the new snippet)
      const snippet = currentAttachment ? `[${currentAttachment.mimetype.split('/')[0]}]` : textToSend;
      const sentAt = Math.floor(Date.now() / 1000);
      setChats(prevChats => promoteChatWithSnippet(prevChats, activeChat.id, snippet, sentAt));
    } catch (err) {
      showErrorToast(t('chats.errors.send'), err instanceof Error ? err.message : undefined);
      updateMessage(selectedSessionId, activeChat.id, tempId, { status: 'failed' });
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Attachment preview banner */}
      {attachment && (
        <div className="attachment-preview-banner">
          {previewUrl ? (
            <img src={previewUrl} alt={attachment.filename} className="preview-thumbnail" />
          ) : (
            <div className="preview-file-icon">📎</div>
          )}
          <div className="preview-file-info">
            <span className="preview-filename">{attachment.filename}</span>
            <span className="preview-filesize">({(attachment.file.size / 1024).toFixed(1)} KB)</span>
          </div>
          <button className="btn-remove-attachment" onClick={handleRemoveAttachment}>
            <X size={18} />
          </button>
        </div>
      )}

      {/* Popular emojis panel */}
      {showEmojiPicker && (
        // No role="menu" here: these are plain buttons with no menuitem roles, no roving focus and
        // no arrow-key navigation, so claiming the role would promise a keyboard contract the panel
        // does not keep. Escape is handled on document instead, see the effect above.
        <div className="chats-emoji-picker">
          <div className="emoji-grid">
            {popularEmojis.map(emoji => (
              <button key={emoji} type="button" className="emoji-btn" onClick={() => handleEmojiClick(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Replying preview banner */}
      {replyingTo && (
        <div className="replying-preview-banner">
          <div className="replying-preview-content">
            <div className="replying-to-title">
              {t('chats.replyingTo', {
                name:
                  replyingTo.direction === 'outgoing' ? t('chats.you') : activeChat.name || activeChat.id.split('@')[0],
              })}
            </div>
            <div className="replying-to-body">
              {replyingTo.type !== 'text' ? `[${replyingTo.type}]` : replyingTo.body}
            </div>
          </div>
          <button className="btn-close-reply" onClick={() => setReplyingTo(null)}>
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
          >
            <Paperclip size={20} />
          </button>

          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            disabled={!canWrite || sending}
            className={`btn-input-accessory ${showEmojiPicker ? 'active' : ''}`}
            title={t('chats.emojiTitle')}
          >
            <Smile size={20} />
          </button>

          <input
            type="text"
            placeholder={
              canWrite
                ? attachment
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
            type="submit"
            disabled={!canWrite || (!messageInput.trim() && !attachment) || sending}
            className="btn-send-message"
            aria-label={t('chats.send')}
          >
            {sending ? <Loader2 className="animate-spin" size={24} /> : <Send size={28} strokeWidth={2.5} />}
          </button>
        </form>
      </footer>
    </>
  );
}

export default ChatComposer;
