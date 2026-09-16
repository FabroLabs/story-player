import assert from 'node:assert/strict';
import test from 'node:test';
import { normaliseCardBoard } from '../browser/v0/core/card-board.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { createCanvasStage, paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { sceneAssetPlan, planAssets } from '../browser/v0/app/assets/scene-loader.mjs';
import { signatureOf } from '../browser/v0/app/timeline-player.mjs';
import { fakeContext, fakeStageElements } from './_dom.mjs';

const plate = { resolution: [1920, 1080], poster: 'assets/farm.svg', video: 'assets/farm.mp4', zones: [] };
const cards = ['farm_cow', 'farm_sheep', 'farm_duck'];
const sheets = { prop: (slug) => ({ url: `assets/${slug}.svg` }), sheet: () => null };
const board = (items, focus = null) => ({ kind: 'cmd', cmd: 'board', cards: items, focus, prompt: 'Meet the animals', subjects: [], line: 2 });
const put = (slug) => ({ kind: 'cmd', cmd: 'put', subjects: [slug], objects: [slug], position: 'left_third', line: 3 });
const pause = (seconds) => ({ kind: 'cmd', cmd: 'pause', seconds, line: 4 });
const bundleOf = (steps) => ({ storylang_version: 0, title: 'Farm board', cast: {}, audio: { bgm: {}, sfx: {} },
  objects: Object.fromEntries([...cards, 'farm_board_lift', 'farm_board_lower'].map((slug) => [slug, { svg: `assets/${slug}.svg`, height_cm: 35 }])),
  scenes: [{ place: 'farm', plate, steps }] });
const state = (items, tMs = 0, actors = []) => ({ plate, actors, tMs, slate: { mode: 'cards', cards: items, focus: null, prompt: 'Meet the animals', standing: true, sinceMs: 0 } });
const animal = { slug: 'farm_cow', kind: 'object', x: 25, feetY: 60, heightPx: 260, opacity: 1 };
const draw = (items, tMs = 0, actors = []) => buildDrawList(state(items, tMs, actors), sheets);
const slateOf = (list) => list.commands.find((command) => command.op === 'slate');

test('farm lift and lower keep base card positions and translate vertically for exactly1200ms', () => {
  for (const name of ['farm_board_lift', 'farm_board_lower']) for (let count = 1; count <= 3; count += 1) {
    const base = cards.slice(0, count);
    const ordinary = slateOf(draw(base));
    const start = slateOf(draw([...base, name], 0));
    const mid = slateOf(draw([...base, name], 600));
    const end = slateOf(draw([...base, name], 1200));
    assert.equal(mid?.farm?.name, name, 'the marker must select the native farm transition');
    assert.deepEqual(start.cards, ordinary.cards);
    assert.deepEqual(mid.cards, ordinary.cards);
    assert.deepEqual(end.cards, ordinary.cards);
    assert.equal(start.farm.dy, name === 'farm_board_lift' ? 0 : -1080);
    assert.equal(mid.farm.dy, -540);
    assert.equal(end.farm.dy, name === 'farm_board_lift' ? -1080 : 0);
    assert.deepEqual(end, slateOf(draw([...base, name], 10000)), 'raised endpoint must persist while exploring');
    assert.equal(mid.transition, undefined, 'farm boards must not use ocean fade or bubbles');
  }
});

test('placed cutouts and their highlights render below the moving board with no guide requirement', () => {
  const bundle = bundleOf([put('farm_cow'), board(['farm_cow', 'farm_board_lift']), pause(1.2),
    { kind: 'cmd', cmd: 'highlight', subjects: ['farm_cow'], line: 5 }, pause(2)]);
  const timeline = compileTimeline(bundle);
  const frame = buildDrawList(stateAt(timeline, bundle, 1300), sheets);
  const propIndex = frame.commands.findIndex((row) => row.op === 'prop' && row.slug === 'farm_cow');
  const boardIndex = frame.commands.findIndex((row) => row.op === 'slate');
  assert.ok(propIndex >= 0 && propIndex < boardIndex, 'the same native cutout must exist beneath the raised board');
  assert.ok(frame.commands.some((row) => row.op === 'ring' && !row.hud), 'habitat highlight must remain in scene space');
  assert.equal(frame.commands.filter((row) => row.slug === 'farm_cow' && row.op === 'prop').length, 1);
});

test('an optional guide appears exactly once and keeps its native corner while farm props are exposed', () => {
  const guide = { slug: 'bibo', kind: 'character', x: 50, feetY: 60, heightPx: 260, opacity: 1, clip: null };
  for (const name of ['farm_board_lift', 'farm_board_lower']) for (const instant of [0, 600, 1200, 4000]) {
    const frame = draw(['farm_cow', name], instant, [animal, guide]);
    const guides = frame.commands.filter((row) => row.slug === 'bibo' && ['sprite', 'missing'].includes(row.op));
    assert.equal(guides.length, 1);
    assert.equal(guides[0].hud, true);
    assert.equal(frame.commands.filter((row) => row.op === 'prop' && row.slug === 'farm_cow').length, 1);
  }
});

