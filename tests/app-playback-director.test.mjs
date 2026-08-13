import assert from 'node:assert/strict';
import test from 'node:test';

import { EventLog } from '../browser/v0/core/event-log.mjs';
import { PlaybackDirector } from '../browser/v0/app/directors/playback-director.mjs';
import { StageRenderer } from '../browser/v0/app/stage/stage-renderer.mjs';
import { V0_STAGE_METHODS } from '../tooling/v0.mjs';

test('the director contract is exactly the fake surface and exists on the real stage', () => {
  // The director never meets a real StageRenderer in this file — it meets
  // `fakeStage` below. A stage method renamed on one side type-checks nowhere
  // and otherwise throws `is not a function` in the browser on the first step
  // that needs it. The fake is the director's exercised surface; the exported
  // contract and real renderer must both match it. Engine integrations hold
  // their headless renderer to the same exported contract.
  const surface = Object.keys(fakeStage()).sort();
  assert.deepEqual(surface, V0_STAGE_METHODS);

  const missing = V0_STAGE_METHODS.filter((call) => typeof StageRenderer.prototype[call] !== 'function');
  assert.deepEqual(missing, [], `StageRenderer is missing stage calls the director makes: ${missing}`);
});

test('resolves characters moving toward each other from one pre-together board snapshot', async () => {
  const forward = await playMoves(['ruby', 'clover']);
  const reversed = await playMoves(['clover', 'ruby']);

  assert.deepEqual(forward, { ruby: 70, clover: 30 });
  assert.deepEqual(reversed, { ruby: 70, clover: 30 });
});

test('puts policy warning lines at the top level of event entries', async () => {
  const log = new EventLog(() => 0);
  const stage = fakeStage();
  const story = baseStory([{ kind: 'cmd', line: 44, cmd: 'not_real' }]);
  const director = makeDirector(story, stage, log);

  await director.play();

  assert.equal(log.entries().find(({ kind }) => kind === 'warning').line, 44);
});

test('combines simultaneous placement and emotion independently of child order', async () => {
  const forward = await playPutAndEmote(['put', 'emote']);
  const reversed = await playPutAndEmote(['emote', 'put']);

  assert.equal(forward, 'happy');
  assert.equal(reversed, 'happy');
});

test('assigns simultaneous travel arrival slots by slug instead of child order', async () => {
  const forward = await playTravels(['ruby', 'clover']);
  const reversed = await playTravels(['clover', 'ruby']);

  assert.deepEqual(forward, { clover: 30, ruby: 70 });
  assert.deepEqual(reversed, { clover: 30, ruby: 70 });
});

test('resolves simultaneous emote facing from the pre-move subject position', async () => {
  let clip = null;
  const stage = fakeStage();
  stage.setCharacterClip = (slug, value) => { if (slug === 'ruby') clip = value; };
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_third', facing: null },
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'right_third', facing: null },
    { kind: 'together', line: 4, steps: [
      { kind: 'cmd', line: 5, cmd: 'move', subjects: ['ruby'], target: 'right_edge' },
      { kind: 'cmd', line: 6, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: 'clover' },
    ] },
  ]);
  story.cast.ruby.capability.happy = { left: 'happy-left', right: 'happy-right' };
  story.cast.ruby.clips['happy-left'] = {};
  story.cast.ruby.clips['happy-right'] = {};

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.equal(clip, 'happy-right');
});

test('turns a character toward where the addressed zone actually is', async () => {
  // A floor pinned to the right half: left_edge is x=59 and center is x=75,
  // so a subject at left_edge must turn RIGHT to address center. Measured off
  // plate width the same zones are 10 and 50, and it would turn left.
  let clip = null;
  const stage = fakeStage();
  stage.setCharacterClip = (slug, value) => { if (slug === 'ruby') clip = value; };
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_edge', facing: null },
    { kind: 'cmd', line: 3, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: 'center' },
  ]);
  story.scenes[0].plate = { resolution: [1920, 1080], zones: [{ name: 'floor', surface: 'floor', description: '', polygon: [[55, 80], [95, 80], [95, 100], [55, 100]], depth: null, scale: null }], default_zone: 'floor' };
  story.cast.ruby.capability.happy = { left: 'happy-left', right: 'happy-right' };
  story.cast.ruby.clips['happy-left'] = {};
  story.cast.ruby.clips['happy-right'] = {};

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.equal(clip, 'happy-right');
});

