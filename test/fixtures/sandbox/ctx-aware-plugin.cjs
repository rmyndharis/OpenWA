// Sandbox fixture: uses ctx.logger and ctx.config (and ctx.pluginId) to prove the bridged context
// is complete — the log surfaces on the host via onLog, carrying the static config.
module.exports = class CtxAwarePlugin {
  async onEnable(ctx) {
    ctx.logger.log('hello from ' + ctx.pluginId, { greeting: ctx.config.greeting });
  }
};
