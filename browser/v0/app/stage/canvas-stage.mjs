/**
 * The picture, on one canvas over the plate video.
 *
 * What this replaces was a `<div class="sprite">` per actor with the sheet as a
 * `background-image` and a fresh `background-position` written every animation
 * frame, walks as CSS transitions on `left`/`top`/`width`/`height`, and a
 * `filter: drop-shadow` on every one of them. Every sprite was a compositor
 * layer, every frame was a style recalculation, and the browser blurred each
 * character's full silhouette again on every paint.
 *
 * Now there is one element and one paint: `buildDrawList` says what the instant
 * looks like in plate coordinates, and this file executes that list through a 2D
 * context whose transform carries the camera, the letterbox and the device pixel
 * ratio together. It is the ONLY file that measures stage DOM or touches the
 * canvas — everybody else asks it, which is what keeps a second definition of
 * "how big is the stage really" from drifting away from the picture.
 */

import { DPR_CAP, chunkAt } from '../assets/rendition-picker.mjs';
import { DEFAULT_STAGE_RESOLUTION, FLASH, HIGHLIGHT, SLATE } from '../../policy.mjs';
import { buildDrawList } from './draw-list.mjs';

// The ink of the shadow and of the placeholder, kept here rather than in the
// pure list: a colour is a paint decision, and the list is meant to survive a
// renderer swap.
const SHADOW_INK = '2, 3, 12';
const MISSING_INK = ['rgba(245, 220, 163, 0.28)', 'rgba(27, 31, 67, 0.88)'];
const TAU = Math.PI * 2;

// The lesson's ink.
//
// The board is frosted glass over a blurred scene, and everything on it is the
// palette the lessons were designed in (`procgraphics/math_board.py`): warm,
// high-contrast, and carrying meaning rather than decoration. The addends are
// told apart by COLOUR — two reds and three greens make five, and a child can
// see the joining without being told it — so the group inks and the pad tints
// under them are one list, indexed by the group the draw list names.
//
// None of this is in the draw list: a client with its own palette is still
// drawing this board, and the list carries the geometry it must agree on.
const SLATE_PANEL_INK = 'rgba(255, 255, 255, 0.59)';
const SLATE_PANEL_EDGE = 'rgba(255, 255, 255, 0.84)';
const SLATE_GROUP_INKS = ['236, 92, 86', '96, 184, 120', '94, 158, 224', '196, 132, 224'];
const SLATE_PAD_TINTS = ['255, 186, 166', '170, 226, 184', '176, 206, 248', '224, 192, 248'];
// A plain count is not two groups of anything, so its counters are one calm
// hue on one calm pad — colour would be claiming a difference that is not there.
const SLATE_COUNT_INK = '120, 150, 210';
const SLATE_PAD_NEUTRAL = '226, 232, 240';
const SLATE_STEM_INK = 'rgb(120, 84, 52)';
const SLATE_LEAF_INK = 'rgb(110, 186, 110)';
const SLATE_SHINE_INK = 'rgba(255, 255, 255, 0.35)';
const SLATE_CROSS_INK = 'rgb(228, 64, 60)';
const SLATE_EQUATION_INKS = {
  term: '60, 70, 80',
  operator: '60, 70, 80',
  equals: '236, 92, 86',
  result: '54, 150, 96',
};
// The gold is the one accent both the ringed counter and the highlight ring are
// drawn in — a child is being shown two halves of one answer, and they should
// look like it.
const GOLD_INK = '245, 197, 66';
// The pad under a counter: the old board drew it at 96% of the CELL, and what
// the draw list carries is the counter's radius — `SLATE.counterRadius` of that
// same cell. Derived rather than written out, so a counter drawn at a different
// fraction of its cell keeps the pad the same fraction of the cell it always was.
const SLATE_PAD_CELL_SHARE = 0.96;
const padShare = () => SLATE_PAD_CELL_SHARE / (2 * SLATE.counterRadius);
// The square a counter PICTURE is fitted in, as a multiple of the counter's
// radius. The apple is two lobes `2r` wide with a leaf reaching `1.24r` up; a
// picture drawn with the ordinary margin around its subject stands about as
// wide as the apple did in a square this size — inside the gold ring, on the
// pad, where the apple stood.
const PICTURE_SIDE = 2.5;
// Rounded first, then the ordinary stacks: a counting board wants the shape of
// a nursery numeral, and every platform that has one names it differently. It
// is set HEAVY, as the lessons were drawn: a numeral a child is reading across
// a room at bedtime is a shape before it is a glyph.
const NUMERAL_FONT = '700 {size}px "SF Pro Rounded", ui-rounded, Nunito, Quicksand, system-ui, sans-serif';
const numeralFont = (size) => NUMERAL_FONT.replace('{size}', String(Math.round(size)));

// How long a character may be missing before the placeholder is shown.
//
// A sheet that decodes inside this is never seen as a blob: the stage draws
// nothing for that character and the next frame has the picture. Anything
// longer than about this is a gap a viewer notices, and a lozenge that says
// "somebody is standing here" beats a hole in the story.
const MISSING_GRACE_MS = 150;

// The remembered frame is a thumbnail, not a copy: it stands in for a character
// while its sheet is re-decoded, at whatever size the stage draws it, and a
// stand-in nobody looks twice at does not need the sharpness of the real one.
// Ten characters at this size is about a megabyte.
const MEMORY_PX = 256;

// A cast, not a story: characters that left three scenes ago are not coming
// back into this frame, and their thumbnails should not outlive them.
const MEMORY_SLUGS = 12;

