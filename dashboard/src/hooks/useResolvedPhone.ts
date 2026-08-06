import { useQuery } from '@tanstack/react-query';
import { contactApi } from '../services/api';

/**
 * Lazily resolve a contact id (e.g. an @lid privacy id) to its phone number (MSISDN digits) for
 * one (sessionId, contactId). Returns null when the engine can't map it — the caller keeps its
 * fallback label in that case. An @lid ↔ phone mapping is stable, so the result is cached for a
 * day; `retry: false` keeps an unmappable id from spamming the server.
 *
 * Call it with `enabled` inputs only when the cheap local formatting already failed
 * (formatPhoneForDisplay returned null) — normal @c.us chats never need the engine round-trip.
 */
export function useResolvedPhone(sessionId: string | undefined, contactId: string | undefined) {
  return useQuery<string | null, Error>({
    queryKey: ['resolvedPhone', sessionId, contactId] as const,
    queryFn: () => contactApi.resolvePhone(sessionId!, contactId!).then(r => r.phone),
    enabled: Boolean(sessionId && contactId),
    staleTime: 24 * 60 * 60 * 1000, // 1 day — lid→phone mappings don't churn
    gcTime: 60 * 60 * 1000,
    retry: false,
  });
}
