import assert from 'node:assert/strict';
import test from 'node:test';

import { stateAt } from '../browser/v0/core/state/state.mjs';
import { SLATE } from '../browser/v0/policy.mjs';

/**
 * The counting board and the ring, folded out of a timeline.
 *
 * Both are answers about an INSTANT, and that is the whole reason they are
 * folded rather than remembered: a lesson is scrubbed, paused and reloaded
 * mid-question, and a board that only knew how to grow forward would show four
 * cards after a seek back to two. Every test here asks for a t and nothing
 * else.
 *
 * The two carry their instants differently, on purpose. The slate hands out the
 * moment its newest card landed (`sinceMs`), because the pop belongs to the
 * card; the ring hands out the moment the highlight fired (`highlightMs`) per
 * actor, because two things named a second apart ring a second apart.
 */

const PLATE = {
  resolution: [1000, 1000],
  default_zone: 'floor',
  poster: 'bucket/poster.png',
  video: 'bucket/plate.mp4',
  zones: [
    { name: 'floor', depth: 1, scale: 1, surface: 'floor', polygon: [[0, 80], [100, 80], [100, 100], [0, 100]] },
  ],
};

const CLIP = { spritesheet: 'bucket/sheet.png', grid: [2, 1], fps: 4, frames: 2 };
const BUNDLE = {
  storylang_version: 0,
  title: 'slate',
  cast: { rabbit: { height_cm: 20, clips: { idle_right: CLIP } } },
  objects: { numeral_3: { height_cm: 40, svg: 'bucket/three.svg' } },
  audio: { sfx: {}, bgm: {} },
  scenes: [
    { line: 1, place: 'dell', plate: PLATE, steps: [] },
    { line: 20, place: 'dell', plate: PLATE, steps: [] },
  ],
};

function stage(tMs, op, payload, sceneIndex = 0) {
  return {
    t_ms: tMs, source: 'stage', op, scene_index: sceneIndex, line: null, ...payload,
  };
}

function timeline(events) {
  return {
    timeline_version: 1,
    storylang_version: 0,
    title: 'slate',
    duration_ms: 20_000,
    events: [stage(0, 'scene', { place: 'dell' }), ...events],
  };
}

const slateAt = (events, tMs) => stateAt(timeline(events), BUNDLE, tMs).slate;
const actorAt = (events, slug, tMs) => stateAt(timeline(events), BUNDLE, tMs)
  .actors.find((actor) => actor.slug === slug);

const NO_BOARD = { count: 0, mode: 'count', groups: [], sinceMs: 0, from: 0 };
const board = (count, mode, groups, sinceMs, from = 0) => ({
  count, mode, groups, sinceMs, from,
});

test('a story with no lesson in it has an empty board, not a missing one', () => {
  assert.deepEqual(slateAt([], 5_000), NO_BOARD);
});

test('the board holds the arithmetic it was last given, and the instant it landed', () => {
  const events = [stage(1_000, 'slate', { count: 1 }), stage(4_000, 'slate', { count: 2 })];

  assert.deepEqual(slateAt(events, 500), NO_BOARD);
  assert.deepEqual(slateAt(events, 2_000), board(1, 'count', [1], 1_000));
  assert.deepEqual(slateAt(events, 9_000), board(2, 'count', [2], 4_000, 1));
});

test('a step that names only a count is the board that existed before modes did', () => {
  // Every lesson bundle built before this board carries `{count}` and nothing
  // else. It is normalised rather than refused, so one client draws one board
  // from either producer.
  assert.deepEqual(slateAt([stage(1_000, 'slate', { count: 3 })], 5_000), board(3, 'count', [3], 1_000));
});

test('a board carries the groups it was reached from, not just the answer it lands on', () => {
  const joined = [stage(1_000, 'slate', { count: 5, mode: 'add', groups: [2, 3] })];
  const taken = [stage(1_000, 'slate', { count: 3, mode: 'subtract', groups: [5, 2] })];

  assert.deepEqual(slateAt(joined, 5_000), board(5, 'add', [2, 3], 1_000));
  assert.deepEqual(slateAt(taken, 5_000), board(3, 'subtract', [5, 2], 1_000));
});

test('the same arithmetic twice does not land again, so the board does not re-build', () => {
  const events = [
    stage(1_000, 'slate', { count: 5, mode: 'add', groups: [2, 3] }),
    stage(6_000, 'slate', { count: 5, mode: 'add', groups: [2, 3] }),
  ];

  assert.deepEqual(slateAt(events, 9_000), board(5, 'add', [2, 3], 1_000));
});

test('the same total reached a different way IS a new board', () => {
  // Five counted and two-and-three are the same number and different pictures:
  // one is five apples, the other is two red and three green. A fold that
  // compared totals alone would leave the first picture standing.
  const events = [
    stage(1_000, 'slate', { count: 5 }),
    stage(6_000, 'slate', { count: 5, mode: 'add', groups: [2, 3] }),
  ];

  assert.deepEqual(slateAt(events, 9_000), board(5, 'add', [2, 3], 6_000));
});

