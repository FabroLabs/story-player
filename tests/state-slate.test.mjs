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

test('a story with no lesson in it has an empty board, not a missing one', () => {
  assert.deepEqual(slateAt([], 5_000), { count: 0, sinceMs: 0 });
});

test('the board holds the count it was last given, and the instant it landed', () => {
  const events = [stage(1_000, 'slate', { count: 1 }), stage(4_000, 'slate', { count: 2 })];

  assert.deepEqual(slateAt(events, 500), { count: 0, sinceMs: 0 });
  assert.deepEqual(slateAt(events, 2_000), { count: 1, sinceMs: 1_000 });
  assert.deepEqual(slateAt(events, 9_000), { count: 2, sinceMs: 4_000 });
});

test('a count that repeats does not land again, so the card already there does not re-pop', () => {
  const events = [stage(1_000, 'slate', { count: 2 }), stage(6_000, 'slate', { count: 2 })];

  assert.deepEqual(slateAt(events, 9_000), { count: 2, sinceMs: 1_000 });
});

test('taking away lands the new top card, because it is the answer now', () => {
  const events = [stage(1_000, 'slate', { count: 5 }), stage(6_000, 'slate', { count: 3 })];

  assert.deepEqual(slateAt(events, 9_000), { count: 3, sinceMs: 6_000 });
});

test('slate(off) is a count of nothing, and it stays off', () => {
  const events = [stage(1_000, 'slate', { count: 3 }), stage(6_000, 'slate', { count: 0 })];

  assert.deepEqual(slateAt(events, 9_000), { count: 0, sinceMs: 6_000 });
});

test('a scene cut clears the board the way it clears the subtitle', () => {
  const events = [
    stage(1_000, 'slate', { count: 3 }),
    stage(6_000, 'scene', { place: 'dell' }, 1),
  ];

  assert.deepEqual(slateAt(events, 9_000), { count: 0, sinceMs: 6_000 });
  // And seeking back is the same answer as never having left.
  assert.deepEqual(slateAt(events, 3_000), { count: 3, sinceMs: 1_000 });
});

test('a count that is not a whole number of cards is refused and said out loud', () => {
  for (const count of [2.5, -1, '3', null]) {
    const state = stateAt(timeline([stage(1_000, 'slate', { count })]), BUNDLE, 5_000);

    assert.deepEqual(state.slate, { count: 0, sinceMs: 0 }, JSON.stringify(count));
    assert.deepEqual(state.warnings, [{
      t_ms: 1_000, scene_index: 0, line: null, type: 'policy', policy: 'slate-count-unusable', count,
    }]);
  }
});

test('a count past the board own ceiling is refused, not quietly shortened', () => {
  // The drawer's answer to 25 is a board of 20. Accepting it here would leave
  // `slate.count` saying 25 over a picture showing 20, with nothing said.
  const state = stateAt(timeline([stage(1_000, 'slate', { count: SLATE.max + 1 })]), BUNDLE, 5_000);

  assert.deepEqual(state.slate, { count: 0, sinceMs: 0 });
  assert.deepEqual(state.warnings, [{
    t_ms: 1_000,
    scene_index: 0,
    line: null,
    type: 'policy',
    policy: 'slate-count-unusable',
    count: SLATE.max + 1,
  }]);
  // And the ceiling itself is a legal count.
  assert.equal(slateAt([stage(1_000, 'slate', { count: SLATE.max })], 5_000).count, SLATE.max);
});

test('the ending takes the board away, the way it takes the subtitle', () => {
  const events = [stage(1_000, 'slate', { count: 3 }), stage(8_000, 'end', {})];
  const ended = stateAt(timeline(events), BUNDLE, 9_000);

  assert.equal(ended.ended, true);
  assert.deepEqual(ended.slate, { count: 0, sinceMs: 8_000 });
  assert.equal(ended.subtitle, '');
  // The frame before it is still the lesson's answer — the board is cleared at
  // the ending, not retroactively.
  assert.deepEqual(slateAt(events, 7_000), { count: 3, sinceMs: 1_000 });
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