test('stages against the plate\'s own floor, including a place the camera never opens', async () => {
  // Every other fixture here uses a full-width floor, where floor-relative and
  // plate-relative x are identical — so the whole span wiring is invisible
  // unless a plate is inset. The dell's floor runs 20..80, the grove's 0..50.
  const placed = {};
  const stage = fakeStage();
  stage.placeCharacter = (slug, _definition, x) => { placed[slug] = Math.round(x * 100) / 100; };

  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_edge', facing: null },
    // A healed travel-of-the-never-placed: the put names a place the story
    // never opens a scene at, so its floor is looked up, not inherited.
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'center', facing: null, place: 'grove' },
  ]);
  story.scenes[0].plate = { resolution: [1920, 1080], zones: [{ name: 'floor', surface: 'floor', description: '', polygon: [[20, 80], [80, 80], [80, 100], [20, 100]], depth: null, scale: null }], default_zone: 'floor' };
  story.scenes.push({
    line: 9,
    place: 'grove',
    plate: { resolution: [1920, 1080], zones: [{ name: 'floor', surface: 'floor', description: '', polygon: [[0, 80], [50, 80], [50, 100], [0, 100]], depth: null, scale: null }], default_zone: 'floor' },
    steps: [],
  });

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.equal(placed.ruby, 26); // 20 + 0.1 * 60, not the plate's 10
  assert.equal(placed.clover, 25); // the grove's own centre, not the dell's 50
});

test('keeps an asynchronous warning on its captured scene and line', async () => {
  const log = new EventLog(() => 0);
  const story = baseStory([]);
  story.scenes.push({ ...story.scenes[0], line: 70, place: 'grove' });
  const director = makeDirector(story, fakeStage(), log);
  await director.play();

  director.warning({ type: 'media', asset: 'sprite', scene_index: 0, line: 9 });

  const warning = log.entries().at(-1);
  assert.deepEqual(warning, {
    t_ms: 0,
    scene_index: 0,
    line: 9,
    kind: 'warning',
    detail: { type: 'media', asset: 'sprite' },
  });
});

async function playMoves(order) {
  const movements = {};
  const stage = fakeStage((slug, options) => { movements[slug] = options.x; });
  const commands = [
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_third', facing: null },
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'right_third', facing: null },
    { kind: 'together', line: 4, steps: order.map((slug, index) => ({
      kind: 'cmd',
      line: 5 + index,
      cmd: 'move',
      subjects: [slug],
      target: slug === 'ruby' ? 'clover' : 'ruby',
    })) },
  ];
  await makeDirector(baseStory(commands), stage, new EventLog(() => 0)).play();
  return movements;
}

async function playPutAndEmote(order) {
  let currentClip = null;
  const stage = fakeStage();
  stage.placeCharacter = (_slug, _definition, _x, clip) => { currentClip = clip; };
  stage.setCharacterClip = (_slug, clip) => { currentClip = clip; };
  const children = {
    put: { kind: 'cmd', line: 3, cmd: 'put', subjects: ['ruby'], position: 'right_third', facing: null },
    emote: { kind: 'cmd', line: 4, cmd: 'emote', subjects: ['ruby'], emotion: 'happy', facing: null },
  };
  const commands = [
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_third', facing: null },
    { kind: 'together', line: 3, steps: order.map((name) => children[name]) },
  ];
  await makeDirector(baseStory(commands), stage, new EventLog(() => 0)).play();
  return currentClip;
}

async function playTravels(order) {
  let scene = null;
  const arrivals = {};
  const stage = fakeStage();
  stage.showScene = (value) => { scene = value.place; };
  stage.placeCharacter = (slug, _definition, x) => {
    if (scene === 'grove') arrivals[slug] = x;
  };
  const travel = (slug) => ({
    kind: 'cmd',
    line: slug === 'ruby' ? 5 : 6,
    cmd: 'travel',
    subjects: [slug],
    destination: 'grove',
    exit_anchor_pct: [100, 80],
  });
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_third', facing: null },
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'right_third', facing: null },
    { kind: 'together', line: 4, steps: order.map(travel) },
  ]);
  story.scenes.push({ ...story.scenes[0], line: 7, place: 'grove', steps: [] });

  await makeDirector(story, stage, new EventLog(() => 0)).play();
  return arrivals;
}

