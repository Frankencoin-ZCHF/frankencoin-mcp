import { TimeoutError, UpstreamError } from "../lib/errors.js";

/** Each fixed origin has an independent circuit. Only transient provider failures count. */
export class ProviderCircuits {
  constructor({ threshold = 3, cooldownMs = 10_000, now = Date.now } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.origins = new Map();
  }
  async run(origin, source, load) {
    let state = this.origins.get(origin);
    if (!state) {
      state = { failures: 0, until: 0, probing: false, generation: 0 };
      this.origins.set(origin, state);
    }
    if (state.until > this.now() || state.probing)
      throw new UpstreamError(source, 503);
    const probe = state.until !== 0;
    if (probe) state.probing = true;
    const generation = state.generation;
    try {
      const result = await load();
      if (generation === state.generation) {
        state.failures = 0;
        state.until = 0;
      }
      return result;
    } catch (err) {
      const transient =
        err instanceof TimeoutError ||
        (err instanceof UpstreamError &&
          (err.upstreamStatus == null ||
            err.upstreamStatus === 429 ||
            err.upstreamStatus >= 500));
      if (
        generation === state.generation &&
        transient &&
        (probe || ++state.failures >= this.threshold)
      ) {
        state.until = this.now() + this.cooldownMs;
        state.generation++;
      } else if (probe && !transient) {
        // This origin answered. Let other operations try even if this particular read failed.
        state.until = 0;
        state.failures = 0;
      }
      throw err;
    } finally {
      if (probe) state.probing = false;
    }
  }
}
