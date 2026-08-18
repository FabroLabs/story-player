import assert from 'node:assert/strict';
import test from 'node:test';

import { stateAt } from '../browser/v0/core/state/state.mjs';

/**
 * What the picture says when it cannot do as it is told.
 *
 * The DOM stage had somewhere to complain: every one of these was a `#warn`
 * into the event log. A pure function has nowhere, so it hands the sentences
 * back with the picture — and the ones that mean the timeline and the bundle do
 * not belong together are refused outright, because a plausible-looking wrong
 * picture is worse than no picture at all.
 */

const PLATE = {
  resolution: [1000, 1000],
  default_zone: 'road',
  poster: 'bucket/poster.png',
  video: 'bucket/plate.mp4',
  zones: [{ name: 'road', depth: 1, scale: 1, surface: 'floor', polygon: [[0, 80], [100, 80], [100, 100], [0, 100]] }],
};

const CLIP = { spritesheet: 'bucket/sheet.png', grid: [2, 1], fps: 4, frames: 2 };
const BUNDLE = {
  storylang_version: 0,
  title: 'refusals',
  cast: { ash: { height_cm: 20, clips: { idle_right: CLIP } } },
  objects: {},
  audio: { sfx: {}, bgm: {} },
  scenes: [{ line: 1, place: 'path', plate: PLATE, steps: [] }],
};

function timeline(events, overrides = {}) {
  return {
    timeline_version: 1,
    storylang_version: 0,
    title: 'refusals',
    duration_ms: 5000,
    events: [{ t_ms: 0, source: 'stage', op: 'scene', scene_index: 0, line: 1, place: 'path' }, ...events],
    ...overrides,
  };
}

function stage(tMs, op, payload) {
  return { t_ms: tMs, source: 'stage', op, scene_index: 0, line: 7, ...payload };
}

const PLACE = stage(0, 'place', { slug: 'ash', x: 30, clip: 'idle_right' });

function at(events, tMs = 4000, overrides = {}) {
  return stateAt(timeline(events, overrides), BUNDLE, tMs);
}

test('a timeline of a version this player cannot read is refused, not misread', () => {
  assert.throws(() => at([PLACE], 1000, { timeline_version: 2 }), /timeline_version/);
  assert.throws(() => at([PLACE], 1000, { storylang_version: 1 }), /not built from each other/);
});

// A cached timeline against a rebuilt bundle with one scene inserted gives
// every later scene the wrong plate — and since band names belong to the plate
// they were traced on, the whole cast then draws at scale 1 on the no-floor
// line with no depth and no crowding. It looks like a picture. It is not one.
test('a timeline and a bundle that were not built from each other are refused', () => {
  assert.throws(
    () => stateAt(timeline([PLACE], {
      events: [{ t_ms: 0, source: 'stage', op: 'scene', scene_index: 0, line: 1, place: 'meadow' }, PLACE],
    }), BUNDLE, 1000),
    /compiled from a different story/,
  );
});

test('a t that is not a number is refused rather than answered with the opening frame', () => {
  assert.throws(() => at([PLACE], Number.NaN), /finite number of milliseconds/);
  // Called straight, so the missing argument really is missing.
  assert.throws(() => stateAt(timeline([PLACE]), BUNDLE), /finite number of milliseconds/);
  // A negative t is not a mistake, it is before the beginning.
  assert.equal(at([PLACE], -500).actors.length, 1);
});

test('an op with no usable x moves nobody, and says so', () => {
  const state = at([PLACE, stage(1000, 'move', { slug: 'ash', clip: 'idle_right', duration_ms: 500 })]);
  assert.equal(state.actors[0].x, 30, 'a walk to nowhere dragged the character off their mark');
  assert.deepEqual(state.warnings, [{
    t_ms: 1000, scene_index: 0, line: 7, type: 'policy', policy: 'position-unusable', op: 'move', slug: 'ash', x: null,
  }]);
});

// The one that already shipped once: a ride is aimed by the WALK, and a walk to
// a target the board could not place carries no x, so the camera used to be cut
// out of its move and left wide for the rest of the scene without a word.
test('a camera op that resolves to no framing leaves the camera where it was, and says so', () => {
  const state = at([PLACE, stage(500, 'shot', { size: 'close', x: 20, y: 90, scale: 2 }), stage(1000, 'pan', { speed: 'slow', duration_ms: null })]);
  assert.deepEqual(state.camera, { scale: 2, x: -20, y: -90 });
  assert.equal(state.warnings.length, 1);
  assert.equal(state.warnings[0].policy, 'camera-framing-unusable');
  assert.equal(state.warnings[0].t_ms, 1000);
});

test('a shot size the vocabulary does not carry is refused by name', () => {
  const state = at([PLACE, stage(1000, 'shot', { size: 'enormous', x: 20, y: 90, scale: 9 })]);
  assert.deepEqual(state.camera, { scale: 1, x: 0, y: 0 });
  assert.deepEqual(state.warnings.map((warning) => [warning.policy, warning.size]), [['camera-shot-size-unknown', 'enormous']]);
});

// An op this player has no meaning for is content the picture is missing while
// every other client draws it — the compiler refuses unknown step kinds for the
// same reason.
test('an op this player does not know is named rather than shrugged at', () => {
  const state = at([PLACE, stage(1000, 'rumble', { intensity: 3 })]);
  assert.deepEqual(state.warnings.map((warning) => [warning.policy, warning.op]), [['unknown-op', 'rumble']]);
});

test('a clip absent from the bundle keeps the pose, names the clip, and clears when it can', () => {
  const missing = [PLACE, stage(1000, 'clip', { slug: 'ash', clip: 'astonished_left' })];
  const state = at(missing);
  assert.equal(state.actors[0].clip, 'idle_right');
  assert.equal(state.actors[0].clipMissing, true);
  assert.deepEqual(state.warnings.map((warning) => [warning.asset, warning.clip]), [['sprite-clip', 'astonished_left']]);
  // Asking again for the clip already on screen is not a failure to report.
  const recovered = at([...missing, stage(2000, 'clip', { slug: 'ash', clip: 'idle_right' })]);
  assert.equal(recovered.actors[0].clipMissing, false);
  assert.equal(recovered.warnings.length, 1, 'the recovery re-reported the original failure');
});

// The reason the guard exists: `spreadAlongBand` propagates one NaN into the
// clamp correction, which is then added to every movable occupant of the band.
test('one unusable x cannot take a whole band down with it', () => {
  const state = at([
    PLACE,
    stage(1000, 'place', { slug: 'ash', x: 30, clip: 'idle_right' }),
    stage(2000, 'depart', { slug: 'ash', x: null, y: 97, clip: 'idle_right', duration_ms: 400 }),
  ]);
  assert.equal(state.actors.length, 1);
  assert.equal(state.actors[0].x, 30);
  assert.ok(Number.isFinite(state.actors[0].feetY));
});
