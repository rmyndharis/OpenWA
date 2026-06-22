// Sandbox fixture: proves onConfigChange + healthCheck reach a sandboxed plugin. It stores ctx from
// onEnable and reports its CURRENT ctx.config via healthCheck — so after a config change the health
// message reflects the new config.
module.exports = class CtxLifecyclePlugin {
  async onEnable(ctx) {
    this.ctx = ctx;
  }
  async onConfigChange(ctx, config) {
    this.ctx = ctx;
    this.changed = config;
  }
  async healthCheck() {
    return { healthy: true, message: JSON.stringify(this.ctx ? this.ctx.config : null) };
  }
};
