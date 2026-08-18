import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';

/**
 * The rules the parity corpus cannot reach.
 *
 * Byte equality with seven published timelines (`compile-timeline.test.mjs`)
 * proves the happy path and nothing else: across all seven, every motion runs
 * to completion, every `travel` carries an explicit anchor, no camera is aimed
 * at nobody, no shot is `medium`, no portal anchor appears, and the only
 * warning any of them fires is `facing-fallback`. Every refusal in the compiler
 * is therefore dead in the corpus — and a refusal that softens back into a
 * default ships green.
 *
 * So these are the cases the deleted director suite pinned, re-aimed at the
 * compiler: the input is a hand-built v0 bundle and the assertion is the event
 * stream, which is the artifact clients actually read. Three of that suite's
 * cases pinned the band argument handed to the DOM renderer — the timeline
 * carries no band on `place` or `move`, by design — and belong with the stage
 * that draws it, not here.
 */

const compile = (story) => compileTimeline(story).events;
const ops = (events, op) => events.filter((event) => event.op === op);
const warnings = (events) => events
  .filter((event) => event.kind === 'warning')
  .map((event) => event.detail);

// --- fixtures --------------------------------------------------------------

function baseStory(steps) {
  const character = {
    height_cm: 12,
    capability: {
      idle: { camera: 'idle' },
      happy: { camera: 'happy' },
      move: { left: 'move-left', right: 'move-right' },
    },
    clips: { idle: {}, happy: {}, 'move-left': {}, 'move-right': {} },
  };
  return {
    storylang_version: 0,
    title: 'Rules',
    cast: { ruby: character, clover: character },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      line: 1,
      place: 'dell',
      plate: { resolution: [1920, 1080], zones: [floorZone('floor', [[0, 80], [100, 80], [100, 100], [0, 100]])], default_zone: 'floor' },
      steps,
    }],
  };
}

// Two bands, so "the one you are in" and "the plate's default" are different
// answers and a test can tell them apart. Front stands at y 90, back at 62.5.
function bandedStory(steps) {
  const story = baseStory(steps);
  story.scenes[0].plate = {
    resolution: [1920, 1080],
    default_zone: 'front',
    zones: [
      { ...floorZone('front', [[0, 80], [100, 80], [100, 100], [0, 100]]), depth: 1, scale: 1 },
      { ...floorZone('back', [[40, 60], [60, 60], [60, 65], [40, 65]]), depth: 2, scale: 0.5 },
    ],
  };
  return story;
}

function floorZone(name, polygon) {
  return { name, surface: 'floor', description: '', polygon, depth: null, scale: null };
}

function put(line, slug, position, extra = {}) {
  return { kind: 'cmd', line, cmd: 'put', subjects: [slug], position, facing: null, ...extra };
}

// --- the walk, and what a `together` shares --------------------------------

test('characters moving toward each other resolve from one pre-together snapshot', () => {
  // Both walks read the board as it was BEFORE the block, so neither of them
  // walks to where the other has just arrived. Run both authored orders: a
  // live board would give the second mover a different answer.
  const moves = (order) => {
    const story = baseStory([
      put(2, 'ruby', 'left_third'),
      put(3, 'clover', 'right_third'),
      { kind: 'together', line: 4, steps: order.map((slug, index) => ({
        kind: 'cmd', line: 5 + index, cmd: 'move', subjects: [slug], target: slug === 'ruby' ? 'clover' : 'ruby',
      })) },
    ]);
    return Object.fromEntries(ops(compile(story), 'move').map((event) => [event.slug, event.x]));
  };

  assert.deepEqual(moves(['ruby', 'clover']), { ruby: 70, clover: 30 });
  assert.deepEqual(moves(['clover', 'ruby']), { ruby: 70, clover: 30 });
});

test('simultaneous placement and emotion combine independently of child order', () => {
  // `togetherStepKey` sorts `emote` into a later phase than every positional
  // command, so the authored emotion survives the placement whichever way round
  // the block was written. The last clip a character is given is the one that
  // sticks, and it must be the emotion.
  const lastClip = (order) => {
    const children = {
      put: put(3, 'ruby', 'right_third'),
      emote: { kind: 'cmd', line: 4, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: null },
    };
    const events = compile(baseStory([
      put(2, 'ruby', 'left_third'),
      { kind: 'together', line: 3, steps: order.map((name) => children[name]) },
    ]));
    return events.filter((event) => event.op === 'place' || event.op === 'clip').at(-1).clip;
  };

  assert.equal(lastClip(['put', 'emote']), 'happy');
  assert.equal(lastClip(['emote', 'put']), 'happy');
});

