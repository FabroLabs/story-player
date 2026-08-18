/**
 * The one file that measures stage DOM and touches the 2D context.
 *
 * There is no DOM to read back afterwards — a canvas keeps no record of what
 * was drawn on it — so the fake context's call log IS the picture here. What
 * these pin is the arithmetic between plate coordinates and device pixels: the
 * camera, the letterbox, the device pixel ratio and its cap, all of which are
 * invisible until they are wrong, at which point the whole cast is off by a
 * factor nobody can name.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createCanvasStage, paintDrawList, sceneSheets } from '../browser/v0/app/stage/canvas-stage.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { fakeContext, fakeElement, fakeStageElements, installDom } from './_dom.mjs';

function stageState({ actors = [], camera } = {}) {
  return {
    plate: { resolution: [1920, 1080] },
    actors: actors.map((actor) => ({ kind: 'character', opacity: 1, frame: 0, clipMissing: false, ...actor })),
    camera: camera ?? { scale: 1, x: 0, y: 0 },
    subtitle: '',
    ended: false,
    warnings: [],
  };
}

const bitmap = (width, height) => ({ width, height });

function book({ url = 'ruby.webp', grid = [1, 1], drawables = {} } = {}) {
  return {
    sheet: () => ({ url, grid }),
    prop: (slug) => ({ url: `${slug}.svg` }),
    drawable: (asked) => drawables[asked] ?? null,
  };
}

test('a lowered tier repaints at once, cheaper, without waiting for a frame', (t) => {
  const { stage, context, elements } = mounted(t, { dpr: 3 });
  const drawables = { 'ruby.webp': bitmap(64, 64) };
  const state = stageState({ actors: [{ slug: 'ruby', clip: 'idle', x: 50, feetY: 900, heightPx: 300 }] });
  stage.draw(state, book({ drawables }));
  const backing = elements.canvas.width;
  assert.ok(context.of('createRadialGradient').length > 0, 'the default tier drew no shadow to begin with');

  const from = context.calls.length;
  stage.setTier({ dprCap: 1.5, shadows: false });
  const since = context.calls.slice(from).map(([name]) => name);

  // Repainted here, not at the next frame: a demotion can land while the story
  // is paused, at the gate, or after the end, and none of those are followed by
  // another frame.
  assert.equal(since.filter((name) => name === 'clearRect').length, 1, 'the demotion did not repaint');
  assert.equal(since.filter((name) => name === 'createRadialGradient').length, 0, 'the low tier still painted a shadow');
  assert.ok(since.includes('drawImage'), 'the low tier stopped drawing the cast');
  assert.ok(elements.canvas.width < backing, `the canvas is still backed at ${elements.canvas.width} device pixels`);
});

test('a tier that changes nothing repaints nothing, and one before the first draw is harmless', (t) => {
  const { stage, context } = mounted(t);
  stage.setTier({ dprCap: 1.5, shadows: false });
  assert.deepEqual(context.calls, [], 'a stage with nothing drawn yet painted a demotion');

  stage.draw(stageState(), book());
  const after = context.calls.length;
  stage.setTier({ dprCap: 1.5, shadows: false });
  assert.equal(context.calls.length, after, 'the same tier was applied twice');
});

/** A stage whose frame is `width`x`height` CSS pixels. */
function mounted(t, { frame = [1920, 1080], dpr = 1 } = {}) {
  const dom = installDom();
  t.after(dom.restore);
  const original = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = dpr;
  t.after(() => { globalThis.devicePixelRatio = original; });
  const resizers = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { resizers.push(callback); }
    observe() {}
    disconnect() {}
  };
  const elements = fakeStageElements();
  elements.frame.getBoundingClientRect = () => ({ width: frame[0], height: frame[1] });
  const warnings = [];
  const stage = createCanvasStage(elements, { onWarning: (detail) => warnings.push(detail) });
  t.after(() => stage.destroy());
  return { elements, stage, warnings, context: elements.canvas.context, resize: () => resizers.forEach((run) => run()) };
}