test('counting on from a smaller count keeps the counters already standing', () => {
  // Four is three and one more. `from` is how many were already there, and the
  // drawer pops only what is new — without it the whole board breathes on every
  // number a lesson counts.
  const events = [stage(1_000, 'slate', { count: 3 }), stage(6_000, 'slate', { count: 4 })];

  assert.deepEqual(slateAt(events, 9_000), board(4, 'count', [4], 6_000, 3));
});

test('a count that shrank builds from nothing, because nothing of it was standing', () => {
  const events = [stage(1_000, 'slate', { count: 5 }), stage(6_000, 'slate', { count: 3 })];

  assert.deepEqual(slateAt(events, 9_000), board(3, 'count', [3], 6_000));
});

test('a take-away after a count is its own build, not a continuation of one', () => {
  const events = [
    stage(1_000, 'slate', { count: 5 }),
    stage(6_000, 'slate', { count: 3, mode: 'subtract', groups: [5, 2] }),
  ];

  assert.deepEqual(slateAt(events, 9_000), board(3, 'subtract', [5, 2], 6_000));
});

test('slate(off) is a count of nothing, and it stays off', () => {
  const events = [stage(1_000, 'slate', { count: 3 }), stage(6_000, 'slate', { count: 0 })];

  assert.deepEqual(slateAt(events, 9_000), { ...NO_BOARD, sinceMs: 6_000 });
});

test('a scene cut clears the board the way it clears the subtitle', () => {
  const events = [
    stage(1_000, 'slate', { count: 3 }),
    stage(6_000, 'scene', { place: 'dell' }, 1),
  ];

  assert.deepEqual(slateAt(events, 9_000), { ...NO_BOARD, sinceMs: 6_000 });
  // And seeking back is the same answer as never having left.
  assert.deepEqual(slateAt(events, 3_000), board(3, 'count', [3], 1_000));
});

test('a count that is not a whole number of counters is refused and said out loud', () => {
  for (const count of [2.5, -1, '3', null]) {
    const state = stateAt(timeline([stage(1_000, 'slate', { count })]), BUNDLE, 5_000);

    assert.deepEqual(state.slate, NO_BOARD, JSON.stringify(count));
    assert.deepEqual(state.warnings, [{
      t_ms: 1_000,
      scene_index: 0,
      line: null,
      type: 'policy',
      policy: 'slate-count-unusable',
      count,
      mode: null,
      groups: null,
    }]);
  }
});

test('a board whose own groups do not make its count is refused, not mended', () => {
  // The board is the answer a child is being shown. A player that quietly drew
  // the five it thought was meant would disagree with the story's own numerals,
  // and nobody would ever say which of the two was wrong.
  const wrong = { count: 6, mode: 'add', groups: [2, 3] };
  const state = stateAt(timeline([stage(1_000, 'slate', wrong)]), BUNDLE, 5_000);

  assert.deepEqual(state.slate, NO_BOARD);
  assert.deepEqual(state.warnings, [{
    t_ms: 1_000, scene_index: 0, line: null, type: 'policy', policy: 'slate-count-unusable', ...wrong,
  }]);
});

test('every shape a board cannot be drawn from is refused', () => {
  const refused = [
    // An arithmetic nobody drew a board for.
    { count: 6, mode: 'multiply', groups: [2, 3] },
    // A join with nothing to join, and a take-away that takes nothing: both are
    // a child watching nothing happen.
    { count: 3, mode: 'add', groups: [3, 0] },
    { count: 3, mode: 'subtract', groups: [3, 0] },
    // Taking everything away lands on 0, and 0 is how `off` is spelled — the
    // board would go away instead of answering.
    { count: 0, mode: 'subtract', groups: [3, 3] },
    // Taking more than there is.
    { count: -1, mode: 'subtract', groups: [2, 3] },
    // Three addends: the board draws two groups, and a third would be a group
    // with no colour of its own.
    { count: 6, mode: 'add', groups: [1, 2, 3] },
    // A plain count with somebody else's groups.
    { count: 3, mode: 'count', groups: [1, 2] },
  ];

  for (const payload of refused) {
    const state = stateAt(timeline([stage(1_000, 'slate', payload)]), BUNDLE, 5_000);

    assert.deepEqual(state.slate, NO_BOARD, JSON.stringify(payload));
    assert.equal(state.warnings.at(0)?.policy, 'slate-count-unusable', JSON.stringify(payload));
  }
});

