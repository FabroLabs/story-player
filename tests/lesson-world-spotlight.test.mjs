import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

const deck = ['a', 'b', 'c', 'd'];
const sheets = { sheet: () => ({ url: 'bibo', grid: [1, 1] }), prop: slug => ({ url: slug }) };
const recipe = (cards = deck, duration = 1800) => ({ layout: 'lesson-guide', guide: 'bibo', world: {
  background: 'garden', actor_box: [.9, .94, .4],
  board: { style: 'garden', panel: [.15, .305, .70, .525], content: {
    cards: [.015, .045, .97, .72], prompt: [.04, .80, .92, .18],
  } },
  phases: [{ id: 'lesson', start_ms: 0, end_ms: 8000, mode: 'lesson', props: [] }],
  cues: [{ id: 'answer', kind: 'reveal', presentation: 'spotlight', start_ms: 2000,
    end_ms: 2000 + duration, cards: [...cards], answer_index: 1 }],
} });
const draw = (tMs, options = recipe(), cards = deck, reducedMotion = false) => buildDrawList({
  tMs, plate: { resolution: [1920, 1080] }, actors: [{ slug: 'bibo', kind: 'character',
    opacity: 1, heightPx: 100, clip: 'idle_camera', frame: 0 }],
  slate: { mode: 'cards', cards, focus: null, prompt: 'Find A', standing: true, sinceMs: 0 },
}, sheets, { width: 390, height: 220, reducedMotion }, options);
const boardOf = list => list.commands.find(command => command.op === 'slate');
const geometry = board => board.cards.map(({ dx, dy, dw, dh }) => ({ dx, dy, dw, dh }));

test('spotlight is an explicit reveal-only option with the existing target guards', () => {
  const input = recipe(), resolved = requireBoardBlock(input, 'https://storage.example/');
  assert.equal(resolved.world.cues[0].presentation, 'spotlight');
  assert.ok(Object.isFrozen(resolved.world.cues[0]));
  for (const value of ['confetti', null, true, '']) {
    const invalid = recipe(); invalid.world.cues[0].presentation = value;
    assert.throws(() => requireBoardBlock(invalid, 'https://storage.example/'), /presentation/);
  }
  const thinking = recipe(); thinking.world.cues[0].kind = 'thinking'; delete thinking.world.cues[0].answer_index;
  assert.throws(() => requireBoardBlock(thinking, 'https://storage.example/'), /presentation/);
  for (const cards of [['b', 'a', 'c', 'd'], ['a', 'b', 'c'], ['a', 'b', 'c', 'other']]) {
    assert.equal(boardOf(draw(2320, recipe(), cards)).engagement, undefined);
  }
  const outdoors = recipe(); outdoors.world.phases[0].mode = 'world';
  assert.equal(boardOf(draw(2320, outdoors)), undefined);
});

test('spotlight compresses then visibly lifts the answer, holds and settles without moving targets', () => {
  const before = boardOf(draw(1999)), start = boardOf(draw(2000)), squash = boardOf(draw(2100));
  const peak = boardOf(draw(2320)), held = boardOf(draw(3000)), ending = boardOf(draw(3799)), end = boardOf(draw(3800));
  assert.equal(before.engagement, undefined);
  assert.deepEqual(start.cards[0].spotlight, { scaleX: 1, scaleY: 1, lift: 0, emphasis: 0 });
  assert.ok(squash.cards[0].spotlight.scaleY < .98);
  assert.ok(peak.cards[0].spotlight.scaleX >= 1.10 && peak.cards[0].spotlight.scaleX <= 1.14);
  assert.ok(peak.cards[0].spotlight.lift >= peak.cards[0].dh * .06);
  assert.ok(held.cards[0].spotlight.scaleX > 1.05);
  assert.ok(ending.cards[0].spotlight.scaleX - 1 < .0001);
  assert.ok(ending.cards[0].spotlight.lift < .01);
  assert.equal(end.engagement, undefined);
  assert.deepEqual(end, before);
  for (const board of [start, squash, peak, held, ending, end]) {
    assert.deepEqual(geometry(board), geometry(before));
    assert.ok(board.cards.every(card => !card.focused && !card.reveal));
    assert.ok(board.cards.slice(1).every(card => !card.spotlight));
  }
  for (const tMs of [1999, 2000, 2100, 2320, 2500, 3000, 3799, 3800]) {
    const first = draw(tMs); draw(7000); draw(0); assert.deepEqual(draw(tMs), first);
  }
});