// --- which band a walk lands in -------------------------------------------

// Two bands, so "the one you are in" and "the plate's default" are different
// answers and a test can tell them apart.
function bandedStory(steps) {
  const story = baseStory(steps);
  story.scenes[0].plate = {
    resolution: [1920, 1080],
    default_zone: 'front',
    zones: [
      { name: 'front', surface: 'floor', description: '', depth: 1, scale: 1, polygon: [[0, 80], [100, 80], [100, 100], [0, 100]] },
      { name: 'back', surface: 'floor', description: '', depth: 2, scale: 0.5, polygon: [[40, 60], [60, 60], [60, 65], [40, 65]] },
    ],
  };
  return story;
}

test('a walk that names no band keeps the character in the band they are standing in', async () => {
  // `put(ruby, center, zone=back)` then `move(ruby, left_third)`. The board's
  // own rule is "a move that names no band leaves the character in the one
  // they are in" — but the director used to resolve `plate.default_zone`
  // before the board ever saw the null, so the rule could never fire: ruby was
  // silently re-banded to the front and walked to the FRONT's left_third.
  let moved = null;
  const stage = fakeStage((slug, options) => { moved = { slug, ...options }; });
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'back' },
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'left_third', zone: null },
  ]);

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.equal(moved.zoneName, 'back', 'the walk left the band the story put them in');
  // left_third of the back band (x 40..60) is 46, not left_third of the frame
  assert.equal(Math.round(moved.x), 46, 'the side was measured against the wrong band');
});

test('a walk that names a band carries it to the renderer', async () => {
  let moved = null;
  const stage = fakeStage((slug, options) => { moved = { slug, ...options }; });
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'front' },
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'center', zone: 'back' },
  ]);

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.equal(moved.zoneName, 'back', 'the renderer was never told which band to draw them in');
});

test('movement and default departure use the published v0 timing policy', async () => {
  const stage = fakeStage();
  const movements = [];
  const departures = [];
  stage.moveCharacter = async (_slug, options) => { movements.push(options); };
  stage.departCharacter = async (_slug, options) => { departures.push(options); };
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: null },
    { kind: 'cmd', line: 3, cmd: 'move', subjects: ['ruby'], target: 'right_edge', zone: null },
    { kind: 'cmd', line: 4, cmd: 'put', subjects: ['clover'], position: 'center', zone: null },
    { kind: 'cmd', line: 5, cmd: 'move', subjects: ['clover'], target: 'center', zone: null },
    { kind: 'cmd', line: 6, cmd: 'move', subjects: ['clover'], target: 'left_edge', zone: null },
    { kind: 'cmd', line: 7, cmd: 'put', subjects: ['owl'], position: 'center', zone: null },
    { kind: 'cmd', line: 8, cmd: 'travel', subjects: ['ruby'], destination: 'grove', exit_anchor_pct: null },
    { kind: 'cmd', line: 9, cmd: 'travel', subjects: ['clover'], destination: 'grove', exit_anchor_pct: null },
    { kind: 'cmd', line: 10, cmd: 'travel', subjects: ['owl'], destination: 'grove', exit_anchor_pct: [50, 80] },
  ]);
  story.cast.owl = story.cast.ruby;

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.equal(movements[0].durationSeconds, 40 / 22);
  assert.equal(movements[1].durationSeconds, 0.25);
  assert.equal(movements[2].durationSeconds, 40 / 22);
  assert.equal(departures[0].x, 108);
  assert.equal(departures[0].y, 80);
  assert.equal(departures[0].durationSeconds, 18 / 22);
  assert.equal(departures[1].x, -8);
  assert.equal(departures[1].durationSeconds, 18 / 22);
  assert.equal(departures[2].durationSeconds, 0.35);
});

test('scene end waits for departures until the published five-second deadline', async (t) => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let fireDeadline;
  let deadlineMs;
  globalThis.setTimeout = (callback, milliseconds) => {
    fireDeadline = callback;
    deadlineMs = milliseconds;
    return 31;
  };
  globalThis.clearTimeout = () => {};
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const stage = fakeStage();
  stage.departCharacter = () => new Promise(() => {});
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: null },
    { kind: 'cmd', line: 3, cmd: 'travel', subjects: ['ruby'], destination: 'grove', exit_anchor_pct: null },
  ]);
  const playback = makeDirector(story, stage, log).play();
  for (let turn = 0; turn < 10 && !fireDeadline; turn += 1) await Promise.resolve();

  assert.equal(deadlineMs, 5_000);
  fireDeadline();
  await playback;
  assert.equal(
    log.entries().some(({ detail }) => detail?.message === 'scene departure deadline reached'),
    true,
  );
});

