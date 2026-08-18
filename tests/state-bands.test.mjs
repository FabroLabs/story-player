import assert from 'node:assert/strict';
import test from 'node:test';

import { stateAt } from '../browser/v0/core/state/state.mjs';

/**
 * Which band, recovered from the step stream.
 *
 * `place` and `move` carry no band, so a client resolves one from the three
 * rules the engine publishes, and everything visible hangs off the answer: the
 * size a character draws, the line their feet land on, what they are painted in
 * front of, and who they make room for. These are those rules, one at a time,
 * on a plate built so each answer is a different number.
 */

const PLATE = {
  resolution: [1000, 1000],
  default_zone: 'road',
  poster: 'bucket/poster.png',
  video: 'bucket/plate.mp4',
  zones: [
    { name: 'road', depth: 1, scale: 1, surface: 'floor', polygon: [[0, 80], [100, 80], [100, 100], [0, 100]] },
    { name: 'ridge', depth: 3, scale: 0.4, surface: 'floor', polygon: [[20, 40], [60, 40], [60, 50], [20, 50]] },
  ],
};

const CLIP = { spritesheet: 'bucket/sheet.png', grid: [2, 1], fps: 4, frames: 2 };
const BUNDLE = {
  storylang_version: 0,
  title: 'bands',
  cast: {
    ash: { height_cm: 20, clips: { idle_right: CLIP } },
    bracken: { height_cm: 20, clips: { idle_right: CLIP } },
  },
  objects: { lantern: { height_cm: 10, svg: 'bucket/lantern.svg' } },
  audio: { sfx: {}, bgm: {} },
  scenes: [{ line: 1, place: 'path', plate: PLATE, steps: [] }],
};

function timeline(events) {
  return {
    timeline_version: 1,
    storylang_version: 0,
    title: 'bands',
    duration_ms: 9000,
    events: [{ t_ms: 0, source: 'stage', op: 'scene', scene_index: 0, line: 1, place: 'path' }, ...events],
  };
}

function stage(tMs, op, payload) {
  return { t_ms: tMs, source: 'stage', op, scene_index: 0, line: null, ...payload };
}

function step(tMs, cmd, detail) {
  return { t_ms: tMs, source: 'step', kind: 'cmd', cmd, scene_index: 0, line: 2, detail };
}

function put(tMs, slug, x, detail) {
  return [
    step(tMs, 'put', { subjects: [slug], position: 'center', zone: null, beside: null, ...detail }),
    stage(tMs, 'place', { slug, x, clip: 'idle_right' }),
  ];
}

function bandOf(events, slug, tMs = 8000) {
  return stateAt(timeline(events), BUNDLE, tMs).actors.find((actor) => actor.slug === slug);
}

test('a put that names no band gets the plate default', () => {
  const ash = bandOf(put(0, 'ash', 30), 'ash');
  assert.equal(ash.band, 'road');
  assert.equal(ash.heightPx, 200);
  assert.equal(ash.feetY, 90);
});

test('a put that names a band gets that one, with its scale and its stand line', () => {
  const ash = bandOf(put(0, 'ash', 30, { zone: 'ridge' }), 'ash');
  assert.equal(ash.band, 'ridge');
  assert.equal(ash.heightPx, 80);
  assert.equal(ash.feetY, 45);
});

test('a move that names no band keeps the one they are standing in', () => {
  const ash = bandOf([
    ...put(0, 'ash', 30, { zone: 'ridge' }),
    step(1000, 'move', { subjects: ['ash'], target: 'right_edge', zone: null }),
    stage(1000, 'move', { slug: 'ash', x: 55, clip: 'idle_right', duration_ms: 500 }),
    stage(1500, 'settle', { slug: 'ash', clip: 'idle_right' }),
  ], 'ash');
  assert.equal(ash.band, 'ridge');
  assert.equal(ash.heightPx, 80);
});

test('a move that names a band walks into it, changing size and stand line on the way', () => {
  const events = [
    ...put(0, 'ash', 30, { zone: 'ridge' }),
    step(1000, 'move', { subjects: ['ash'], target: 'center', zone: 'road' }),
    stage(1000, 'move', { slug: 'ash', x: 50, clip: 'idle_right', duration_ms: 1000 }),
    stage(2000, 'settle', { slug: 'ash', clip: 'idle_right' }),
  ];
  assert.equal(bandOf(events, 'ash', 1500).heightPx, 140);
  const arrived = bandOf(events, 'ash');
  assert.equal(arrived.band, 'road');
  assert.equal(arrived.heightPx, 200);
  assert.equal(arrived.feetY, 90);
});