test('a count past the board own ceiling is refused, not quietly shortened', () => {
  // The drawer's answer to 25 is a board of 20. Accepting it here would leave
  // `slate.count` saying 25 over a picture showing 20, with nothing said.
  const state = stateAt(timeline([stage(1_000, 'slate', { count: SLATE.max + 1 })]), BUNDLE, 5_000);

  assert.deepEqual(state.slate, NO_BOARD);
  assert.equal(state.warnings.at(0)?.policy, 'slate-count-unusable');
  // And the ceiling itself is a legal count, however it is reached.
  assert.equal(slateAt([stage(1_000, 'slate', { count: SLATE.max })], 5_000).count, SLATE.max);
  assert.equal(
    slateAt([stage(1_000, 'slate', { count: SLATE.max, mode: 'add', groups: [10, 10] })], 5_000).count,
    SLATE.max,
  );
  // A subtraction is bounded by what it STARTS with, which is what gets drawn.
  const tooMany = [stage(1_000, 'slate', { count: 1, mode: 'subtract', groups: [SLATE.max + 1, SLATE.max] })];
  assert.deepEqual(slateAt(tooMany, 5_000), NO_BOARD);
});

test('the board a fold hands out cannot be written back into the fold', () => {
  // `groups` is one array living inside the World; a caller keeping the picture
  // and pushing a number into it would change what every later instant answers.
  const held = slateAt([stage(1_000, 'slate', { count: 5, mode: 'add', groups: [2, 3] })], 5_000);
  held.groups.push(9);

  assert.deepEqual(
    slateAt([stage(1_000, 'slate', { count: 5, mode: 'add', groups: [2, 3] })], 5_000).groups,
    [2, 3],
  );
});

test('the ending takes the board away, the way it takes the subtitle', () => {
  const events = [stage(1_000, 'slate', { count: 3 }), stage(8_000, 'end', {})];
  const ended = stateAt(timeline(events), BUNDLE, 9_000);

  assert.equal(ended.ended, true);
  assert.deepEqual(ended.slate, { ...NO_BOARD, sinceMs: 8_000 });
  assert.equal(ended.subtitle, '');
  // The frame before it is still the lesson's answer — the board is cleared at
  // the ending, not retroactively.
  assert.deepEqual(slateAt(events, 7_000), board(3, 'count', [3], 1_000));
});

test('a highlight stamps the actor it names, and nobody else', () => {
  const events = [
    stage(500, 'place', { slug: 'rabbit', x: 40, clip: 'idle_right' }),
    stage(600, 'place_object', { slug: 'numeral_3', x: 60, zone: null }),
    stage(3_000, 'highlight', { slug: 'numeral_3' }),
  ];

  assert.equal(actorAt(events, 'numeral_3', 4_000).highlightMs, 3_000);
  assert.equal(actorAt(events, 'rabbit', 4_000).highlightMs, null);
  // Before it fires there is nothing to draw, which is the seek-backward case.
  assert.equal(actorAt(events, 'numeral_3', 1_000).highlightMs, null);
});

test('a second highlight restarts the ring rather than queueing behind the first', () => {
  const events = [
    stage(500, 'place', { slug: 'rabbit', x: 40, clip: 'idle_right' }),
    stage(1_000, 'highlight', { slug: 'rabbit' }),
    stage(1_200, 'highlight', { slug: 'rabbit' }),
  ];

  assert.equal(actorAt(events, 'rabbit', 2_000).highlightMs, 1_200);
});

test('a scene cut takes the ring with the actor it was on', () => {
  const events = [
    stage(500, 'place', { slug: 'rabbit', x: 40, clip: 'idle_right' }),
    stage(1_000, 'highlight', { slug: 'rabbit' }),
    stage(2_000, 'scene', { place: 'dell' }, 1),
    stage(2_100, 'place', { slug: 'rabbit', x: 40, clip: 'idle_right' }, 1),
  ];

  assert.equal(actorAt(events, 'rabbit', 3_000).highlightMs, null);
});

test('the ending takes the ring too, because the cast is still standing there', () => {
  // `scene` clears the rings by clearing the actors; `end` leaves everybody on
  // stage, so the ring has to be taken off them one at a time or the last frame
  // a lesson freezes on keeps a gold ellipse around its final answer. The page
  // every other client is written from (`docs/embedding.md`) promises exactly
  // this at exactly these two ops.
  const events = [
    stage(500, 'place', { slug: 'rabbit', x: 40, clip: 'idle_right' }),
    stage(7_800, 'highlight', { slug: 'rabbit' }),
    stage(8_000, 'end', {}),
  ];

  assert.equal(actorAt(events, 'rabbit', 8_500).highlightMs, null);
  // The frame before the ending is still ringed — cleared at the op, not
  // retroactively, the same as the board.
  assert.equal(actorAt(events, 'rabbit', 7_900).highlightMs, 7_800);
});

test('a ring around nobody is content the picture is missing, and it says so', () => {
  const state = stateAt(timeline([stage(1_000, 'highlight', { slug: 'fox' })]), BUNDLE, 5_000);

  assert.deepEqual(state.warnings, [{
    t_ms: 1_000, scene_index: 0, line: null, type: 'policy', policy: 'highlight-missing', slug: 'fox',
  }]);
});
