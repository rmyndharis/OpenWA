// Sandbox fixture: a plugin that issues config.calls storage calls at once and awaits them all, the shape of loading or
// saving the state of every key of a list with Promise.all. It reports how many settled, how many failed and the first
// error. A read checks that each answer is the value of its own key.
module.exports = class StorageBurstPlugin {
  async onEnable(ctx) {
    const { calls, write } = ctx.config;
    const issue = i => (write ? ctx.storage.set('k' + i, { n: i }) : ctx.storage.get('k' + i));
    const settled = await Promise.allSettled(Array.from({ length: calls }, (_, i) => issue(i)));
    const failed = settled.filter(result => result.status === 'rejected');
    const wrong = settled.filter(
      (result, i) => !write && result.status === 'fulfilled' && !(result.value && result.value.n === i),
    ).length;
    ctx.logger.log('settled', {
      ok: settled.length - failed.length,
      failed: failed.length,
      wrong,
      firstError: failed[0] ? String(failed[0].reason && failed[0].reason.message) : null,
    });
  }
};
