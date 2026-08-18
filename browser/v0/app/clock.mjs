/**
 * Story time: the one number every plane of the picture is drawn from.
 *
 * It is wall time with a hole in it. Paused, `now()` answers the instant it was
 * paused at and keeps answering it however long the viewer is away, so a cast
 * drawn from `stateAt(now())`, a plate aimed from the same framing and a
 * narration held at its own offset all stop together and all continue together.
 * Seeking moves the hole instead of the clock: the origin is rewritten so that
 * `now()` is the instant asked for, running or not.
 */
export class StoryClock {
  #now;
  #origin = null;
  #held = 0;
  #running = false;

  constructor({ now = defaultNow } = {}) {
    this.#now = now;
  }

  /** Run from wherever the clock is standing. Idempotent, like resume. */
  start() {
    if (this.#running) return;
    this.#origin = this.#now() - this.#held;
    this.#running = true;
  }

  now() {
    if (!this.#running) return this.#held;
    return Math.max(0, Math.round(this.#now() - this.#origin));
  }

  get running() {
    return this.#running;
  }

  /** Freeze at the instant on screen. Nothing after this moves until `start`. */
  pause() {
    if (!this.#running) return;
    this.#held = this.now();
    this.#running = false;
  }

  /**
   * Stand at `milliseconds`, running or not.
   *
   * Rounded and floored here rather than at every call site: `stateAt` refuses a
   * non-finite t, and a negative one would read as "before the story", which is
   * not an instant this player has.
   */
  seek(milliseconds) {
    const t = Number.isFinite(milliseconds) ? Math.max(0, Math.round(milliseconds)) : 0;
    this.#held = t;
    if (this.#running) this.#origin = this.#now() - t;
  }
}

function defaultNow() {
  return performance.now();
}