test('the stage is the plate’s own pixels, backed at what the screen really shows', (t) => {
  const { elements, stage, context } = mounted(t, { frame: [960, 540], dpr: 2 });
  stage.draw(stageState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }] }), book());

  // 1920x1080 of logical stage, letterboxed by half into a 960x540 frame, on a
  // 2x display: 1920 device pixels across. Backing it at the CSS size would be
  // the soft picture the whole rendition ladder exists to avoid; backing it at
  // the raw 1920*2 would be four times the fill rate for pixels off the screen.
  assert.equal(elements.stage.style.width, '1920px');
  assert.equal(elements.stage.style['--fit-scale'], '0.5');
  assert.deepEqual([elements.canvas.width, elements.canvas.height], [1920, 1080]);
  assert.equal(context.of('setTransform').length, 2);
});

test('the device pixel ratio is capped where the sheet ladder stops', (t) => {
  // A 3x phone asks for three times the pixels of a 1x laptop and the ladder
  // stops at 512, so past 2 the extra pixels have nothing sharper to carry.
  // The cap has to be the SAME number the rendition picker uses, or the canvas
  // is backed for a tier that was never downloaded.
  const { elements, stage } = mounted(t, { frame: [1920, 1080], dpr: 3 });
  stage.draw(stageState(), book());
  assert.deepEqual([elements.canvas.width, elements.canvas.height], [3840, 2160]);
});

test('the backing store is written only when it really moved', (t) => {
  const { elements, stage } = mounted(t, { frame: [1920, 1080] });
  stage.draw(stageState(), book());
  const afterFirst = elements.canvas.sizes.length;
  stage.draw(stageState(), book());
  stage.draw(stageState(), book());
  // Assigning `canvas.width` clears the canvas even when the value is
  // unchanged: writing it every frame throws the frame away and draws it again.
  assert.equal(elements.canvas.sizes.length, afterFirst);
});

test('the camera, the letterbox and the density arrive as one transform', (t) => {
  const { stage, context } = mounted(t, { frame: [960, 540], dpr: 2 });
  stage.draw(stageState({ camera: { scale: 1.55, x: -20, y: -10 } }), book());

  // fit 0.5 x dpr 2 = 1, so the numbers here are the camera's alone: a plate
  // point p lands at 1.55p + (-20% of 1920, -10% of 1080).
  const [, aimed] = context.of('setTransform');
  assert.deepEqual(aimed, [1.55, 0, 0, 1.55, -384, -108]);
});

test('a sprite is cut from the sheet that decoded, in the proportions of its grid', (t) => {
  const { stage, context } = mounted(t);
  const sheet = bitmap(900, 900);
  stage.draw(
    stageState({ actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly', frame: 7 }] }),
    book({ url: 'owl.webp', grid: [3, 3], drawables: { 'owl.webp': sheet } }),
  );

  const [drawn] = context.of('drawImage');
  // Frame 7 of a 3x3 is column 1, row 2 — and the source rectangle is read off
  // the bitmap, so a sheet served at a size nobody expected draws the right
  // cell smaller rather than a slice of two wrong ones.
  assert.deepEqual(drawn.slice(0, 9), [sheet, 300, 600, 300, 300, 860, 772, 200, 200]);
});

test('the shadow gives the canvas back exactly as it found it', (t) => {
  // The shadow is the one command that moves the context under itself:
  // `save`, `translate` onto the feet, `scale` flat, draw, `restore`. Losing
  // that `restore` puts every later command on the first actor's feet, squashed
  // — the whole cast off the stage — while every `drawImage` argument in the
  // log stays exactly right. Only the transform in force can see it.
  const { stage, context } = mounted(t, { frame: [960, 540], dpr: 2 });
  stage.draw(
    stageState({
      actors: [
        { slug: 'ruby', x: 30, feetY: 90, heightPx: 200, clip: 'idle' },
        { slug: 'owl', x: 70, feetY: 90, heightPx: 200, clip: 'idle' },
      ],
      camera: { scale: 1.55, x: -20, y: -10 },
    }),
    book({ drawables: { 'ruby.webp': bitmap(512, 512) } }),
  );

  const camera = [1.55, 1.55, -384, -108];
  for (const call of context.of('drawImage')) assert.deepEqual(call.at(-1).transform, camera);
  assert.deepEqual(context.matrix(), camera, 'a shadow left the context moved');
  assert.equal(context.depth(), 0, 'a save was never restored');
});

test('a sheet that has not decoded yet draws the placeholder, never a hole', (t) => {
  const { stage, context } = mounted(t);
  stage.draw(
    stageState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }] }),
    book({ drawables: {} }),
  );
  assert.deepEqual(context.of('drawImage'), []);
  // The lozenge `.sprite.is-missing` used to paint, in the character's own box.
  const [placeholder] = context.of('ellipse').filter(([, , rx]) => rx === 100);
  assert.deepEqual(placeholder.slice(0, 4), [960, 872, 100, 100]);
});

