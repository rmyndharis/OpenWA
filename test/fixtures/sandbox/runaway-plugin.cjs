// Sandbox fixture: a plugin that wedges the worker in an infinite loop. Proves the host can force-
// terminate a runaway untrusted plugin (the loop blocks the worker event loop, so cooperative
// shutdown is impossible — only terminate() reclaims it).
module.exports = class RunawayPlugin {
  async onEnable() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      /* spin forever */
    }
  }
};
