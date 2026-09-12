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
import { counterCount, normaliseSlate, slateSchedule } from '../../core/slate.mjs';
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
 * The counting board: a frosted panel over the scene, a counter per thing
 * counted, the running total, and the equation that names what happened.
 *
 * `hud` is the one word that matters to whoever executes this list. Everything
 * else here is under the camera, so a push-in magnifies it; the board is not,
 * because a board that doubled in size and slid off the top of the frame when
 * the story leaned in on somebody would take the number a child is counting
 * with it. It is measured against the plate all the same, so it is still the
 * same list on every device.
 *
 * The whole build is a function of `tMs - sinceMs` and nothing else: the
 * counters pop in one at a time, a subtraction then crosses out the ones taken,
 * and only after that does the equation write itself token by token. A seek
 * backwards is the same arithmetic asked at a smaller t, which is why none of
 * it is remembered anywhere.
 */
function slateFor(slate, tMs, width, height) {
  const board = normaliseSlate(slate);
  if (!board || board.count < 1) return null;
  const drawn = counterCount(board);
  if (drawn < 1) return null;

  // `from` is how many counters were already standing when this board was
  // raised - a plain count growing over a plain count. They are drawn settled,
  // and the build starts at the first new one.
  const sinceMs = Number.isFinite(slate?.sinceMs) ? slate.sinceMs : 0;
  const elapsed = (Number.isFinite(tMs) ? tMs : 0) - sinceMs;
  const schedule = slateSchedule(board, Number.isInteger(slate?.from) ? slate.from : 0);
  const { from } = schedule;
  const panel = panelBox(width, height);
  const { places, cell, band } = counterPlaces(panel, width, height, drawn);

  const counters = [];
  let present = 0;
  let ringed = -1;
  for (let index = 0; index < drawn; index += 1) {
    const scale = index < from
      ? 1
      : popScale((elapsed - ((index - from) * SLATE.staggerMs)) / SLATE.popMs);
    const cross = takeProgress(schedule, drawn, index, elapsed);
    const alpha = 1 - cross;
    if (scale > 0.5 && alpha > 0.5) present += 1;
    // The ring marks where the count has got to: the newest counter that has
    // begun to arrive and has not been taken away again.
    if (scale > 0.2 && alpha > 0.5) ringed = index;
    counters.push({
      n: index + 1,
      group: groupOf(board, index),
      cx: round(places[index][0]),
      cy: round(places[index][1]),
      r: round(cell * SLATE.counterRadius),
      scale: round(scale, 4),
      alpha: round(alpha, 4),
      cross: round(cross, 4),
      ring: false,
    });
  }
  if (ringed >= 0) counters[ringed].ring = true;

  const badgeSize = (SLATE.badgePct / 100) * height;
  const [badgeInX, badgeDownY] = SLATE.badgeOffset;
  return {
    op: 'slate',
    hud: true,
    mode: board.mode,
    count: board.count,
    groups: [...board.groups],
    progress: round(clamped(elapsed / schedule.endMs), 4),
    panel: {
      x: round(panel.x),
      y: round(panel.y),
      w: round(panel.w),
      h: round(panel.h),
      r: round(panel.r),
      sheenH: round(panel.h * (SLATE.sheenPct / 100)),
    },
    counters,
    // A badge over an empty board is a lesson insisting the answer is zero
    // while the first counter is still on its way in.
    badge: present > 0
      ? {
        cx: round((panel.x + panel.w) - (badgeInX * badgeSize)),
        cy: round(panel.y + (badgeDownY * badgeSize)),
        size: round(badgeSize),
        n: present,
      }
      : null,
    equation: equationFor(board, schedule, elapsed, band),
  };
}

/** How far through being taken away a counter is; 0 for every counter that stays. */
function takeProgress({ countersEnd, taken }, drawn, index, elapsed) {
  const first = drawn - taken;
  if (taken < 1 || index < first) return 0;
  const at = countersEnd + ((index - first) * SLATE.takeStaggerMs);
  return smoothstep((elapsed - at) / SLATE.takeMs);
}

