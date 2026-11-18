// Sandbox fixture: a plugin that logs config.lines times in a loop that never yields, the shape of a retry loop that
// logs each failed attempt. The loop runs inside onEnable, so the lifecycle result follows the last line.
module.exports = class LogFloodPlugin {
  async onEnable(ctx) {
    for (let attempt = 0; attempt < ctx.config.lines; attempt++) ctx.logger.warn('retrying', { attempt });
  }
};
