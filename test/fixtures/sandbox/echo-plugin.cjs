// Trivial lifecycle plugin for the sandbox worker integration test. A clean return from each
// lifecycle method signals success to the host (no capability context is used in phase B1).
module.exports = class EchoPlugin {
  async onEnable() {
    /* no-op */
  }
  async onDisable() {
    /* no-op */
  }
};