test('a rendition that is not square is cut along its own two axes', (t) => {
  // `renditionGrid` reflows a one-row strip into `ceil(sqrt(frames))` columns,
  // so every frame count that is not a perfect square lands on a rectangular
  // grid — 20 frames is 5x4. A cell measured off the wrong axis slides every
  // frame across two neighbouring cells and errors nowhere; a 3x3 on a square
  // sheet cannot tell the two apart, because there both answers are equal.
  const { stage, context } = mounted(t);
  const sheet = bitmap(1600, 1280);
  stage.draw(
    stageState({ actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly', frame: 7 }] }),
    book({ url: 'owl.webp', grid: [5, 4], drawables: { 'owl.webp': sheet } }),
  );

  // Frame 7 of a 5x4 is column 2, row 1, and the cells are 320x320.
  assert.deepEqual(context.of('drawImage')[0].slice(0, 5), [sheet, 640, 320, 320, 320]);
});

test('a drawable that measures in naturalWidth is measured, not replaced', (t) => {
  // The `Image` the decode fallback returns on old iOS Safari. Preferring
  // `naturalWidth`/`naturalHeight` is what keeps those devices — the ones the
  // fallback exists for — from drawing a placeholder for every character.
  const { stage, context } = mounted(t);
  const image = { naturalWidth: 900, naturalHeight: 900 };
  stage.draw(
    stageState({ actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly', frame: 7 }] }),
    book({ url: 'owl.webp', grid: [3, 3], drawables: { 'owl.webp': image } }),
  );
  assert.deepEqual(context.of('drawImage')[0].slice(0, 5), [image, 300, 600, 300, 300]);
});

test('a sheet that decoded to nothing is a placeholder, not a throw', (t) => {
  // `drawImage` with a zero-width source rectangle throws, and a throw here
  // takes the whole frame rather than one sprite.
  const { stage, context } = mounted(t);
  stage.draw(
    stageState({ actors: [{ slug: 'owl', x: 50, feetY: 90, heightPx: 200, clip: 'fly' }] }),
    book({ url: 'owl.webp', grid: [3, 3], drawables: { 'owl.webp': bitmap(0, 0) } }),
  );
  assert.deepEqual(context.of('drawImage'), []);
  assert.equal(context.of('ellipse').length, 1);
});

test('a prop taller than it is wide is centred over its own x', (t) => {
  // The other half of the fit: a lantern, a trunk, a door is height-limited, so
  // the centring term is the only thing standing between it and the left edge
  // of its box — half a box width off the stand line it was given.
  const { stage, context } = mounted(t);
  const tall = bitmap(100, 200);
  stage.draw(
    stageState({ actors: [{ slug: 'lantern', kind: 'object', x: 50, feetY: 100, heightPx: 300, clip: null }] }),
    { ...book(), drawable: () => tall },
  );
  assert.deepEqual(context.of('drawImage')[0].slice(0, 5), [tall, 885, 780, 150, 300]);
});

test('a prop that measures nothing fills its box instead of vanishing', (t) => {
  // An SVG carrying only a `viewBox` decodes to an intrinsic size of zero — the
  // bitmap cache says so itself — and props are SVGs. It fetched, it decoded,
  // so nothing upstream has anything to report: drawing the placeholder here
  // would leave a permanent glowing blob where a lantern is, with a clean log.
  // CSS `background-size: contain` scaled exactly these files against the box,
  // which is why they looked right on the DOM stage.
  const { stage, context } = mounted(t);
  const shapeless = { width: 0, height: 0 };
  stage.draw(
    stageState({ actors: [{ slug: 'lantern', kind: 'object', x: 50, feetY: 100, heightPx: 300, clip: null }] }),
    { ...book(), drawable: () => shapeless },
  );

  assert.deepEqual(context.of('drawImage')[0].slice(0, 5), [shapeless, 810, 780, 300, 300]);
  assert.deepEqual(context.of('ellipse'), []);
});

test('a prop is fitted whole into its box and stood on its own feet', (t) => {
  const { stage, context } = mounted(t);
  stage.draw(
    stageState({ actors: [{ slug: 'lantern', kind: 'object', x: 50, feetY: 100, heightPx: 300, clip: null }] }),
    { ...book(), drawable: () => bitmap(200, 100) },
  );

  // A 2:1 prop in a 300 box is drawn 300x150 — and its bottom sits on the
  // stand line, not 150 px above it, which is where the DOM stage's
  // `background-position: 0 0` left it hanging.
  const [drawn] = context.of('drawImage');
  assert.deepEqual(drawn.slice(0, 5), [drawn[0], 810, 930, 300, 150]);
});

test('a resize repaints the instant already on screen', (t) => {
  // The story may be paused, or over, or still at its begin gate: in all three
  // nothing is going to ask for another frame, and a canvas resized to new
  // dimensions comes back blank.
  const { stage, context, resize, elements } = mounted(t, { frame: [1920, 1080] });
  stage.draw(
    stageState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }] }),
    book({ drawables: { 'ruby.webp': bitmap(512, 512) } }),
  );
  const drawnOnce = context.of('drawImage').length;
  elements.frame.getBoundingClientRect = () => ({ width: 960, height: 540 });

  resize();

  assert.equal(elements.canvas.width, 960, 'the backing store did not follow the frame');
  assert.equal(context.of('drawImage').length, drawnOnce + 1, 'the resized canvas was left blank');
});