/**
 * `elements` is the template's stage bag; only `frame`, `stage` and `canvas`
 * are touched here.
 *
 * `dprCap` is the same ceiling the rendition picker chooses tiers against, and
 * it is one constant on purpose: a canvas backed at 3x while the sheets were
 * chosen for 2x is a full third more pixels to fill with nothing sharper to
 * put in them.
 */
export function createCanvasStage(elements, {
  onWarning = () => {}, dprCap = DPR_CAP, shadows = true,
  now = () => globalThis.performance?.now?.() ?? 0,
} = {}) {
  const context = elements.canvas?.getContext?.('2d') ?? null;
  // The last frame each character was drawn at, as a thumbnail of its own. A
  // decoded sheet cannot be held for this: the cache closes a bitmap when it
  // evicts it, which is exactly the moment this exists for.
  const memory = new Map();
  const missedSince = new Map();
  let density = dprCap;
  let shadowed = shadows;
  let plate = [0, 0];
  let backing = [0, 0];
  let renderScale = 0;
  let last = null;
  let observer = null;
  let destroyed = false;

  if (!context) {
    // Said once, at construction, and then never again: a stage with no context
    // draws nothing for the whole session, and one line saying so is worth more
    // than one per frame. The poster, the subtitles and the audio still play
    // over it — the fallback the plan asks for is the absence of this canvas,
    // not an exception out of it.
    //
    // The two reasons are named apart on purpose. "This browser has no 2D
    // canvas" is a device story runs on; "there is no canvas in the element
    // bag" is this repo wiring itself up wrong, and blaming the browser for it
    // would send somebody hunting a phone that does not exist.
    onWarning({
      type: 'media',
      asset: 'stage-canvas',
      message: elements.canvas
        ? 'this browser gave no 2D canvas context; the picture is poster and subtitles only'
        : 'the stage was built without a canvas element; the picture is poster and subtitles only',
    });
  } else if (typeof globalThis.ResizeObserver === 'function') {
    observer = new ResizeObserver(() => resized());
    observer.observe(elements.frame);
  }

  return { fitScale, draw, setTier, destroy };

  /**
   * Take the numbers a lower tier asks for, mid-story.
   *
   * Repainted from the last list rather than left for the next frame: a
   * demotion happens because frames are already scarce, and the first thing the
   * viewer should see from it is the cheaper picture, not one more expensive one.
   */
  function setTier({ dprCap: nextCap = density, shadows: nextShadows = shadowed } = {}) {
    if (destroyed) return;
    if (nextCap === density && nextShadows === shadowed) return;
    density = Number.isFinite(nextCap) && nextCap > 0 ? nextCap : density;
    shadowed = nextShadows !== false;
    if (!last) return;
    sizeStage(last.list.width, last.list.height);
    paint(last.list, last.lookup, last.counter);
  }

  /**
   * The stage's letterbox scale, measured now.
   *
   * Public because the asset layer needs the same number to choose a sheet's
   * resolution: the tier is decided by how big a sprite ends up on the viewer's
   * screen, and this is the step between the logical stage and that screen.
   */
  function fitScale() {
    return fitStage() ?? 1;
  }

  /** Paint one instant. `sheets` is `sceneSheets` or anything with its shape. */
  function draw(state, sheets) {
    if (!context || destroyed) return null;
    const list = buildDrawList(state, sheets);
    sizeStage(list.width, list.height);
    last = { list, lookup: lookupOf(sheets), counter: counterOf(sheets) };
    paint(list, last.lookup, last.counter);
    return list;
  }

  function paint(list, lookup, counter) {
    paintDrawList(context, list, {
      lookup,
      counter,
      scale: renderScale,
      shadows: shadowed,
      onPainted: remember,
      onMissing: standIn,
    });
  }

  /**
   * Keep this character's current cell, in case its sheet goes away.
   *
   * Copied only when the cell changes — a clip runs at twelve to sixteen frames
   * a second against a loop drawing twenty-four, so most frames cost nothing —
   * and into the character's own canvas, reused, so a story does not allocate
   * one per frame.
   */
  function remember(command, drawable) {
    if (command.op !== 'sprite' || destroyed) return;
    const key = `${command.url} ${command.cell[0]},${command.cell[1]}`;
    const held = memory.get(command.slug);
    missedSince.delete(command.slug);
    if (held?.key === key) {
      memory.delete(command.slug);
      memory.set(command.slug, held);
      return;
    }
    const [columns, rows] = command.cells;
    const cellWidth = sourceWidth(drawable) / columns;
    const cellHeight = sourceHeight(drawable) / rows;
    if (!(cellWidth > 0) || !(cellHeight > 0)) return;
    const shrink = Math.min(1, MEMORY_PX / Math.max(cellWidth, cellHeight));
    const width = Math.max(1, Math.round(cellWidth * shrink));
    const height = Math.max(1, Math.round(cellHeight * shrink));
    const canvas = held?.canvas ?? createCanvas();
    const into = canvas?.getContext?.('2d');
    if (!into) return;
    canvas.width = width;
    canvas.height = height;
    into.drawImage(
      drawable,
      command.cell[0] * cellWidth, command.cell[1] * cellHeight, cellWidth, cellHeight,
      0, 0, width, height,
    );
    // Deleted before it is set so the map stays in least-recently-drawn order:
    // when the cast outgrows the budget, the character nobody has drawn for the
    // longest is the one whose thumbnail goes.
    memory.delete(command.slug);
    memory.set(command.slug, { canvas, key });
    if (memory.size > MEMORY_SLUGS) memory.delete(memory.keys().next().value);
  }

  /**
   * What to draw for a character whose sheet is not there.
   *
   * Answers `true` when it has handled the command, which includes deciding to
   * draw NOTHING: for the first breath of a miss the picture is better off
   * without a blob that a decode landing a frame later would replace. The
   * placeholder is the last resort, for somebody who has never been on screen.
   */
  function standIn(into, command) {
    const held = memory.get(command.slug);
    if (held?.canvas) {
      into.globalAlpha = command.opacity;
      into.drawImage(held.canvas, command.dx, command.dy, command.dw, command.dh);
      into.globalAlpha = 1;
      return true;
    }
    const first = missedSince.get(command.slug);
    if (first === undefined) {
      missedSince.set(command.slug, now());
      return true;
    }
    return now() - first < MISSING_GRACE_MS;
  }

  function createCanvas() {
    const owner = elements.canvas?.ownerDocument ?? globalThis.document ?? null;
    return owner?.createElement?.('canvas') ?? null;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect();
    observer = null;
    last = null;
    // The remembered frames go with the stage: they are canvases of their own,
    // and a destroyed player holding a megabyte of thumbnails is the leak this
    // file is otherwise careful about.
    memory.clear();
    missedSince.clear();
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, backing[0], backing[1]);
  }

  /**
   * The logical stage is the plate's own pixels, and the canvas is backed at
   * exactly the device pixels those cover once the letterbox and the display's
   * density are in — no more, because every extra pixel is fill rate a weak
   * machine spends on nothing, and no fewer, because a canvas stretched by CSS
   * is the soft picture the whole rendition ladder exists to avoid.
   */
  function sizeStage(width, height) {
    if (width !== plate[0] || height !== plate[1]) {
      plate = [width, height];
      elements.stage.style.width = `${width}px`;
      elements.stage.style.height = `${height}px`;
    }
    const scale = fitStage() ?? 1;
    renderScale = scale * Math.min(positive(globalThis.devicePixelRatio) || 1, density);
    const pixels = [
      Math.max(1, Math.round(width * renderScale)),
      Math.max(1, Math.round(height * renderScale)),
    ];
    // Assigning `width` clears the canvas even when the value is unchanged, so
    // it is written only when it really moved — otherwise every frame would
    // start by throwing the previous one away twice.
    if (pixels[0] === backing[0] && pixels[1] === backing[1]) return;
    backing = pixels;
    elements.canvas.width = pixels[0];
    elements.canvas.height = pixels[1];
  }

  // A resize repaints from the last list rather than waiting for the next
  // frame: the story may be paused, or over, or still at its begin gate, and
  // in all three nothing is going to ask for another frame.
  function resized() {
    if (destroyed || !last) {
      fitStage();
      return;
    }
    sizeStage(last.list.width, last.list.height);
    // Through `paint`, not around it: a cell that is not decoded at this
    // instant is ordinary now the renditions are cut up — every chunk boundary
    // is one — and repainting without the stand-in puts the missing lozenge
    // where a character was for as long as the next chunk takes to arrive.
    paint(last.list, last.lookup, last.counter);
  }

  function fitStage() {
    if (destroyed) return null;
    const box = elements.frame.getBoundingClientRect();
    const width = elements.stage.offsetWidth || plate[0] || DEFAULT_STAGE_RESOLUTION[0];
    const height = elements.stage.offsetHeight || plate[1] || DEFAULT_STAGE_RESOLUTION[1];
    const measured = Math.min(box.width / width, box.height / height);
    // A stage with no size yet — mounted hidden, or measured before the first
    // layout — is 0 here, and 0 would ask the ladder for its smallest sheet for
    // the whole story. 1 is the honest guess: the logical stage at 1:1.
    //
    // The SAME number goes to the stylesheet and to the caller. Writing the raw
    // measurement here while answering 1 above it put `scale(0)` on the logical
    // stage — the picture, the plate and the canvas all scaled to nothing —
    // while the rendition picker was told the stage was full size.
    const scale = Number.isFinite(measured) && measured > 0 ? measured : 1;
    elements.stage.style.setProperty('--fit-scale', scale);
    return scale;
  }
}