// --- what the camera is told ----------------------------------------------

/** Every camera call the director makes, in order, as `[name, ...args]`. */
function watchCamera(stage) {
  const calls = [];
  for (const name of ['pushIn', 'pullOut', 'setShot', 'panTo', 'follow', 'followOff']) {
    stage[name] = (...args) => calls.push([name, ...args]);
  }
  return calls;
}

test('a camera aiming at somebody reads the band they are actually standing on', async () => {
  // `resolvePoint` was handed the plate's DEFAULT band for both axes, and the
  // board's own `zone` was thrown away — so a character on the back road was
  // framed on the near floor's stand line at their x, several percent low and
  // then magnified. Front stands at y 90 here, back at 62.5: one number tells
  // the two apart, and every camera command shares the resolver.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'back' },
    { kind: 'cmd', line: 3, cmd: 'push_in', subjects: [], target: 'ruby', speed: 'slow' },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
  ]);

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.deepEqual(calls, [
    ['pushIn', { x: 50, y: 62.5 }, 'slow'],
    // Ruby is 12 cm — 120 px at the front, 60 px on this half-scale band — so
    // framing her at her source size asks for 8.5x of a 1080p plate and the
    // ceiling answers instead. The band-sensitive case is the test below: this
    // one clamps either way, which is exactly why it cannot pin the band.
    ['setShot', 'close', { x: 50, y: 62.5 }, 3.5],
  ]);
});

test('a shot is sized by the band its subject is standing on', async () => {
  // The ceiling hides this whenever the subject is small, so the fixture is a
  // 40 cm character: 400 px at the front, 200 px on the half-scale band, which
  // is 1.28x against 2.56x — both under the ceiling, so dropping the band from
  // the lookup changes the answer instead of being clamped into agreement.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'back' },
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'medium', target: 'ruby' },
  ]);
  story.cast.ruby = { ...story.cast.ruby, height_cm: 40 };

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.deepEqual(calls.map(([, size, , scale]) => [size, scale]), [
    ['close', 2.56],
    // and `medium` is resolved the same way — it used to be a flat 1.25 for
    // everybody, which is what made a close-up on the big cast come out WIDER
    // than a medium on the same character
    ['medium', 1.28],
  ]);
});

test('a shot inside a together is sized by the band its subject is arriving on', async () => {
  // The renderer resizes the sprite to its destination band synchronously, and
  // `move` sorts before `shot`, so measuring against the `together` snapshot
  // framed a subject at the size of the band it was LEAVING: a 40 cm character
  // drawn 400 px at the front, framed as if still 200 px, is 400 x 2.56 = 1024 px
  // in a 1080 px frame with nothing to spare — and on a deeper band, cropped.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'back' },
    {
      kind: 'together',
      line: 3,
      steps: [
        { kind: 'cmd', line: 4, cmd: 'move', subjects: ['ruby'], target: 'left_third', zone: 'front' },
        { kind: 'cmd', line: 5, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
      ],
    },
  ]);
  story.cast.ruby = { ...story.cast.ruby, height_cm: 40 };

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  const shot = calls.find(([name]) => name === 'setShot');
  assert.equal(shot?.[3], 1.28, 'the shot was sized by the band the subject had left');
});

test('a side word is still measured across the default band, whoever is elsewhere', () => {
  // The other half of the same rule: a side has no band of its own, so
  // `left_third` means the same thing to the camera wherever the cast is.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'back' },
    { kind: 'cmd', line: 3, cmd: 'pan_to', subjects: [], target: 'left_third', speed: null },
  ]);

  return makeDirector(story, stage, new EventLog(() => 0)).play().then(() => {
    // left_third of the full-width front band is 30, and its floor is y 90 —
    // measured across the back band it would be 46, on a stand line of 62.5
    assert.deepEqual(calls, [['panTo', 30, 'slow']]);
  });
});

