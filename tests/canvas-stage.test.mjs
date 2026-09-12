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
import { SLATE } from '../browser/v0/policy.mjs';
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
  // A stage built without a tier keeps shadows on, and this is the only place
  // left that paints one: no tier asks for shadows any more (`capability.mjs`),
  // so this assertion is what still pins `paintShadow` working at all.
  assert.ok(context.of('createRadialGradient').length > 0, 'a stage with shadows on drew none');

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
function mounted(t, { frame = [1920, 1080], dpr = 1, now = () => 0 } = {}) {
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
  const stage = createCanvasStage(elements, { onWarning: (detail) => warnings.push(detail), now });
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

test('a sheet that has not decoded yet is a breath of nothing, then the placeholder', (t) => {
  // A decode that lands on the next frame should never have been announced with
  // a blob: at twenty-four frames a second a viewer sees the lozenge flash and
  // reads it as a fault. Only a character that stays missing gets one.
  let clock = 0;
  const { stage, context } = mounted(t, { now: () => clock });
  const paint = () => stage.draw(
    stageState({ actors: [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }] }),
    book({ drawables: {} }),
  );
  const lozenge = () => context.of('ellipse').filter(([, , rx]) => rx === 100);

  paint();
  assert.deepEqual(context.of('drawImage'), []);
  assert.deepEqual(lozenge(), [], 'a blob for a sheet that may be there next frame');

  // Frames keep coming while the decode is in flight; none of them announces it.
  clock = 100;
  paint();
  assert.deepEqual(lozenge(), [], 'the placeholder was painted before the grace was over');

  clock = 200;
  paint();
  // The lozenge `.sprite.is-missing` used to paint, in the character's own box.
  assert.deepEqual(lozenge().at(0).slice(0, 4), [960, 872, 100, 100]);
});