test('a browser with no 2D context says so once and then draws nothing', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const elements = fakeStageElements();
  elements.canvas = fakeElement('div'); // no getContext at all
  const warnings = [];
  const stage = createCanvasStage(elements, { onWarning: (detail) => warnings.push(detail) });

  assert.equal(stage.draw(stageState(), book()), null);
  assert.equal(stage.draw(stageState(), book()), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /this browser gave no 2D canvas context/);
  assert.equal(typeof stage.fitScale(), 'number');
  stage.destroy();
});

test('a stage built with no canvas at all blames the wiring, not the browser', (t) => {
  // Two different stories: a device that cannot give a 2D context, and this
  // repo assembling its own element bag wrong. Blaming the browser for the
  // second sends somebody hunting a phone that does not exist.
  const dom = installDom();
  t.after(dom.restore);
  const elements = { ...fakeStageElements(), canvas: null };
  const warnings = [];
  const stage = createCanvasStage(elements, { onWarning: (detail) => warnings.push(detail) });
  assert.match(warnings[0].message, /built without a canvas element/);
  stage.destroy();
});

test('a stage measured before it has been laid out guesses 1:1, not zero', () => {
  // 0 would ask the rendition ladder for its smallest sheet for the whole
  // story, and nothing would ever ask again.
  const context = fakeContext();
  const canvas = fakeElement('canvas');
  canvas.getContext = () => context;
  const elements = { ...fakeStageElements(), canvas };
  elements.frame.getBoundingClientRect = () => ({ width: 0, height: 0 });
  const stage = createCanvasStage(elements);

  assert.equal(stage.fitScale(), 1);
  // The same number reaches the stylesheet. `--fit-scale: 0` is not a small
  // stage, it is `transform: scale(0)` — the picture, the plate and the canvas
  // all scaled out of existence while the ladder is told the stage is full size.
  assert.equal(elements.stage.style['--fit-scale'], '1');
  stage.destroy();
});

test('destroy wipes the canvas, and drawing after it is a no-op rather than a throw', (t) => {
  const { stage, context } = mounted(t);
  stage.draw(
    stageState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }] }),
    book({ drawables: { 'ruby.webp': bitmap(512, 512) } }),
  );
  const drawnFrames = context.of('clearRect').length;

  stage.destroy();

  // The last frame must not be left on screen behind a destroyed player: the
  // host element survives a `destroy()` and can be mounted again.
  assert.equal(context.of('clearRect').length, drawnFrames + 1);
  const after = context.calls.length;
  assert.equal(stage.draw(stageState(), book()), null);
  assert.equal(context.calls.length, after);
});

/**
 * Two facts this stage rests on live in the stylesheet, not in any module, and
 * the browser check that would catch them is dev-harness gated — it never runs
 * in CI. Read as text, the way `subtitle-overlay.test.mjs` reads its own rules.
 */
