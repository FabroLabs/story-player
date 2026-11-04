import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList, WIDE_CAMERA } from '../browser/v0/app/stage/draw-list.mjs';
import { lessonWorldCamera } from '../browser/v0/app/stage/lesson-world.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

const sheets = { sheet: () => ({ url: 'assets/bibo.webp', grid: [1, 1] }), prop: slug => ({ url: `assets/${slug}.svg` }) };
const camera = () => [{ at_ms: 1000, scale: 1, cx: .5, cy: .5 }, { at_ms: 3000, scale: 1.5, cx: .6, cy: .5 }];
const options = (keys = camera()) => ({ layout: 'lesson-guide', guide: 'bibo', world: {
  background: 'garden', board: { style: 'garden', panel: [.1, .36, .8, .48] }, actor_box: [.82, .93, .42],
  phases: [
    { id: 'explore', start_ms: 0, end_ms: 6000, mode: 'world', props: [{ slug: 'ball', keyframes: [
      { at: 0, box: [.2, .8, .1, .1] }, { at: 1, box: [.8, .8, .1, .1] },
    ] }] },
    { id: 'teach', start_ms: 6000, end_ms: 8000, mode: 'lesson', props: [] },
  ],
  ...(keys ? { camera: keys } : {}),
} });
const resolved = keys => requireBoardBlock(options(keys), 'https://storage.example/');
const state = tMs => ({ tMs, plate: { resolution: [1920, 1080] },
  actors: [{ slug: 'bibo', kind: 'character', opacity: 1, heightPx: 100, clip: 'idle_camera', frame: 0 }],
  slate: { mode: 'cards', cards: ['a', 'b', 'c', 'd'], focus: 3, prompt: 'Find C', standing: true, sinceMs: 0 },
});
const draw = (tMs, keys = camera(), viewport = null) => buildDrawList(state(tMs), sheets, viewport, resolved(keys));
const withoutHud = list => list.commands.map(({ hud, ...command }) => command);

test('the world camera holds before its first key, moves linearly between keys and holds after its last', () => {
  assert.deepEqual(draw(0).camera, { scale: 1, x: 0, y: 0 });
  assert.deepEqual(draw(1000).camera, { scale: 1, x: 0, y: 0 });
  assert.deepEqual(draw(2000).camera, { scale: 1.25, x: -18.75, y: -12.5 });
  assert.deepEqual(draw(3000).camera, { scale: 1.5, x: -40, y: -25 });
  assert.deepEqual(draw(5999).camera, { scale: 1.5, x: -40, y: -25 });
});

test('dense keys are found by search exactly as a straight scan would find them', () => {
  const keys = Array.from({ length: 101 }, (_, i) => ({ at_ms: i * 40, scale: 1 + (i % 7) / 10, cx: (i % 11) / 10, cy: (i % 5) / 4 }));
  const world = { camera: keys };
  const scan = tMs => {
    const right = keys.findIndex(key => key.at_ms > tMs);
    if (right === 0) return lessonWorldCamera({ camera: [keys[0]] }, tMs);
    if (right === -1) return lessonWorldCamera({ camera: [keys.at(-1)] }, tMs);
    return lessonWorldCamera({ camera: [keys[right - 1], keys[right]] }, tMs);
  };
  for (const tMs of [-5, 0, 13, 40, 1999, 2000, 2021, 3987, 4000, 9000]) assert.deepEqual(lessonWorldCamera(world, tMs), scan(tMs), `${tMs} ms`);
});

