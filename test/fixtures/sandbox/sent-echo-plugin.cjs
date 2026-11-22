// Sandbox fixture: subscribes to message:sent and sends another message via ctx.messages.sendText.
// Used to verify async echo loop suppression across the worker IPC boundary.
module.exports = class SentEchoPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:sent', async hookCtx => {
      await ctx.messages.sendText(hookCtx.sessionId || 's1', hookCtx.data.chatId, 'auto-echo');
      return { continue: true, data: hookCtx.data };
    });
  }
};
