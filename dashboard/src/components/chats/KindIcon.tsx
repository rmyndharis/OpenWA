import { User, Users, Megaphone, CircleDashed } from 'lucide-react';
import type { ChatKind } from '../../services/api';

function KindIcon({ kind, size = 20, strokeWidth }: { kind: ChatKind; size?: number; strokeWidth?: number }) {
  if (kind === 'group' || kind === 'broadcast') return <Users size={size} strokeWidth={strokeWidth} />;
  if (kind === 'channel') return <Megaphone size={size} strokeWidth={strokeWidth} />;
  if (kind === 'status') return <CircleDashed size={size} strokeWidth={strokeWidth} />;
  return <User size={size} strokeWidth={strokeWidth} />;
}

export default KindIcon;
