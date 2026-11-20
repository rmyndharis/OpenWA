// Sandbox fixture: a plugin that writes config.calls keys in a loop without awaiting any of them, the shape of a forEach
// that saves per-item state. The writes outlive onEnable. By default nothing catches a rejected write, which would be an
// unhandled rejection; with config.swallow each rejection is caught and counted, and the count is logged once every
// write has settled.
module.exports = class StorageUnawaitedSetPlugin {
  async onEnable(ctx) {
    const { calls, swallow } = ctx.config;
    const writes = [];
    let rejected = 0;
    for (let i = 0; i < calls; i++) {
      const write = ctx.storage.set('k' + i, { n: i });
      if (swallow) {
        writes.push(
          write.catch(() => {
            rejected++;
          }),
        );
      }
    }
    if (swallow) void Promise.all(writes).then(() => ctx.logger.log('settled', { rejected }));
  }
};
