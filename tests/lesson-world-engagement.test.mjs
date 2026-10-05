import assert from 'node:assert/strict';
import test from 'node:test';
import { requireBoardBlock } from '../browser/v0/app/urls.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

const deck = ['a', 'b', 'c', 'd'];
const sheets = { sheet: () => ({ url: 'bibo', grid: [1, 1] }), prop: slug => ({ url: slug }) };
const recipe = () => ({ layout: 'lesson-guide', guide: 'bibo', world: {
  background: 'garden', actor_box: [.9, .94, .4],
  board: { style: 'garden', panel: [.11, .34, .78, .5], content: {
    cards: [.03, .08, .94, .70], prompt: [.04, .81, .92, .16],
  } },
  phases: [
    { id: 'intro', start_ms: 0, end_ms: 1000, mode: 'world', props: [] },
    { id: 'lesson', start_ms: 1000, end_ms: 8000, mode: 'lesson', props: [] },
  ],
  cues: [
    { id: 'wait', kind: 'thinking', start_ms: 2000, end_ms: 4000, cards: [...deck] },
    { id: 'answer', kind: 'reveal', start_ms: 4000, end_ms: 5600, cards: [...deck], answer_index: 3 },
  ],
} });
const draw = (tMs, options = recipe(), cards = deck, focus = 2) => buildDrawList({
  tMs, plate: { resolution: [1920, 1080] }, actors: [{ slug: 'bibo', kind: 'character',
    opacity: 1, heightPx: 100, clip: 'idle_camera', frame: 0 }],
  slate: { mode: 'cards', cards, focus, prompt: 'Find C', standing: true, sinceMs: 0 },
}, sheets, null, options);
const boardOf = list => list.commands.find(command => command.op === 'slate');
const geometry = board => board.cards.map(({ dx, dy, dw, dh }) => ({ dx, dy, dw, dh }));

test('content bands and answer cues are copied, frozen and strictly validated', () => {
  const input = recipe(), resolved = requireBoardBlock(input, 'https://storage.example/');
  assert.deepEqual(resolved, input);
  input.world.board.content.cards[0] = .8; input.world.cues[0].cards[0] = 'other';
  assert.equal(resolved.world.board.content.cards[0], .03);
  assert.equal(resolved.world.cues[0].cards[0], 'a');
  assert.ok(Object.isFrozen(resolved.world.cues[0].cards));
  const mutations = [
    w => { w.board.content.cards[0] = -.1; }, w => { w.board.content.prompt[2] = 2; },
    w => { w.board.content.prompt = [.04, .2, .92, .16]; }, w => { delete w.board.content.prompt; },
    w => { w.board.content.extra = true; }, w => { w.cues[0].answer_index = 3; },
    w => { delete w.cues[1].answer_index; }, w => { w.cues[1].answer_index = 5; },
    w => { w.cues[1].start_ms = 3000; }, w => { w.cues[0].start_ms = -1; },
    w => { w.cues[1].end_ms = 4000; }, w => { w.cues[1].end_ms = Infinity; },
    w => { w.cues[1].id = 'wait'; }, w => { w.cues[1].kind = 'correct'; },
    w => { w.cues[1].cards[0] = '../a'; }, w => { w.cues[1].cards[0] = 'b'; },
    w => { w.cues[1].score = 1; },
  ];
  for (const mutate of mutations) {
    const invalid = recipe(); mutate(invalid.world);
    assert.throws(() => requireBoardBlock(invalid, 'https://storage.example/'), /board world/, String(mutate));
  }
});

test('custom content gives cards a roomy fixed area and reserves separate prompt and thinking space', () => {
  const board = boardOf(draw(2500)), old = recipe(); delete old.world.board.content;
  assert.ok(board.cards[0].dw > boardOf(draw(2500, old)).cards[0].dw);
  assert.ok(board.cards.every(card => card.dw === card.dh && card.dy >= board.panel.y + board.panel.h * .08));
  assert.ok(Math.max(...board.cards.map(card => card.dy + card.dh)) < board.prompt.cy - board.prompt.size / 2);
  assert.ok(board.prompt.size >= 58, 'short prompts must remain readable in the taller face');
  const dots = board.engagement.dots;
  assert.equal(dots.length, 3);
  assert.ok(dots.every(dot => dot.cy - dot.r > board.prompt.cy + board.prompt.size / 2));
  assert.ok(dots.every(dot => dot.cy + dot.r <= board.panel.y + board.panel.h * .97));
  assert.deepEqual(boardOf(draw(1999)).prompt, board.prompt, 'thinking must not shift prompt text');
  assert.deepEqual(boardOf(draw(5600)).prompt, board.prompt, 'reveal must not shift prompt text');
});

