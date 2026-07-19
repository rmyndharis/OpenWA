import { useQuery } from '@tanstack/react-query';
import { contactApi } from '../services/api';

/**
 * Batch-fetch profile picture URLs for a list of chat ids in ONE request (the chat-list sidebar).
 * Firing one useProfilePicture per row bursts N parallel calls and exhausts the per-IP throttle
 * (429s); the batch endpoint resolves up to 50 ids server-side, 3 at a time.
 *
 * Caching mirrors useProfilePicture: 1h stale (signed CDN URLs rotate), 30min gc, no retry — an
 * id that comes back null just keeps the icon fallback. The query key uses the sorted id list so
 * reordering the sidebar doesn't refetch.
 */
export function useProfilePictures(sessionId: string | undefined, contactIds: string[]) {
  const sortedKey = [...contactIds].sort().join(',');
  return useQuery<Record<string, string | null>, Error>({
    queryKey: ['profilePictures', sessionId, sortedKey] as const,
    queryFn: () => contactApi.profilePictures(sessionId!, sortedKey.split(',')).then(r => r.pictures),
    enabled: Boolean(sessionId && contactIds.length > 0),
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}
