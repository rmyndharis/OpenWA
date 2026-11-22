// Sandbox fixture: finishes onEnable cleanly, then enters a synchronous infinite loop
// from a timer with no host dispatches in flight.
module.exports = class IdleSpinPlugin {
  async onEnable() {
    setTimeout(() => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        /* spin forever */
      }
    }, 20);
  }
};
