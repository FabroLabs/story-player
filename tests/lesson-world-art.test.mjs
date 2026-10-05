import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

const sheets = { sheet: () => ({ url: 'assets/bibo.webp', grid: [1, 1] }), prop: slug => ({ url: `assets/${slug}.png` }) };
const recipe = () => ({ layout: 'lesson-guide', guide: 'bibo', world: {
  background: 'garden', actor_box: [.9, .94, .4],
  board: { style: 'garden', panel: [.1, .4, .8, .44], art: 'wooden_board', art_box: [.05, .25, .9, .7] },
  phases: [
    { id: 'intro', start_ms: 0, end_ms: 1000, mode: 'world', props: [] },
    { id: 'transfer', start_ms: 1000, end_ms: 5000, mode: 'lesson',
      content_opacity: [{ at: 0, opacity: 0 }, { at: .5, opacity: 1 }, { at: 1, opacity: 1 }],
      props: [{ slug: 'apple', cards: ['a', 'apple'], card_index: 2, hide_card_image: true, keyframes: [
        { at: 0, box: [.2, .7, .16, .20] },
        { at: .75, anchor: 'card', box: [.5, .5, 1, 1] },
        { at: 1, anchor: 'card', box: [.5, .5, 1, 1] },
      ] }] },
    { id: 'teach', start_ms: 5000, end_ms: 8000, mode: 'lesson', content_opacity: 1, props: [] },
    { id: 'friends', start_ms: 8000, end_ms: 10000, mode: 'lesson', content_opacity: 0, props: [
      { slug: 'ball', keyframes: [{ at: 0, box: [.2, .7, .1, .1] }, { at: 1, box: [.7, .7, .1, .1] }] },
    ] },
  ],
} });
const state = (tMs, cards = ['a', 'apple']) => ({ tMs, plate: { resolution: [1920, 1080] }, camera: { scale: 2, x: 10, y: 10 },
  actors: [{ slug: 'bibo', kind: 'character', opacity: 1, heightPx: 100, clip: 'idle_camera', frame: 0 }],
  slate: { mode: 'cards', cards, focus: null, prompt: 'A is for apple', standing: true, sinceMs: 0 },
});
const draw = (tMs, options = recipe(), cards) => buildDrawList(state(tMs, cards), sheets, null, options);
const boardOf = list => list.commands.find(c => c.op === 'slate');

test('artwork, content fades and anchored transfers are immutable validated presentation data', () => {
  const input = recipe(), resolved = requireBoardBlock(input, 'https://storage.example/');
  assert.deepEqual(resolved, input);
  input.world.board.art_box[0] = .2;
  input.world.phases[1].content_opacity[0].opacity = 1;
  input.world.phases[1].props[0].cards[0] = 'changed';
  assert.equal(resolved.world.board.art_box[0], .05);
  assert.equal(resolved.world.phases[1].content_opacity[0].opacity, 0);
  assert.deepEqual(resolved.world.phases[1].props[0].cards, ['a', 'apple']);
  assert.ok(Object.isFrozen(resolved.world.phases[1].content_opacity[0]));
  const padded = recipe();
  padded.world.board.art_box = [.06, .27741951647250407, .88, .7822222222222223];
  assert.deepEqual(requireBoardBlock(padded, 'https://storage.example/').world.board.art_box, padded.world.board.art_box,
    'transparent art padding may extend outside the visible stage');
});

test('unsafe art and ambiguous transfer recipes cannot reach the renderer', () => {
  const mutations = [
    w => { delete w.board.art; }, w => { delete w.board.art_box; },
    w => { w.board.art = '../wood'; }, w => { w.board.art_box = [.2, .2, -1, 1]; },
    w => { w.phases[1].content_opacity = 2; }, w => { w.phases[1].content_opacity = []; },
    w => { w.phases[1].content_opacity[0].at = .1; },
    w => { w.phases[1].content_opacity[1].opacity = NaN; },
    w => { w.phases[1].content_opacity[1].at = 0; },
    w => { w.phases[1].props[0].cards = ['apple', 'a']; },
    w => { w.phases[1].props[0].card_index = 3; },
    w => { w.phases[1].props[0].keyframes[1].anchor = 'actor'; },
    w => { delete w.phases[1].props[0].cards; },
    w => { w.phases[1].props[0].hide_card_image = 'yes'; },
    w => { w.phases[1].props[0].cards = ['a', 'apple', 'a']; },
  ];
  for (const change of mutations) {
    const input = recipe(); change(input.world);
    assert.throws(() => requireBoardBlock(input, 'https://storage.example/'), /board world/);
  }
});