test('the offset is clamped so the plate always covers the frame at the corners', () => {
  const at = (scale, cx, cy) => lessonWorldCamera({ camera: [{ at_ms: 0, scale, cx, cy }] }, 0);
  assert.deepEqual(at(2, 0, 0), { scale: 2, x: 0, y: 0 });
  assert.deepEqual(at(2, 1, 1), { scale: 2, x: -100, y: -100 });
  assert.deepEqual(at(1.5, 1, 0), { scale: 1.5, x: -50, y: 0 });
  assert.deepEqual(at(1, 0, 1), { scale: 1, x: 0, y: 0 });
  for (const [cx, cy] of [[0, 0], [0, 1], [1, 0], [1, 1], [.5, .5]]) {
    for (const scale of [1, 1.2, 1.5, 2]) {
      const { x, y } = at(scale, cx, cy);
      for (const offset of [x, y]) assert.ok(offset <= 0 && offset + scale * 100 >= 100 - 1e-9, `${scale} at ${cx},${cy}`);
    }
  }
});

test('an authored camera takes the whole world picture under it, guide included', () => {
  const list = draw(2000);
  assert.deepEqual(list.commands.map(c => [c.op, c.slug]), [['prop', 'garden'], ['prop', 'ball'], ['sprite', 'bibo']]);
  assert.ok(list.commands.every(c => !Object.hasOwn(c, 'hud')));
  assert.deepEqual(withoutHud(list), withoutHud(draw(2000, null)), 'the camera moves the picture, never the plate geometry');
});

test('a board phase stays wide and screen-fixed even while the world camera is pushed in', () => {
  const list = draw(7000);
  assert.equal(list.camera, WIDE_CAMERA);
  assert.deepEqual(list, draw(7000, null));
});

test('reduced motion keeps the world wide', () => {
  const list = draw(3000, camera(), { reducedMotion: true });
  assert.equal(list.camera, WIDE_CAMERA);
  assert.deepEqual(list, draw(3000, null, { reducedMotion: true }));
});

test('a world without a camera draws the same list it always drew', () => {
  for (const tMs of [0, 2000, 7000]) {
    const list = draw(tMs, null);
    assert.equal(list.camera, WIDE_CAMERA);
    assert.ok(list.commands.every(c => c.hud), `${tMs} ms stays in stage coordinates`);
  }
  assert.equal(Object.hasOwn(resolved(null).world, 'camera'), false);
});

test('the painted background, props and guide all land under the pushed-in camera', () => {
  const context = fakeContext(), image = { width: 1920, height: 1080 };
  paintDrawList(context, draw(3000), { lookup: () => image });
  const draws = context.of('drawImage');
  assert.equal(draws.length, 3);
  for (const call of draws) assert.deepEqual(call.at(-1).transform, [1.5, 1.5, -768, -270]);
  const [a, , e] = draws[0].at(-1).transform;
  assert.ok(e <= 0 && e + a * 1920 >= 1920, 'the background still covers the frame');
  assert.equal(context.depth(), 0);
});

test('camera keys are refused unless sorted, in range, inside the world and without extra fields', () => {
  const mutations = [
    keys => { keys[1].at_ms = 1000; }, keys => { keys[1].at_ms = 500; }, keys => { keys[1].at_ms = 8001; },
    keys => { keys[0].at_ms = -1; }, keys => { keys[1].scale = 2.01; }, keys => { keys[0].scale = .99; },
    keys => { keys[0].cx = -.01; }, keys => { keys[1].cy = 1.01; }, keys => { keys[0].ease = 'in'; },
    keys => { delete keys[0].cy; }, keys => { keys[0].scale = Number.NaN; }, keys => { keys.length = 0; },
  ];
  for (const mutate of mutations) {
    const keys = camera(); mutate(keys);
    assert.throws(() => resolved(keys), /board world camera/);
  }
  assert.throws(() => resolved({ at_ms: 0, scale: 1, cx: .5, cy: .5 }), /board world camera/);
  const world = resolved([{ at_ms: 0, scale: 2, cx: 0, cy: 1 }, { at_ms: 8000, scale: 1, cx: 1, cy: 0 }]).world;
  assert.deepEqual(world.camera, [{ at_ms: 0, scale: 2, cx: 0, cy: 1 }, { at_ms: 8000, scale: 1, cx: 1, cy: 0 }]);
  assert.ok(Object.isFrozen(world.camera[0]));
});
