// Sandbox fixture: the 'slow' route awaits a capability call that outlives the webhook dispatch budget, the shape of a
// handler awaiting a slow upstream. The 'fast' route awaits a call that is answered at once and returns its value.
module.exports = class WebhookSlowCapPlugin {
  async onEnable(ctx) {
    ctx.registerWebhook('slow', async () => {
      await ctx.net.fetch('https://upstream.invalid/slow');
      return { status: 200 };
    });
    ctx.registerWebhook('fast', async () => ({ status: 200, body: String(await ctx.storage.get('key')) }));
  }
};