test('thinking is neutral and cues require the exact deck and a lesson phase', () => {
  const thinking = boardOf(draw(2500));
  assert.equal(thinking.engagement.kind, 'thinking');
  assert.ok(thinking.cards.every(card => !card.focused && !card.reveal));
  assert.notDeepEqual(thinking.engagement.dots, boardOf(draw(2700)).engagement.dots);
  for (const cards of [['b', 'a', 'c', 'd'], ['a', 'b', 'c']]) {
    const changed = boardOf(draw(2500, recipe(), cards));
    assert.equal(changed.engagement, undefined);
    assert.equal(changed.cards[1].focused, true, 'a mismatched cue cannot alter native state');
  }
  const outdoors = recipe(); outdoors.world.cues[0].start_ms = 0;
  assert.equal(draw(500, outdoors).commands.some(command => command.op === 'slate'), false);
});

test('answer revelation has one finite pop, glow and deterministic burst without moving card targets', () => {
  const before = boardOf(draw(3999)), start = boardOf(draw(4000)), peak = boardOf(draw(4225)), settled = boardOf(draw(4600)), end = boardOf(draw(5600));
  assert.equal(start.engagement.kind, 'reveal');
  assert.equal(start.cards[2].reveal.scale, 1);
  assert.ok(peak.cards[2].reveal.scale > 1.05 && peak.cards[2].reveal.scale <= 1.06);
  assert.equal(settled.cards[2].reveal.scale, 1);
  assert.ok(peak.cards[2].reveal.glow > 0);
  assert.equal(peak.cards[2].reveal.sparkles.length, 8);
  assert.ok(peak.cards[2].reveal.sparkles.every(particle => particle.opacity > 0 && particle.opacity <= 1));
  assert.deepEqual(peak.cards.map(card => card.focused), [false, false, true, false]);
  assert.equal(end.engagement, undefined);
  assert.ok(end.cards.every(card => !card.reveal));
  for (const board of [start, peak, settled, end]) assert.deepEqual(geometry(board), geometry(before));
  for (const tMs of [1999, 2000, 2500, 3999, 4000, 4225, 4600, 5599, 5600]) {
    const first = draw(tMs); draw(7000); draw(500); assert.deepEqual(draw(tMs), first);
  }
});

test('cue paint transforms only the revealed card and restores the guide and prompt', () => {
  const context = fakeContext(), images = Object.fromEntries(['garden', 'bibo', ...deck].map(slug => [slug, { width: 128, height: 128 }]));
  paintDrawList(context, draw(4225), { lookup: url => images[url] });
  const paint = slug => context.of('drawImage').find(args => args[0] === images[slug]).at(-1);
  assert.ok(paint('c').transform[0] > 1.05);
  for (const slug of ['a', 'b', 'd', 'bibo']) assert.deepEqual(paint(slug).transform, [1, 1, 0, 0]);
  assert.deepEqual(context.of('fillText').at(-1).at(-1).transform, [1, 1, 0, 0]);
  assert.ok(context.of('stroke').some(([stroke]) => stroke.ink === '#fffdf2'), 'answer badge has a clear checkmark');
  const colors = ['#e8ad24', '#29998e', '#e56d59'];
  assert.deepEqual(colors.map(color => context.of('fill').filter(([fill]) => fill.ink === color).length), [3, 3, 2],
    'eight high-contrast stars use three warm colors');
  for (const sparkle of boardOf(draw(4225)).cards[2].reveal.sparkles) {
    assert.ok(context.of('stroke').some(([stroke]) => stroke.ink === '#fffdf2' && stroke.width === sparkle.edge),
      'every star has its own thin white outline');
  }
  assert.equal(context.depth(), 0); assert.equal(context.globalAlpha, 1);
  const neutral = fakeContext(); paintDrawList(neutral, draw(2500), { lookup: url => images[url] });
  assert.equal(neutral.of('fill').filter(([fill]) => fill.ink === '#708b78').length, 3, 'three neutral thinking dots');
  assert.equal(neutral.of('fill').some(([fill]) => colors.includes(fill.ink)), false);
});

