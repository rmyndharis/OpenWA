// Sandbox fixture: a plugin that calls ctx.storage.get config.calls times in a loop that never yields and never awaits
// a call, the shape of a missing await in a loop over a large list. The loop runs inside onEnable, so the lifecycle
// result follows the last call.
module.exports = class CapFloodPlugin {
  async onEnable(ctx) {
    for (let i = 0; i < ctx.config.calls; i++) ctx.storage.get('key').catch(() => undefined);
  }
};
