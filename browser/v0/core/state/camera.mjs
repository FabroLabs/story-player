import { easeCamera } from './bezier.mjs';
import {
  CAMERA_DURATIONS_MS,
  PAN_SCALE_FLOOR,
  PUSH_SCALE,
  SHOT_SIZES,
} from '../../policy.mjs';

/**
 * Where the camera is pointing at t.
 *
 * The arithmetic below moved here verbatim from the DOM stage renderer, whose
 * suite proved at the time that the move changed nothing. That renderer and its
 * suite are both gone now — the canvas stage reads a framing out of `stateAt`
 * rather than owning one — so what holds this file today is `state-motion`'s
 * camera tests, `state-refusals`' two camera refusals, and the drawlist goldens,
 * which carry a real push, a real pan and a subject-framed shot out of the
 * parity corpus.
 *
 * What is new is the last two functions: a transition the browser used to run
 * is now a number this file computes, so a seek to the middle of a push lands
 * where the push had got to.
 */

export const PLATE_CENTRE = Object.freeze({ x: 50, y: 50 });
export const WIDE_FRAMING = Object.freeze({ scale: 1, x: 0, y: 0 });

// The camera is a scale and an offset, both written into one `transform`: a
// plate point `p` lands at `scale * p + offset`, in percent of the layer. That
// is the whole model — a push, a shot, a pan and a ride differ only in which
// offset they ask for.
//
// A magnified layer keeps covering the frame only while its offset stays
// between `100 * (1 - scale)` and 0: past the top end the near edge pulls in,
// past the bottom end the far one does, and either way the stage background
// shows through. The interval is exactly zero wide at 1x, which is the reason a
// pan has to magnify before it can move at all rather than a rule anyone chose.
export function clampOffset(offset, scale) {
  return Math.min(0, Math.max(100 * (1 - scale), offset));
}

// Hold `point` exactly where it already is and grow the world around it.
export function framingHolding(point, scale) {
  return { scale, x: clampOffset(point.x * (1 - scale), scale), y: clampOffset(point.y * (1 - scale), scale) };
}

// Bring plate x to the middle of the frame, as far as the clamp allows, and
// leave the height alone — a pan is a horizontal move, and the vertical one is
// a different word. Aiming both axes at a character would point the camera at
// their FEET, which is what a stand line is: on a wide open that drove the frame
// straight down into the floor and pinned it there against the clamp.
//
// "Leave it alone" is not "keep the number": lifting the scale re-scales the
// axis under it, so what is preserved is the plate point already in the middle.
export function framingPanned(x, scale, held) {
  const middleY = (50 - held.y) / held.scale;
  return { scale, x: clampOffset(50 - (scale * x), scale), y: clampOffset(50 - (scale * middleY), scale) };
}

// An omitted speed is a slow move — the language's own default. An unknown word
// is the director's to refuse; if one reaches here anyway it is still slow, never
// a duration of `undefined`.
export function cameraDuration(speed) {
  return Object.hasOwn(CAMERA_DURATIONS_MS, speed ?? 'slow') ? CAMERA_DURATIONS_MS[speed ?? 'slow'] : CAMERA_DURATIONS_MS.slow;
}

export function isFramingFinite({ scale, x, y }) {
  return Number.isFinite(scale) && Number.isFinite(x) && Number.isFinite(y);
}

/**
 * What one camera op asks for: a new framing, and how long to take over it.
 *
 * `held` is the framing the last op ASKED for, not the one on screen — the
 * renderer kept `#framing` as the target and every op composed off it, so a
 * push that interrupts a pull-out magnifies from where the pull-out was headed.
 *
 * A `refusal` back means the op changes nothing, and says which of the two
 * refusals the renderer also had: a size the vocabulary does not carry, or a
 * framing that is not three finite numbers. The second is not hypothetical — a
 * ride is aimed by the WALK, and a walk to a target the board could not place
 * carries no x at all, which used to write `translate(NaN%, …)` and hard-cut
 * the camera out of a move.
 */
export function framingForOp(event, held) {
  if (event.op === 'shot' && !Object.hasOwn(SHOT_SIZES, event.size)) {
    return { refusal: { type: 'policy', policy: 'camera-shot-size-unknown', size: event.size ?? null } };
  }
  const framing = requested(event, held);
  if (!framing) return { refusal: { type: 'policy', policy: 'camera-op-unknown', op: event.op } };
  if (!isFramingFinite(framing)) {
    return { refusal: { type: 'policy', policy: 'camera-framing-unusable', framing: { ...framing } } };
  }
  return { framing, durationMs: durationForOp(event) };
}

function requested(event, held) {
  switch (event.op) {
    // A push holds the point it names still and never shrinks: already closer
    // than the push scale means it re-aims at the closeness it is in.
    case 'push_in':
      return framingHolding({ x: event.x, y: event.y }, Math.max(held.scale, PUSH_SCALE));
    case 'pull_out':
      return { ...WIDE_FRAMING };
    // A shot is a cut, and its `scale` is on the wire because a `close` is
    // framed by its subject — never look the size up in a table. A `wide`
    // frames nobody and so carries no point: it opens on the plate centre.
    case 'shot': {
      const point = Number.isFinite(event.x) && Number.isFinite(event.y) ? { x: event.x, y: event.y } : PLATE_CENTRE;
      return framingHolding(point, event.scale);
    }
    // A pan lifts the scale to the pan floor first, because at 1x there is
    // nowhere to move to.
    case 'pan':
      return framingPanned(event.x, Math.max(held.scale, PAN_SCALE_FLOOR), held);
    case 'camera_reset':
      return { ...WIDE_FRAMING };
    default:
      return null;
  }
}

function durationForOp(event) {
  // A cut and a scene reset are instant; a ride carries the walk's own
  // milliseconds; everything else is its speed word.
  if (event.op === 'shot' || event.op === 'camera_reset') return 0;
  if (event.op === 'pan' && Number.isFinite(event.duration_ms)) return event.duration_ms;
  return cameraDuration(event.speed);
}

/**
 * The framing on screen partway through a move.
 *
 * Each component eases separately, which is what the browser did with a
 * `transform` transition — and `from` is the framing that was VISIBLE when the
 * move started, not the one it was aiming at, because a transition interrupted
 * mid-flight restarts from the picture rather than from the target.
 */
export function framingBetween(from, to, progress) {
  if (progress >= 1) return to;
  const eased = easeCamera(progress);
  return {
    scale: from.scale + ((to.scale - from.scale) * eased),
    x: from.x + ((to.x - from.x) * eased),
    y: from.y + ((to.y - from.y) * eased),
  };
}
