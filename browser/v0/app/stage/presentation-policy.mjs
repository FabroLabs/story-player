import { zoneScale } from '../../core/geometry.mjs';

// Two straight lines joined at a knee. Below the knee this is the original
// linear rule, untouched. Above it the line flattens, because a plain
// 10 px/cm put a 110 cm bear at 1100 px on a 1080 px stage — taller than the
// frame, rendered off the top, and the scene looked empty.
export const SPRITE_PX_PER_CM = 10;
export const SPRITE_KNEE_CM = 40;
export const SPRITE_PX_PER_CM_ABOVE_KNEE = 100 / 70; // the world's tallest, 110 cm, lands at 500 px
export const MINIMUM_SPRITE_HEIGHT_PX = 72;

const KNEE_PX = SPRITE_KNEE_CM * SPRITE_PX_PER_CM;

export function spriteHeightForCm(heightCm) {
  if (!Number.isFinite(heightCm) || heightCm <= 0) return MINIMUM_SPRITE_HEIGHT_PX;

  const measuredHeight = heightCm <= SPRITE_KNEE_CM
    ? heightCm * SPRITE_PX_PER_CM
    : KNEE_PX + ((heightCm - SPRITE_KNEE_CM) * SPRITE_PX_PER_CM_ABOVE_KNEE);

  return Math.max(MINIMUM_SPRITE_HEIGHT_PX, measuredHeight);
}

/**
 * What a character is really drawn at: their centimetres, shrunk by their band.
 *
 * Two callers need this and they must never disagree — the renderer, which sizes
 * the element, and the director, which has to know how far a close-up must
 * magnify to fill the frame with them.
 */
export function drawnSpriteHeightPx(heightCm, zone) {
  return spriteHeightForCm(heightCm) * zoneScale(zone);
}

// The art's native cell: every sprite sheet in the forest world is 512x512 per
// frame, measured off the PNG headers. A 15 cm hedgehog is drawn 150 px tall, so
// two thirds of the art it already has are being thrown away at 1x — which is
// why a close-up does not need new assets, only permission to use the pixels.
// The day the art changes cell size, this number moves with it.
export const SPRITE_SOURCE_PX = 512;

// How far framing a subject may magnify the plate. `close` wants the subject
// drawn at its own resolution, which is 3.41x for a hedgehog — but the same rule
// aimed at somebody small on a far band asks for 11x, and the plate is 1080p. So
// the subject gets as close as it can and the plate's tolerance is what stops it.
// Above this the background stops being a picture.
export const CLOSE_SCALE_CEILING = 3.5;

// How tall each named size wants its subject drawn, in stage pixels. `close` is
// the art's own cell; `medium` is half of it. Both are frames the SUBJECT owns
// rather than magnifications the camera owns, and that is what keeps the two
// words in order: 512/h is never smaller than 256/h, so a `close` can never come
// out wider than a `medium` and no clamp is needed to promise it.
//
// `medium` was a flat 1.25 of the plate, which had the same fault `close` had —
// one number meant a different frame for every character — and fixing only
// `close` is what made it show up as an inversion (bear: medium 1.25, close
// 1.024, the close-up pulling BACK).
export const SHOT_SUBJECT_PX = Object.freeze({ medium: SPRITE_SOURCE_PX / 2, close: SPRITE_SOURCE_PX });

/**
 * The camera scale that draws a subject of `drawnHeightPx` at the size `size` wants.
 *
 * A camera that can only magnify cannot make a big character look closer than it
 * already is: a 110 cm bear is drawn 500 px tall, which is 46% of a 1080 stage —
 * already a close-up — so both sizes come back at or near 1x for the tallest
 * cast. That is the honest answer, not a bug, and it is published.
 */
export function subjectFramedScale(drawnHeightPx, size) {
  const wanted = SHOT_SUBJECT_PX[size];
  if (!Number.isFinite(wanted)) return 1; // `wide` frames nobody
  if (!Number.isFinite(drawnHeightPx) || drawnHeightPx <= 0) return 1;
  return Math.min(CLOSE_SCALE_CEILING, Math.max(1, wanted / drawnHeightPx));
}
