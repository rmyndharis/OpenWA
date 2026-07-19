import { useQuery } from '@tanstack/react-query';
import { contactApi } from '../services/api';

/**
 * Lazily fetch a chat participant's profile picture URL for one (sessionId, contactId).
 *
 * The endpoint returns the WhatsApp signed CDN URL (or null when the user hid their picture).
 * Those URLs rotate every few hours, so we cache aggressively — `staleTime: 1h` keeps a healthy
 * picture from refetching on every Chats mount/sidebar scroll, while still refreshing often
 * enough to follow a contact's avatar change. `retry: false` keeps an unavailable picture from
 * spamming the server (the user just sees the icon fallback).
 *
 * The query is disabled when either id is missing so it can be called unconditionally from the
 * chat list / room header without firing for the empty placeholder state.
 */
export function useProfilePicture(sessionId: string | undefined, contactId: string | undefined) {
  return useQuery<string | null, Error>({
    queryKey: ['profilePicture', sessionId, contactId] as const,
    queryFn: () => contactApi.profilePicture(sessionId!, contactId!).then(r => r.url),
    enabled: Boolean(sessionId && contactId),
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 30 * 60 * 1000, // drop unused avatars from cache after 30 min
    retry: false,
  });
}
