// Sandbox fixture: exercises the capability bridge. onEnable calls a host capability and only
// resolves if it gets the expected result back — so a broken round-trip surfaces as a lifecycle
// rejection in the integration test.
module.exports = class CapEchoPlugin {
  async onEnable(ctx) {
    const result = await ctx.messages.sendText('s', 'c', 'hi');
    if (!result || result.messageId !== 'wamid') {
      throw new Error('unexpected capability result: ' + JSON.stringify(result));
    }
  }
};
