import type { ChatKind } from '../../services/api';
import KindIcon from './KindIcon';

// Chat list avatar. Renders from the sidebar's ONE batch request (useProfilePictures) — firing a
// query per row burst the per-IP throttle into 429s. The generic icon stays while the batch loads
// or when the contact hides their picture.
function ChatAvatar({ pictureUrl, kind }: { pictureUrl?: string | null; kind: ChatKind }) {
  if (pictureUrl) {
    return (
      <div className="chat-avatar">
        <img src={pictureUrl} alt="" />
      </div>
    );
  }
  return (
    <div className="chat-avatar">
      <KindIcon kind={kind} />
    </div>
  );
}

export default ChatAvatar;