/**
 * Everything a scene draws from, as the draw list asks for it.
 *
 * `plan` is the scene loader's plan — the sheets it chose a tier for and the
 * props it collected — and `cache` is the decoded-bitmap LRU. Splitting the
 * question in two is what lets a sheet be planned before it is decoded: the
 * list is built from the plan, and a bitmap that has not landed yet paints as
 * the placeholder instead of leaving a hole.
 *
 * `counter` is the board's counter picture (`counter-picture.mjs`), the one
 * asset that is the story's rather than a scene's: it is handed through here
 * so the list and the painter ask one object about everything they draw.
 */
export function sceneSheets(plan, cache, counter = null) {
  const sheets = new Map();
  for (const sheet of plan?.sheets ?? []) sheets.set(`${sheet.slug} ${sheet.clip}`, sheet);
  const props = new Map((plan?.props ?? []).map((prop) => [prop.slug, { url: prop.url }]));
  return {
    counter: () => counter,
    // Per FRAME, not per clip: where the bundle carries a chunk ladder, which
    // object a clip is drawn from changes as it loops, and `chunkAt` answers
    // both halves at once — the chunk, and the frame that chunk starts at.
    sheet: (slug, clip, frame) => {
      const held = sheets.get(`${slug} ${clip}`);
      return held ? chunkAt(held, frame) : null;
    },
    prop: (slug) => props.get(slug) ?? null,
    drawable: (url) => cache?.get(url) ?? null,
  };
}