test('simultaneous travel takes its arrival slots by slug, not by child order', () => {
  const arrivals = (order) => {
    const story = baseStory([
      put(2, 'ruby', 'left_third'),
      put(3, 'clover', 'right_third'),
      { kind: 'together', line: 4, steps: order.map((slug) => ({
        kind: 'cmd', line: slug === 'ruby' ? 5 : 6, cmd: 'travel', subjects: [slug],
        destination: 'grove', exit_anchor_pct: [100, 80],
      })) },
    ]);
    story.scenes.push({ ...story.scenes[0], line: 7, place: 'grove', steps: [] });
    const events = compile(story);
    const grove = events.filter((event) => event.scene_index === 1 && event.op === 'place');
    return Object.fromEntries(grove.map((event) => [event.slug, event.x]));
  };

  assert.deepEqual(arrivals(['ruby', 'clover']), { clover: 30, ruby: 70 });
  assert.deepEqual(arrivals(['clover', 'ruby']), { clover: 30, ruby: 70 });
});

test('a simultaneous emote faces from the pre-move subject position', () => {
  const story = baseStory([
    put(2, 'ruby', 'left_third'),
    put(3, 'clover', 'right_third'),
    { kind: 'together', line: 4, steps: [
      { kind: 'cmd', line: 5, cmd: 'move', subjects: ['ruby'], target: 'right_edge' },
      { kind: 'cmd', line: 6, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: 'clover' },
    ] },
  ]);
  story.cast.ruby.capability.happy = { left: 'happy-left', right: 'happy-right' };
  story.cast.ruby.clips['happy-left'] = {};
  story.cast.ruby.clips['happy-right'] = {};

  assert.equal(ops(compile(story), 'clip').at(-1).clip, 'happy-right');
});

test('a follow shares a together with the move it rides, and is applied first', () => {
  // The ride is set up by `follow` and consumed by the walk, so the order the
  // block applies its children is load-bearing: `togetherStepKey` sorts by
  // command name and 'follow' < 'move'. Applied the other way round, the walk
  // emits no `pan` at all and the ride silently starts one walk late.
  const events = compile(baseStory([
    put(2, 'ruby', 'left_third'),
    put(3, 'clover', 'right_third'),
    { kind: 'together', line: 4, steps: [
      { kind: 'cmd', line: 6, cmd: 'move', subjects: ['ruby'], target: 'clover', beside: 'left', zone: null },
      { kind: 'cmd', line: 5, cmd: 'follow', subjects: [], target: 'ruby' },
    ] },
  ]));

  const ride = ops(events, 'pan');
  assert.equal(ride.length, 1, 'the follow did not ride the walk it shares a block with');
  assert.deepEqual(
    { x: ride[0].x, speed: ride[0].speed },
    { x: ops(events, 'move')[0].x, speed: null },
  );
});

// --- which band a side word is measured against ----------------------------

test('a walk that names no band stays in the band the character is standing in', () => {
  // The board's own rule is "a move that names no band leaves the character in
  // the one they are in". Resolve the plate default before the board sees the
  // null and the rule can never fire: ruby is silently re-banded to the front
  // and walks to the FRONT's left_third instead of the back band's.
  const events = compile(bandedStory([
    put(2, 'ruby', 'center', { zone: 'back' }),
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'left_third', zone: null },
  ]));

  // left_third of the back band (x 40..60) is 46, not left_third of the frame
  assert.equal(Math.round(ops(events, 'move')[0].x), 46);
});

