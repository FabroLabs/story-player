import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList, sceneSheets } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

const sheets = { sheet: () => ({ url: 'assets/bibo.webp', grid: [1, 1] }), prop: slug => ({ url: `assets/${slug}.svg` }) };
const options = () => ({ layout: 'lesson-guide', guide: 'bibo', world: {
  background: 'garden', board: { style: 'garden', panel: [.1, .36, .8, .48] }, actor_box: [.82, .93, .42],
  phases: [
    { id: 'explore', start_ms: 0, end_ms: 2000, mode: 'world', props: [{ slug: 'ball', keyframes: [
      { at: 0, box: [.2, .8, .1, .1], opacity: 0 }, { at: 1, box: [.8, .8, .1, .1], opacity: 1 },
    ] }] },
    { id: 'teach', start_ms: 2000, end_ms: 8000, mode: 'lesson', props: [] },
  ],
} });
const state = tMs => ({ tMs, plate: { resolution: [1920, 1080] }, camera: { scale: 2, x: 10, y: 10 },
  actors: [{ slug: 'bibo', kind: 'character', opacity: 1, heightPx: 100, clip: 'idle_camera', frame: 0 }],
  slate: { mode: 'cards', cards: ['a', 'b', 'c', 'd'], focus: 3, prompt: 'Find C', standing: true, sinceMs: 0 },
});
const draw = (tMs, board = options()) => buildDrawList(state(tMs), sheets, null, board);

test('world options are copied and frozen before callers can mutate the phase recipe', () => {
  const input = options();
  const resolved = requireBoardBlock(input, 'https://storage.example/');
  assert.deepEqual(resolved, input);
  assert.ok(Object.isFrozen(resolved.world.phases[0].props[0].keyframes[0].box));
  input.world.phases[0].props[0].keyframes[0].box[0] = 9;
  assert.equal(resolved.world.phases[0].props[0].keyframes[0].box[0], .2);
});

test('world recipes reject unknown fields, unsafe references and ambiguous time windows', () => {
  const mutations = [
    w => { w.background = '../garden'; }, w => { w.url = 'https://bad.example/a'; },
    w => { w.board.style = 'unknown'; }, w => { w.board.panel = [.5, .4, .8, .4]; },
    w => { w.actor_box = [.5, .5, 0]; }, w => { w.phases[0].id = ''; },
    w => { w.phases[1].start_ms = 2001; }, w => { w.phases[1].start_ms = 1999; },
    w => { w.phases[0].mode = 'film'; }, w => { w.phases[0].props[0].keyframes[0].at = .2; },
    w => { w.phases[0].props[0].keyframes[0].opacity = 2; },
    w => { w.phases[0].props[0].keyframes[0].box[2] = 0; },
  ];
  for (const mutate of mutations) {
    const input = options(); mutate(input.world);
    assert.throws(() => requireBoardBlock(input, 'https://storage.example/'), /board world/);
  }
  assert.throws(() => requireBoardBlock({ world: options().world }, 'https://storage.example/'), /world.*lesson-guide/);
});

test('world phase paints its background, interpolated prop and full guide without a board', () => {
  const list = draw(1000);
  assert.deepEqual(list.commands.map(c => [c.op, c.slug]), [['prop', 'garden'], ['prop', 'ball'], ['sprite', 'bibo']]);
  const [backdrop, ball, bibo] = list.commands;
  assert.deepEqual([backdrop.dx, backdrop.dy, backdrop.dw, backdrop.dh], [0, 0, 1920, 1080]);
  assert.deepEqual([ball.dx, ball.dy, ball.dw, ball.dh, ball.opacity], [864, 810, 192, 108, .5]);
  assert.deepEqual([bibo.dx, bibo.dy, bibo.dw, bibo.dh], [1347.6, 550.8, 453.6, 453.6]);
  assert.ok(list.commands.every(c => c.hud), 'world uses stable authored stage coordinates');
  assert.deepEqual(draw(1000), list, 'seek back must reconstruct the same instant');
});

test('garden lesson panel settles within the world with stable ordered cards and exact focus', () => {
  const list = draw(2300);
  const board = list.commands.find(c => c.op === 'slate');
  assert.equal(board.world.style, 'garden');
  assert.deepEqual([board.panel.x, board.panel.y, board.panel.w, board.panel.h], [192, 388.8, 1536, 518.4]);
  assert.deepEqual(board.cards.map(c => [c.slug, c.focused]), [['a', false], ['b', false], ['c', true], ['d', false]]);
  for (const c of board.cards) {
    assert.ok(c.dx > board.panel.x && c.dx + c.dw < board.panel.x + board.panel.w);
    assert.ok(c.dy > board.panel.y && c.dy + c.dh < board.panel.y + board.panel.h);
    assert.ok(c.dw > 250, 'four cards remain readable on a small stage');
  }
  assert.deepEqual(draw(7000).commands.find(c => c.op === 'slate'), board);
  const entering = draw(2000).commands.find(c => c.op === 'slate');
  assert.deepEqual(entering.panel, board.panel, 'the sitting rim must remain fixed from the first reveal frame');
  assert.deepEqual(entering.cards, board.cards, 'the teaching targets cannot move underneath a seated guide');
  assert.equal(entering.world.opacity, 0);
  for (const tMs of [2050, 2100, 2150, 2200, 2250]) {
    const revealing = draw(tMs).commands.find(c => c.op === 'slate');
    assert.deepEqual(revealing.panel, board.panel, `rim remains fixed at ${tMs} ms`);
    assert.deepEqual(revealing.cards, board.cards);
    assert.ok(revealing.world.opacity > 0 && revealing.world.opacity < 1);
  }
  assert.equal(board.world.opacity, 1);
  assert.deepEqual(draw(2300).commands.find(c => c.op === 'slate'), board);
});