/**
 * Execute a draw list against a 2D context.
 *
 * `scale` is the whole viewport: the letterbox times the capped device pixel
 * ratio. Everything in the list is in plate coordinates, so this is the one
 * place the two spaces meet — `plate point p` lands at
 * `(camera.scale * p + camera.offset) * scale`, which is the same mapping the
 * video plate writes into its CSS transform from the same framing.
 */
export function paintDrawList(context, list, {
  lookup = () => null, scale = 1, shadows = true,
  // The board's counter picture, as decoded so far: `null` until it lands, and
  // the apple is drawn meanwhile. Asked once per paint, not once per counter.
  counter = () => null,
  // The stage's memory of what each character last looked like, and where it is
  // told about it. Defaulted away so the list still paints on its own — the
  // goldens and the draw-list tests execute it with nothing behind them.
  onMissing = () => false, onPainted = () => {},
} = {}) {
  const { camera } = list;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, Math.round(list.width * scale), Math.round(list.height * scale));
  const magnification = camera.scale * scale;
  const offsetX = (camera.x / 100) * list.width * scale;
  const offsetY = (camera.y / 100) * list.height * scale;
  const underCamera = () => context.setTransform(magnification, 0, 0, magnification, offsetX, offsetY);
  underCamera();
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  for (const command of list.commands) {
    // `hud` is the list's word for "the camera was left out of this one". The
    // transform drops to the viewport alone for the length of such a command
    // and is put straight back, so nothing after it has to know. The board is
    // the reason the word exists — a board that doubled under a push-in would
    // take the number a child is counting with it — and the companion kept in
    // the corner over that board is drawn the same way.
    if (command.hud) context.setTransform(scale, 0, 0, scale, 0, 0);
    if (command.op === 'performance') {
      const drawable = command.shape ? shapeDrawable(context, command) : lookup(command.url);
      if (drawable) paintPerformanceNode(context, command, drawable, scale);
      if (command.hud) underCamera();
      continue;
    }
    if (command.op === 'shadow') {
      // The low tier draws no shadows: a radial gradient per character per
      // frame is the most expensive thing on the list and the least of what a
      // viewer is looking at.
      if (shadows) paintShadow(context, command);
      if (command.hud) underCamera();
      continue;
    }
    if (command.op === 'ring') {
      paintRing(context, command);
      if (command.hud) underCamera();
      continue;
    }
    // The board survives the low tier along with the ring — they carry the
    // lesson, and a device too weak for a drop shadow is not too weak for a
    // rounded rectangle.
    if (command.op === 'slate') {
      paintSlate(context, command, list.width, counter());
      if (command.hud) underCamera();
      continue;
    }
    const drawable = command.url ? lookup(command.url) : null;
    // A sheet still decoding is the ordinary case, not a failure: the scene
    // loader gates the opening and warms the rest during playback, so a later
    // scene reached early draws placeholders for an instant. The asset that
    // truly failed was named once by the loader; a second line per frame would
    // bury the log.
    if (!drawable) {
      if (!onMissing(context, command)) paintMissing(context, command);
      if (command.hud) underCamera();
      continue;
    }
    context.globalAlpha = command.opacity;
    if (command.op === 'prop') paintProp(context, command, drawable);
    else paintSprite(context, command, drawable);
    context.globalAlpha = 1;
    if (command.hud) underCamera();
    onPainted(command, drawable);
  }
  if (list.transition) {
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.globalAlpha = list.transition.opacity;
    context.fillStyle = list.transition.color;
    context.fillRect(0, 0, list.width, list.height);
    context.globalAlpha = 1;
  }
}

function paintSprite(context, command, drawable) {
  const [columns, rows] = command.cells;
  // Proportional, not `cellPx * column`: the cell size is read off the bitmap
  // that actually decoded, so a sheet served at a size nobody expected draws
  // the right cell smaller rather than a slice of two wrong ones.
  const cellWidth = sourceWidth(drawable) / columns;
  const cellHeight = sourceHeight(drawable) / rows;
  if (!(cellWidth > 0) || !(cellHeight > 0)) {
    paintMissing(context, command);
    return;
  }
  context.drawImage(
    drawable,
    command.cell[0] * cellWidth,
    command.cell[1] * cellHeight,
    cellWidth,
    cellHeight,
    command.dx,
    command.dy,
    command.dw,
    command.dh,
  );
}

/**
 * A prop is one whole picture, so nothing about it may be cropped: it is
 * fitted inside the square box its band earned it and stood on the box's floor.
 * The DOM stage fitted it the same way but pinned it to the box's TOP corner,
 * which left a wide prop hanging in the air above its own stand line.
 *
 * A prop that measures nothing is drawn to fill the box rather than replaced
 * by the placeholder. An SVG carrying only a `viewBox` decodes to an intrinsic
 * size of zero (see `bitmap-cache.mjs`) — it fetched fine, it decoded fine, and
 * nobody would ever say so — and CSS `background-size: contain` scaled exactly
 * those files against the box, which is why they looked right before. A
 * placeholder here would be a permanent glowing blob in a story with a clean
 * log.
 */
function paintProp(context, command, drawable) {
  const width = sourceWidth(drawable);
  const height = sourceHeight(drawable);
  if (!(width > 0) || !(height > 0)) {
    context.drawImage(drawable, command.dx, command.dy, command.dw, command.dh);
    return;
  }
  const fit = Math.min(command.dw / width, command.dh / height);
  const drawnWidth = width * fit;
  const drawnHeight = height * fit;
  context.drawImage(
    drawable,
    command.dx + ((command.dw - drawnWidth) / 2),
    command.dy + command.dh - drawnHeight,
    drawnWidth,
    drawnHeight,
  );
}

