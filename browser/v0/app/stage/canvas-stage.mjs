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

import { DPR_CAP } from '../assets/rendition-picker.mjs';
import { DEFAULT_STAGE_RESOLUTION } from '../../policy.mjs';
import { buildDrawList } from './draw-list.mjs';

// The ink of the shadow and of the placeholder, kept here rather than in the
// pure list: a colour is a paint decision, and the list is meant to survive a
// renderer swap.
const SHADOW_INK = '2, 3, 12';
const MISSING_INK = ['rgba(245, 220, 163, 0.28)', 'rgba(27, 31, 67, 0.88)'];
const TAU = Math.PI * 2;

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
    paint(last.list, last.lookup);
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
    last = { list, lookup: lookupOf(sheets) };
    paint(list, last.lookup);
    return list;
  }

  function paint(list, lookup) {
    paintDrawList(context, list, {
      lookup,
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
    paintDrawList(context, last.list, { lookup: last.lookup, scale: renderScale, shadows: shadowed });
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
 */
export function sceneSheets(plan, cache) {
  const sheets = new Map();
  for (const sheet of plan?.sheets ?? []) {
    sheets.set(`${sheet.slug} ${sheet.clip}`, { url: sheet.url, grid: sheet.grid });
  }
  const props = new Map((plan?.props ?? []).map((prop) => [prop.slug, { url: prop.url }]));
  return {
    sheet: (slug, clip) => sheets.get(`${slug} ${clip}`) ?? null,
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
  // The stage's memory of what each character last looked like, and where it is
  // told about it. Defaulted away so the list still paints on its own — the
  // goldens and the draw-list tests execute it with nothing behind them.
  onMissing = () => false, onPainted = () => {},
} = {}) {
  const { camera } = list;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, Math.round(list.width * scale), Math.round(list.height * scale));
  const magnification = camera.scale * scale;
  context.setTransform(
    magnification,
    0,
    0,
    magnification,
    (camera.x / 100) * list.width * scale,
    (camera.y / 100) * list.height * scale,
  );
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';

  for (const command of list.commands) {
    if (command.op === 'shadow') {
      // The low tier draws no shadows: a radial gradient per character per
      // frame is the most expensive thing on the list and the least of what a
      // viewer is looking at.
      if (shadows) paintShadow(context, command);
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
      continue;
    }
    context.globalAlpha = command.opacity;
    if (command.op === 'prop') paintProp(context, command, drawable);
    else paintSprite(context, command, drawable);
    context.globalAlpha = 1;
    onPainted(command, drawable);
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