test('a wide frames nobody, and every other camera command carries its speed', async () => {
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', facing: null },
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'wide', target: null },
    { kind: 'cmd', line: 4, cmd: 'pan_to', subjects: [], target: 'ruby', speed: 'medium' },
    // every command that takes a speed, with the speed left unnamed: all three
    // defaults moved from medium to slow and each one can be reverted alone
    { kind: 'cmd', line: 5, cmd: 'push_in', subjects: [], target: 'ruby', speed: null },
    { kind: 'cmd', line: 6, cmd: 'pan_to', subjects: [], target: 'ruby', speed: null },
    { kind: 'cmd', line: 7, cmd: 'pull_out', subjects: [], speed: null },
  ]);

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.deepEqual(calls, [
    ['setShot', 'wide', null, 1],
    ['panTo', 50, 'medium'],
    // an unnamed speed is slow, in the director as in the renderer and the language
    ['pushIn', { x: 50, y: 90 }, 'slow'],
    ['panTo', 50, 'slow'],
    ['pullOut', 'slow'],
  ]);
});

test('a portal anchor is checked like every other aim, not trusted because it is pre-resolved', async () => {
  // `target_pct` is copied out of the catalog by the compiler with no shape
  // check (bundle.py), and it used to share the finiteness guard with every
  // other target. Skipping it costs more now than it did: one non-number lands
  // in the framing, the whole `transform` becomes unparseable rather than one
  // dropped property, and every later pan reads the bad number back out.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'push_in', subjects: [], target: 'far_path', target_pct: [61.5], speed: 'slow' },
    { kind: 'cmd', line: 3, cmd: 'push_in', subjects: [], target: 'near_path', target_pct: [40, 88], speed: 'slow' },
  ]);

  await makeDirector(story, stage, log).play();

  assert.deepEqual(calls, [['pushIn', { x: 40, y: 88 }, 'slow']], 'a half-written portal anchor reached the camera');
  assert.deepEqual(
    log.entries().filter((entry) => entry.kind === 'warning').map((entry) => entry.detail),
    [{ type: 'policy', policy: 'camera-target-unresolved', cmd: 'push_in', target: 'far_path' }],
  );
});

test('follow(off) releases the ride and never reaches cast resolution', async () => {
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', facing: null },
    { kind: 'cmd', line: 3, cmd: 'follow', subjects: [], target: 'ruby' },
    { kind: 'cmd', line: 4, cmd: 'follow', subjects: [], target: 'off' },
  ]);

  await makeDirector(story, stage, log).play();

  assert.deepEqual(calls, [['follow', 'ruby'], ['followOff']]);
  assert.deepEqual(log.entries().filter((entry) => entry.kind === 'warning'), []);
});

test('a camera aimed at nobody warns once, under one name for all five commands', async () => {
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'push_in', subjects: [], target: 'nobody', speed: 'slow' },
    { kind: 'cmd', line: 3, cmd: 'pan_to', subjects: [], target: 'nobody', speed: null },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'close', target: 'nobody' },
    { kind: 'cmd', line: 5, cmd: 'follow', subjects: [], target: 'nobody' },
  ]);

  await makeDirector(story, stage, log).play();

  assert.deepEqual(calls, [], 'the camera moved toward somebody who is not there');
  assert.deepEqual(
    log.entries().filter((entry) => entry.kind === 'warning').map((entry) => entry.detail),
    [
      { type: 'policy', policy: 'camera-target-unresolved', cmd: 'push_in', target: 'nobody' },
      { type: 'policy', policy: 'camera-target-unresolved', cmd: 'pan_to', target: 'nobody' },
      { type: 'policy', policy: 'camera-target-unresolved', cmd: 'shot', target: 'nobody' },
      { type: 'policy', policy: 'camera-target-unresolved', cmd: 'follow', target: 'nobody' },
    ],
  );
});

test('a subject nobody measured is refused, not framed at maximum magnification', async () => {
  // Without a height, `spriteHeightForCm` falls to its 72 px legibility floor —
  // a number chosen for DRAWING a tiny character readably — and framing 72 px at
  // source size asks for the ceiling. So an unmeasured character would have got
  // the tightest shot in the language, silently, on no evidence at all. Four
  // characters in the forest catalog carry `height_cm: null` today.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', facing: null },
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'close', target: 'ruby' },
  ]);
  story.cast.ruby = { ...story.cast.ruby, height_cm: null };

  await makeDirector(story, stage, log).play();

  assert.deepEqual(calls, [], 'an unmeasured subject was framed anyway');
  assert.deepEqual(
    log.entries().filter((entry) => entry.kind === 'warning').map((entry) => entry.detail),
    [{ type: 'policy', policy: 'camera-subject-unmeasured', cmd: 'shot', target: 'ruby' }],
  );
});