test('a put stages against the plate own floor, including a place no scene opens', () => {
  // Every full-width fixture makes floor-relative and plate-relative x
  // identical, so the whole span wiring is invisible unless a plate is inset.
  // The dell's floor runs 20..80, the grove's 0..50.
  const story = baseStory([
    put(2, 'ruby', 'left_edge'),
    // A healed travel-of-the-never-placed: the put names a place the story
    // never opens a scene at, so its floor is looked up, not inherited.
    put(3, 'clover', 'center', { place: 'grove' }),
  ]);
  story.scenes[0].plate.zones = [floorZone('floor', [[20, 80], [80, 80], [80, 100], [20, 100]])];
  story.scenes.push({
    line: 9,
    place: 'grove',
    plate: { resolution: [1920, 1080], zones: [floorZone('floor', [[0, 80], [50, 80], [50, 100], [0, 100]])], default_zone: 'floor' },
    steps: [],
  });

  const placed = Object.fromEntries(ops(compile(story), 'place').map((event) => [event.slug, event.x]));
  assert.equal(placed.ruby, 26); // 20 + 0.1 * 60, not the plate's 10
  assert.equal(placed.clover, 25); // the grove's own centre, not the dell's 50
});

test('a character turns toward where the addressed zone actually is', () => {
  // A floor pinned to the right half: left_edge is x=59 and center is x=75, so
  // a subject at left_edge must turn RIGHT to address center. Measured off
  // plate width the same zones are 10 and 50, and it would turn left.
  const story = baseStory([
    put(2, 'ruby', 'left_edge'),
    { kind: 'cmd', line: 3, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: 'center' },
  ]);
  story.scenes[0].plate.zones = [floorZone('floor', [[55, 80], [95, 80], [95, 100], [55, 100]])];
  story.cast.ruby.capability.happy = { left: 'happy-left', right: 'happy-right' };
  story.cast.ruby.clips['happy-left'] = {};
  story.cast.ruby.clips['happy-right'] = {};

  assert.equal(ops(compile(story), 'clip')[0].clip, 'happy-right');
});

// --- how long anything takes ----------------------------------------------

test('movement and default departure use the published v0 timing policy', () => {
  const story = baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'right_edge', zone: null },
    put(4, 'clover', 'center', { zone: null }),
    { kind: 'cmd', line: 5, cmd: 'move', subjects: ['clover'], target: 'center', zone: null },
    { kind: 'cmd', line: 6, cmd: 'move', subjects: ['clover'], target: 'left_edge', zone: null },
    put(7, 'owl', 'center', { zone: null }),
    { kind: 'cmd', line: 8, cmd: 'travel', subjects: ['ruby'], destination: 'grove', exit_anchor_pct: null },
    { kind: 'cmd', line: 9, cmd: 'travel', subjects: ['clover'], destination: 'grove', exit_anchor_pct: null },
    { kind: 'cmd', line: 10, cmd: 'travel', subjects: ['owl'], destination: 'grove', exit_anchor_pct: [50, 80] },
  ]);
  story.cast.owl = story.cast.ruby;
  const events = compile(story);

  assert.deepEqual(ops(events, 'move').map((event) => event.duration_ms), [1818, 250, 1818]);
  assert.deepEqual(
    ops(events, 'depart').map(({ slug, x, y, duration_ms: ms }) => ({ slug, x, y, ms })),
    [
      // no anchor and standing right of centre: out through the right edge,
      // on the stand line the plate's own floor answers with
      { slug: 'ruby', x: 108, y: 90, ms: 818 },
      { slug: 'clover', x: -8, y: 90, ms: 818 },
      // an anchor it is already standing on still costs the shortest walk-off
      { slug: 'owl', x: 50, y: 80, ms: 350 },
    ],
  );
});

test('a scene end waits for a walk-off, and the wait is what makes the story longer', () => {
  const story = baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'travel', subjects: ['ruby'], destination: 'grove', exit_anchor_pct: [72, 90] },
  ]);
  const timeline = compileTimeline(story);

  // 22 x-percent per second, so 22 percent of walk is exactly one second — and
  // the story is that second long, which is only true because the scene waited.
  assert.equal(ops(timeline.events, 'depart')[0].duration_ms, 1000);
  assert.equal(ops(timeline.events, 'exit')[0].t_ms, 1000);
  assert.equal(timeline.duration_ms, 1000);
  assert.deepEqual(warnings(timeline.events), []);
});

