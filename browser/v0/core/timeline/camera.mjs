import { isSide, resolvePoint, zoneNamed } from '../geometry.mjs';
import { drawnSpriteHeightPx, subjectFramedScale } from '../../app/stage/presentation-policy.mjs';
import { CAMERA_DURATIONS_MS, SHOT_SIZES } from '../../policy.mjs';

/**
 * Where the camera is looking, and how close — resolved once, for everyone.
 *
 * Nothing here decides WHEN; these are the numbers a camera op carries, and
 * they are computed here rather than in each client because a `close` is a
 * different magnification for every character. Ask a phone to look the size up
 * in a table and the two disagree about the shot.
 *
 * Each function reports through `onWarning` and answers with the fallback the
 * language promises, or with null where there is no honest fallback.
 */

/**
 * An absent speed means slow — the language's own default, resolved here so the
 * implementations of it cannot drift. A word neither the language nor the
 * player has is a malformed bundle: the point is that it is SAID rather than
 * absorbed. The move still happens, at the default — only its pacing was
 * unreadable.
 */
export function cameraSpeed(step, onWarning) {
  const speed = step.speed ?? 'slow';
  if (Object.hasOwn(CAMERA_DURATIONS_MS, speed)) return speed;
  onWarning({ type: 'policy', policy: 'camera-speed-unknown', cmd: step.cmd, speed });
  return 'slow';
}

/**
 * `target_pct` is a portal the story compiler already resolved. A side word is
 * measured across the plate's default band — that is what `left_edge` means to
 * a camera, whoever else is standing elsewhere — while a character is read on
 * the band they are actually on, which is the only way the height comes out
 * right for anyone off the near floor.
 *
 * The finiteness check guards BOTH ways in, portal included: `target_pct` is
 * copied out of the catalog unchecked, and one non-number in it costs the whole
 * framing, which then latches into every later pan.
 */
export function cameraPoint(step, reference, plate, onWarning) {
  const point = Array.isArray(step.target_pct)
    ? { x: step.target_pct[0], y: step.target_pct[1] }
    : pointOnBand(step, reference, plate);
  if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
  onWarning({
    type: 'policy', policy: 'camera-target-unresolved', cmd: step.cmd, target: step.target,
  });
  return null;
}

/**
 * A wide frames nobody, so it is the one camera command with nothing to aim at.
 * An unknown SIZE is refused rather than defaulted, unlike an unknown speed:
 * the size is what the command means, and defaulting it answers a close-up with
 * an unchanged wide and no warning at all.
 *
 * A shot reads the LIVE board rather than a `together` snapshot, because inside
 * a block the children are ordered `move` before `shot` and the subject is
 * already standing on the band it has just arrived on. Measured against the
 * snapshot, a deer walking to the front row frames at the height of the band it
 * was leaving — head and feet cut off. Outside a block the two are the same.
 */
export function resolveShot(step, board, plate, cast, onWarning) {
  if (!Object.hasOwn(SHOT_SIZES, step.size)) {
    onWarning({
      type: 'policy', policy: 'camera-shot-size-unknown', cmd: step.cmd, size: step.size,
    });
    return null;
  }
  if (step.size === 'wide') return { size: 'wide', point: null, scale: SHOT_SIZES.wide };

  // the aim first, so a target that is nobody is answered by the name every
  // other camera command answers it with, not by a question about its height
  const point = cameraPoint(step, board, plate, onWarning);
  if (!point) return null;
  const scale = shotScale(step, board, plate, cast, onWarning);
  if (scale === null) return null;
  return { size: step.size, point, scale };
}

/**
 * `medium` and `close` are framed by their subject, so neither scale is a
 * constant anybody can look up — each is how far this character, on this band,
 * has to be magnified to be drawn at the height that size asks for.
 */
function shotScale(step, board, plate, cast, onWarning) {
  const heightCm = cast?.[step.target]?.height_cm;
  // A subject nobody measured is refused rather than framed at a guess: without
  // a height, the sprite falls to its legibility floor and the frame that comes
  // back is the CEILING — maximum magnification on a character whose size is
  // simply unknown.
  if (!Number.isFinite(heightCm) || heightCm <= 0) {
    onWarning({
      type: 'policy', policy: 'camera-subject-unmeasured', cmd: step.cmd, target: step.target,
    });
    return null;
  }
  const band = board.positionOf?.(step.target)?.zone ?? null;
  return subjectFramedScale(drawnSpriteHeightPx(heightCm, zoneNamed(plate, band)), step.size);
}

function pointOnBand(step, reference, plate) {
  const floor = zoneNamed(plate, null)?.polygon;
  const band = isSide(step.target) ? null : reference.positionOf?.(step.target)?.zone ?? null;
  return resolvePoint(step.target, reference, floor, zoneNamed(plate, band)?.polygon ?? floor);
}
