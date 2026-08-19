import { easeIn } from './bezier.mjs';

/**
 * A walk, as a function of t.
 *
 * The DOM stage transitioned four properties at once — `left`, `top`, `width`
 * and `height`, all linear — and the feet stayed on a straight line between the
 * two stand lines because `top` is `y − height` and two linear ramps summed are
 * still one. Interpolating the same four here keeps that true, and keeps a walk
 * between bands shrinking over its whole length instead of popping on arrival.
 *
 * A departure adds the fade, which is the one component that is neither linear
 * nor on the same clock: CSS `ease-in`, evaluated rather than animated, and
 * carried on its own schedule so that shoving somebody who is walking off does
 * not make them solid again.
 */

export function beginMotion(startMs, durationMs, from, to, { fade = null } = {}) {
  const span = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
  return {
    startMs,
    durationMs: span,
    from: { x: from.x, feetY: from.feetY, heightPx: from.heightPx },
    to: { x: to.x, feetY: to.feetY, heightPx: to.heightPx },
    fade: fade === true ? { startMs, durationMs: span } : fade,
  };
}

export function motionAt(motion, tMs) {
  const opacity = motion.fade ? 1 - easeIn(progressOf(motion.fade, tMs)) : 1;
  const elapsed = tMs - motion.startMs;
  // The ends are returned rather than interpolated to: a walk has to ARRIVE on
  // the x the timeline published, and `from + (to - from) * 1` is not always
  // `to` in binary floating point.
  if (motion.durationMs <= 0 || elapsed >= motion.durationMs) return { ...motion.to, opacity };
  if (elapsed <= 0) return { ...motion.from, opacity };

  const progress = elapsed / motion.durationMs;
  const { from, to } = motion;
  return {
    x: lerp(from.x, to.x, progress),
    feetY: lerp(from.feetY, to.feetY, progress),
    heightPx: lerp(from.heightPx, to.heightPx, progress),
    opacity,
  };
}

/**
 * Re-aim a motion that is already running, from wherever it has got to.
 *
 * Crowding can shove a character who is mid-walk. The browser answered that by
 * restarting the transition — a new target, the full duration again, starting
 * from the picture and not from where the walk began — and so does this. What
 * it does NOT restart is the walk's own settle, which is a separate event at
 * its own instant, nor a departure's fade, which the browser left running on
 * the clock it was given.
 *
 * One DELIBERATE difference from the DOM stage, for a walk that also changes
 * band. There, crowding wrote `left` and `top` and nothing else, so position
 * restarted while `width`/`height` kept running on the original clock — two
 * clocks, and `top` computed against the FINAL height, which takes the feet off
 * the straight line between the two stand lines that the size ramp is there to
 * keep them on. All four restart together here. The stage that behaved the
 * other way is deleted in the next phase; the law about the feet is published.
 */
export function redirectMotion(motion, tMs, to) {
  return beginMotion(tMs, motion.durationMs, motionAt(motion, tMs), to, { fade: motion.fade });
}

function progressOf({ startMs, durationMs }, tMs) {
  if (durationMs <= 0) return 1;
  return Math.min(1, Math.max(0, (tMs - startMs) / durationMs));
}

function lerp(from, to, progress) {
  return from + ((to - from) * progress);
}