/**
 * The equation, once the counters have finished doing what they do.
 *
 * `null` until then, and deliberately: the numerals are the abstraction of what
 * the child has just watched happen, and one that appeared alongside the
 * counters would be the answer arriving before the question. The tokens carry
 * no x of their own - they are glyphs, and only the painter knows how wide a
 * glyph is in the font it has.
 */
function equationFor(board, { revealEnd, tokens }, elapsed, band) {
  if (elapsed < revealEnd || tokens.length === 0) return null;
  return {
    y: round(band.y),
    h: round(band.h),
    tokens: tokens.map(({ text, role }, index) => ({
      text,
      role,
      alpha: round(smoothstep((elapsed - (revealEnd + (index * SLATE.tokenMs))) / SLATE.tokenMs), 4),
    })),
  };
}

/** The frosted panel, in plate pixels: percentages of the plate, both ways. */
function panelBox(width, height) {
  const { left, top, right, bottom } = SLATE.panelPct;
  return {
    x: (left / 100) * width,
    y: (top / 100) * height,
    w: ((right - left) / 100) * width,
    h: ((bottom - top) / 100) * height,
    r: (SLATE.radiusPct / 100) * height,
  };
}

/**
 * Where the counters stand, how big they are, and what is left below them for
 * the equation.
 *
 * There is no ten-frame and no empty slot: the rows are sized to the count
 * actually being drawn and centred on the plate, so three counters are three
 * counters rather than three in a grid of ten. Six and over split into two
 * balanced rows, and the cell is the smallest of what the panel's width, the
 * rows' shared height and the plate itself allow.
 */
function counterPlaces(panel, width, height, n) {
  const rows = n <= SLATE.perRow ? [n] : [Math.ceil(n / 2), Math.floor(n / 2)];
  const top = panel.y + (panel.h * (SLATE.countersTopPct / 100));
  const bottom = panel.y + (panel.h * (SLATE.countersBottomPct / 100));
  const cell = Math.min(
    (panel.w * SLATE.cellShare) / Math.max(...rows),
    (bottom - top) / rows.length,
    (SLATE.cellMaxPct / 100) * height,
  );
  const firstY = top + (((bottom - top) - (rows.length * cell)) / 2) + (cell / 2);
  const places = [];
  for (const [row, inRow] of rows.entries()) {
    const firstX = ((width - (inRow * cell)) / 2) + (cell / 2);
    for (let column = 0; column < inRow; column += 1) {
      places.push([firstX + (column * cell), firstY + (row * cell)]);
    }
  }
  const bandGap = SLATE.bandGapPct / 100;
  const panelBottom = panel.y + panel.h;
  const bandY = bottom + ((panelBottom - bottom) * bandGap);
  return { places, cell, band: { y: bandY, h: panelBottom - bandY - (panel.h * bandGap) } };
}

// Which addend a counter belongs to - the colour a painter tells the groups
// apart by. A subtraction is one group being taken from, so all of it is the
// first group; a plain count has no groups to tell apart at all.
function groupOf(board, index) {
  return board.mode === 'add' && index >= board.groups[0] ? 1 : 0;
}

// The standard back-out: the counter overshoots its size and settles. `c1` is
// the curve's own constant and not a second number to tune - its peak is
// exactly `SLATE.overshoot`, which is the number that IS published, and a test
// holds the two together.
const BACK_C1 = 1.70158;

function popScale(progress) {
  if (!Number.isFinite(progress) || progress >= 1) return 1;
  const past = Math.max(0, progress) - 1;
  return 1 + ((BACK_C1 + 1) * past * past * past) + (BACK_C1 * past * past);
}

// The ease a counter fades on and a numeral arrives on: out of rest and into
// it, so nothing in the lesson snaps.
function smoothstep(progress) {
  const u = clamped(progress);
  return u * u * (3 - (2 * u));
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
