/**
 * One instant of the picture, as an ordered list of things to draw.
 *
 * `stateAt` answers who is where; this answers what a renderer does about it —
 * and it answers in PLATE space (the 1920x1080 the story was written against),
 * carrying no canvas, no device pixel ratio and no letterbox. That separation is
 * what makes the list a fixture: the same instant of the same story produces the
 * same JSON on a phone and on a laptop, so a golden can pin placement without
 * pinning the machine it was drawn on. The viewport enters exactly once, at
 * paint time, as a single multiplier.
 *
 * It is also the seam the plan's WebGL renderer would plug into: a command list
 * that names no 2D context can be executed by anything. Nothing here draws.
 *
 * The four commands, in the order they are emitted per actor:
 *
 *   shadow      the soft ellipse that replaces the DOM stage's drop-shadow
 *   sprite      one cell of a sheet, feet-anchored in a square box
 *   prop        a whole SVG, fitted inside that same box
 *   missing     the placeholder, for a clip the bundle lacks or a sheet that
 *               has not decoded yet
 *
 * The sheet comes from the caller, not from the bundle, and that is deliberate:
 * which sheet a clip draws from is the rendition picker's answer (a tier chosen
 * for this viewport), and its grid is NOT the bundle's grid — a one-row strip is
 * re-gridded near-square by the encode. Reading a rendition with the bundle's
 * grid animates the wrong cells and errors nowhere.
 */

import { frameCell } from '../../core/clips.mjs';
import { DEFAULT_STAGE_RESOLUTION } from '../../policy.mjs';

// The shadow, as fractions of the sprite's drawn height. The DOM stage traced
// the artwork's own silhouette with `filter: drop-shadow`, which costs a
// full-size blur per sprite per frame; this is one ellipse under the feet at
// roughly the footprint that shadow had. Wide and shallow, because it is a
// shape on the ground rather than a copy of the character.
export const SHADOW_RADIUS_X = 0.3;
export const SHADOW_RADIUS_Y = 0.06;
export const SHADOW_OPACITY = 0.34;

export const WIDE_CAMERA = Object.freeze({ scale: 1, x: 0, y: 0 });

const NO_SHEETS = Object.freeze({ sheet: () => null, prop: () => null });

/**
 * `state` is `stateAt`'s answer; `sheets` answers two questions about assets:
 *
 *   sheet(slug, clip) -> { url, grid } | null
 *   prop(slug)        -> { url } | null
 *
 * Both may answer `null` at any time — a scene whose sheets are still being
 * planned, a clip the bundle never carried — and the answer is a placeholder,
 * never a gap.
 */
export function buildDrawList(state, sheets = NO_SHEETS) {
  const [width, height] = plateSize(state?.plate);
  const commands = [];

  // `state.actors` arrives in paint order — farthest band first — and stays in
  // it. Depth is the compiler's and the state core's answer; re-sorting here
  // would be a second opinion about who covers whom.
  for (const actor of state?.actors ?? []) {
    const opacity = clamped(actor?.opacity);
    const size = positive(actor?.heightPx);
    if (opacity <= 0 || size === 0) continue;

    const centreX = (Number(actor.x) / 100) * width;
    const feetY = (Number(actor.feetY) / 100) * height;
    // Unreachable by construction — the state core refuses an unusable x at the
    // op that carried it and says so in its warnings, and every height and
    // stand line it hands out is finite. Guarded anyway because the cost of
    // being wrong is `drawImage(NaN, …)`, which throws and takes the whole
    // frame with it rather than losing one sprite.
    if (!Number.isFinite(centreX) || !Number.isFinite(feetY)) continue;

    const box = {
      dx: round(centreX - (size / 2)),
      dy: round(feetY - size),
      dw: round(size),
      dh: round(size),
      opacity: round(opacity, 4),
    };
    commands.push({
      op: 'shadow',
      slug: actor.slug,
      cx: round(centreX),
      cy: round(feetY),
      rx: round(size * SHADOW_RADIUS_X),
      ry: round(size * SHADOW_RADIUS_Y),
      opacity: round(opacity * SHADOW_OPACITY, 4),
    });
    commands.push(figure(actor, box, sheets));
  }

  return { width, height, camera: framing(state?.camera), commands };
}

function figure(actor, box, sheets) {
  const slug = actor.slug;
  if (actor.kind === 'object') {
    const prop = sheets.prop(slug) ?? null;
    return prop?.url ? { op: 'prop', slug, url: prop.url, ...box } : { op: 'missing', slug, ...box };
  }

  // `clipMissing` is the state core's word for "the story asked for a clip this
  // bundle does not carry, and this is the pose left showing". The pose is
  // still drawn; only a clip with nothing behind it falls through to the
  // placeholder.
  const sheet = actor.clip && !actor.clipMissing ? sheets.sheet(slug, actor.clip) : null;
  const cells = gridOf(sheet?.grid);
  if (!sheet?.url || !cells) return { op: 'missing', slug, ...box };

  const frame = Number.isInteger(actor.frame) && actor.frame >= 0 ? actor.frame : 0;
  return { op: 'sprite', slug, url: sheet.url, cell: frameCell(frame, cells), cells, ...box };
}

/**
 * The camera as the plate reads it: a scale and an offset in percent, the same
 * pair the video plate writes into a CSS transform. Rounded exactly as the DOM
 * stage rounded it — a scale finer than an offset, because a scale multiplies
 * every coordinate under it.
 */
function framing(camera) {
  const { scale, x, y } = camera ?? WIDE_CAMERA;
  if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y)) return WIDE_CAMERA;
  return { scale: round(scale, 6), x: round(x, 4), y: round(y, 4) };
}

function plateSize(plate) {
  const [width, height] = plate?.resolution ?? [];
  return [
    positive(width) || DEFAULT_STAGE_RESOLUTION[0],
    positive(height) || DEFAULT_STAGE_RESOLUTION[1],
  ];
}

// A grid of zero columns divides by zero and lands every frame on cell NaN, so
// a grid that is not two positive whole numbers is no grid at all.
function gridOf(grid) {
  const [columns, rows] = grid ?? [];
  if (!Number.isInteger(columns) || !Number.isInteger(rows)) return null;
  return columns > 0 && rows > 0 ? [columns, rows] : null;
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function clamped(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

// Two decimals of a plate pixel is a hundredth of a pixel on a 1:1 stage and
// far less than that once the letterbox shrinks it. It exists so a golden
// carries `640.5` rather than `640.4999999999999`.
function round(value, places = 2) {
  const step = 10 ** places;
  return Math.round(value * step) / step;
}
