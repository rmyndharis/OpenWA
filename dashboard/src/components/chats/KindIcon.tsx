import { User, Users, Megaphone, CircleDashed } from 'lucide-react';
import type { ChatKind } from '../../services/api';

function KindIcon({ kind }: { kind: ChatKind }) {
  if (kind === 'group' || kind === 'broadcast') return <Users size={20} />;
  if (kind === 'channel') return <Megaphone size={20} />;
  if (kind === 'status') return <CircleDashed size={20} />;
  return <User size={20} />;
}

export default KindIcon;
