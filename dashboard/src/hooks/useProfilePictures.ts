import { useQuery } from '@tanstack/react-query';
import { contactApi } from '../services/api';

/**
 * Batch-fetch profile picture URLs for a list of chat ids in ONE request (the chat-list sidebar).
 * Firing one useProfilePicture per row bursts N parallel calls and exhausts the per-IP throttle
 * (429s); the batch endpoint resolves up to 50 ids server-side, 5 at a time with a per-id deadline.
 *
 * Ids are resolved in LIST ORDER, capped at 50 — for long sidebars the visible top rows get their
 * pictures instead of an arbitrary sorted subset (which can exclude every row on screen). The
 * query key uses the sorted id set so reordering the sidebar doesn't refetch.
 *
 * Caching mirrors useProfilePicture: 1h stale (signed CDN URLs rotate), 30min gc, no retry — an
 * id that comes back null just keeps the icon fallback.
 */
export function useProfilePictures(sessionId: string | undefined, contactIds: string[]) {
  const requestIds = contactIds.slice(0, 50); // list order: the visible top rows win the cap
  const sortedKey = [...requestIds].sort().join(',');
  return useQuery<Record<string, string | null>, Error>({
    queryKey: ['profilePictures', sessionId, sortedKey] as const,
    queryFn: () => contactApi.profilePictures(sessionId!, requestIds).then(r => r.pictures),
    enabled: Boolean(sessionId && requestIds.length > 0),
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}
