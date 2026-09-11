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
 * The commands, in the order they are emitted:
 *
 *   shadow      the soft ellipse that replaces the DOM stage's drop-shadow
 *   sprite      one cell of a sheet, feet-anchored in a square box
 *   prop        a whole SVG, fitted inside that same box
 *   missing     the placeholder, for a clip the bundle lacks or a sheet that
 *               has not decoded yet
 *   ring        the lesson's glow around the thing being named, right after the
 *               actor it belongs to, so it lies over them and under whoever
 *               stands in front
 *   slate       the counting board, last of all and marked `hud`, because it
 *               sits over the whole picture and is NOT under the camera — see
 *               the note on it below
 *
 * The sheet comes from the caller, not from the bundle, and that is deliberate:
 * which sheet a clip draws from is the rendition picker's answer (a tier chosen
 * for this viewport, and — where the bundle carries chunks — which chunk of it
 * holds this frame), and its grid is NOT the bundle's grid: a one-row strip is
 * re-gridded near-square by the encode. Reading a rendition with the bundle's
 * grid animates the wrong cells and errors nowhere.
 */

import { frameCell } from '../../core/clips.mjs';
import { DEFAULT_STAGE_RESOLUTION, HIGHLIGHT, SLATE } from '../../policy.mjs';

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
 *   sheet(slug, clip, frame) -> { url, grid, chunkStart? } | null
 *   prop(slug)               -> { url } | null
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
    const ring = ringFor(actor, box, state?.tMs);
    if (ring) commands.push(ring);
  }

  const slate = slateFor(state?.slate, state?.tMs, width, height);
  if (slate) commands.push(slate);

  return { width, height, camera: framing(state?.camera), commands };
}

/**
 * The ring a `highlight` leaves on its subject, while it is still ringing.
 *
 * Its own progress travels with it rather than the instant it started, so the
 * renderer needs no clock and no policy of its own to know how far through the
 * pulse it is — and a golden reads as a fraction rather than as a timestamp
 * that moves whenever the story ahead of it does.
 *
 * It also carries its subject's opacity, like the shadow under the same figure:
 * a ring is a mark ON somebody, and one drawn at full strength around a
 * character still fading in — which is every naming scene, where the thing is
 * put down and ringed in the same instant — is a gold ellipse floating over an
 * arrival rather than a pointer at it.
 */
function ringFor(actor, box, tMs) {
  const since = actor?.highlightMs;
  if (!Number.isFinite(since) || !Number.isFinite(tMs)) return null;
  const progress = (tMs - since) / HIGHLIGHT.durationMs;
  if (progress < 0 || progress >= 1) return null;
  const radius = (box.dw / 2) * (1 + (HIGHLIGHT.ringPct / 100));
  return {
    op: 'ring',
    slug: actor.slug,
    cx: round(box.dx + (box.dw / 2)),
    cy: round(box.dy + (box.dh / 2)),
    rx: round(radius),
    ry: round(radius),
    progress: round(progress, 4),
    opacity: box.opacity,
  };
}

/**
 * The counting board: `count` cards in rows of five, each row centred, the
 * newest ringed and still growing into place.
 *
 * `hud` is the one word that matters to whoever executes this list. Everything
 * else here is under the camera, so a push-in magnifies it; the slate is not,
 * because a board that doubled in size and slid off the top of the frame when
 * the story leaned in on somebody would take the number a child is counting
 * with it. It is measured against the plate all the same, so it is still the
 * same list on every device.
 */
function slateFor(slate, tMs, width, height) {
  const count = slate?.count;
  if (!Number.isInteger(count) || count < 1) return null;
  const shown = Math.min(count, SLATE.max);
  const cell = (SLATE.cellPct / 100) * height;
  const gap = (SLATE.gapPct / 100) * height;
  const pop = popScale((tMs - slate.sinceMs) / SLATE.popMs);
  const cells = [];

  for (let n = 1; n <= shown; n += 1) {
    const row = Math.floor((n - 1) / SLATE.perRow);
    const column = (n - 1) % SLATE.perRow;
    const inRow = Math.min(shown - (row * SLATE.perRow), SLATE.perRow);
    const rowWidth = (inRow * cell) + ((inRow - 1) * gap);
    cells.push({
      n,
      dx: round(((width - rowWidth) / 2) + (column * (cell + gap))),
      dy: round(((SLATE.topPct / 100) * height) + (row * (cell + gap))),
      dw: round(cell),
      dh: round(cell),
      // Only the newest card is new: the ring marks the total the story just
      // said, and the pop is that card arriving. Everything before it is
      // furniture and must not move, or the whole board breathes on every count.
      ring: n === shown,
      pop: n === shown ? round(pop, 4) : 1,
    });
  }

  return { op: 'slate', hud: true, count: shown, cells };
}

// The standard back-out: the card overshoots its size and settles. `c1` is the
// curve's own constant and not a second number to tune — its peak is exactly
// `SLATE.overshoot`, which is the number that IS published, and a test holds
// the two together.
const BACK_C1 = 1.70158;

function popScale(progress) {
  if (!Number.isFinite(progress) || progress >= 1) return 1;
  const past = Math.max(0, progress) - 1;
  return 1 + ((BACK_C1 + 1) * past * past * past) + (BACK_C1 * past * past);
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
  const frame = Number.isInteger(actor.frame) && actor.frame >= 0 ? actor.frame : 0;
  const sheet = actor.clip && !actor.clipMissing ? sheets.sheet(slug, actor.clip, frame) : null;
  const cells = gridOf(sheet?.grid);
  if (!sheet?.url || !cells) return { op: 'missing', slug, ...box };

  // The frame is the CLIP's, and the sheet may be one chunk of it: the cell is
  // counted from where that chunk begins. An adapter with no chunks answers 0
  // and this is the identity it has always been.
  const cell = frameCell(frame - (sheet.chunkStart ?? 0), cells);
  return { op: 'sprite', slug, url: sheet.url, cell, cells, ...box };
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
