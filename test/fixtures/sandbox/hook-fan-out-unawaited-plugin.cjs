// Sandbox fixture: a message:sending hook that issues config.calls calls and returns without awaiting them, the shape of
// a handler that replies to many chats and moves on. config.verb picks a send (a send fires message:sending again on the
// host) or a storage write. The calls outlive the handler. Once every one has settled the plugin logs how many were
// answered inside the hook's re-entrancy guard, how many outside it, and how many were refused, with the first refusal.
module.exports = class HookFanOutUnawaitedPlugin {
  async onEnable(ctx) {
    const { calls, verb } = ctx.config;
    const outcomes = { guarded: 0, unguarded: 0, refused: 0, refusal: null };
    let settled = 0;
    const done = () => {
      if (++settled === calls) ctx.logger.log('settled', outcomes);
    };
    ctx.registerHook('message:sending', async () => {
      for (let i = 0; i < calls; i++) {
        const call =
          verb === 'storage' ? ctx.storage.set('k' + i, { n: i }) : ctx.messages.sendText('s', 'c' + i, 'hi');
        call.then(
          answer => {
            if (answer === true) outcomes.guarded++;
            else if (answer === false) outcomes.unguarded++;
            done();
          },
          error => {
            outcomes.refused++;
            outcomes.refusal ??= error.message;
            done();
          },
        );
      }
      return { continue: true };
    });
  }
};
