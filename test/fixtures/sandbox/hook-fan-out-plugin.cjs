// Sandbox fixture: a message:sending hook that awaits config.calls capability calls at once, the shape of a handler that
// replies to many chats. Each answer says whether the host ran that call inside the hook's re-entrancy guard.
module.exports = class HookFanOutPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:sending', async () => {
      const guarded = await Promise.all(
        Array.from({ length: ctx.config.calls }, (_, i) => ctx.messages.sendText('s', 'c' + i, 'hi')),
      );
      return { continue: true, data: { guarded } };
    });
  }
};