test('spotlight stays inside the face and clear of prompt and neighboring images at every slot', () => {
  for (const cards of [deck.slice(0, 2), deck]) for (const duration of [600, 1800]) {
    for (let answer_index = 1; answer_index <= cards.length; answer_index++) {
      const options = recipe(cards, duration); options.world.cues[0].answer_index = answer_index;
      for (let elapsed = 0; elapsed < duration; elapsed += 20) {
        const board = boardOf(draw(2000 + elapsed, options, cards));
        const card = board.cards[answer_index - 1], fx = card.spotlight;
        const x = card.dx + card.dw * (1 - fx.scaleX) / 2;
        const y = card.dy + card.dh * (1 - fx.scaleY) / 2 - fx.lift;
        const right = x + card.dw * fx.scaleX, bottom = y + card.dh * fx.scaleY;
        assert.ok(x >= board.panel.x && right <= board.panel.x + board.panel.w);
        assert.ok(y >= board.panel.y && bottom <= board.prompt.cy - board.prompt.size / 2);
        for (const other of board.cards.filter(item => item !== card)) {
          const inset = other.dw * .06;
          assert.ok(right <= other.dx + inset || x >= other.dx + other.dw - inset, 'neighbor image remains unobscured');
        }
      }
    }
  }
});

test('spotlight paints the neutral raised answer last with a grounded shadow and no badges or particles', () => {
  const context = fakeContext(), images = Object.fromEntries(['garden', 'bibo', ...deck].map(slug => [slug, { width: 128, height: 128 }]));
  paintDrawList(context, draw(2320), { lookup: url => images[url] });
  const painted = context.of('drawImage');
  const cardOrder = painted.filter(args => deck.some(slug => images[slug] === args[0])).map(args => deck.find(slug => images[slug] === args[0]));
  assert.deepEqual(cardOrder, ['b', 'c', 'd', 'a']);
  const paint = slug => painted.find(args => args[0] === images[slug]).at(-1);
  assert.ok(paint('a').transform[0] >= 1.1);
  for (const slug of ['b', 'c', 'd', 'bibo']) assert.deepEqual(paint(slug).transform, [1, 1, 0, 0]);
  const forbidden = ['#fff0b2', '#c48a12', '#d19b24', '#e8ad24', '#29998e', '#e56d59'];
  for (const call of [...context.of('fill'), ...context.of('stroke')]) assert.ok(!forbidden.includes(call.at(-1).ink));
  assert.ok(context.of('fill').some(([fill]) => String(fill.ink).startsWith('rgba(35, 47, 47,')), 'neutral soft grounding shadow');
  assert.deepEqual(context.of('fillText').at(-1).at(-1).transform, [1, 1, 0, 0]);
  assert.equal(context.depth(), 0); assert.equal(context.globalAlpha, 1);
});

test('reduced motion keeps spotlight still with a neutral emphasis until its finite end', () => {
  const expected = { scaleX: 1, scaleY: 1, lift: 0, emphasis: 1 };
  for (const time of [2000, 2100, 2320, 3000, 3799]) {
    assert.deepEqual(boardOf(draw(time, recipe(), deck, true)).cards[0].spotlight, expected);
  }
  assert.equal(boardOf(draw(3800, recipe(), deck, true)).engagement, undefined);
});