test('a transparent board image replaces vector wood and survives content fading without moving its support', () => {
  const list = draw(2000), board = boardOf(list);
  const art = { width: 1600, height: 900 }, image = { width: 400, height: 600 }, bibo = { width: 512, height: 512 };
  const context = fakeContext();
  paintDrawList(context, list, { lookup: url => url === 'assets/wooden_board.png' ? art : url === 'assets/bibo.webp' ? bibo : image });
  const paintedArt = context.of('drawImage').find(args => args[0] === art);
  assert.ok(paintedArt, 'the generated board must reach the painter');
  assert.deepEqual(paintedArt.slice(1, -1), [288, 270, 1344, 756]);
  assert.equal(paintedArt.at(-1).alpha, 1);
  assert.equal(context.of('fill').some(([paint]) => paint.ink === '#a46e3c'), false, 'vector wood must not cover generated artwork');
  const teachingImage = context.of('drawImage').find(args => args[0] === image && args.length === 6);
  assert.equal(teachingImage.at(-1).alpha, .5, 'content fades independently of the wooden board');
  assert.equal(context.of('drawImage').find(args => args[0] === bibo).at(-1).alpha, 1);
  for (const tMs of [1300, 4999, 5000, 8000, 9000]) {
    assert.deepEqual(boardOf(draw(tMs)).panel, board.panel);
    assert.equal(boardOf(draw(tMs)).world.opacity, 1, 'consecutive lesson phases cannot fade the board again');
  }
  assert.equal(context.depth(), 0);
});

test('all world props paint in front of the persistent board and behind the guide', () => {
  assert.deepEqual(draw(9000).commands.map(c => [c.op, c.slug]), [
    ['prop', 'garden'], ['slate', undefined], ['prop', 'ball'], ['sprite', 'bibo'],
  ]);
  assert.equal(boardOf(draw(9000)).world.contentOpacity, 0);
  assert.deepEqual(draw(500).commands.map(c => [c.op, c.slug]), [['prop', 'garden'], ['sprite', 'bibo']]);
});

test('an outdoor object docks into its exact image inset and hands off once without duplicates', () => {
  const incoming = draw(4000), board = boardOf(incoming), card = board.cards[1];
  const prop = incoming.commands.find(c => c.op === 'prop' && c.slug === 'apple');
  assert.equal(card.imageHidden, true);
  assert.equal(board.cards[0].imageHidden, undefined);
  const inset = Math.min(card.dw, card.dh) * .06;
  assert.deepEqual([prop.dx, prop.dy, prop.dw, prop.dh], [card.dx + inset, card.dy + inset, card.dw - inset * 2, card.dh - inset * 2]);
  const image = { width: 350, height: 500 }, lookup = url => url === 'assets/apple.png' ? image : { width: 512, height: 512 };
  const before = fakeContext(), after = fakeContext();
  paintDrawList(before, incoming, { lookup }); paintDrawList(after, draw(5000), { lookup });
  const paints = context => context.of('drawImage').filter(args => args[0] === image);
  assert.equal(paints(before).length, 1); assert.equal(paints(after).length, 1);
  assert.deepEqual(paints(before), paints(after), 'the card restores exactly the same image fit on phase handoff');
  assert.equal(boardOf(draw(5000)).cards[1].imageHidden, undefined);
});

test('target guards preserve a changed answer board and all authored movement remains seekable', () => {
  for (const cards of [['apple', 'a'], ['a', 'apple', 'ball']]) {
    const changed = draw(3000, recipe(), cards);
    assert.equal(changed.commands.some(c => c.op === 'prop' && c.slug === 'apple'), false);
    assert.ok(boardOf(changed).cards.every(c => !c.imageHidden));
  }
  const earlier = draw(2500);
  for (const tMs of [9000, 1300, 7000, 500, 9999]) draw(tMs);
  assert.deepEqual(draw(2500), earlier);
});
