// Sandbox fixture: registers a message:received hook that swallows the event and tags the data,
// so the integration test can assert the full hook round-trip (host dispatch -> worker handler).
module.exports = class HookPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:received', async (hookCtx) => ({
      continue: false,
      data: { ...hookCtx.data, seen: true },
    }));
  }
};
