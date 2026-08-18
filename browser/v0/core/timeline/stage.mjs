import { NO_FLOOR_STAND_Y, floorYAtX, zoneNamed } from '../geometry.mjs';
import { toMs } from './timing.mjs';

/**
 * The stage as a notebook: every call the walk makes, written down at the
 * millisecond it was made.
 *
 * It carries no pixels, but it is not a stub — the two things it really owns
 * decide the schedule. One motion per character: starting a new one cancels
 * whatever that character was doing, and a cancelled walk records no settle,
 * which is how an emote during a walk keeps its emotion. And a departure is
 * tracked until it lands, because a scene cannot close while somebody is still
 * walking off it.
 *
 * Every surface here is one the DOM renderer also implements. Where the two
 * could drift, this is the one a published timeline was measured from.
 */
export class TimelineStage {
  #schedule;
  #recorder;
  #scene = null;
  #sceneIndex = null;
  #motions = new Map();
  #departures = new Set();
  #whenDrained = null;
  #followSlug = null;

  constructor(schedule, recorder) {
    this.#schedule = schedule;
    this.#recorder = recorder;
  }

  showScene(scene, origin = {}) {
    // A scene change cuts every actor, which resolves any motion still in
    // flight. Without that, a walk-off abandoned at the cut would keep burning
    // time AND stay pending, so the NEXT scene's end would wait on somebody who
    // is already gone — minutes of a story, held on nothing.
    this.#cancelAll();
    this.#scene = scene;
    this.#sceneIndex = origin.scene_index ?? null;
    this.#record('scene', origin, { place: scene?.place ?? null });
  }

  placeCharacter(slug, x, clipKey, origin = {}) {
    // attach/supersede both invalidate the actor's action: putting or
    // re-clipping a character cancels the motion it was in.
    this.#cancel(slug);
    this.#record('place', origin, { slug, x, clip: clipKey ?? null });
  }

  // A prop is placed once and never animated, so it cancels nothing and starts
  // nothing — but a client still has to draw it, so it is recorded.
  placeObject(slug, x, zone = null, origin = {}) {
    this.#record('place_object', origin, { slug, x, zone });
  }

  setCharacterClip(slug, clipKey, origin = {}) {
    this.#cancel(slug);
    this.#record('clip', origin, { slug, clip: clipKey ?? null });
  }

  moveCharacter(slug, { x, clipKey, settleClipKey, durationSeconds, ...origin }) {
    const duration = toMs(durationSeconds);
    this.#record('move', origin, { slug, x, clip: clipKey ?? null, duration_ms: duration });
    this.#ride(slug, x, duration);
    // The settle is recorded WHEN IT HAPPENS, not promised on the move: a
    // client replaying a promised settle would wipe an emotion the story asked
    // for mid-walk, 1.8 s later, on that client only.
    this.#startMotion(slug, duration, (completed) => {
      if (completed) this.#record('settle', origin, { slug, clip: settleClipKey ?? null });
    });
  }

  departCharacter(slug, { x, y, clipKey, durationSeconds, ...origin }) {
    const duration = toMs(durationSeconds);
    const exitY = y ?? this.floorY(x);
    this.#record('depart', origin, {
      slug, x, y: exitY, clip: clipKey ?? null, duration_ms: duration,
    });
    this.#ride(slug, x, duration);
    // The camera sees them out and then has nobody to follow.
    if (this.#followSlug === slug) this.#followSlug = null;

    const departure = { slug };
    this.#departures.add(departure);
    this.#startMotion(slug, duration, (completed) => {
      // Same rule as the settle, other end: a character put back on stage
      // mid-exit is still there, so only a walk that ran out removes anybody.
      if (completed) this.#record('exit', origin, { slug });
      this.#departures.delete(departure);
      if (this.#departures.size === 0) {
        const drained = this.#whenDrained;
        this.#whenDrained = null;
        drained?.();
      }
    });
  }

  /** How many are still walking off — what a scene's end has to wait for. */
  pendingDepartures() {
    return this.#departures.size;
  }

  /**
   * Called once, when the last walk-off lands. `null` withdraws the interest:
   * a scene that gave up waiting must not be told later that they arrived.
   */
  whenDeparturesDrain(run) {
    this.#whenDrained = run;
  }

  floorY(x, zoneName = null) {
    const polygon = zoneNamed(this.#scene?.plate, zoneName)?.polygon;
    return floorYAtX(polygon, x) ?? NO_FLOOR_STAND_Y;
  }

  pushIn(point, speed = 'slow') {
    this.#record('push_in', {}, { x: point.x, y: point.y, speed });
  }

  pullOut(speed = 'slow') {
    this.#record('pull_out', {}, { speed });
  }

  // `scale` is on the wire because a `close` is framed by its SUBJECT: it is
  // 3.41x for a 15 cm hedgehog and 1.46x for a 35 cm owl, so no client can look
  // the size up in a table any more. `wide` and `medium` still carry the number
  // the table would have given, so a reader never has two ways to find it.
  setShot(size, point = null, scale = null) {
    this.#record('shot', {}, { size, x: point?.x ?? null, y: point?.y ?? null, scale });
  }

  // One op for both ways the camera slides: a `pan_to` names a speed word, a
  // follow ride names the milliseconds of the walk it is riding. Recording them
  // apart would publish two shapes for one movement. There is no `y`, because a
  // pan is horizontal.
  panTo(x, speed = 'slow') {
    this.#record('pan', {}, { x, speed, duration_ms: null });
  }

  // `follow` and `followOff` record nothing on their own: a ride that never
  // rides is not something anyone sees, and the command itself is already in
  // the step stream. What the camera actually does arrives as `pan`.
  follow(slug) {
    this.#followSlug = slug;
  }

  followOff() {
    this.#followSlug = null;
  }

  resetCamera() {
    this.#followSlug = null;
    this.#record('camera_reset', {}, {});
  }

  setSubtitle(text) {
    this.#record('subtitle', {}, { text: text ?? '' });
  }

  showEnd() {
    this.#record('end', {}, {});
  }

  #ride(slug, x, durationMs) {
    if (this.#followSlug !== slug) return;
    this.#record('pan', {}, { x, speed: null, duration_ms: durationMs });
  }

  #startMotion(slug, durationMs, settled) {
    this.#cancel(slug);
    const timer = this.#schedule.at(durationMs, () => {
      this.#motions.delete(slug);
      settled(true);
    });
    this.#motions.set(slug, { timer, settled });
  }

  #cancel(slug) {
    const motion = this.#motions.get(slug);
    if (!motion) return;
    // Dropped from the map before the timer is cleared, so a cancelled motion's
    // own bookkeeping can never delete a successor's entry.
    this.#motions.delete(slug);
    this.#schedule.cancel(motion.timer);
    motion.settled(false);
  }

  #cancelAll() {
    for (const slug of [...this.#motions.keys()]) this.#cancel(slug);
  }

  #record(op, origin, payload) {
    this.#recorder.stage(op, {
      scene_index: origin.scene_index ?? this.#sceneIndex,
      line: origin.line ?? null,
    }, payload);
  }
}
