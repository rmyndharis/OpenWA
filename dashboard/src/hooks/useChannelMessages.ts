import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { sessionApi, type ChannelMessage } from '../services/api';

/** Fetches a channel's recent posts. Disabled until both ids are present; mirrors useChatMessages' shape. */
export function useChannelMessages(
  sessionId: string | null,
  channelId: string | null,
): UseQueryResult<ChannelMessage[], Error> {
  return useQuery<ChannelMessage[], Error>({
    queryKey: ['channel-messages', sessionId, channelId],
    queryFn: () => sessionApi.getChannelMessages(sessionId!, channelId!),
    enabled: Boolean(sessionId && channelId),
  });
}
