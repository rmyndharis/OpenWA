// Sandbox fixture: a hook handler that does ~10 ms of synchronous work per event and then continues.
// A burst of dispatches queues behind each other in the worker, so late ones time out while the worker
// is still answering; the liveness probe must not mistake that backlog for a blocked event loop.
module.exports = class BusyHookPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:received', () => {
      const until = Date.now() + 10;
      while (Date.now() < until) {
        /* busy */
      }
      return { continue: true };
    });
  }
};