/**
 * The counting board: frosted glass, a counter per thing counted, and the
 * equation under them.
 *
 * Every number is the draw list's; every colour is here. A counter grows about
 * its own centre, so the ones already standing do not shift as the next one
 * lands — the board is sized for where the counters WILL be, which is why it
 * does not jump as the last one arrives.
 */
function paintSlate(context, {
  mode, panel, counters, equation, flash = null,
}, plateWidth, picture = null) {
  context.save();
  paintPanel(context, panel);
  for (const counter of counters) paintCounter(context, counter, mode, flash, picture);
  if (equation) paintEquation(context, equation, plateWidth);
  context.restore();
}

function paintPanel(context, panel) {
  roundedRect(context, panel.x, panel.y, panel.w, panel.h, panel.r);
  context.fillStyle = SLATE_PANEL_INK;
  context.fill();
  context.strokeStyle = SLATE_PANEL_EDGE;
  // The old board drew a 3px edge on a 720-high frame; a plate is measured in
  // its own pixels, so the edge is measured in them too.
  context.lineWidth = Math.max(2, panel.h * 0.005);
  context.stroke();
}

/**
 * One counter: a tinted pad, the gold ring if it is the one the count has
 * reached or a cue has swept it, the counter itself on top — the host's
 * picture, or the drawn apple — and the red X if it is being taken away.
 *
 * The order is the z-order and every step of it is load-bearing. The pad is the
 * ground, so it goes down first — drawn after the ring it would BURY it, since
 * the pad is wider than the ring is (the ring is a mark on the counter, the pad
 * is the counter's own base). The apple sits inside the ring rather than over
 * it, and the X goes last so it reads as a mark ON the apple — the order the
 * old board drew them in, and the order a child would draw them in. A flash
 * widens the ring and lays a halo under it; the halo is part of the ring's own
 * step, so the order stays pad, ring, apple, cross.
 *
 * A picture takes the apple's step and nothing else: the list says the counter
 * IS a picture (`image`), and the apple stands in only while that picture has
 * not landed — a board should never go blank for a fetch that is still coming.
 */
function paintCounter(context, {
  group, cx, cy, r, scale, alpha, cross, ring, swept = false, image = false,
}, mode, flash = null, picture = null) {
  // A counter at the very start of its pop has no size at all, and one already
  // taken away has nothing left to draw.
  if (!(scale > 0.01) || !(alpha > 0.01)) return;
  const radius = r * scale;
  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = `rgba(${padTint(mode, group)}, 0.8)`;
  circle(context, cx, cy, radius * padShare());
  context.fill();
  if (ring || swept) {
    paintGoldRing(context, cx, cy, radius + (r * SLATE.ringGap), Math.max(2, r * SLATE.ringWidth), alpha, flash);
  }
  if (image && picture) paintPicture(context, picture, cx, cy, radius);
  else paintApple(context, cx, cy, radius, counterInk(mode, group));
  if (cross > 0.01) paintCross(context, cx, cy, radius, r, cross);
  context.restore();
}

/**
 * The host's counter picture, in the apple's place: fitted whole inside a
 * square about the counter's centre, the way a prop is fitted inside its box,
 * so a picture of any shape lands unstretched. A picture that measures nothing
 * (an SVG carrying only a `viewBox` — see `paintProp`) fills the square.
 */
function paintPicture(context, picture, cx, cy, radius) {
  const side = radius * PICTURE_SIDE;
  const width = sourceWidth(picture);
  const height = sourceHeight(picture);
  const fit = width > 0 && height > 0 ? Math.min(side / width, side / height) : 0;
  const drawnWidth = fit > 0 ? width * fit : side;
  const drawnHeight = fit > 0 ? height * fit : side;
  context.drawImage(picture, cx - (drawnWidth / 2), cy - (drawnHeight / 2), drawnWidth, drawnHeight);
}

/**
 * The gold ring on a counter, and the flash that swells it.
 *
 * The swell is a half sine over the pulse: nothing at either end, `FLASH.gain`
 * times the width at the peak, so the ring breathes rather than jumps. The
 * halo is the same ink twice as wide, at `FLASH.halo` of the counter's own
 * alpha on the same curve — a glow that arrives and leaves with the pulse
 * rather than a second ring that pops in — and it goes down first, so the ring
 * stays crisp over it.
 */
function paintGoldRing(context, cx, cy, radius, width, alpha, flash) {
  const pulse = flash ? Math.sin(Math.PI * Math.min(1, Math.max(0, flash.progress))) : 0;
  const swollen = width * (1 + ((FLASH.gain - 1) * pulse));
  context.strokeStyle = `rgba(${GOLD_INK}, 1)`;
  if (pulse > 0) {
    context.globalAlpha = alpha * FLASH.halo * pulse;
    context.lineWidth = swollen * 2;
    circle(context, cx, cy, radius);
    context.stroke();
    context.globalAlpha = alpha;
  }
  context.lineWidth = swollen;
  circle(context, cx, cy, radius);
  context.stroke();
}

/**
 * An apple, because the lessons count apples: two overlapping lobes, a stem, a
 * leaf and a highlight. It is drawn rather than fetched so the board needs no
 * asset of its own and a counter can be any size the layout gives it.
 */
