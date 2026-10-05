import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { createCanvasStage, paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext, fakeStageElements, installDom } from './_dom.mjs';
import { read } from './_parity.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { sceneAssetPlan, createSceneLoader } from '../browser/v0/app/assets/scene-loader.mjs';

const GUIDE = { layout: 'lesson-guide', guide: 'bibo' };
const sheets = { sheet: () => ({ url: 'assets/guide.webp', grid: [1, 1] }), prop: slug => ({ url: `assets/${slug}.svg` }) };
const actor = slug => ({ slug, kind: 'character', opacity: 1, heightPx: 200, clip: 'idle_camera', frame: 0 });
const lesson = (cards = ['a', 'b', 'c', 'd']) => ({
  plate: { resolution: [1920, 1080] }, camera: { scale: 1.4, x: 20, y: 5 }, tMs: 1000,
  actors: [actor('other'), actor('bibo')],
  slate: { mode: 'cards', cards, focus: 3, prompt: 'A B C D', standing: true, sinceMs: 0 },
});

test('a guide-only mount keeps its opt-in layout without requesting a counter picture', () => {
  const board = requireBoardBlock(GUIDE, 'https://storage.example/');
  assert.deepEqual(board, GUIDE);
  assert.ok(Object.isFrozen(board));
  assert.deepEqual(requireBoardBlock({ ...GUIDE, counter: 'assets/nut.png' }, 'https://storage.example/'), {
    ...GUIDE, counter: 'https://storage.example/assets/nut.png',
  });
});

test('malformed lesson-guide options are refused before rendering', () => {
  for (const board of [
    { layout: 'unknown', guide: 'bibo' }, { guide: 'bibo' }, { layout: 'lesson-guide' },
    { layout: 'lesson-guide', guide: '' }, { layout: 'lesson-guide', guide: 'two guides' },
    { layout: 'lesson-guide', guide: 7 },
  ]) assert.throws(() => requireBoardBlock(board, 'https://storage.example/'), /board.*layout|board.*guide/);
});

for (const viewport of [{ width: 1920, height: 1080 }, { width: 390, height: 219.375 }]) {
  for (const quantity of [1, 2, 3, 4]) {
    test(`${quantity} original teaching cards keep every field and clear the guide at ${viewport.width}px`, () => {
      const state = lesson(['a', 'b', 'c', 'd'].slice(0, quantity));
      state.slate.focus = 1;
      const normal = buildDrawList(state, sheets, viewport);
      const list = buildDrawList(state, sheets, viewport, GUIDE);
      const board = list.commands.find(command => command.op === 'slate');
      const guide = list.commands.find(command => command.op === 'sprite');
      assert.deepEqual(board, normal.commands.find(command => command.op === 'slate'),
        'selecting a guide must not alter the board, cards, prompt or their paint data');
      assert.equal(guide.slug, 'bibo', 'paint order must not choose a different narrator');
      assert.equal(guide.hud, true, 'camera motion must not move the guide');
      assert.deepEqual([guide.dx, guide.dy, guide.dw, guide.dh], [1555.2, 723.6, 345.6, 345.6]);
      assert.ok(guide.dx >= 0 && guide.dx + guide.dw <= 1920);
      assert.ok(guide.dy >= 0 && guide.dy + guide.dh <= 1080);
      for (const card of board.cards) assert.ok(card.dy + card.dh < guide.dy,
        'the full guide cell must fit below every original teaching tile');
      const later = buildDrawList({ ...state, tMs: 9000, camera: { scale: 2, x: 60, y: 20 } }, sheets, viewport, GUIDE);
      const otherFrame = later.commands.find(command => command.op === 'sprite');
      assert.deepEqual([otherFrame.dx, otherFrame.dy, otherFrame.dw, otherFrame.dh],
        [guide.dx, guide.dy, guide.dw, guide.dh], 'guide placement must not bob with time or camera');
    });
  }
}

test('the default card board still uses its full panel and first corner companion', () => {
  const list = buildDrawList(lesson(), sheets);
  const board = list.commands.find(command => command.op === 'slate');
  const guide = list.commands.find(command => command.op === 'sprite');
  assert.equal(board.layout, undefined);
  assert.deepEqual([board.panel.x, board.panel.w], [86.4, 1747.2]);
  assert.equal(new Set(board.cards.map(card => card.dy)).size, 1);
  assert.equal(guide.slug, 'other');
  assert.deepEqual([guide.dw, guide.dh], [291.6, 291.6]);
});