test('farm movement never fades cutout artwork or translates the habitat layer', () => {
  const art = { width: 512, height: 512 };
  const plain = fakeContext();
  paintDrawList(plain, draw(['farm_cow'], 0), { lookup: () => art });
  const context = fakeContext();
  paintDrawList(context, draw(['farm_cow', 'farm_board_lift'], 600, [animal]), { lookup: () => art });
  const images = context.of('drawImage');
  assert.equal(images.length, 2, 'one scene prop plus one image on the moving board');
  assert.ok(images.every((row) => row.at(-1).alpha === 1));
  assert.deepEqual(images[0].at(-1).transform, [1, 1, 0, 0]);
  assert.deepEqual(images[1].at(-1).transform, [1, 1, 0, -540]);
  assert.deepEqual(context.matrix(), [1, 1, 0, 0]);
  assert.equal(context.globalAlpha, 1);
});

test('farm markers reject missing bases, nested or misplaced controls and marker focus', () => {
  for (const items of [['farm_board_lift'], ['farm_board_lift', 'farm_cow'], ['farm_cow', 'farm_board_wrong'],
    ['farm_cow', 'farm_board_lift', 'farm_board_lower'], ['farm_cow', 'ocean_zone_out', 'farm_board_lift'],
    ['farm_cow', 'farm_sheep', 'farm_duck', 'fourth', 'farm_board_lift']]) {
    assert.equal(normaliseCardBoard({ cards: items }), null, items.join(' '));
  }
  assert.equal(normaliseCardBoard({ cards: ['farm_cow', 'farm_board_lift'], focus: 2 }), null);
});

test('raised holds, lower-to-plain and reverse seeking all use only the authored story clock', () => {
  const base = ['farm_cow'];
  const bundle = bundleOf([put('farm_cow'), board([...base, 'farm_board_lift']), pause(4),
    board([...base, 'farm_board_lower']), pause(1.2), board(base), pause(1)]);
  const timeline = compileTimeline(bundle);
  assert.equal(timeline.events.filter((row) => row.kind === 'warning').length, 0);
  const cursor = createStateCursor(timeline, bundle);
  for (const instant of [0, 600, 1200, 3999, 4000, 4600, 5200, 6000, 600, 4600, 1200]) {
    assert.deepEqual(cursor.at(instant), stateAt(timeline, bundle, instant));
    assert.deepEqual(buildDrawList(cursor.at(instant), sheets), buildDrawList(stateAt(timeline, bundle, instant), sheets));
  }
  assert.equal(stateAt(timeline, bundle, 5200).slate.sinceMs, 4000, 'dropping lower must not reset the same board');
  const moving = [...base, 'farm_board_lift'];
  assert.notEqual(signatureOf(state(moving, 0)), signatureOf(state(moving, 600)));
  assert.notEqual(signatureOf(state(moving, 600)), signatureOf(state(moving, 1200)));
  assert.equal(signatureOf(state(moving, 1200)), signatureOf(state(moving, 5000)));
});

test('paused resize redraws the same lift progress in both directions without a frame snapshot', () => {
  const previousObserver = globalThis.ResizeObserver;
  let resized;
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe() {} disconnect() {} };
  const elements = fakeStageElements();
  let viewport = { width: 340, height: 191 };
  elements.frame.getBoundingClientRect = () => viewport;
  const art = { width: 512, height: 512 };
  const decoded = { ...sheets, drawable: () => art };
  const frameState = state(['farm_cow', 'farm_board_lift'], 600, [animal]);
  const stage = createCanvasStage(elements, { dprCap: 1 });
  try {
    const initial = stage.draw(frameState, decoded);
    assert.equal(slateOf(initial)?.farm?.dy, -540);
    for (const view of [{ width: 960, height: 540 }, { width: 340, height: 191 }]) {
      viewport = view;
      elements.canvas.context.calls.length = 0;
      resized();
      const expected = fakeContext();
      paintDrawList(expected, buildDrawList(frameState, decoded, view), { lookup: () => art, scale: Math.min(view.width / 1920, view.height / 1080) });
      assert.deepEqual(elements.canvas.context.of('drawImage'), expected.of('drawImage'));
    }
  } finally {
    stage.destroy();
    if (previousObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousObserver;
  }
});

test('farm board and scene cutouts share declared required native media dependencies', () => {
  const bundle = bundleOf([put('farm_cow'), board(['farm_cow', 'farm_board_lift']), pause(2)]);
  const timeline = compileTimeline(bundle);
  const assets = planAssets(sceneAssetPlan(timeline, bundle, 0));
  for (const slug of ['farm_cow', 'farm_board_lift']) assert.ok(assets.some((asset) => asset.slug === slug && asset.required));
  const cow = assets.filter((asset) => asset.slug === 'farm_cow');
  assert.ok(cow.every((asset) => asset.url === 'assets/farm_cow.svg'));
});
