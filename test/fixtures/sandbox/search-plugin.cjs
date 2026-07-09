// Sandbox fixture: registers a search provider whose handler returns canned SearchResults derived from
// the query, so the integration test can assert the full search RPC round-trip
// (host dispatch -> worker handler -> search-result). The handler echoes the query term into the hit.
module.exports = class SearchPlugin {
  async onEnable(ctx) {
    ctx.registerSearchProvider(async (query) => {
      const term = String(query.q || '');
      return {
        hits: term
          ? [
              {
                messageId: 'm1',
                waMessageId: 'wamid1',
                sessionId: 's1',
                chatId: 'c1@c.us',
                body: `match for ${term}`,
                snippet: `<mark>${term}</mark>`,
                timestamp: 1700000000,
                type: 'text',
                direction: 'outgoing',
                from: 'a@c.us',
              },
            ]
          : [],
        total: term ? 1 : 0,
        tookMs: 2,
        provider: 'plugin:search-fixture',
      };
    });
  }
};