test('a shot size the player does not know is refused, not quietly widened', async () => {
  // `SHOT_SCALES[size] ?? SHOT_SCALES.wide` answered a close-up with an unchanged
  // wide and zero warnings — and `SHOT_SCALES.constructor` is a FUNCTION, which
  // `??` never rescues, so a prototype name reached the transform as scale NaN.
  // The size is what the command MEANS, so an unreadable one performs nothing.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', facing: null },
    { kind: 'cmd', line: 3, cmd: 'shot', subjects: [], size: 'closeup', target: 'ruby' },
    { kind: 'cmd', line: 4, cmd: 'shot', subjects: [], size: 'constructor', target: 'ruby' },
  ]);

  await makeDirector(story, stage, log).play();

  assert.deepEqual(calls, [], 'an unknown shot size still moved the camera');
  assert.deepEqual(
    log.entries().filter((entry) => entry.kind === 'warning').map((entry) => entry.detail),
    [
      { type: 'policy', policy: 'camera-shot-size-unknown', cmd: 'shot', size: 'closeup' },
      { type: 'policy', policy: 'camera-shot-size-unknown', cmd: 'shot', size: 'constructor' },
    ],
  );
});

test('a camera speed the language no longer has is said out loud, then paced slow', async () => {
  // `fast` was REMOVED from the language by this branch and from the duration
  // table with it, and then absorbed at playback as slow with no warning: a
  // hand-made bundle carrying it played, and the phone timeline published
  // `speed: "fast"` against a numbers table with no such row. Unlike a size, a
  // speed is only pacing, so the move still happens — at the language's default.
  const stage = fakeStage();
  const calls = watchCamera(stage);
  const log = new EventLog(() => 0);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', facing: null },
    { kind: 'cmd', line: 3, cmd: 'push_in', subjects: [], target: 'ruby', speed: 'fast' },
    { kind: 'cmd', line: 4, cmd: 'pull_out', subjects: [], speed: 'toString' },
  ]);

  await makeDirector(story, stage, log).play();

  // the speed is the last argument of both calls, whatever else they carry
  assert.deepEqual(calls.map((call) => [call[0], call.at(-1)]), [
    ['pushIn', 'slow'],
    ['pullOut', 'slow'],
  ]);
  assert.deepEqual(
    log.entries().filter((entry) => entry.kind === 'warning').map((entry) => entry.detail),
    [
      { type: 'policy', policy: 'camera-speed-unknown', cmd: 'push_in', speed: 'fast' },
      { type: 'policy', policy: 'camera-speed-unknown', cmd: 'pull_out', speed: 'toString' },
    ],
  );
});

test('a follow shares a together with the move it rides, and is applied first', async () => {
  // The ride is set up by `follow` and consumed by the walk, so the order the
  // `together` applies its children is load-bearing: `togetherStepKey` sorts by
  // command name and 'follow' < 'move' alphabetically. Rename either command and
  // the ride silently starts one walk late.
  const applied = [];
  const stage = fakeStage((slug) => applied.push(['move', slug]));
  stage.follow = (slug) => applied.push(['follow', slug]);
  const story = baseStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'left_third', facing: null },
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'right_third', facing: null },
    { kind: 'together', line: 4, steps: [
      { kind: 'cmd', line: 6, cmd: 'move', subjects: ['ruby'], target: 'clover', beside: 'left', zone: null },
      { kind: 'cmd', line: 5, cmd: 'follow', subjects: [], target: 'ruby' },
    ] },
  ]);

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.deepEqual(applied, [['follow', 'ruby'], ['move', 'ruby']]);
});

test('a put that names a band carries it to the renderer', () => {
  // The move side had a twin; the put side did not, and replacing the band with
  // `null` here left 145/145 green — bug #1 and bug #4 re-shipping through the
  // `put` door instead of the `move` door.
  const placed = [];
  const stage = fakeStage();
  stage.placeCharacter = (slug, _d, _x, _c, _o, zoneName) => placed.push([slug, zoneName]);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'center', zone: 'back' },
  ]);

  return makeDirector(story, stage, new EventLog(() => 0)).play().then(() => {
    assert.deepEqual(placed, [['ruby', 'back']]);
  });
});

