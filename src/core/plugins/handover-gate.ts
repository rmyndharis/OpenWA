import { ConversationMapping } from '../../modules/integration/entities/conversation-mapping.entity';

// The core deterministically stops the bot when a human has taken over (or the conversation is
// closed). Default (no mapping yet) = bot, so a brand-new conversation still reaches the adapter.
export function shouldDispatchInbound(mapping: Pick<ConversationMapping, 'handoverState'> | null): boolean {
  return !mapping || mapping.handoverState === 'bot';
}