test('world choreography moves a guide with no native slate and docks a prop into the themed board', () => {
  const board = options();
  board.choreography = [{ id: 'fetch', kind: 'carry', start_ms: 0, end_ms: 4000,
    actor: { keyframes: [{ at: 0, box: [.2, .8, .42] }, { at: 1, box: [.8, .8, .42] }] },
    prop: { slug: 'c', cards: ['a', 'b', 'c', 'd'], card_index: 3, hide_card_image: true,
      keyframes: [{ at: 0, anchor: 'actor', box: [.5, .5, .3, .3] }, { at: .6, anchor: 'card', box: [.5, .5, 1, 1] }, { at: 1, anchor: 'card', box: [.5, .5, 1, 1] }] },
  }];
  const outdoor = buildDrawList({ ...state(1000), slate: null }, sheets, null, board);
  assert.equal(outdoor.commands.some(c => c.op === 'slate'), false);
  assert.equal(outdoor.commands.find(c => c.op === 'sprite').dx, 445.2);
  assert.equal(outdoor.commands.filter(c => c.slug === 'c').length, 1);
  const docked = draw(3000, board);
  const card = docked.commands.find(c => c.op === 'slate').cards[2];
  const prop = docked.commands.find(c => c.op === 'prop' && c.slug === 'c');
  assert.equal(card.imageHidden, true);
  const inset = Math.min(card.dw, card.dh) * .06;
  assert.deepEqual([prop.dx, prop.dy, prop.dw, prop.dh], [card.dx + inset, card.dy + inset, card.dw - 2 * inset, card.dh - 2 * inset]);
});

test('teaching cards clear a guide seated across the top rim of a lower garden board', () => {
  const board = options(); board.world.board.panel = [.10, .40, .80, .44];
  for (const card of draw(3000, board).commands.find(c => c.op === 'slate').cards) {
    assert.ok(card.dy >= .53 * 1080, 'seated feet must not overlap teaching cards');
    assert.ok(card.dy + card.dh <= .78 * 1080, 'prompt needs a separate readable band');
  }
});

test('preloaded world objects are available to the same safe sheet lookup as native props', () => {
  const images = sceneSheets({ sheets: [], props: [], worldObjects: [{ slug: 'garden', url: 'assets/garden.png' }] }, { get: () => null });
  assert.deepEqual(images.prop('garden'), { url: 'assets/garden.png' });
});

test('a world background covers a wide stage without stretching while props remain whole', () => {
  const context = fakeContext(), backdrop = { width: 1600, height: 1200 }, object = { width: 400, height: 600 };
  paintDrawList(context, draw(1000), { lookup: url => url === 'assets/garden.svg' ? backdrop : object });
  const background = context.of('drawImage').find(args => args[0] === backdrop);
  assert.deepEqual(background.slice(1, -1), [0, 150, 1600, 900, 0, 0, 1920, 1080]);
  const prop = context.of('drawImage').find(args => args[0] === object && args.length === 6);
  assert.deepEqual(prop.slice(1, -1), [924, 810, 72, 108], 'portrait prop keeps its full image');
});

test('garden board paint leaves the world bright and supplies wood behind clean teaching cards', () => {
  const context = fakeContext();
  paintDrawList(context, draw(3000), { lookup: () => ({ width: 1920, height: 1080 }), shadows: false });
  assert.equal(context.of('fill').some(([paint]) => paint.ink === 'rgba(11, 24, 29, 0.22)'), false);
  assert.ok(context.of('fill').some(([paint]) => paint.ink === '#a46e3c'), 'wooden frame is physically painted');
  assert.ok(context.of('fill').some(([paint]) => paint.ink === '#fff8e7'), 'warm interior supports readable letters');
  assert.equal(context.depth(), 0);
});

test('board reveal fades the physical board and cards together without fading its seated guide', () => {
  const context = fakeContext(), guide = { width: 512, height: 512 }, object = { width: 400, height: 600 };
  paintDrawList(context, draw(2150), { lookup: url => url === 'assets/bibo.webp' ? guide : object });
  const interior = context.of('fill').find(([paint]) => paint.ink === '#fff8e7');
  assert.equal(interior[0].alpha, .875);
  const guidePaint = context.of('drawImage').find(args => args[0] === guide);
  assert.equal(guidePaint.at(-1).alpha, 1);
  const teachingImages = context.of('drawImage').filter(args => args[0] === object && args.length === 6);
  assert.equal(teachingImages.length, 4);
  assert.ok(teachingImages.every(args => args.at(-1).alpha === .875));
});
