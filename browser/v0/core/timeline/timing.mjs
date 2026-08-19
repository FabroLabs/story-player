/**
 * Time for a story nobody is watching.
 *
 * A performance is concurrent — narration plays while somebody walks under it,
 * a scene refuses to close until a walk-off lands — and a timeline is one
 * ordered list. What turns the first into the second is a discrete-event clock:
 * time is a number that moves only when something waits on it, and it moves to
 * the next deadline rather than by a tick. Three minutes of story compile in
 * microseconds, and the answer is a function of the bundle and nothing else.
 *
 * The walk itself is a generator: it yields a gate and stops there. The loop
 * below fires deadlines until that gate opens and then resumes it. That is
 * exactly what the promise machinery this replaces did — fire one timer, let
 * every consequence run to quiescence, fire the next — with the event loop's
 * scheduling made explicit instead of borrowed.
 */

/** Seconds as whole milliseconds — the unit every time in the timeline uses. */
export function toMs(seconds) {
  return Math.round(Math.max(0, Number(seconds) || 0) * 1000);
}

export class Schedule {
  #now = 0;
  #timers = [];
  #sequence = 0;

  now() {
    return this.#now;
  }

  /**
   * Parks `run` at `delayMs` from now and hands back the handle `cancel` takes.
   *
   * Every duration is rounded to whole milliseconds ON ARRIVAL, so a float like
   * `4.365 * 1000` can never leak a `.0000000001` into a published artifact.
   */
  at(delayMs, run) {
    const timer = {
      at: this.#now + Math.round(Math.max(0, Number(delayMs) || 0)),
      sequence: this.#sequence += 1,
      run,
    };
    this.#timers.push(timer);
    return timer;
  }

  cancel(timer) {
    const index = this.#timers.indexOf(timer);
    if (index >= 0) this.#timers.splice(index, 1);
  }

  /**
   * Jumps to the earliest deadline and fires exactly one timer.
   *
   * One, not all of that millisecond's: firing a deadline can start or cancel
   * others at the same instant, and a batch would decide their fate before they
   * were made. Ties break on insertion order, never on scan order, because two
   * timers landing on the same millisecond is the normal case — a `together`
   * whose children all move — and the timeline has to be byte-identical anyway.
   */
  fireNext() {
    if (this.#timers.length === 0) return false;
    const next = this.#timers.reduce((earliest, timer) => (
      timer.at < earliest.at || (timer.at === earliest.at && timer.sequence < earliest.sequence)
        ? timer
        : earliest
    ));
    this.cancel(next);
    this.#now = next.at;
    next.run();
    return true;
  }
}

/** What a blocked walk is waiting for. Opens once and never closes. */
export function createGate() {
  let open = false;
  return {
    passed: () => open,
    pass() { open = true; },
  };
}

/**
 * Drives `walk` to its end, advancing the clock only when it has to.
 *
 * A walk that is neither finished nor waiting on anything is a bug in this
 * compiler, not a slow story — so it raises instead of spinning.
 */
export function runToEnd(schedule, walk) {
  let blocked = walk.next();
  while (!blocked.done) {
    const gate = blocked.value;
    while (!gate.passed()) {
      if (!schedule.fireNext()) {
        throw new Error(
          `the story stalled at ${schedule.now()} ms with nothing left to wait for — every `
          + 'blocking step parks a timer, so this is a bug in the compiler, not a defect '
          + 'in the story',
        );
      }
    }
    blocked = walk.next();
  }
}
