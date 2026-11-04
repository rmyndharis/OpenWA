import type { ChatKind } from '../../services/api';
import KindIcon from './KindIcon';

// Pastel tone for a picture-less avatar, hashed from the chat id so a contact keeps its colour across
// reloads. The names map to the `.avatar-tone-*` rules in Chats.css (light and dark).
const AVATAR_TONES = ['blue', 'orange', 'pink', 'brown', 'violet', 'teal'] as const;
const avatarTone = (id: string): string => {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_TONES[Math.abs(hash) % AVATAR_TONES.length];
};

const ICON_SIZE = { sm: 20, md: 24, lg: 40 } as const;

// Chat list avatar. Renders from the sidebar's ONE batch request (useProfilePictures) — firing a
// query per row burst the per-IP throttle into 429s. The generic icon stays while the batch loads
// or when the contact hides their picture. The room header and the contact panel reuse it for the
// open chat, whose single-picture query hands `onImageError` a refetch for an expired CDN URL.
function ChatAvatar({
  chatId,
  pictureUrl,
  kind,
  size = 'md',
  onImageError,
}: {
  chatId: string;
  pictureUrl?: string | null;
  kind: ChatKind;
  size?: keyof typeof ICON_SIZE;
  onImageError?: () => void;
}) {
  if (pictureUrl) {
    return (
      <div className={`chat-avatar avatar-${size}`}>
        <img src={pictureUrl} alt="" onError={onImageError} />
      </div>
    );
  }
  return (
    <div className={`chat-avatar avatar-${size} avatar-tone-${avatarTone(chatId)}`}>
      <KindIcon kind={kind} size={ICON_SIZE[size]} strokeWidth={1.75} />
    </div>
  );
}

export default ChatAvatar;