function paintApple(context, cx, cy, r, ink) {
  const lobe = r * 0.62;
  context.fillStyle = `rgb(${ink})`;
  oval(context, cx - r, cy - (r * 0.85), (lobe * 0.2) + r, r + (r * 0.85));
  context.fill();
  oval(context, cx - (lobe * 0.2), cy - (r * 0.85), r + (lobe * 0.2), r + (r * 0.85));
  context.fill();
  context.strokeStyle = SLATE_STEM_INK;
  context.lineWidth = Math.max(2, r * 0.14);
  context.beginPath();
  context.moveTo(cx, cy - (r * 0.78));
  context.lineTo(cx + (r * 0.1), cy - (r * 1.18));
  context.stroke();
  context.fillStyle = SLATE_LEAF_INK;
  oval(context, cx + (r * 0.16), cy - (r * 1.24), r * 0.5, r * 0.36);
  context.fill();
  context.fillStyle = SLATE_SHINE_INK;
  oval(context, cx - (r * 0.5), cy - (r * 0.5), r * 0.4, r * 0.45);
  context.fill();
}

// The X over a counter being taken away: it grows as the counter fades, so the
// two read as one gesture rather than as a disappearance and a mark.
function paintCross(context, cx, cy, radius, r, cross) {
  const reach = radius * (0.55 + (0.45 * cross));
  context.strokeStyle = SLATE_CROSS_INK;
  context.lineWidth = Math.max(2, r * SLATE.crossWidth);
  context.beginPath();
  context.moveTo(cx - reach, cy - reach);
  context.lineTo(cx + reach, cy + reach);
  context.moveTo(cx - reach, cy + reach);
  context.lineTo(cx + reach, cy - reach);
  context.stroke();
}

/**
 * The equation, centred in the band the list left for it.
 *
 * The tokens arrive with an alpha each and no x: how wide a glyph is belongs to
 * the font this device actually has, so the line is measured here and centred
 * on the plate. Operands in slate ink, the `=` in red, the answer in green —
 * the colour says which numeral is the one the child was working towards.
 */
function paintEquation(context, { y, h, tokens }, plateWidth) {
  const [bandShare, plateShare] = SLATE.equationFont;
  const size = Math.round(Math.min(h * bandShare, plateWidth * plateShare));
  context.font = numeralFont(size);
  context.textAlign = 'left';
  context.textBaseline = 'middle';
  const gap = size * SLATE.tokenGap;
  const widths = tokens.map(({ text }) => context.measureText(text).width);
  const line = widths.reduce((total, width) => total + width, 0) + (gap * (tokens.length - 1));
  let x = (plateWidth - line) / 2;
  for (const [index, token] of tokens.entries()) {
    if (token.alpha > 0.01) {
      context.globalAlpha = token.alpha;
      context.fillStyle = `rgba(${SLATE_EQUATION_INKS[token.role] ?? SLATE_EQUATION_INKS.term}, 1)`;
      context.fillText(token.text, x, y + (h / 2));
    }
    x += widths[index] + gap;
  }
  context.globalAlpha = 1;
}

function counterInk(mode, group) {
  return mode === 'count' ? SLATE_COUNT_INK : SLATE_GROUP_INKS[group % SLATE_GROUP_INKS.length];
}

function padTint(mode, group) {
  return mode === 'add' ? SLATE_PAD_TINTS[group % SLATE_PAD_TINTS.length] : SLATE_PAD_NEUTRAL;
}

function circle(context, cx, cy, radius) {
  context.beginPath();
  context.ellipse(cx, cy, Math.max(0, radius), Math.max(0, radius), 0, 0, TAU);
}

// An ellipse from the box it fits in, which is how the old board's shapes were
// written — two corners rather than a centre and two radii.
function oval(context, x, y, width, height) {
  context.beginPath();
  context.ellipse(x + (width / 2), y + (height / 2), width / 2, height / 2, 0, 0, TAU);
}

/**
 * The ring a `highlight` leaves: gold, and pulsing `HIGHLIGHT.pulses` times
 * across its life.
 *
 * A sine of the progress rather than a fade, so it begins and ends at nothing —
 * a ring that appeared at full strength would read as a second object arriving
 * on stage rather than as the one already there being pointed at.
 */
function paintRing(context, {
  cx, cy, rx, ry, progress, opacity = 1,
}) {
  if (!(rx > 0) || !(ry > 0)) return;
  // Stroked at every instant of its life, including the two it is invisible at:
  // a canvas draws nothing at alpha 0, and one branch fewer is one fewer place
  // for the ring to disappear at a boundary nobody meant.
  //
  // The subject's own opacity multiplies the pulse, so the ring arrives and
  // leaves with whoever it is marking. The default is for a list written before
  // the field existed: a ring with no opacity is a ring at full strength, which
  // is what those lists meant.
  const alpha = Math.abs(Math.sin(progress * HIGHLIGHT.pulses * Math.PI)) * opacity;
  context.save();
  context.globalAlpha = alpha;
  context.strokeStyle = `rgba(${GOLD_INK}, 1)`;
  context.lineWidth = Math.max(2, rx * 0.06);
  context.beginPath();
  context.ellipse(cx, cy, rx, ry, 0, 0, TAU);
  context.stroke();
  context.restore();
}

// Written out rather than `roundRect`, which is younger than the browsers this
// player still draws on — the same reason the placeholder is an ellipse.
function roundedRect(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo((x + width) - r, y);
  context.arcTo(x + width, y, x + width, y + r, r);
  context.lineTo(x + width, (y + height) - r);
  context.arcTo(x + width, y + height, (x + width) - r, y + height, r);
  context.lineTo(x + r, y + height);
  context.arcTo(x, y + height, x, (y + height) - r, r);
  context.lineTo(x, y + r);
  context.arcTo(x, y, x + r, y, r);
  context.closePath();
}

