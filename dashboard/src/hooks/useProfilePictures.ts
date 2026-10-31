import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { contactApi } from '../services/api';

// Signed CDN URLs rotate: a held picture is reused for an hour, then asked for again.
const PICTURE_TTL_MS = 60 * 60 * 1000;
// The batch route answers null for a hidden or missing picture and also for a lookup that failed (throttled or past
// its per-id deadline), and the two look alike; an id skipped after another lookup timed out is absent from the
// answer. A null is held for a minute only: a failure heals on the next change of ids after that, and a real null
// costs one more lookup then. An absent id is asked for again at once.
const NULL_TTL_MS = 60 * 1000;

interface ResolvedPicture {
  url: string | null;
  at: number;
}

type Held = Map<string, ResolvedPicture>;

// What each session's batches were told, with the time it arrived. It is kept in the query cache, beside the data
// of the batches it came with, and not with the page: a page that mounts again finds it instead of asking for every
// picture once more, and signing out, which clears the cache, drops it. Nothing collects it on its own, as it is
// small and its entries age out by their own clock.
const HELD_KEY = 'profilePicturesHeld';
const heldKey = (sessionId: string) => [HELD_KEY, sessionId] as const;
function heldFor(client: QueryClient, sessionId: string): Held {
  client.setQueryDefaults([HELD_KEY], { gcTime: Infinity });
  let held = client.getQueryData<Held>(heldKey(sessionId));
  if (!held) {
    held = new Map();
    client.setQueryData(heldKey(sessionId), held);
  }
  return held;
}

/**
 * Batch-fetch profile picture URLs for a list of chat ids in ONE request (the chat-list sidebar).
 * Firing one useProfilePicture per row bursts N parallel calls and exhausts the per-IP throttle
 * (429s); the batch endpoint resolves up to 50 ids server-side, 5 at a time with a per-id deadline.
 *
 * Ids are resolved in LIST ORDER, capped at 50 — for long sidebars the visible top rows get their
 * pictures instead of an arbitrary sorted subset (which can exclude every row on screen). The
 * query key uses the sorted id set so reordering the sidebar doesn't refetch.
 *
 * A change of membership (a message from a chat outside the top 50 pushes one out) is a new key, but
 * only the ids not held yet are asked for: every answer is kept per session with the time it arrived and
 * reused for an hour, a null (hidden, no picture, or a lookup that failed) for a minute. What is held lives
 * in the query cache, so a page that mounts again with the same ids asks for nothing. The data returned
 * covers the requested ids, and the previous data of the same session stays while a smaller batch is
 * out, so the rows keep their pictures instead of dropping to the generic icon. An invalidated batch (a
 * picture was changed) asks for every id again, held or not.
 *
 * Caching mirrors useProfilePicture: 1h stale (signed CDN URLs rotate), 30min gc, no retry — an
 * id that comes back null just keeps the icon fallback.
 */
export function useProfilePictures(sessionId: string | undefined, contactIds: string[]) {
  const queryClient = useQueryClient();
  const requestIds = contactIds.slice(0, 50); // list order: the visible top rows win the cap
  const sortedKey = [...requestIds].sort().join(',');
  return useQuery<Record<string, string | null>, Error>({
    queryKey: ['profilePictures', sessionId, sortedKey] as const,
    queryFn: async ({ client, queryKey }) => {
      const held = heldFor(client, sessionId!);
      const view = () => {
        const pictures: Record<string, string | null> = {};
        for (const id of requestIds) {
          const entry = held.get(id);
          if (entry) pictures[id] = entry.url;
        }
        return pictures;
      };
      const now = Date.now();
      const invalidated = client.getQueryState(queryKey)?.isInvalidated ?? false;
      const missing = requestIds.filter(id => {
        const entry = held.get(id);
        return invalidated || !entry || now - entry.at >= (entry.url === null ? NULL_TTL_MS : PICTURE_TTL_MS);
      });
      if (missing.length > 0) {
        try {
          const { pictures } = await contactApi.profilePictures(sessionId!, missing);
          const at = Date.now();
          for (const id of missing) if (id in pictures) held.set(id, { url: pictures[id], at });
        } catch (err) {
          // A failed top-up (throttled, engine starting) must not blank the pictures already held. The ids
          // it left out stay unresolved and are asked for again on the next change of membership.
          if (Object.keys(view()).length === 0) throw err;
        }
      }
      return view();
    },
    // The previous batch's pictures stay up while the next one loads, but only within one session.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === sessionId ? previous : undefined),
    enabled: Boolean(sessionId && requestIds.length > 0),
    // Fresh until the oldest requested picture is an hour old. A missing one (an id the answer left out, a
    // failed top-up) or an expired one makes the query stale at once, so the next focus or mount asks again
    // for just those, instead of a failed attempt counting as a fresh hour. A null's shorter clock is for the
    // next change of ids only: counted here, it would send every focus back for all the pictures nobody has.
    staleTime: query => {
      const held = sessionId ? queryClient.getQueryData<Held>(heldKey(sessionId)) : undefined;
      let expiresAt = Infinity;
      for (const id of requestIds) {
        const entry = held?.get(id);
        if (!entry) return 0;
        expiresAt = Math.min(expiresAt, entry.at + PICTURE_TTL_MS);
      }
      return Math.max(0, expiresAt - query.state.dataUpdatedAt);
    },
    gcTime: 30 * 60 * 1000,
    retry: false,
  });
}
