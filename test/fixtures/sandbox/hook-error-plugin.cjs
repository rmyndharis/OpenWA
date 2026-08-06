// Sandbox fixture: registers a message:received hook whose handler always throws, so the integration
// test can assert the failure rides the hook-result back to the host instead of vanishing.
module.exports = class HookErrorPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:received', async () => {
      throw new Error('intentional hook failure');
    });
  }
};