test('a scene end gives up at the published five-second deadline and says so', () => {
  // 250 x-percent of walk is 11.4 seconds, so the deadline lands first. The
  // scene closes on the warning, the walk-off never arrives, and the next
  // scene's cut cancels it — so there is no `exit` at all.
  const story = baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'travel', subjects: ['ruby'], destination: 'grove', exit_anchor_pct: [-200, 90] },
  ]);
  story.scenes.push({ ...story.scenes[0], line: 9, place: 'grove', steps: [] });
  const timeline = compileTimeline(story);

  const deadline = timeline.events.find((event) => event.kind === 'warning');
  assert.deepEqual(deadline.detail, {
    type: 'media', asset: 'travel', message: 'scene departure deadline reached',
  });
  assert.equal(deadline.t_ms, 5000);
  assert.deepEqual({ scene: deadline.scene_index, line: deadline.line }, { scene: 0, line: 1 });
  assert.deepEqual(ops(timeline.events, 'exit'), []);
  // and the abandoned walk's own timer never moves the clock again
  assert.equal(timeline.duration_ms, 5000);
});

// --- what the camera is told ----------------------------------------------

test('a camera aiming at somebody reads the band they are actually standing on', () => {
  // Handed the plate's DEFAULT band for both axes, a character on the back road
  // is framed on the near floor's stand line at their x — several percent low,
  // and then magnified. Front stands at y 90 here, back at 62.5.
  const events = compile(bandedStory([
    put(2, 'ruby', 'center', { zone: 'back' }),
    { kind: 'cmd', line: 3, cmd: 'push_in', subjects: [], target: 'ruby', speed: 'slow' },
  ]));

  assert.deepEqual(
    ops(events, 'push_in').map(({ x, y, speed }) => ({ x, y, speed })),
    [{ x: 50, y: 62.5, speed: 'slow' }],
  );
});

test('a shot is sized by the band its subject is standing on', () => {
  // The close-up ceiling hides this whenever the subject is small, so the
  // fixture is a 40 cm character: 400 px at the front, 200 px on the half-scale
  // band, which is 1.28x against 2.56x — both under the ceiling, so dropping
  // the band from the lookup changes the answer instead of being clamped into
  // agreement. `medium` is resolved the same way; it used to be a flat 1.25 for
  // everybody, which made a close-up on the big cast come out WIDER than a
  // medium on the same character.
  const story = bandedStory([
    put(2, 'ruby', 'center', { zone: 'back' }),
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'medium', target: 'ruby' },
  ]);
  story.cast.ruby = { ...story.cast.ruby, height_cm: 40 };

  assert.deepEqual(
    ops(compile(story), 'shot').map(({ size, scale }) => [size, scale]),
    [['close', 2.56], ['medium', 1.28]],
  );
});

test('a shot inside a together is sized by the band its subject is arriving on', () => {
  // `move` sorts before `shot` and the subject is already standing on the band
  // it has just arrived on. Measured against the block's snapshot instead, a
  // 40 cm character drawn 400 px at the front is framed as if still 200 px:
  // 400 x 2.56 = 1024 px in a 1080 px frame, and on a deeper band, cropped.
  const story = bandedStory([
    put(2, 'ruby', 'center', { zone: 'back' }),
    { kind: 'together', line: 3, steps: [
      { kind: 'cmd', line: 4, cmd: 'move', subjects: ['ruby'], target: 'left_third', zone: 'front' },
      { kind: 'cmd', line: 5, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
    ] },
  ]);
  story.cast.ruby = { ...story.cast.ruby, height_cm: 40 };

  assert.equal(ops(compile(story), 'shot')[0].scale, 1.28);
});

test('a side word is still measured across the default band, whoever is elsewhere', () => {
  // The other half of the same rule: a side has no band of its own, so
  // `left_third` means the same thing to the camera wherever the cast is.
  const events = compile(bandedStory([
    put(2, 'ruby', 'center', { zone: 'back' }),
    { kind: 'cmd', line: 3, cmd: 'pan_to', subjects: [], target: 'left_third', speed: null },
  ]));

  // left_third of the full-width front band is 30; across the back band it
  // would be 46
  assert.deepEqual(
    ops(events, 'pan').map(({ x, speed, duration_ms: ms }) => ({ x, speed, ms })),
    [{ x: 30, speed: 'slow', ms: null }],
  );
});

test('a wide frames nobody, and every camera command carries its speed', () => {
  const events = compile(baseStory([
    put(2, 'ruby', 'center'),
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'wide', target: null },
    { kind: 'cmd', line: 4, cmd: 'pan_to', subjects: [], target: 'ruby', speed: 'medium' },
    // every command that takes a speed, with the speed left unnamed
    { kind: 'cmd', line: 5, cmd: 'push_in', subjects: [], target: 'ruby', speed: null },
    { kind: 'cmd', line: 6, cmd: 'pan_to', subjects: [], target: 'ruby', speed: null },
    { kind: 'cmd', line: 7, cmd: 'pull_out', subjects: [], speed: null },
  ]));

  assert.deepEqual(
    events.filter((event) => ['shot', 'pan', 'push_in', 'pull_out'].includes(event.op))
      .map(({ op, x, y, size, scale, speed }) => ({ op, x, y, size, scale, speed })),
    [
      { op: 'shot', x: null, y: null, size: 'wide', scale: 1, speed: undefined },
      { op: 'pan', x: 50, y: undefined, size: undefined, scale: undefined, speed: 'medium' },
      // an unnamed speed is slow, in the compiler as in the language
      { op: 'push_in', x: 50, y: 90, size: undefined, scale: undefined, speed: 'slow' },
      { op: 'pan', x: 50, y: undefined, size: undefined, scale: undefined, speed: 'slow' },
      { op: 'pull_out', x: undefined, y: undefined, size: undefined, scale: undefined, speed: 'slow' },
    ],
  );
});