test('an arrival and a put on the same band are handed the same band name', async () => {
  // The board holds `null` for "the engine's answer" and a put holds the
  // default zone's NAME. The renderer groups crowding by that key, so one
  // physical band was two groups and the pair was never spread: in Ruby's
  // forest_glow an arriving hedgehog and a put owl landed on the same pixel.
  // The arrival is the half that mattered, so this stages a real one.
  const placed = [];
  const stage = fakeStage();
  stage.placeCharacter = (slug, _d, _x, _c, _o, zoneName) => placed.push([slug, zoneName]);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['clover'], position: 'center', zone: null },
    { kind: 'cmd', line: 3, cmd: 'travel', subjects: ['clover'], destination: 'grove' },
  ]);
  story.scenes.push({
    line: 9,
    place: 'grove',
    plate: story.scenes[0].plate,
    steps: [{ kind: 'cmd', line: 10, cmd: 'put', subjects: ['ruby'], position: 'center', zone: null }],
  });

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  const grove = placed.filter(([slug]) => slug === 'clover' || slug === 'ruby').slice(-2);
  assert.deepEqual(
    new Set(grove.map(([, zoneName]) => zoneName)), new Set(['front']),
    `the arrival and the put disagree about one band: ${JSON.stringify(grove)}`,
  );
});

test('a prop never joins the board, so a revisit does not re-stage it as a character', async () => {
  // `beginScene` re-stages EVERYONE at a place, not only arrivals, so a prop on
  // the board came back as a character and warned `cast-missing`.
  const log = new EventLog(() => 0);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby', 'lamp'], objects: ['lamp'], position: 'center', zone: null },
  ]);
  story.objects = { lamp: { svg: 'lamp.svg', height_cm: 30, rest_surface: 'floor' } };
  story.scenes.push({ ...story.scenes[0], line: 9, steps: [] });

  await makeDirector(story, fakeStage(), log).play();

  const missing = log.entries().filter((e) => e.detail?.policy === 'cast-missing');
  assert.deepEqual(missing, [], 'the prop was re-staged as a character on the second scene');
});

test('a prop set down beside a character lands beside them, not at the band centre', async () => {
  const drawn = [];
  const stage = fakeStage();
  stage.placeObject = (slug, _d, x) => drawn.push([slug, Math.round(x * 100) / 100]);
  const story = bandedStory([
    { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: 'right_third', zone: null },
    { kind: 'cmd', line: 3, cmd: 'put', subjects: ['lamp'], objects: ['lamp'], position: 'ruby', zone: null },
  ]);
  story.objects = { lamp: { svg: 'lamp.svg', height_cm: 30, rest_surface: 'floor' } };

  await makeDirector(story, stage, new EventLog(() => 0)).play();

  assert.deepEqual(drawn, [['lamp', 70]], 'the prop ignored the character it was named against');
});

function makeDirector(story, stage, log) {
  return new PlaybackDirector({
    story,
    storyUrl: 'http://localhost/build/story.json',
    stage,
    audio: { playSound() {}, setMusic() {}, playNarration: async () => ({ ok: true, elapsedMs: 0 }) },
    clock: { now: () => 0, wait: async () => {} },
    log,
  });
}

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
    cast: { ruby: character, clover: character },
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      line: 1,
      place: 'dell',
      plate: { resolution: [1920, 1080], zones: [{ name: 'floor', surface: 'floor', description: '', polygon: [[0, 80], [100, 80], [100, 100], [0, 100]], depth: null, scale: null }], default_zone: 'floor' },
      steps,
    }],
  };
}

function fakeStage(onMove = () => {}) {
  return {
    showScene() {},
    placeCharacter() {},
    // the real stage has had this since props were drawn; the fake did not, so
    // every director test that touched a prop threw instead of asserting
    placeObject() {},
    setCharacterClip() {},
    moveCharacter: async (slug, options) => onMove(slug, options),
    departCharacter: async () => {},
    floorY: () => 80,
    pushIn() {},
    pullOut() {},
    setShot() {},
    panTo() {},
    follow() {},
    followOff() {},
    setSubtitle() {},
    resetCamera() {},
    showEnd() {},
  };
}