function ruleFor(css, selector) {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies = [];
  // Every rule that names it, not the first: this stage's box is declared in a
  // shared `position: absolute; inset: 0` rule and its size in a rule of its
  // own, and stopping at the first one would read half the answer.
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.split(',').some((one) => one.trim() === selector)) bodies.push(body);
  }
  return bodies.length ? bodies.join(';') : null;
}

const stylesheet = () => fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8');

test('the canvas is stretched to the logical stage by the stylesheet', () => {
  // A canvas is a REPLACED element: `inset: 0` alone leaves it at its intrinsic
  // 300x150 and the browser stretches that little picture over the box. The
  // whole cast would be drawn into a corner and blown up.
  const rule = ruleFor(stylesheet(), '.stage-canvas');
  assert.ok(rule, 'no .stage-canvas rule in styles.css — this reader is stale, not the stylesheet');
  assert.match(rule, /width:\s*100%/);
  assert.match(rule, /height:\s*100%/);
});

test('nothing on the stage filters', () => {
  // A `filter` or a `backdrop-filter` on a stage element is a full-frame blur
  // over a playing video and a canvas, on every paint. The DOM stage carried
  // one per sprite and one over the whole picture at the start and the end;
  // both are what this rewrite is for.
  const css = stylesheet().replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders = [];
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = selectors.trim();
    const onStage = /\.(stage|plate|logical-stage|sprite|start-ceremony|end-overlay)/.test(selector);
    if (onStage && /(^|[\s;])(-webkit-)?(backdrop-)?filter\s*:/.test(body)) {
      offenders.push(`${selector} { ${body.trim()} }`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the sheet book answers per clip, per prop, and per decoded url', () => {
  const plan = {
    sheets: [
      { slug: 'ruby', clip: 'idle_right', url: 'ruby-idle.webp', grid: [5, 5], tier: 320 },
      { slug: 'ruby', clip: 'walk_left', url: 'ruby-walk.webp', grid: [9, 9], tier: 320 },
    ],
    props: [{ slug: 'lantern', url: 'lantern.svg' }],
  };
  const decoded = { 'ruby-walk.webp': bitmap(2880, 2880) };
  const sheets = sceneSheets(plan, { get: (url) => decoded[url] ?? null });

  assert.deepEqual(sheets.sheet('ruby', 'walk_left'), { url: 'ruby-walk.webp', grid: [9, 9] });
  assert.equal(sheets.sheet('ruby', 'sleep'), null);
  assert.equal(sheets.sheet('bramble', 'idle_right'), null);
  assert.deepEqual(sheets.prop('lantern'), { url: 'lantern.svg' });
  assert.equal(sheets.prop('stump'), null);
  assert.equal(sheets.drawable('ruby-walk.webp'), decoded['ruby-walk.webp']);
  assert.equal(sheets.drawable('ruby-idle.webp'), null);
});

test('the painter clears the frame before it draws the next one', () => {
  const context = fakeContext();
  const list = buildDrawList(
    stageState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }] }),
    book(),
  );
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 0.5 });

  assert.deepEqual(context.names().slice(0, 3), ['setTransform', 'clearRect', 'setTransform']);
  // Cleared in device pixels, with the identity transform in force — clearing
  // under the camera's own transform leaves the part of the previous frame the
  // camera has since moved off.
  assert.deepEqual(context.of('clearRect')[0], [0, 0, 960, 540]);
  // Both halves: a context with smoothing off draws a sprite scaled from its
  // tier with hard nearest-neighbour edges.
  assert.equal(context.imageSmoothingEnabled, true);
  assert.equal(context.imageSmoothingQuality, 'high');
});

test('the painter draws each figure at its own opacity and leaves none behind', () => {
  const context = fakeContext();
  const list = buildDrawList(
    stageState({
      actors: [
        { slug: 'ruby', x: 30, feetY: 90, heightPx: 200, clip: 'idle', opacity: 0.25 },
        { slug: 'owl', x: 70, feetY: 90, heightPx: 200, clip: 'idle' },
      ],
    }),
    book(),
  );
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1 });

  assert.deepEqual(context.of('drawImage').map((call) => call.at(-1).alpha), [0.25, 1]);
  // A globalAlpha left at a departing character's fade would dim everything
  // drawn after them, including the next frame's first command.
  assert.equal(context.globalAlpha, 1);
});