test('a portal anchor is checked like every other aim, not trusted for being pre-resolved', () => {
  // `target_pct` is copied out of the catalog with no shape check, and it
  // shares the finiteness guard with every other target. Skipping it puts one
  // non-number into the framing, which every later pan then reads back out.
  const events = compile(baseStory([
    { kind: 'cmd', line: 2, cmd: 'push_in', subjects: [], target: 'far_path', target_pct: [61.5], speed: 'slow' },
    { kind: 'cmd', line: 3, cmd: 'push_in', subjects: [], target: 'near_path', target_pct: [40, 88], speed: 'slow' },
  ]));

  assert.deepEqual(
    ops(events, 'push_in').map(({ x, y }) => ({ x, y })),
    [{ x: 40, y: 88 }],
    'a half-written portal anchor reached the camera',
  );
  assert.deepEqual(warnings(events), [
    { type: 'policy', policy: 'camera-target-unresolved', cmd: 'push_in', target: 'far_path' },
  ]);
});

test('follow(off) releases the ride and never reaches cast resolution', () => {
  const events = compile(baseStory([
    put(2, 'ruby', 'center'),
    { kind: 'cmd', line: 3, cmd: 'follow', subjects: [], target: 'ruby' },
    { kind: 'cmd', line: 4, cmd: 'follow', subjects: [], target: 'off' },
    { kind: 'cmd', line: 5, cmd: 'move', subjects: ['ruby'], target: 'right_edge', zone: null },
  ]));

  // a released follow rides nothing, so the walk after it emits no `pan`
  assert.deepEqual(ops(events, 'pan'), []);
  // and `off` is a word, not a character: it never reaches cast resolution, so
  // it cannot warn that the camera is aimed at somebody who is not there
  assert.deepEqual(warnings(events).filter((detail) => detail.type === 'policy'), []);
});

test('a camera aimed at nobody warns once, under one name for all four commands', () => {
  const events = compile(baseStory([
    { kind: 'cmd', line: 2, cmd: 'push_in', subjects: [], target: 'nobody', speed: 'slow' },
    { kind: 'cmd', line: 3, cmd: 'pan_to', subjects: [], target: 'nobody', speed: null },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'close', target: 'nobody' },
    { kind: 'cmd', line: 5, cmd: 'follow', subjects: [], target: 'nobody' },
  ]));

  assert.deepEqual(
    events.filter((event) => event.source === 'stage' && event.op !== 'scene'
      && event.op !== 'subtitle' && event.op !== 'camera_reset' && event.op !== 'end'),
    [],
    'the camera moved toward somebody who is not there',
  );
  assert.deepEqual(warnings(events), [
    { type: 'policy', policy: 'camera-target-unresolved', cmd: 'push_in', target: 'nobody' },
    { type: 'policy', policy: 'camera-target-unresolved', cmd: 'pan_to', target: 'nobody' },
    { type: 'policy', policy: 'camera-target-unresolved', cmd: 'shot', target: 'nobody' },
    { type: 'policy', policy: 'camera-target-unresolved', cmd: 'follow', target: 'nobody' },
  ]);
});