// Most `place` ops are arrivals: somebody walked in through a `travel`, and no
// `put` claims them. A band name belongs to the plate it was traced on, so the
// destination answers with its own default.
test('an arrival nobody put anywhere stands on the destination default', () => {
  const ash = bandOf([stage(0, 'place', { slug: 'ash', x: 30, clip: 'idle_right' })], 'ash');
  assert.equal(ash.band, 'road');
  assert.equal(ash.heightPx, 200);
});

test('standing beside somebody means standing at their distance', () => {
  const beside = bandOf([
    ...put(0, 'ash', 30, { zone: 'ridge' }),
    ...put(1000, 'bracken', 30.01, { position: 'ash', beside: 'right' }),
  ], 'bracken');
  assert.equal(beside.band, 'ridge');
  assert.equal(beside.heightPx, 80);
});

test('being put AT somebody joins their band too, without a beside', () => {
  const at = bandOf([
    ...put(0, 'ash', 30, { zone: 'ridge' }),
    ...put(1000, 'bracken', 30, { position: 'ash' }),
  ], 'bracken');
  assert.equal(at.band, 'ridge');
});

test('a prop stands on the band its own op names', () => {
  const lantern = bandOf([
    ...put(0, 'ash', 30),
    stage(1000, 'place_object', { slug: 'lantern', x: 40, zone: 'ridge' }),
  ], 'lantern');
  assert.equal(lantern.band, 'ridge');
  assert.equal(lantern.kind, 'object');
  assert.equal(lantern.heightPx, 40);
  assert.equal(lantern.clip, null);
});

// The board writes `null` for "whatever the plate answers" while a `put` writes
// the default band's NAME. They are the same ground, and the DOM stage grouped
// crowding by the raw key, so an arrival and somebody put on the same band
// never met: in Ruby's forest_glow the two landed on one x and were drawn on
// one pixel. Resolving both to the name is what closes that.
test('an arrival and a put on the default band are the same band, and make room for each other', () => {
  const state = stateAt(timeline([
    stage(0, 'place', { slug: 'ash', x: 50, clip: 'idle_right' }),
    ...put(1000, 'bracken', 50),
  ]), BUNDLE, 2000);
  const [ash, bracken] = ['ash', 'bracken'].map((slug) => state.actors.find((actor) => actor.slug === slug));
  assert.equal(ash.band, bracken.band);
  assert.equal(Math.abs(ash.x - bracken.x), 20, 'two 20%-wide cells were left on one x');
});

// The board reads its own answers, and what it holds for an arrival is `null`
// — "the story said nothing" — not the default band's name. Walking toward
// somebody standing on nothing in particular therefore changes nobody's band.
// Resolving the two into one key here (which crowding needs) and reading the
// anchor off that key is how a walk starts moving people between bands.
test('walking to somebody who arrived on no named band leaves your own band alone', () => {
  const events = [
    stage(0, 'place', { slug: 'ash', x: 70, clip: 'idle_right' }),
    ...put(1000, 'bracken', 30, { zone: 'ridge' }),
    step(2000, 'move', { subjects: ['bracken'], target: 'ash', zone: null }),
    stage(2000, 'move', { slug: 'bracken', x: 70, clip: 'idle_right', duration_ms: 500 }),
    stage(2500, 'settle', { slug: 'bracken', clip: 'idle_right' }),
  ];
  const bracken = bandOf(events, 'bracken');
  assert.equal(bracken.band, 'ridge', 'the walker was dragged onto the arrival band');
  assert.equal(bracken.heightPx, 80);
  // And the arrival is still on the same physical ground as anybody put there,
  // which is what lets the two make room for each other.
  assert.equal(bandOf(events, 'ash').band, 'road');
});

test('a move beside somebody joins their band, not the one named on the step', () => {
  const bracken = bandOf([
    ...put(0, 'ash', 30, { zone: 'ridge' }),
    ...put(500, 'bracken', 80),
    step(2000, 'move', { subjects: ['bracken'], target: 30.01, position: 'ash', beside: 'right', zone: null }),
    stage(2000, 'move', { slug: 'bracken', x: 30.01, clip: 'idle_right', duration_ms: 500 }),
    stage(2500, 'settle', { slug: 'bracken', clip: 'idle_right' }),
  ], 'bracken');
  assert.equal(bracken.band, 'ridge');
});

