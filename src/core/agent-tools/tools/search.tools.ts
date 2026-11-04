import { NotImplementedException } from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { MessageDirection } from '../../../modules/message/entities/message.entity';
import type { SearchService } from '../../../modules/search/search.service';
import {
  SEARCH_CONTAINS_MIN_TERM_LENGTH,
  SEARCH_CONTAINS_TERMS_MAX_LENGTH,
  SEARCH_CONTAINS_WINDOW,
  SEARCH_LIMIT_MAX,
  SEARCH_MATCH_MODES,
  SEARCH_OFFSET_MAX,
  SEARCH_QUERY_MAX_LENGTH,
} from '../../../modules/search/search.constants';
import { ContainsTermsRefusedError } from '../../../modules/search/search-terms';
import { chatIdSchema } from '../chat-id-schema';
import { defineTool, type AnyToolDescriptor } from '../tool-descriptor';

/**
 * Global message search for agents: the same SearchService, scopes and limits as `GET /api/search`.
 *
 * `search` is undefined when SEARCH_ENABLED=false leaves SearchModule out. The tool is still
 * registered, so the published tool surface (and the counts the README states) does not depend on
 * configuration; calling it answers 501, as the REST route answers 404 then.
 *
 * `containsEnabled` is SEARCH_CONTAINS_ENABLED. With it on, `match` defaults to contains, unlike REST
 * (word): an agent often knows only part of a word or types it without accents. Contains does not run
 * every query word does (two-character words alone, as most Korean and many CJK words are, give the
 * trigram index nothing to look up, and the terms together are bounded), so a query it refuses for its
 * terms runs as a word search, as does one while its index is not ready. With it off the built-in
 * provider answers 501 to contains, so the tool defaults to word like REST.
 */
export function searchTools(search: SearchService | undefined, containsEnabled = false): AnyToolDescriptor[] {
  const defaultMatch = containsEnabled ? 'contains' : 'word';
  const matchHelp = containsEnabled
    ? `match=contains (the default) finds any part of a word, ignoring case and accents, and ranks the ${SEARCH_CONTAINS_WINDOW} most recently stored matches (whole words first, then newest), so total is at most ${SEARCH_CONTAINS_WINDOW}: narrow with more terms, chatId or dateTo to reach older ones. It needs a term of ${SEARCH_CONTAINS_MIN_TERM_LENGTH} or more characters and at most ${SEARCH_CONTAINS_TERMS_MAX_LENGTH} characters in all its terms; without match, a query outside those bounds runs as match=word, which finds whole words only.`
    : 'match=word (the default) finds whole words; match=contains needs SEARCH_CONTAINS_ENABLED=true on the server.';
  return [
    defineTool({
      name: 'MessageSearch',
      // A key restricted to selected chats must name an allowed chat, as MessageList requires; the
      // allowlist is then also handed to the provider, which narrows hits before limit/offset/total and
      // is how a plugin provider knows to refuse a restricted key.
      chatScope: ['chatId'],
      description:
        'Search persisted messages across every session and chat the API key may read. Returns ranked hits with a <mark>-highlighted snippet, chatId, sender and timestamp; resolve names with SessionGetChats or ContactFindOne. ' +
        `${matchHelp} A key restricted to selected chats must pass chatId.`,
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        q: z.string().trim().min(1).max(SEARCH_QUERY_MAX_LENGTH).describe('Search term'),
        match: z
          .enum(SEARCH_MATCH_MODES)
          .optional()
          .describe(`contains: any part of a word; word: whole words only. Default: ${defaultMatch}`),
        chatId: chatIdSchema.optional().describe('Restrict to a single chat JID'),
        from: z.string().optional().describe('Filter by sender phone or JID'),
        direction: z.enum(MessageDirection).optional(),
        dateFrom: z
          .number()
          .min(-Number.MAX_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe('Epoch-ms lower bound (inclusive)'),
        dateTo: z
          .number()
          .min(-Number.MAX_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe('Epoch-ms upper bound (inclusive)'),
        limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
        offset: z.number().int().min(0).max(SEARCH_OFFSET_MAX).optional(),
      }),
      handler: async (input, apiKey, chatScope) => {
        if (!search) throw new NotImplementedException('Search is disabled (SEARCH_ENABLED=false).');
        // Both scopes come from the authenticated key, never the input, exactly as SearchController
        // passes them: SearchService overwrites any caller-supplied scope at the provider boundary.
        const sessionIds = apiKey.allowedSessions ?? undefined;
        const chatIds = await chatScope?.idsForFilter(apiKey);
        try {
          return await search.search({ ...input, match: input.match ?? defaultMatch }, sessionIds, chatIds);
        } catch (error) {
          // Unless the agent asked for contains, a query contains cannot run yet (its index is not ready)
          // or cannot run at all for its terms (too short or too long) is answered as a word search.
          const fallback = error instanceof NotImplementedException || error instanceof ContainsTermsRefusedError;
          if (input.match || defaultMatch === 'word' || !fallback) throw error;
          return search.search({ ...input, match: 'word' }, sessionIds, chatIds);
        }
      },
    }),
  ];
}