test('large reveal stars hold their color briefly before fading completely', () => {
  for (const tMs of [4080, 4260, 4350]) {
    const card = boardOf(draw(tMs)).cards[2];
    assert.ok(card.reveal.sparkles.every(star => star.opacity === 1));
    assert.ok(card.reveal.sparkles.every(star => star.r >= card.dw * .044 && star.r <= card.dw * .056));
  }
  assert.ok(boardOf(draw(4000)).cards[2].reveal.sparkles.every(star => star.opacity === 0));
  assert.ok(boardOf(draw(4800)).cards[2].reveal.sparkles.every(star => star.opacity > 0 && star.opacity < .5));
  assert.ok(boardOf(draw(5200)).cards[2].reveal.sparkles.every(star => star.opacity === 0));
  const short = recipe(); short.world.cues[1].end_ms = 4600;
  assert.ok(boardOf(draw(4260, short)).cards[2].reveal.sparkles.every(star => star.opacity === 1));
  assert.ok(boardOf(draw(4599, short)).cards[2].reveal.sparkles.every(star => star.opacity < .01));
  assert.equal(boardOf(draw(4600, short)).engagement, undefined);
});

test('the moving star orbit leaves the popped answer badge unobscured', () => {
  for (const duration of [600, 1600]) {
    const options = recipe(); options.world.cues[1].end_ms = 4000 + duration;
    for (const answer_index of [1, 2, 3, 4]) {
      options.world.cues[1].answer_index = answer_index;
      for (let elapsed = 200; elapsed <= 500; elapsed += 25) {
        const card = boardOf(draw(4000 + elapsed, options)).cards[answer_index - 1];
        const { scale, sparkles } = card.reveal;
        const cx = card.dx + card.dw / 2 + card.dw * .41 * scale;
        const cy = card.dy + card.dh / 2 - card.dh * .41 * scale;
        const badgeRadius = Math.min(card.dw, card.dh) * .062 * scale * 1.1;
        for (const star of sparkles) {
          const clearance = Math.hypot(star.cx - cx, star.cy - cy) - star.r - star.edge / 2 - badgeRadius;
          assert.ok(clearance > card.dw * .012, `badge overlap at ${elapsed}ms in ${duration}ms reveal`);
        }
      }
    }
  }
});

test('outer-card celebrations stay inside a taller illustrated face with a separate prompt lane', () => {
  const options = recipe();
  options.world.board.panel = [.15, .305, .70, .525];
  options.world.board.content = { cards: [.015, .045, .97, .72], prompt: [.04, .80, .92, .18] };
  for (const answer_index of [1, 2, 3, 4]) {
    options.world.cues[1].answer_index = answer_index;
    for (const tMs of [4000, 4225, 4600, 4900, 5199, 5599]) {
      const board = boardOf(draw(tMs, options)), { panel, prompt } = board;
      assert.ok(prompt.size >= 69, 'the taller prompt band should use its available height');
      for (const card of board.cards) {
        assert.ok(card.dy + card.dh < prompt.cy - prompt.size / 2);
        for (const sparkle of card.reveal?.sparkles ?? []) {
          const reach = sparkle.r + sparkle.edge / 2;
          assert.ok(sparkle.cx - reach >= panel.x && sparkle.cx + reach <= panel.x + panel.w);
          assert.ok(sparkle.cy - reach >= panel.y && sparkle.cy + reach <= panel.y + panel.h);
          assert.ok(Math.hypot(sparkle.cx - card.dx - card.dw / 2, sparkle.cy - card.dy - card.dh / 2) - reach >= card.dw * .3,
            'the card center stays clear of every star and its outline');
        }
      }
    }
  }
});