test('a character whose sheet went away keeps its last drawing', (t) => {
  // The bitmap cache closes a sheet when it evicts it, so nothing can hold the
  // decoded pixels — the stage keeps a thumbnail of the cell it last drew and
  // stands that in. A wrong pose is a character; a lozenge is a fault.
  const { stage, context } = mounted(t);
  const actors = [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }];
  stage.draw(stageState({ actors }), book({ drawables: { 'ruby.webp': bitmap(64, 64) } }));

  const from = context.calls.length;
  stage.draw(stageState({ actors }), book({ drawables: {} }));
  const since = context.calls.slice(from);

  const drawn = since.filter(([name]) => name === 'drawImage');
  assert.equal(drawn.length, 1, 'the character was not stood in for');
  assert.deepEqual(drawn[0].slice(2, 6), [860, 772, 200, 200], 'the stand-in was drawn somewhere other than the box');
  assert.deepEqual(
    since.filter(([name]) => name === 'createLinearGradient'),
    [],
    'the placeholder was painted over a character we still had a picture of',
  );
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

test('a resize repaints through the stand-in, not over it', (t) => {
  // Now the renditions are cut up, a cell that is not decoded at this instant is
  // ordinary — every chunk boundary is one. A repaint that goes around the
  // stand-in puts the missing lozenge where a character was for as long as the
  // next chunk takes to arrive, and a phone turned mid-swap is exactly that.
  const { stage, context, resize, elements } = mounted(t, { frame: [1920, 1080] });
  const actors = [{ slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle' }];
  stage.draw(stageState({ actors }), book({ drawables: { 'ruby.webp': bitmap(512, 512) } }));
  stage.draw(stageState({ actors }), book({ drawables: {} }));

  const from = context.calls.length;
  elements.frame.getBoundingClientRect = () => ({ width: 960, height: 540 });
  resize();
  const since = context.calls.slice(from);

  assert.equal(since.filter(([name]) => name === 'drawImage').length, 1, 'the character was not stood in for');
  assert.deepEqual(
    since.filter(([name]) => name === 'createLinearGradient'),
    [],
    'the resize painted the placeholder over a character we still had a picture of',
  );
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

test('nothing on the stage filters, and the plate only eases the one it is given', () => {
  // A `filter` or a `backdrop-filter` on a stage element is a full-frame blur
  // over a playing video and a canvas, on every paint. The DOM stage carried
  // one per sprite and one over the whole picture at the start and the end;
  // both are what this rewrite is for.
  //
  // The counting board's frost is the one carve-out, and it is NOT in here: it
  // is written onto the plate from JS (`video-plate.mjs::frost`) twice in a
  // lesson, not stood up in the stylesheet for the whole story. What the
  // stylesheet owns is how it eases — `filter` by name, never `all`, because
  // the camera reaches the same element on the story's clock and a transition
  // over THAT slides the ground under a frozen cast.
  const plate = ruleFor(stylesheet(), '.plate-layer');
  assert.ok(plate, 'no .plate-layer rule in styles.css — this reader is stale');
  assert.match(plate, /transition:\s*filter\s+var\(--frost-ms/);
  assert.doesNotMatch(plate, /transition:\s*all/);

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

  assert.deepEqual(
    sheets.sheet('ruby', 'walk_left', 17),
    { url: 'ruby-walk.webp', grid: [9, 9], chunkStart: 0 },
    'a clip with no chunk ladder is one sheet at every frame, as it always was',
  );
  assert.equal(sheets.sheet('ruby', 'sleep', 0), null);
  assert.equal(sheets.sheet('bramble', 'idle_right', 0), null);
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

// --- the lesson's two overlays ---------------------------------------------

function lessonList({
  camera, slate, highlightMs, tMs = 0, opacity = 1,
} = {}) {
  return buildDrawList({
    ...stageState({
      actors: [{
        slug: 'ruby', x: 50, feetY: 90, heightPx: 200, clip: 'idle', highlightMs, opacity,
      }],
      camera,
    }),
    slate,
    tMs,
  }, book());
}

const counting = (count, sinceMs = 0) => ({
  count, mode: 'count', groups: [count], sinceMs, from: 0,
});
const joining = (left, right) => ({
  count: left + right, mode: 'add', groups: [left, right], sinceMs: 0, from: 0,
});
const taking = (left, right) => ({
  count: left - right, mode: 'subtract', groups: [left, right], sinceMs: 0, from: 0,
});
const boardOf = (list) => list.commands.find((command) => command.op === 'slate');
// Every ellipse the painter drew, as [cx, cy, rx].
const ovals = (context) => context.of('ellipse').map((call) => call.slice(0, 3));

test('the board is painted outside the camera, and the picture is handed back under it', () => {
  const context = fakeContext();
  const list = lessonList({ camera: { scale: 2, x: -25, y: -25 }, slate: counting(2), tMs: 4_000 });
  // Half a letterbox: the board drops the CAMERA and keeps the viewport, and at
  // scale 1 those two are indistinguishable — which is every device but this
  // harness, where a board painted in raw plate pixels is a postage stamp or a
  // board off the top of the frame.
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 0.5 });

  // A push-in doubles what is under it; the board — and the companion kept in
  // the corner OVER the board — are drawn at the viewport alone, at the plate
  // coordinates the list gave them.
  const numerals = context.of('fillText');
  assert.deepEqual(numerals.map((call) => call[0]), ['2', '2'], 'the badge and the equation');
  for (const call of numerals) assert.deepEqual(call.at(-1).transform, [0.5, 0.5, 0, 0]);
  assert.deepEqual(context.of('drawImage')[0].at(-1).transform, [0.5, 0.5, 0, 0], 'the companion');
  // And put back, so a second frame painted from the same list starts where the
  // first one did rather than one camera behind it.
  assert.deepEqual(context.matrix(), [1, 1, -240, -135]);
  assert.equal(context.depth(), 0);
});

test('the ring stays under the camera, because it is a mark on somebody', () => {
  const context = fakeContext();
  const list = lessonList({
    camera: { scale: 2, x: -25, y: -25 },
    highlightMs: 0,
    tMs: 400,
  });
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1 });

  // The transform in force when the ring was stroked, which is the whole claim:
  // asserting the ellipse's own arguments would pass under any transform at
  // all, because those are plate coordinates either way.
  assert.deepEqual(context.of('stroke')[0].at(-1).transform, [2, 2, -480, -270]);
  assert.deepEqual(context.of('ellipse')[0].slice(0, 2), [list.commands[1].dx + 100, list.commands[1].dy + 100]);
});

test('the counters stand on the panel, each on a pad of its own', () => {
  const context = fakeContext();
  const list = lessonList({ slate: counting(2), tMs: 4_000 });
  const board = boardOf(list);
  // Shadows off so every mark in the log belongs to the board.
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  // The panel is drawn first, and its rounded path starts a corner radius in
  // from its own left edge — without it the counters sit unbacked over a bright
  // plate.
  assert.deepEqual(context.of('moveTo')[0], [board.panel.x + board.panel.r, board.panel.y]);
  // Then a pad under each counter, centred on the place the list named, and
  // wider than the apple standing on it.
  const drawn = ovals(context);
  for (const counter of board.counters) {
    const pad = drawn.find(([cx, cy]) => cx === counter.cx && cy === counter.cy);
    assert.ok(pad, `nothing was drawn at counter ${counter.n}`);
    assert.ok(pad[2] > counter.r, 'the pad is smaller than the apple it holds');
  }
  // The badge's numeral, and the equation's, are the only text on the board.
  assert.deepEqual(context.of('fillText').map((call) => call[0]), ['2', '2']);
  assert.equal(context.textBaseline, 'middle');
});

test('the ring brightens twice across its life, and is out at both ends', () => {
  const ringAlpha = (tMs) => {
    const context = fakeContext();
    paintDrawList(context, lessonList({ highlightMs: 0, tMs }), { lookup: () => bitmap(512, 512), scale: 1 });
    const [ring] = context.of('stroke');
    return ring === undefined ? null : Math.round(ring.at(-1).alpha * 1000) / 1000;
  };

  // Two pulses across 1.5 s: brightest a quarter and three quarters through,
  // out at the start and between them. `null` is the ring being gone entirely
  // rather than merely dark, which is the difference the last line asks about.
  assert.equal(ringAlpha(0), 0);
  assert.equal(ringAlpha(375), 1);
  assert.equal(ringAlpha(750), 0);
  assert.equal(ringAlpha(1_125), 1);
  assert.equal(ringAlpha(1_500), null, 'the ring outlived its own duration');
});

test('the ring fades with the subject it is marking', () => {
  const context = fakeContext();
  // A naming scene puts the thing down and rings it in the same instant, so the
  // ring's brightest moment lands while the character is still fading in. At
  // full strength over a quarter-visible fox it reads as a gold ellipse that
  // arrived on its own.
  paintDrawList(context, lessonList({ highlightMs: 0, tMs: 375, opacity: 0.25 }), {
    lookup: () => bitmap(512, 512), scale: 1,
  });

  const [ring] = context.of('stroke');
  // 375 ms is the pulse's own peak (1), so what is left is the subject's.
  assert.equal(Math.round(ring.at(-1).alpha * 1000) / 1000, 0.25);
});

test('the newest counter grows about its own centre, and its pad grows with it', () => {
  const context = fakeContext();
  // Half way through the first pop, where the back-out curve is past full size:
  // a counter drawn from a corner or at a constant size looks identical at the
  // two instants pinned everywhere else, 0 and settled.
  const list = lessonList({ slate: counting(1), tMs: 175 });
  const [counter] = boardOf(list).counters;
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  assert.ok(counter.scale > 1, 'the sample instant is not mid-pop, where the counter overshoots');
  // Everything drawn about the counter's own centre: the gold ring outside it
  // and the pad under it. Both are the counter's radius TIMES the pop, so a
  // settled counter beside this one would not move as this one lands.
  const radii = ovals(context)
    .filter(([cx, cy]) => cx === counter.cx && cy === counter.cy)
    .map(([, , rx]) => Math.round(rx * 100) / 100);
  const grown = counter.r * counter.scale;
  // The pad is 96% of the CELL, whatever fraction of that cell the counter
  // itself is drawn at — so it is measured from the published radius rather
  // than from a second copy of it.
  const pad = grown * (0.96 / (2 * SLATE.counterRadius));
  assert.ok(radii.includes(Math.round(pad * 100) / 100), `the pad: ${radii}`);
  assert.ok(radii.includes(Math.round((grown + (counter.r * SLATE.ringGap)) * 100) / 100), `the ring: ${radii}`);
});

test('the gold ring is drawn over the pad, not under it', () => {
  // The pad is wider than the ring is — it is the counter's ground, the ring is
  // a mark on the counter — so a pad laid down afterwards buries the one thing
  // on the board that says where the count has got to. Z-order, not geometry:
  // both circles are at the same centre either way, and both are the right size
  // either way.
  const context = fakeContext();
  const list = lessonList({ slate: counting(1), tMs: 4_000 });
  const [counter] = boardOf(list).counters;
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  const marks = context.calls.filter(([name]) => name === 'ellipse' || name === 'fill' || name === 'stroke');
  const padAt = marks.findIndex(([name, cx, cy, rx]) => name === 'ellipse'
    && cx === counter.cx && cy === counter.cy
    && Math.round(rx * 100) / 100 === Math.round(counter.r * (0.96 / (2 * SLATE.counterRadius)) * 100) / 100);
  // The gold one: the panel's own edge is stroked before any counter.
  const ringAt = marks.findIndex(([name, detail]) => name === 'stroke' && detail?.ink === `rgba(${'245, 197, 66'}, 1)`);

  assert.ok(padAt >= 0, 'the pad was not drawn');
  assert.ok(ringAt > padAt, 'the pad was drawn over the ring');
});

test('a counter being taken away is crossed out as it goes', () => {
  const context = fakeContext();
  // Mid-take: the first of the two taken counters is half gone.
  const list = lessonList({ slate: taking(5, 2), tMs: 1_350 + 225 });
  const board = boardOf(list);
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  const going = board.counters[3];
  assert.ok(going.cross > 0 && going.alpha < 1, 'the sample instant is not mid-take');
  // The X reaches further across the counter the further through the take it
  // is, and it is drawn at the alpha the counter is fading through — the mark
  // and the fade are one gesture rather than a mark and then a disappearance.
  const reach = going.r * going.scale * (0.55 + (0.45 * going.cross));
  const at = (value) => Math.round(value * 100) / 100;
  const drawnFrom = context.of('moveTo').map(([x, y]) => [at(x), at(y)]);
  assert.ok(drawnFrom.some(([x, y]) => x === at(going.cx - reach) && y === at(going.cy - reach)));
  assert.ok(drawnFrom.some(([x, y]) => x === at(going.cx - reach) && y === at(going.cy + reach)));
  assert.ok(context.of('stroke').some((call) => call.at(-1).alpha === going.alpha));
});

test('the weak tier still draws the lesson, shadows or no shadows', () => {
  const context = fakeContext();
  const list = lessonList({ slate: joining(1, 2), highlightMs: 3_900, tMs: 4_000 });
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  assert.equal(context.of('createRadialGradient').length, 0, 'the low tier painted a shadow');
  // The badge, then the whole equation.
  assert.deepEqual(context.of('fillText').map((call) => call[0]), ['3', '1', '+', '2', '=', '3']);
  // The panel's edge, a stem per apple, the gold ring on the newest counter and
  // the lesson's own highlight moved onto that counter: the lesson survives a
  // device too weak for a drop shadow, because it is what the story is for.
  assert.equal(context.of('stroke').length, 6);
});

test('a counter still at the very start of its pop is not drawn at all', () => {
  const context = fakeContext();
  const list = lessonList({ slate: counting(2), tMs: 0 });
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  // The panel is there — it is sized for where the counters will land, so the
  // board does not jump — and the counters wait until they have a size. So does
  // the badge: a running total over an empty board is a lesson insisting the
  // answer is zero while the first apple is still on its way in.
  assert.ok(context.of('fill').length > 0, 'the panel was not drawn');
  assert.deepEqual(ovals(context), []);
  assert.deepEqual(context.of('fillText'), []);
});

test('the addends are drawn in two colours, because that IS the lesson', () => {
  const context = fakeContext();
  const list = lessonList({ slate: joining(2, 3), tMs: 8_000 });
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });
  const inks = context.of('fill').map((call) => call.at(-1).ink);
  const count = (ink) => inks.filter((drawn) => drawn === ink).length;

  // Two reds and three greens make five, and a child sees the joining rather
  // than being told it. Two lobes to an apple, one pad under each.
  assert.equal(count('rgb(236, 92, 86)'), 4);
  assert.equal(count('rgb(96, 184, 120)'), 6);
  assert.equal(count('rgba(255, 186, 166, 0.8)'), 2);
  assert.equal(count('rgba(170, 226, 184, 0.8)'), 3);
  // The glass they stand on: a white panel and the brighter sheen along its top.
  assert.equal(count('rgba(255, 255, 255, 0.59)'), 1);
  assert.equal(count('rgba(255, 255, 255, 0.22)'), 1);
});

test('a plain count is one calm hue, because there is no difference to claim', () => {
  const context = fakeContext();
  paintDrawList(context, lessonList({ slate: counting(3), tMs: 8_000 }), {
    lookup: () => bitmap(512, 512), scale: 1, shadows: false,
  });
  const inks = context.of('fill').map((call) => call.at(-1).ink);

  assert.equal(inks.filter((ink) => ink === 'rgb(120, 150, 210)').length, 6);
  assert.equal(inks.filter((ink) => ink === 'rgba(226, 232, 240, 0.8)').length, 3);
  assert.equal(inks.filter((ink) => ink.startsWith('rgb(236')).length, 0, 'a group colour on a plain count');
});

test('the answer is green, the equals is red, and the badge is its own chip', () => {
  const context = fakeContext();
  const list = lessonList({ slate: joining(2, 3), tMs: 8_000 });
  const { badge } = boardOf(list);
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });
  const written = context.of('fillText').map((call) => [call[0], call[1], call[2], call.at(-1).ink]);

  assert.deepEqual(written.map(([text, , , ink]) => [text, ink]), [
    ['5', 'rgb(74, 58, 18)'],
    ['2', 'rgba(60, 70, 80, 1)'],
    ['+', 'rgba(60, 70, 80, 1)'],
    ['3', 'rgba(60, 70, 80, 1)'],
    ['=', 'rgba(236, 92, 86, 1)'],
    ['5', 'rgba(54, 150, 96, 1)'],
  ]);
  // The running total stands in the middle of its own chip, not beside it.
  assert.deepEqual(written[0].slice(1, 3), [badge.cx, badge.cy]);
  assert.ok(context.of('fill').some((call) => call.at(-1).ink === 'rgb(255, 213, 92)'), 'the chip');
});