// An ellipse cannot carry a radial gradient of its own, so the gradient is
// drawn round and the space it is drawn in is squashed.
function paintShadow(context, { cx, cy, rx, ry, opacity }) {
  if (!(rx > 0) || !(ry > 0) || opacity <= 0) return;
  context.save();
  context.globalAlpha = opacity;
  context.translate(cx, cy);
  context.scale(1, ry / rx);
  const gradient = context.createRadialGradient(0, 0, 0, 0, 0, rx);
  gradient.addColorStop(0, `rgba(${SHADOW_INK}, 1)`);
  gradient.addColorStop(1, `rgba(${SHADOW_INK}, 0)`);
  context.fillStyle = gradient;
  context.beginPath();
  context.arc(0, 0, rx, 0, TAU);
  context.fill();
  context.restore();
}

/**
 * The placeholder: the same warm lozenge `.sprite.is-missing` painted, so a
 * character whose sheet is late or absent still reads as somebody standing
 * there rather than as a hole in the story.
 *
 * An ellipse rather than a rounded rectangle because `roundRect` is younger
 * than the browsers this player still draws on, and the shape is a stand-in
 * either way.
 */
function paintMissing(context, { dx, dy, dw, dh, opacity }) {
  if (!(dw > 0) || !(dh > 0)) return;
  context.save();
  context.globalAlpha = opacity;
  const gradient = context.createLinearGradient(dx, dy, dx + dw, dy + dh);
  gradient.addColorStop(0, MISSING_INK[0]);
  gradient.addColorStop(1, MISSING_INK[1]);
  context.fillStyle = gradient;
  context.beginPath();
  context.ellipse(dx + (dw / 2), dy + (dh / 2), dw / 2, dh / 2, 0, 0, TAU);
  context.fill();
  context.restore();
}

function lookupOf(sheets) {
  return typeof sheets?.drawable === 'function' ? (url) => sheets.drawable(url) : () => null;
}

// The counter picture as decoded so far, read at paint time rather than at
// draw time: it lands whenever its fetch does, and the next paint — the one
// its landing asks the runtime for, since a settled board has no frame of its
// own coming — shows it from the list already in hand.
function counterOf(sheets) {
  return typeof sheets?.counter === 'function' ? () => sheets.counter()?.drawable ?? null : () => null;
}

// An `ImageBitmap` measures in `width`; an `Image` from the decode fallback
// measures in `naturalWidth` and answers 0 for `width` until it is in a
// document, which it never is.
function sourceWidth(drawable) {
  return positive(drawable?.naturalWidth) || positive(drawable?.width);
}

