// Sandbox fixture: a hook handler that never resolves, to prove the host's per-handler timeout lets
// the chain proceed instead of stalling on a wedged untrusted plugin.
module.exports = class HookHangPlugin {
  async onEnable(ctx) {
    ctx.registerHook('message:received', () => new Promise(() => {}));
  }
};