test('a subject nobody measured is refused, not framed at maximum magnification', () => {
  // Without a height the sprite falls to its 72 px legibility floor — a number
  // chosen for DRAWING a tiny character readably — and framing 72 px at source
  // size asks for the ceiling. An unmeasured character would get the tightest
  // shot in the language, silently, on no evidence at all.
  const story = baseStory([
    put(2, 'ruby', 'center'),
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
  ]);
  story.cast.ruby = { ...story.cast.ruby, height_cm: null };

  const events = compile(story);
  assert.deepEqual(ops(events, 'shot'), [], 'an unmeasured subject was framed anyway');
  assert.deepEqual(warnings(events), [
    { type: 'policy', policy: 'camera-subject-unmeasured', cmd: 'shot', target: 'ruby' },
  ]);
});

test('a shot size the player does not know is refused, not quietly widened', () => {
  // `SHOT_SIZES[size] ?? wide` answers a close-up with an unchanged wide and no
  // warning — and `SHOT_SIZES.constructor` is a FUNCTION, which `??` never
  // rescues, so a prototype name reaches the framing as scale NaN. The size is
  // what the command MEANS, so an unreadable one performs nothing.
  const events = compile(baseStory([
    put(2, 'ruby', 'center'),
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'closeup', target: 'ruby' },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'constructor', target: 'ruby' },
  ]));

  assert.deepEqual(ops(events, 'shot'), [], 'an unknown shot size still moved the camera');
  assert.deepEqual(warnings(events), [
    { type: 'policy', policy: 'camera-shot-size-unknown', cmd: 'shot', size: 'closeup' },
    { type: 'policy', policy: 'camera-shot-size-unknown', cmd: 'shot', size: 'constructor' },
  ]);
});

test('a camera speed the language does not have is said out loud, then paced slow', () => {
  // `fast` was removed from the language and from the duration table with it,
  // and then absorbed at playback as slow with no warning: a hand-made bundle
  // carrying it played, and the timeline published `speed: "fast"` against a
  // table with no such row. Unlike a size, a speed is only pacing, so the move
  // still happens — at the language's default.
  const events = compile(baseStory([
    put(2, 'ruby', 'center'),
    { kind: 'cmd', line: 3, cmd: 'push_in', subjects: [], target: 'ruby', speed: 'fast' },
    { kind: 'cmd', line: 4, cmd: 'pull_out', subjects: [], speed: 'toString' },
  ]));

  assert.deepEqual(
    events.filter((event) => event.op === 'push_in' || event.op === 'pull_out')
      .map(({ op, speed }) => [op, speed]),
    [['push_in', 'slow'], ['pull_out', 'slow']],
  );
  assert.deepEqual(warnings(events), [
    { type: 'policy', policy: 'camera-speed-unknown', cmd: 'push_in', speed: 'fast' },
    { type: 'policy', policy: 'camera-speed-unknown', cmd: 'pull_out', speed: 'toString' },
  ]);
});

// --- one motion per character ---------------------------------------------

test('an emotion during a walk suppresses the settle it would have wiped', () => {
  // The settle is recorded WHEN IT HAPPENS, never promised on the move. Promise
  // it, and a client replaying the promise wipes the authored emotion 1.8 s
  // into the walk — which is the whole reason `emote` sorts last in a block.
  const events = compile(baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'right_edge', zone: null },
    { kind: 'cmd', line: 4, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: null },
  ]));

  assert.equal(ops(events, 'move').length, 1);
  assert.deepEqual(ops(events, 'settle'), [], 'a cancelled walk still promised its settle');
  assert.equal(ops(events, 'clip').at(-1).clip, 'happy');
});

test('a character put back on stage mid-exit is still there, so nothing removes them', () => {
  const events = compile(baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'travel', subjects: ['ruby'], destination: 'grove', exit_anchor_pct: [-8, 90] },
    put(4, 'ruby', 'left_third'),
  ]));

  assert.equal(ops(events, 'depart').length, 1);
  assert.deepEqual(ops(events, 'exit'), [], 'a walk-off that was interrupted still removed its character');
});