test('the lesson guide also owns the empty opening board, but cannot replace an absent guide', () => {
  const state = { ...lesson(), slate: { mode: 'count', count: 0, groups: [], standing: true } };
  const opening = buildDrawList(state, sheets, null, GUIDE);
  assert.deepEqual(opening.commands[0], buildDrawList(state, sheets).commands[0]);
  assert.equal(opening.commands.find(command => command.op === 'sprite').dh, 345.6);
  const absent = buildDrawList({ ...lesson(), actors: [actor('other')] }, sheets, null, GUIDE);
  assert.equal(absent.commands.some(command => command.op === 'sprite'), false);
});

test('the native stage reserves guide caption space for its mount and removes it on destroy', t => {
  const dom = installDom(); t.after(dom.restore);
  const elements = fakeStageElements();
  elements.frame.getBoundingClientRect = () => ({ width: 390, height: 219.375 });
  const stage = createCanvasStage(elements, { board: GUIDE }); t.after(() => stage.destroy());
  assert.equal(elements.frame.classList.contains('has-lesson-guide'), true);
  const list = stage.draw(lesson(), sheets);
  assert.deepEqual(list.commands[0], buildDrawList(lesson(), sheets).commands[0]);
  assert.equal(list.commands.find(command => command.op === 'sprite').slug, 'bibo');
  assert.equal(elements.frame.classList.contains('has-lesson-guide'), true);
  stage.draw({ ...lesson(), slate: null }, sheets);
  assert.equal(elements.frame.classList.contains('has-lesson-guide'), true);
  stage.destroy();
  assert.equal(elements.frame.classList.contains('has-lesson-guide'), false);
  const ordinary = createCanvasStage(elements); t.after(() => ordinary.destroy());
  assert.equal(elements.frame.classList.contains('has-lesson-guide'), false);
});

const ledge = [.855, .82, .092, .006];
test('an optional guide ledge is a copied immutable box wholly inside the stage', () => {
  const input = { ...GUIDE, ledge: [...ledge] };
  const resolved = requireBoardBlock(input, 'https://storage.example/');
  assert.deepEqual(resolved.ledge, ledge);
  assert.notStrictEqual(resolved.ledge, input.ledge);
  assert.ok(Object.isFrozen(resolved.ledge));
  input.ledge[0] = 0;
  assert.equal(resolved.ledge[0], .855);
});

test('invalid or unscoped guide ledges are refused before a mount paints', () => {
  for (const value of [null, {}, [0, 0, 1], [0, 0, 1, 1, 1], [0, NaN, .1, .1],
    [-.1, 0, .1, .1], [0, 0, 0, .1], [0, 0, .1, -.1], [.95, .8, .1, .1], [.8, .95, .1, .1]]) {
    assert.throws(() => requireBoardBlock({ ...GUIDE, ledge: value }, 'https://storage.example/'), /board ledge/);
  }
  assert.throws(() => requireBoardBlock({ ledge }, 'https://storage.example/'), /board ledge.*lesson-guide/);
});

test('a persistent guide ledge leaves the teaching board unchanged and paints behind the guide', () => {
  const options = requireBoardBlock({ ...GUIDE, ledge }, 'https://storage.example/');
  for (const tMs of [0, 2000, 10000, 190715, 2000]) {
    const state = { ...lesson(), tMs };
    const list = buildDrawList(state, sheets, null, options);
    assert.deepEqual(list.commands[0], buildDrawList(state, sheets).commands[0]);
    assert.deepEqual(list.commands[1], { op: 'ledge', hud: true, x: 1641.6, y: 885.6, w: 176.64, h: 6.48 });
    assert.equal(list.commands[2].slug, 'bibo');
    for (const card of list.commands[0].cards) assert.ok(card.dy + card.dh < list.commands[1].y);
  }
  assert.equal(buildDrawList(lesson(), sheets).commands.some(c => c.op === 'ledge'), false);
  assert.equal(buildDrawList({ ...lesson(), slate: null }, sheets, null, options).commands.some(c => c.op === 'ledge'), false);
  const empty = { ...lesson(), slate: { mode: 'count', count: 0, groups: [], standing: true } };
  assert.equal(buildDrawList(empty, sheets, null, options).commands[1].op, 'ledge');
});

