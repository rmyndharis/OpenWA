// Sandbox fixture: a message:received hook that echoes ctx.config back in the result data — after an
// optional `data.delay` await. Lets the integration test assert (a) the host-resolved per-session
// config slice reaches ctx.config, and (b) it stays correct when dispatches for different sessions
// interleave across an await (the AsyncLocalStorage scope must survive the await).
module.exports = class HookConfigPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:received', async (hookCtx) => {
      const delay = hookCtx.data && hookCtx.data.delay ? hookCtx.data.delay : 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return { continue: true, data: { config: ctx.config } };
    });
  }
};