function sourceHeight(drawable) {
  return positive(drawable?.naturalHeight) || positive(drawable?.height);
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// WHT consumes evaluated source-space commands. Motion/contact/depth/effect
// phase is already resolved by the shared core; this function only paints.
const performanceLayers = new WeakMap();
function paintPerformanceNode(context, command, drawable, viewportScale = 1) {
  context.save();
  context.globalAlpha = command.opacity;
  if (command.travel) {
    for (const tile of command.travel.tiles) {
      context.save();
      context.translate(tile.x + (tile.flip ? tile.width : 0), tile.y);
      if (tile.flip) context.scale(-1, 1);
      context.drawImage(drawable, ...command.source, 0, 0, tile.width, tile.height);
      context.restore();
    }
    context.restore();
    return;
  }
  if (command.projection) {
    for(const polygon of command.projectionClips??[]){context.beginPath();polygon.forEach((p,i)=>i?context.lineTo(...p):context.moveTo(...p));context.closePath();context.clip();}
    paintProjectedImage(context, drawable, command.source, command.projectionMesh);
    context.restore();
    return;
  }
  context.transform(...command.matrix);
  const [sx, sy, width, height] = command.source;
  if (command.mask) {
    context.beginPath();
    if (command.mask.type === 'rect') context.rect(...command.mask.rect);
    else {
      command.mask.points.forEach((p, i) => i ? context.lineTo(...p) : context.moveTo(...p));
      context.closePath();
    }
    context.clip();
  }
  if (command.glow) {
    context.shadowColor = command.glow.color;
    context.shadowBlur = command.glow.blur * viewportScale;
  }
  if (command.water) {
    let layer = performanceLayers.get(context);
    if (!layer) {
      const canvas = context.canvas?.ownerDocument?.createElement('canvas')
        ?? (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(width, height) : null);
      if (!canvas) throw new Error('water masking requires an offscreen canvas');
      layer = { canvas, context: canvas.getContext('2d') };
      performanceLayers.set(context, layer);
    }
    if (layer.canvas.width !== width) layer.canvas.width = width;
    if (layer.canvas.height !== height) layer.canvas.height = height;
    const into = layer.context;
    into.clearRect(0, 0, width, height);
    into.drawImage(drawable, sx, sy, width, height, 0, 0, width, height);
    const water = command.water;
    const end = water.line + water.sourceHeight * (water.fade ?? .23);
    into.globalCompositeOperation = 'source-atop';
    const tint = into.createLinearGradient(0, water.line - 2, 0, end);
    tint.addColorStop(0, '#55cce000');
    tint.addColorStop(.18, water.color ? water.color.slice(0,7)+'30' : '#55cce030');
    tint.addColorStop(1, water.color ?? '#55cce080');
    into.fillStyle = tint;
    into.fillRect(0, water.line - 2, width, height - water.line + 2);
    into.globalCompositeOperation = 'destination-in';
    const alpha = into.createLinearGradient(0, water.line - 2, 0, end);
    alpha.addColorStop(0, '#000000');
    alpha.addColorStop(1, 'rgba(0,0,0,' + (water.opacity ?? .6) + ')');
    into.fillStyle = alpha;
    into.fillRect(0, 0, width, height);
    into.globalCompositeOperation = 'source-over';
    context.drawImage(layer.canvas, 0, 0);
  } else context.drawImage(drawable, sx, sy, width, height, 0, 0, width, height);
  context.shadowBlur = 0;
  for (const light of command.lights) {
    const halo=context.createRadialGradient(light.x,light.y,0,light.x,light.y,light.radius*4);
    halo.addColorStop(0,light.color+'b3');halo.addColorStop(.35,light.color+'4d');halo.addColorStop(1,light.color+'00');
    context.globalAlpha=command.opacity*light.opacity;
    context.fillStyle=halo;context.beginPath();context.arc(light.x,light.y,light.radius*4,0,Math.PI*2);context.fill();
    context.fillStyle='#ffffffcc';context.beginPath();context.ellipse(light.x,light.y,light.radius*.85,light.radius*.5,0,0,Math.PI*2);context.fill();
  }
  context.shadowBlur = 0;
  for (const particle of command.particles) {
    context.globalAlpha = command.opacity * particle.opacity;
    context.fillStyle = particle.color;
    context.beginPath();
    if (particle.points) particle.points.forEach((p,i)=>i ? context.lineTo(...p) : context.moveTo(...p));
    else {
      context.moveTo(particle.x, particle.y - particle.radius * 2);
      context.lineTo(particle.x + particle.radius, particle.y);
      context.lineTo(particle.x, particle.y + particle.radius * 2);
      context.lineTo(particle.x - particle.radius, particle.y);
    }
    context.closePath(); context.fill();
    if (particle.stroke) {
      context.strokeStyle=particle.stroke; context.lineWidth=particle.stroke_width; context.stroke();
    }
  }
  context.restore();
}

// The shared core emits the source reference projective screen mesh.
// This adapter only textures its triangles.
function paintProjectedImage(context, image, source, mesh) {
  const [sx, sy, sw, sh] = source;
  const transform=context.getTransform?.()??{a:1,b:0};
  const overlap=Math.max(.15,1/Math.max(.001,Math.hypot(transform.a,transform.b)));
  const triangle = (uv, xy) => {
    const [[u0,v0],[u1,v1],[u2,v2]] = uv;
    const [[x0,y0],[x1,y1],[x2,y2]] = xy;
    const det = u0*(v1-v2)+u1*(v2-v0)+u2*(v0-v1);
    if (Math.abs(det) < 1e-12) throw new Error('degenerate projection triangle');
    const a=(x0*(v1-v2)+x1*(v2-v0)+x2*(v0-v1))/det;
    const c=(x0*(u2-u1)+x1*(u0-u2)+x2*(u1-u0))/det;
    const e=(x0*(u1*v2-u2*v1)+x1*(u2*v0-u0*v2)+x2*(u0*v1-u1*v0))/det;
    const b=(y0*(v1-v2)+y1*(v2-v0)+y2*(v0-v1))/det;
    const d=(y0*(u2-u1)+y1*(u0-u2)+y2*(u1-u0))/det;
    const f=(y0*(u1*v2-u2*v1)+y1*(u2*v0-u0*v2)+y2*(u0*v1-u1*v0))/det;
    const center=[(x0+x1+x2)/3,(y0+y1+y2)/3];
    const expanded=xy.map(p=>{const dx=p[0]-center[0],dy=p[1]-center[1],length=Math.hypot(dx,dy)||1;return [p[0]+dx*overlap/length,p[1]+dy*overlap/length];});
    context.save();context.beginPath();expanded.forEach((p,i)=>i?context.lineTo(...p):context.moveTo(...p));context.closePath();context.clip();
    context.transform(a,b,c,d,e,f);
    context.drawImage(image,sx,sy,sw,sh,0,0,sw,sh);context.restore();
  };
  for(let i=0;i<mesh.length;i+=3){
    const points=mesh.slice(i,i+3);
    triangle(points.map(p=>[p[2]*sw,p[3]*sh]),points.map(p=>p.slice(0,2)));
  }
}

const performanceShapes = new WeakMap();
function shapeDrawable(context, command) {
  let cache = performanceShapes.get(context);
  if (!cache) { cache = new Map(); performanceShapes.set(context, cache); }
  const key = JSON.stringify([command.shape, command.source]);
  if (cache.has(key)) return cache.get(key);
  const [,,w,h] = command.source;
  const canvas = context.canvas?.ownerDocument?.createElement('canvas')
    ?? (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w,h) : null);
  if (!canvas) throw new Error('shape rasterization requires a canvas');
  canvas.width=w; canvas.height=h;
  const c=canvas.getContext('2d'), s=command.shape;
  const [x,y,width,height]=s.bounds??[0,0,w,h];
  c.beginPath();
  if(s.kind==='rect')c.rect(x,y,width,height);
  else if(s.kind==='roundrect')c.roundRect(x,y,width,height,s.radius??0);
  else c.ellipse(x+width/2,y+height/2,width/2,height/2,0,s.kind==='arc'?s.start_angle:0,s.kind==='arc'?s.end_angle:Math.PI*2);
  if(s.shadow){c.shadowColor=s.shadow.color;c.shadowBlur=s.shadow.blur;c.shadowOffsetX=s.shadow.offset[0];c.shadowOffsetY=s.shadow.offset[1];}
  if(s.fill){c.fillStyle=s.fill;c.fill();}
  if(s.stroke){c.strokeStyle=s.stroke;c.lineWidth=s.stroke_width??1;c.stroke();}
  cache.set(key,canvas);
  return canvas;
}
