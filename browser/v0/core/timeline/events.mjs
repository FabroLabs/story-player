/**
 * The one ordered stream a timeline is, and the shapes that go in it.
 *
 * Two sources share the array, in the order a player lives through them:
 *
 *   source: "step"    the authored step as the walk reached it — scene, line,
 *                     kind, its detail. Traceability back to the .story file.
 *                     Warnings arrive here too.
 *   source: "stage"   the resolved render call — which x, which clip key, how
 *                     many milliseconds. What a renderer needs and cannot
 *                     derive without reimplementing this player.
 *
 * `TIMELINE_OPS` is the contract between this compiler and every interpreter of
 * its output — the browser's own `stateAt` and the phone alike. It replaced a
 * list of stage METHOD names, which only ever described how one renderer was
 * written; these are the events themselves, and the engine repository's
 * `wiki/clients/mobile.md` documents each payload.
 */

export const TIMELINE_OPS = Object.freeze([
  'scene',
  'place',
  'place_object',
  'clip',
  'move',
  'settle',
  'depart',
  'exit',
  'push_in',
  'pull_out',
  'shot',
  'pan',
  'camera_reset',
  'subtitle',
  'end',
]);

export class Recorder {
  #events = [];
  #now;

  constructor(now) {
    this.#now = now;
  }

  /** A resolved render call. The payload is flat — see the op table. */
  stage(op, origin, payload) {
    this.#events.push({
      t_ms: this.#now(),
      source: 'stage',
      op,
      scene_index: origin.scene_index ?? null,
      line: origin.line ?? null,
      ...payload,
    });
  }

  /** An authored step, or a warning about one. */
  step(entry) {
    this.#events.push({ t_ms: this.#now(), ...entry, source: 'step' });
  }

  events() {
    return this.#events;
  }
}

/**
 * A step's own fields, minus the three the event carries in its own right.
 *
 * Copied rather than referenced so a caller holding the timeline cannot reach
 * back into the bundle, and key-sorted at every depth because a timeline is a
 * published artifact and the determinism law does not care which order the
 * story language happened to emit a step's fields in.
 */
export function stepDetail(step, together = null) {
  const { kind, line, cmd, ...detail } = step;
  if (together) detail.together_line = together.line;
  return sorted(detail);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}
