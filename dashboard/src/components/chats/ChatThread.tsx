import { useCallback, useEffect, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, CornerUpLeft, Loader2, MessageSquare, Smile, Trash2 } from 'lucide-react';
import type { Chat } from '../../services/api';
import { getMediaSrc, senderKey, type ChatMessageView } from '../../utils/chatMessages';
import MessageBody from './MessageBody';

// Stable per-sender colour for group message labels, like WhatsApp gives each participant a colour.
// Hashed from the sender's name so the same person keeps the same colour across a session. The palette
// is tuned to stay legible on both the light and dark incoming-bubble backgrounds.
const SENDER_COLORS = ['#d1416f', '#7c5cff', '#0a86c4', '#1a8f5c', '#c26a00', '#c0392b', '#0e7c86', '#8e44ad'];
const senderColor = (name: string): string => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
};

interface ChatThreadProps {
  activeChat: Chat;
  messages: ChatMessageView[];
  loadingMessages: boolean;
  messagesError: boolean;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  onMediaLoad: () => void;
  onOpenImage: (messageId: string) => void;
  onReply: (message: ChatMessageView) => void;
  onReact: (message: ChatMessageView, emoji: string) => void;
  onDelete: (message: ChatMessageView) => void;
}

// The messages area of the active chat room: the bubble list (media, quotes, reactions, hover
// actions) plus the floating scroll-to-bottom button. The page owns the message query and the
// scroll-position hook (its containerRef is handed down); reply/react/delete/lightbox intents go
// back up as callbacks.
function ChatThread({
  activeChat,
  messages,
  loadingMessages,
  messagesError,
  messagesContainerRef,
  onMediaLoad,
  onOpenImage,
  onReply,
  onReact,
  onDelete,
}: ChatThreadProps) {
  const { t } = useTranslation();

  // Scroll-to-bottom button visibility. The main scroll-position memory is owned by
  // useChatScrollPosition, which doesn't expose its pin state (intentionally — that would re-render
  // the whole room on every scroll). This small listener tracks only the boolean "user is far from
  // the bottom" so we can float the jump button.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      // 120px gap = a couple of message bubbles before counting as "scrolled up".
      setShowJumpToBottom(el.scrollHeight - el.scrollTop - el.clientHeight > 120);
    };
    onScroll(); // sync initial position (e.g. saved restore landed above the bottom)
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  });

  const handleJumpToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messagesContainerRef]);

  // Reset the jump button whenever the active chat changes: the new chat's content is restored by
  // useChatScrollPosition and our listener will resync on its first scroll tick.
  useEffect(() => {
    setShowJumpToBottom(false);
  }, [activeChat?.id]);

  // Helper formats
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return '';
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // position:relative so the scroll-to-bottom button can float inside.
  return (
    <div className="room-messages" ref={messagesContainerRef}>
      {/* Floating scroll-to-bottom button. Hidden while loading (no height to measure yet)
          and when the user is already at/near the bottom. */}
      {showJumpToBottom && !loadingMessages && (
        <button
          type="button"
          className="scroll-to-bottom-btn"
          onClick={handleJumpToBottom}
          aria-label={t('chats.scrollToBottom')}
          title={t('chats.scrollToBottom')}
        >
          <ChevronDown size={22} />
        </button>
      )}
      {loadingMessages ? (
        <div className="messages-loading">
          <Loader2 className="animate-spin" size={32} />
          <span>{t('chats.loadingMessages')}</span>
        </div>
      ) : messagesError ? (
        <div className="messages-empty">
          <MessageSquare size={32} />
          <span>{t('chats.loadMessagesError')}</span>
        </div>
      ) : messages.length === 0 ? (
        <div className="messages-empty">
          <MessageSquare size={32} />
          <span>{t('chats.noMessagesInChat')}</span>
        </div>
      ) : (
        messages.map((msg, index) => {
          const isMe = msg.direction === 'outgoing';
          const formattedTime = formatTime(msg.timestamp || Math.floor(new Date(msg.createdAt).getTime() / 1000));

          // Label who posted, WhatsApp-style: only in groups, only on incoming messages,
          // and only on the first of a consecutive run from the same sender (so a burst
          // from one person isn't repeated on every bubble).
          const prev = messages[index - 1];
          const showSender = Boolean(
            activeChat?.isGroup &&
            !isMe &&
            msg.chatName &&
            // Key the run on the stable sender id (participant JID), not the display
            // name — two participants who share a pushName must still start a new run.
            (!prev || prev.direction === 'outgoing' || senderKey(prev) !== senderKey(msg)),
          );

          const isMediaMessage = msg.type !== 'text';
          const mediaInfo = msg.metadata?.media;

          const renderMedia = () => {
            if (msg.type === 'revoked') return null;
            // location/call have no downloadable media payload — render them before the
            // mediaInfo gate. The raw body (a base64 thumbnail / empty token) is suppressed below.
            if (msg.type === 'location') {
              // WhatsApp location messages carry a base64 JPEG map-preview thumbnail in `body`.
              const thumb = msg.body && msg.body.length > 100 ? `data:image/jpeg;base64,${msg.body}` : '';
              return (
                <div className="message-location">
                  {thumb && (
                    <img
                      src={thumb}
                      alt=""
                      onLoad={onMediaLoad}
                      style={{ maxWidth: 220, borderRadius: 8, display: 'block', marginBottom: 4 }}
                    />
                  )}
                  <span className="message-media-omitted">📍 {t('chats.media.location')}</span>
                </div>
              );
            }
            if (msg.type === 'call') {
              const call = msg.metadata?.call;
              const callKey = call?.video
                ? call.missed
                  ? 'callVideoMissed'
                  : 'callVideo'
                : call?.missed
                  ? 'callMissed'
                  : 'call';
              return (
                <div className="message-media-omitted">
                  {`${call?.video ? '📹' : '📞'} ${t(`chats.media.${callKey}`)}`}
                </div>
              );
            }
            if (!mediaInfo) return null;
            if (mediaInfo.omitted) {
              return <div className="message-media-omitted">📎 {t('chats.media.omitted')}</div>;
            }
            const mediaSrc = getMediaSrc(mediaInfo);
            if (!mediaSrc) return null;

            switch (msg.type) {
              case 'image':
              case 'sticker':
                return (
                  <div className="message-media-image">
                    <img
                      src={mediaSrc}
                      alt={mediaInfo.filename || t('chats.media.image')}
                      className="chat-image-media"
                      onLoad={onMediaLoad}
                      onClick={() => onOpenImage(msg.id)}
                    />
                  </div>
                );
              case 'video':
                return (
                  <div className="message-media-video">
                    <video src={mediaSrc} controls className="chat-video-media" onLoadedData={onMediaLoad} />
                  </div>
                );
              case 'audio':
              case 'voice':
                return (
                  <div className="message-media-audio">
                    <audio src={mediaSrc} controls className="chat-audio-media" />
                  </div>
                );
              case 'document':
              default:
                return (
                  <div className="message-media-document">
                    <a href={mediaSrc} download={mediaInfo.filename || 'document'} className="chat-document-media">
                      📎 {mediaInfo.filename || t('chats.downloadDocument')}
                    </a>
                  </div>
                );
            }
          };

          const reactions = msg.metadata?.reactions || {};
          const hasReactions = Object.keys(reactions).length > 0;
          const isRevoked = msg.type === 'revoked';
          const isMasked = msg.type === 'masked';

          return (
            <div
              key={msg.id}
              className={`message-bubble-wrapper ${isMe ? 'outgoing' : 'incoming'}`}
              data-wa-message-id={msg.waMessageId}
            >
              <div className="message-bubble-container">
                <div
                  className={`message-bubble ${isMe ? 'outgoing' : 'incoming'} ${msg.status} ${
                    isMediaMessage ? 'media-type' : ''
                  } ${isRevoked ? 'revoked-type' : ''}`}
                >
                  {/* Group sender label (WhatsApp-style: coloured name atop the bubble) */}
                  {/* Group sender label (WhatsApp-style: coloured name atop the bubble).
                      Colour keys on the stable sender id, so same-named participants
                      still get distinct colours; the label shows the human name. */}
                  {showSender && (
                    <div className="message-sender" style={{ color: senderColor(senderKey(msg)!) }}>
                      {msg.chatName}
                    </div>
                  )}

                  {/* Quoted message display */}
                  {msg.metadata?.quotedMessage && (
                    <div className="message-quote-box">
                      <MessageBody text={msg.metadata.quotedMessage.body} className="quote-body" />
                    </div>
                  )}

                  {renderMedia()}

                  {isRevoked ? (
                    <div className="message-text">{t('chats.messageDeleted')}</div>
                  ) : isMasked ? (
                    <div className="message-text message-masked">{t('chats.messageMasked')}</div>
                  ) : (
                    msg.body &&
                    (!mediaInfo || msg.body !== mediaInfo.filename) &&
                    msg.type !== 'location' &&
                    msg.type !== 'call' && <MessageBody text={msg.body} className="message-text" />
                  )}

                  <div className="message-meta">
                    <span className="message-time">{formattedTime}</span>
                    {isMe && (
                      <span className={`message-status-icon ${msg.status}`}>
                        {msg.status === 'pending' && '🕒'}
                        {msg.status === 'sent' && '✓'}
                        {msg.status === 'delivered' && '✓✓'}
                        {msg.status === 'read' && '✓✓'}
                        {msg.status === 'failed' && '⚠️'}
                      </span>
                    )}
                  </div>

                  {/* Reactions display */}
                  {hasReactions && (
                    <div className="message-reactions-badge">
                      {Object.values(reactions)
                        .slice(0, 3)
                        .map((emoji, idx) => (
                          <span key={idx} className="reaction-emoji-span">
                            {emoji}
                          </span>
                        ))}
                      {Object.keys(reactions).length > 1 && (
                        <span className="reactions-count-span">{Object.keys(reactions).length}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Message actions menu (hover) */}
                {!isRevoked && (
                  <div className="message-actions-menu">
                    <button
                      type="button"
                      className="action-btn"
                      onClick={() => onReply(msg)}
                      title={t('chats.actions.reply')}
                    >
                      <CornerUpLeft size={14} />
                    </button>

                    <div className="reaction-trigger-wrapper">
                      <button type="button" className="action-btn reaction-btn" title={t('chats.actions.react')}>
                        <Smile size={14} />
                      </button>
                      <div className="reaction-quick-popover">
                        {['👍', '❤️', '😂', '😮', '😢', '🙏'].map(emoji => (
                          <button key={emoji} type="button" onClick={() => onReact(msg, emoji)}>
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>

                    {isMe && msg.status !== 'pending' && (
                      <button
                        type="button"
                        className="action-btn delete-btn"
                        onClick={() => onDelete(msg)}
                        title={t('chats.actions.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

export default ChatThread;