test('the gold is the ring and the take-away is red, and neither is the other', () => {
  const context = fakeContext();
  const list = lessonList({ slate: taking(5, 2), tMs: 1_350 + 225 });
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });
  const inks = context.of('stroke').map((call) => call.at(-1).ink);

  assert.equal(inks.filter((ink) => ink === 'rgba(245, 197, 66, 1)').length, 1, 'one ringed counter');
  assert.equal(inks.filter((ink) => ink === 'rgb(228, 64, 60)').length, 1, 'one counter being taken');
});

test('anything the list marks hud is drawn with the camera left out, not just the board', () => {
  // The board is the reason the word exists, but the companion kept in the
  // corner over it is the next thing to carry it. The painter is asked about
  // the WORD rather than about the op, so a list carrying a hud figure lands it
  // at the viewport — and puts the camera back for whoever is drawn after.
  const context = fakeContext();
  const list = {
    width: 1920,
    height: 1080,
    camera: { scale: 2, x: -25, y: -25 },
    commands: [
      {
        op: 'prop', slug: 'corner', url: 'corner.svg', hud: true, dx: 100, dy: 100, dw: 200, dh: 200, opacity: 1,
      },
      {
        op: 'prop', slug: 'onstage', url: 'onstage.svg', dx: 100, dy: 100, dw: 200, dh: 200, opacity: 1,
      },
    ],
  };
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 0.5 });

  const [hud, onstage] = context.of('drawImage');
  assert.deepEqual(hud.at(-1).transform, [0.5, 0.5, 0, 0]);
  assert.deepEqual(onstage.at(-1).transform, [1, 1, -240, -135]);
  assert.equal(context.depth(), 0);
});

test('the equation is measured in the font the device has, and centred on the plate', () => {
  const context = fakeContext();
  const list = lessonList({ slate: joining(2, 3), tMs: 8_000 });
  const { equation } = boardOf(list);
  paintDrawList(context, list, { lookup: () => bitmap(512, 512), scale: 1, shadows: false });

  // Every token is measured before any of it is placed: the tokens carry no x,
  // because how wide a glyph is belongs to the font this device actually has.
  assert.deepEqual(context.of('measureText').map((call) => call[0]), ['2', '+', '3', '=', '5']);
  const written = context.of('fillText').filter((call) => call[0] !== '5' || call[1] > 0);
  const tokens = written.slice(1);
  assert.deepEqual(tokens.map((call) => call[0]), ['2', '+', '3', '=', '5']);
  // Centred: the line's own middle is the plate's middle, and it sits in the
  // band the list left for it.
  const left = tokens[0][1];
  const right = tokens.at(-1)[1] + (context.measureText('5').width);
  assert.ok(Math.abs(((left + right) / 2) - (list.width / 2)) < 1);
  for (const call of tokens) assert.equal(call[2], equation.y + (equation.h / 2));
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