// A `together` fires its children at one instant, and the compiler resolves
// their anchors against the board as the block FOUND it. So a child standing
// beside somebody another child is moving stands where that character was.
test('inside a together, an anchor is where the block found them', () => {
  const events = [
    ...put(0, 'ash', 30, { zone: 'ridge' }),
    { t_ms: 2000, source: 'step', kind: 'together', scene_index: 0, line: 8, detail: { steps: [] } },
    step(2000, 'move', { subjects: ['ash'], target: 'center', zone: 'road', together_line: 8 }),
    step(2000, 'put', { subjects: ['bracken'], position: 'ash', beside: 'right', zone: null, together_line: 8 }),
    stage(2000, 'move', { slug: 'ash', x: 50, clip: 'idle_right', duration_ms: 500 }),
    stage(2000, 'place', { slug: 'bracken', x: 30.01, clip: 'idle_right' }),
    stage(2500, 'settle', { slug: 'ash', clip: 'idle_right' }),
  ];
  assert.equal(bandOf(events, 'bracken').band, 'ridge', 'the anchor was read after the block moved them');
  assert.equal(bandOf(events, 'ash').band, 'road');
});

test('a band the plate has never heard of is no band at all, not the default', () => {
  const ash = bandOf([
    ...put(0, 'ash', 30),
    step(1000, 'move', { subjects: ['ash'], target: 'center', zone: 'balcony' }),
    stage(1000, 'move', { slug: 'ash', x: 50, clip: 'idle_right', duration_ms: 500 }),
    stage(1500, 'settle', { slug: 'ash', clip: 'idle_right' }),
  ], 'ash');
  assert.equal(ash.band, 'balcony');
  assert.equal(ash.heightPx, 200, 'an untraced band draws at full size');
  assert.equal(ash.feetY, 86, 'and stands on the no-floor line');
});

// Paint order cannot tween, so a walk that changes band switches it at
// whichever end keeps the character right for longer — on departure when they
// are coming toward the camera, on arrival when they are going away, so the
// unavoidable pop lands where the sprite is smallest.
test('a walk toward the camera re-sorts at its start, and away from it at its end', () => {
  const away = [
    ...put(0, 'ash', 30),
    ...put(500, 'bracken', 80, { zone: 'ridge' }),
    step(1000, 'move', { subjects: ['ash'], target: 'center', zone: 'ridge' }),
    stage(1000, 'move', { slug: 'ash', x: 45, clip: 'idle_right', duration_ms: 1000 }),
    stage(2000, 'settle', { slug: 'ash', clip: 'idle_right' }),
  ];
  const order = (events, tMs) => stateAt(timeline(events), BUNDLE, tMs).actors.map((actor) => actor.slug);
  assert.deepEqual(order(away, 1500), ['bracken', 'ash'], 'a walk away re-sorted before it landed');
  assert.deepEqual(order(away, 2000), ['ash', 'bracken']);

  // bracken is placed FIRST here, so that the tie-break inside the near band
  // puts them behind ash and the re-sort is visible at all.
  const toward = [
    ...put(0, 'bracken', 80),
    ...put(500, 'ash', 30, { zone: 'ridge' }),
    step(1000, 'move', { subjects: ['ash'], target: 'center', zone: 'road' }),
    stage(1000, 'move', { slug: 'ash', x: 45, clip: 'idle_right', duration_ms: 1000 }),
    stage(2000, 'settle', { slug: 'ash', clip: 'idle_right' }),
  ];
  assert.deepEqual(order(toward, 999), ['ash', 'bracken']);
  assert.deepEqual(order(toward, 1000), ['bracken', 'ash'], 'a walk toward the camera waited to re-sort');
});

// Farthest band first, so depth 1 lands on top; inside one band, the order
// people arrived. The state hands them over already in paint order.
test('the cast is handed over back to front', () => {
  const state = stateAt(timeline([
    ...put(0, 'ash', 30),
    ...put(1000, 'bracken', 30, { zone: 'ridge' }),
    stage(2000, 'place_object', { slug: 'lantern', x: 80, zone: 'road' }),
  ]), BUNDLE, 3000);
  assert.deepEqual(state.actors.map((actor) => actor.slug), ['bracken', 'ash', 'lantern']);
});

test('a cut empties the stage, and nobody keeps a band across it', () => {
  const state = stateAt({
    ...timeline([...put(0, 'ash', 30, { zone: 'ridge' })]),
    events: [
      ...timeline([...put(0, 'ash', 30, { zone: 'ridge' })]).events,
      { t_ms: 5000, source: 'stage', op: 'scene', scene_index: 0, line: 9, place: 'path' },
    ],
  }, BUNDLE, 6000);
  assert.deepEqual(state.actors, []);
});