test('a scene cut cancels every motion still running, and waits for none of them', () => {
  const story = baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'right_edge', zone: null },
  ]);
  story.scenes.push({ ...story.scenes[0], line: 9, place: 'grove', steps: [] });
  const timeline = compileTimeline(story);

  // A `move` is not a departure, so the scene never waited for it: the cut
  // lands at 0 ms and the settle it would have recorded never happens.
  assert.deepEqual(ops(timeline.events, 'settle'), []);
  assert.deepEqual(ops(timeline.events, 'scene').map((event) => event.t_ms), [0, 0]);
  assert.equal(timeline.duration_ms, 0);
});

// --- props and cast -------------------------------------------------------

test('a prop never joins the board, so a revisit does not re-stage it as a character', () => {
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby', 'lamp'], objects: ['lamp'], position: 'center', facing: null, zone: null },
  ]);
  story.objects = { lamp: { svg: 'lamp.svg', height_cm: 30, rest_surface: 'floor' } };
  story.scenes.push({ ...story.scenes[0], line: 9, steps: [] });

  const events = compile(story);
  assert.deepEqual(
    warnings(events).filter((detail) => detail.policy === 'cast-missing'),
    [],
    'the prop was re-staged as a character on the second scene',
  );
});

test('a prop set down beside a character lands beside them, not at the band centre', () => {
  const story = bandedStory([
    put(2, 'ruby', 'right_third', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['lamp'], objects: ['lamp'], position: 'ruby', facing: null, zone: null },
  ]);
  story.objects = { lamp: { svg: 'lamp.svg', height_cm: 30, rest_surface: 'floor' } };

  assert.deepEqual(
    ops(compile(story), 'place_object').map(({ slug, x }) => [slug, x]),
    [['lamp', 70]],
    'the prop ignored the character it was named against',
  );
});

test('a prop the story never defined is refused and named', () => {
  const events = compile(baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['lamp'], objects: ['lamp'], position: 'center', facing: null, zone: null },
  ]));

  assert.deepEqual(ops(events, 'place_object'), []);
  assert.deepEqual(warnings(events), [{ type: 'policy', policy: 'object-missing', slug: 'lamp' }]);
});

test('a character the story never cast is refused and named', () => {
  const story = baseStory([]);
  story.scenes.push({ ...story.scenes[0], line: 9, place: 'grove', steps: [] });
  story.scenes[0].steps = [
    put(2, 'stranger', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'travel', subjects: ['stranger'], destination: 'grove', exit_anchor_pct: [50, 90] },
  ];

  const events = compile(story);
  // Twice, and both are real: once where the `put` would have staged them, and
  // again where the arrival at the destination would have. An uncast character
  // is drawn nowhere, so neither scene may quietly proceed as if they were.
  assert.deepEqual(
    warnings(events).filter((detail) => detail.policy === 'cast-missing'),
    [
      { type: 'policy', policy: 'cast-missing', slug: 'stranger' },
      { type: 'policy', policy: 'cast-missing', slug: 'stranger' },
    ],
  );
  assert.deepEqual(ops(events, 'place'), [], 'an uncast character was drawn anyway');
});

test('a verb the character has no clip for falls back, and the fallback is named', () => {
  const story = baseStory([
    put(2, 'ruby', 'center', { zone: null }),
    { kind: 'cmd', line: 3, cmd: 'emote', subjects: ['ruby'], emotion: 'furious', facing: null },
  ]);

  const events = compile(story);
  // the first clip by name, so the character is drawn as something rather than
  // as nothing — and the substitution is on the record
  assert.equal(ops(events, 'clip')[0].clip, 'happy');
  // Both rungs of the ladder are reported, in the order they were tried: the
  // facing ladder finds no variant at all for the verb, and only then does the
  // clip fall back to a name off the character's own sheet.
  assert.deepEqual(warnings(events), [
    { policy: 'facing-fallback', verb: 'furious', requested: 'camera', selected: null, slug: 'ruby' },
    { type: 'policy', policy: 'clip-missing', slug: 'ruby', verb: 'furious', selected: 'happy' },
  ]);
});

test('a command this player does not perform keeps its own line', () => {
  const events = compile(baseStory([{ kind: 'cmd', line: 44, cmd: 'not_real' }]));
  const warning = events.find((event) => event.kind === 'warning');

  assert.equal(warning.line, 44);
  assert.deepEqual(warning.detail, { type: 'policy', policy: 'unknown-command', cmd: 'not_real' });
});
