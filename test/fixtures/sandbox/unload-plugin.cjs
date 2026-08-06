// Sandbox fixture: proves runLifecycle('onUnload') actually reaches the plugin inside the worker.
// onUnload flips a flag that healthCheck then reports, so the host can observe the hook ran.
module.exports = class UnloadPlugin {
  constructor() {
    this.unloaded = false;
  }
  async onUnload() {
    this.unloaded = true;
  }
  async healthCheck() {
    return { healthy: true, message: this.unloaded ? 'unloaded' : 'loaded' };
  }
};