test('the low tier draws the ledge in HUD coordinates between the cards and the actor', () => {
  const options = requireBoardBlock({ ...GUIDE, ledge }, 'https://storage.example/');
  const list = buildDrawList(lesson(), sheets, null, options);
  const context = fakeContext(), actorBitmap = { width: 512, height: 512 }, cardBitmap = { width: 512, height: 640 };
  paintDrawList(context, list, { shadows: false, scale: .2,
    lookup: url => url === 'assets/guide.webp' ? actorBitmap : cardBitmap });
  const shelf = context.calls.findIndex(([op, ...args]) => op === 'rect' && JSON.stringify(args) === JSON.stringify([1641.6, 885.6, 176.64, 6.48]));
  const cards = context.calls.map((c, i) => c[0] === 'drawImage' && c[1] === cardBitmap ? i : -1).filter(i => i >= 0);
  const actorPaint = context.calls.findIndex(([op, bitmap]) => op === 'drawImage' && bitmap === actorBitmap);
  assert.ok(shelf > Math.max(...cards) && actorPaint > shelf, 'the shelf must be visible behind the seated guide');
  assert.equal(context.calls[shelf + 1][0], 'fill');
  assert.equal(context.calls[shelf + 1][1].ink, 'rgba(255, 255, 255, 0.84)');
  assert.equal(context.depth(), 0, 'the shelf cannot leak canvas state into the actor');
  assert.ok(context.calls.slice(0, shelf).some(c => JSON.stringify(c) === JSON.stringify(['setTransform', .2, 0, 0, .2, 0, 0])));
});

test('top guide captions follow finite story windows and reset on seeks, absent guides and destroy', t => {
  const dom = installDom(); t.after(dom.restore);
  const elements = fakeStageElements();
  elements.frame.getBoundingClientRect = () => ({ width: 390, height: 219.375 });
  const board = { ...GUIDE, choreography: [{ id: 'comic-run', kind: 'peek', caption: 'top', start_ms: 1000, end_ms: 5000,
    actor: { keyframes: [{ at: 0, box: [.15, .99, .32] }, { at: 1, box: [1.12, .99, .32] }] } }] };
  const stage = createCanvasStage(elements, { board }); t.after(() => stage.destroy());
  const top = () => elements.frame.classList.contains('has-top-guide-caption');
  for (const [tMs, enabled] of [[999, false], [1000, true], [3000, true], [5000, false], [3000, true], [999, false]]) {
    const list = stage.draw({ ...lesson(), tMs }, sheets);
    assert.equal(top(), enabled, `caption lane at ${tMs} ms`);
    assert.deepEqual(list.commands[0], buildDrawList({ ...lesson(), tMs }, sheets).commands[0]);
  }
  stage.draw({ ...lesson(), tMs: 2000, actors: [] }, sheets); assert.equal(top(), false);
  stage.draw({ ...lesson(), tMs: 2000 }, sheets); assert.equal(top(), true);
  stage.draw({ ...lesson(), tMs: 2000, slate: null }, sheets); assert.equal(top(), false);
  stage.draw({ ...lesson(), tMs: 2000 }, sheets); assert.equal(top(), true);
  stage.destroy(); assert.equal(top(), false);
  const ordinary = createCanvasStage(elements); t.after(() => ordinary.destroy());
  ordinary.draw({ ...lesson(), tMs: 2000 }, sheets); assert.equal(top(), false);
});


test('a lesson guide requests a rendition sharp enough for its native HUD cell', () => {
  const bundle = read('golden_push_dusk', 'bundle');
  bundle.objects = { a: { svg: 'assets/a.svg', height_cm: 30 } };
  bundle.scenes = [{ ...bundle.scenes[0], steps: [
    { kind: 'cmd', cmd: 'put', subjects: ['robin'], objects: [], position: 'center', facing: null, beside: null, zone: null },
    { kind: 'cmd', cmd: 'board', cards: ['a'], subjects: [], focus: null, prompt: '' },
    { kind: 'cmd', cmd: 'pause', seconds: 2 },
  ] }];
  const timeline = compileTimeline(bundle);
  const viewport = { fitScale: 390 / 1920, dpr: 2 };
  const board = { layout: 'lesson-guide', guide: 'robin' };
  const cache = { get: () => null };
  const loader = createSceneLoader({ timeline, bundle, cache });
  const defaultPlan = loader.plan(0, viewport);
  const guidedPlan = loader.plan(0, { ...viewport, board });
  assert.ok(guidedPlan.sheets.length > 0);
  for (const sheet of guidedPlan.sheets.filter(sheet => sheet.slug === 'robin')) {
    assert.ok(sheet.drawnHeightPx >= 345.6, 'physical centimetres cannot size a prominent HUD guide');
    assert.ok(sheet.wantedPx >= 140.4);
    assert.equal(sheet.tier, 200);
  }
  assert.ok(defaultPlan.sheets.every(sheet => sheet.drawnHeightPx < 540), 'a default mount keeps floor sizing');
  assert.notStrictEqual(defaultPlan, guidedPlan, 'the loader cache must distinguish guide geometry');
  const desktop = sceneAssetPlan(timeline, bundle, 0, { fitScale: 1, dpr: 1, board });
  assert.ok(desktop.sheets.every(sheet => sheet.tier === 384));
});
