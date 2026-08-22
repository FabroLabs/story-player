/**
 * A story played while it is still being written.
 *
 * `compile-prefix.test.mjs` proves the schedule half of the promise: the scenes
 * published so far compile to the finished timeline's own opening. This is the
 * other half, the one a viewer actually meets — what the player does when it
 * reaches the end of what exists, what happens when the next scene lands, and
 * what it refuses. The host is still the only party that fetches anything: the
 * scenes below are handed over already parsed, exactly as a host hands them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import {
  downloadSession, findByClass, installAudio, installDom, virtualFrames,
} from './_dom.mjs';
import { platesOf, read } from './_parity.mjs';

const STEM = 'golden_push_dusk';
const ASSET_BASE = 'https://storage.example/';

test('a story that catches up with its writer waits, and the next scene starts it again', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(player.durationOf(1));

  assert.equal(player.waiting.hidden, false, 'the stage never said it was waiting for the writer');
  assert.equal(player.end.hidden, true, 'a story still being written showed its end screen');
  assert.equal(player.frames.pending(), 0, 'a waiting story is still asking for frames');
  assert.equal(player.video.paused, true, 'the plate kept rolling under the spinner');
  assert.equal(player.audio.every((media) => media.paused), true, 'a line kept reading itself out under the spinner');
  // The manifest's count, from the first frame: a viewer must not watch
  // "scene 1 of 1" become "scene 2 of 2" and wonder how long this goes on.
  assert.equal(player.badge.textContent, 'scene 1 of 3');
  const wasLong = player.total.textContent;
  const heard = player.audio.length;

  await player.appendScene(1);
  assert.equal(player.waiting.hidden, true, 'the spinner outlived the scene it was waiting for');
  assert.ok(player.frames.pending() > 0, 'the scene landed and nothing started the loop again');
  assert.notEqual(player.total.textContent, wasLong, 'the scrub bar still ends where the prefix did');

  player.frames.advanceTo(player.durationOf(1) + 800);
  assert.equal(player.end.hidden, true, 'the story ended inside the scene that had just arrived');
  assert.equal(player.waiting.hidden, true, 'the story stopped again inside a published scene');
  // The appended scene is heard, not just drawn — and heard off the asset base
  // the story was mounted with, which is the whole of what resolving it means.
  assert.ok(player.audio.length > heard, 'the scene that arrived plays in silence');
  assert.ok(
    player.audio.at(-1).url.startsWith(ASSET_BASE),
    `an appended line was opened at ${player.audio.at(-1).url}, outside the asset base`,
  );
  assert.equal(player.audio.at(-1).paused, false, 'the line of the appended scene never started');
});

test('a writer who finishes early ends the story at the end, not at a spinner', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(3_000);

  // The ordinary case: the host learns the writer stopped while the viewer is
  // still inside a scene, long before playback reaches the end of it.
  await player.finishStory('done');
  assert.equal(player.end.hidden, true, 'the story ended where the viewer was, not at its end');

  player.frames.advanceTo(player.durationOf(1));
  assert.equal(player.waiting.hidden, true, 'a finished story waited for a scene nobody was writing');
  assert.equal(player.end.hidden, false, 'a finished story never reached its end');
});

test('a scene that arrives before the story needs it is never noticed', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(2_000);
  const spoken = player.subtitle.textContent;

  await player.appendScene(1);

  assert.equal(player.subtitle.textContent, spoken, 'an append moved the line being read');
  assert.equal(player.waiting.hidden, true, 'a story with more to play stopped to wait');
  assert.ok(player.frames.pending() > 0, 'the story stopped asking for frames');

  // Straight through the end the story had when it started, without a pause at
  // it: that end moved the moment the scene landed.
  player.frames.advanceTo(player.durationOf(1) + 400);
  assert.equal(player.waiting.hidden, true, 'the story waited at an end that had already moved');
  assert.equal(player.end.hidden, true, 'the story ended at a boundary that was no longer the end');
});

test('a viewer who pauses while waiting is not started again by the scene that lands', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(player.durationOf(1));
  player.toggle.dispatch('click');

  assert.equal(player.toggle.getAttribute('aria-label'), 'play', 'the transport lied about what it would do');
  await player.appendScene(1);

  assert.equal(player.waiting.hidden, true);
  assert.equal(player.frames.pending(), 0, 'a story paused by its viewer was started by an append');
});

test('a viewer who presses play again while waiting gets the story the moment it arrives', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(player.durationOf(1));
  player.toggle.dispatch('click');
  player.toggle.dispatch('click');

  assert.equal(player.toggle.getAttribute('aria-label'), 'pause', 'the transport forgot it had been asked to play');
  await player.appendScene(1);
  assert.ok(player.frames.pending() > 0, 'the story the viewer asked for never started');
});

test('the host saying the writer stopped turns the wait into the end', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(player.durationOf(1));
  assert.equal(player.waiting.hidden, false);

  // 'failed' and 'done' are one behaviour here on purpose: the published prefix
  // is the story either way, and the sentence about the missing ending belongs
  // to the host, next to the player rather than inside it.
  await player.finishStory('failed');

  assert.equal(player.waiting.hidden, true, 'the spinner outlived the story');
  assert.equal(player.end.hidden, false, 'a story nobody will finish never ended');
  assert.equal(player.toggle.getAttribute('aria-label'), 'replay');
  // The manifest promised three; one was written. The badge counts what exists,
  // or it argues with the end screen next to it.
  assert.equal(player.badge.textContent, 'scene 1 of 1');

  await assert.rejects(() => player.appendScene(1), /already finished/);
});

test('a scene naming somebody the story never carried is refused, and the prefix plays on', async (t) => {
  const player = await mount(t);
  player.start();
  player.frames.advanceTo(1_000);

  const stranger = player.scene(1);
  stranger.steps[1].subjects = ['nobody_here'];
  await assert.rejects(() => player.appendScene(stranger), /nobody_here/);

  // Refused whole: the story is still one scene long, still playing, and the
  // scene that was actually written still goes in afterwards.
  player.frames.advanceTo(2_000);
  assert.equal(player.end.hidden, true, 'a refused scene ended the story');
  assert.equal(player.waiting.hidden, true, 'a refused scene stopped the story');
  await player.appendScene(1);
  player.frames.advanceTo(player.durationOf(2) - 200);
  assert.equal(player.badge.textContent, 'scene 2 of 3', 'the story never reached the scene it accepted');
});

test('a player mounted for a finished story says so rather than growing one', async (t) => {
  const player = await mount(t, { published: 3, stream: null });

  assert.equal(typeof player.handle.appendScene, 'function', 'a host has nothing to feature-detect');
  await assert.rejects(
    () => player.appendScene(1),
    /not mounted for a story that is still being written/,
  );
  await assert.rejects(() => player.finishStory('done'), /still being written/);
});

test('what the mount refuses, it refuses at the door', async (t) => {
  const refuses = await doorman(t);

  // A plate with no traced zones answers nothing, and the compiler cannot say
  // so — a warning raised on the hint path would appear in the prefix and not
  // in the finished compile. So it is said here, once, at the mount.
  await assert.rejects(
    refuses({ plates: { forest_glow: { dusk: { video: 'bucket/video.mp4' } } } }),
    /"forest_glow" at "dusk" is not a plate/,
  );
  await assert.rejects(refuses({ plates: { forest_glow: 'dusk' } }), /must be an object keyed by time/);
  // Streaming without the block is the divergence the block exists to prevent.
  await assert.rejects(refuses({ plates: null }), /must be mounted with its manifest plates block/);
  await assert.rejects(refuses({ stream: { sceneCount: 3 } }), /"sceneCount", which it does not take/);
  await assert.rejects(refuses({ stream: { scenes: 0 } }), /whole number of scenes/);
  await assert.rejects(refuses({ stream: 'yes' }), /stream must be an object/);
});

test('the plates block reaches the compiler, at the mount and at every append', async (t) => {
  const whole = forwardStory();
  const plates = platesOf(whole);
  const finished = placedX(compileTimeline(whole, { plates }), 'clover');

  // Not vacuous: without the block a published prefix stages this step
  // somewhere else, and goes on doing so until the glade's own scene lands.
  assert.notEqual(
    placedX(compileTimeline({ ...whole, scenes: whole.scenes.slice(0, 1) }), 'clover'),
    finished,
    'the divergence the hint exists for has gone — this test proves nothing now',
  );

  const player = await mount(t, { whole });
  assert.equal(placedX(await player.timeline(), 'clover'), finished, 'the mount compiled without the block');

  // The glade is still unpublished after this one, so the block is still the
  // only answer — an append that dropped it would move a character the viewer
  // is already looking at.
  await player.appendScene(1);
  assert.equal(placedX(await player.timeline(), 'clover'), finished, 'the append compiled without the block');
});

test('a stream that does not say how long the story is counts what it has', async (t) => {
  const player = await mount(t, { stream: {} });
  player.start();
  player.frames.advanceTo(1_000);
  assert.equal(player.badge.textContent, 'scene 1 of 1');

  await player.appendScene(1);
  assert.equal(player.badge.textContent, 'scene 1 of 2', 'the badge waited for a cut to admit the story had grown');
  player.frames.advanceTo(player.durationOf(2) - 200);
  assert.equal(player.badge.textContent, 'scene 2 of 2');
});

/**
 * A story whose first scene puts somebody into a place only its LAST scene
 * opens — the one shape no fixture in the corpus has, and the only one where
 * the manifest's block is the sole answer.
 *
 * Three floors, three centres, so "I could not find the glade" and "I read the
 * glade's own plate" are different numbers rather than one arrived at twice.
 */
const floorZone = (polygon) => ({
  name: 'floor', surface: 'floor', description: '', polygon, depth: null, scale: null,
});

const plateOf = (name, polygon) => ({
  video: `bucket/${name}.mp4`,
  poster: `bucket/${name}.jpg`,
  resolution: [1920, 1080],
  default_zone: 'floor',
  zones: [floorZone(polygon)],
});

const walker = {
  height_cm: 90,
  capability: { idle: { camera: 'idle' }, move: { left: 'move-left', right: 'move-right' } },
  clips: {
    idle: { spritesheet: 'bucket/idle.png' },
    'move-left': { spritesheet: 'bucket/left.png' },
    'move-right': { spritesheet: 'bucket/right.png' },
  },
};

function forwardStory() {
  return {
    storylang_version: 0,
    title: 'Forward',
    cast: { ruby: walker, clover: walker },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [
      {
        line: 1,
        place: 'dell',
        time: 'day',
        plate: plateOf('dell', [[20, 80], [80, 80], [80, 100], [20, 100]]),
        steps: [
          // Healed: ruby is sent to a place no scene opens until the third.
          { kind: 'cmd', line: 2, cmd: 'put', subjects: ['ruby'], position: null, facing: null, place: 'glade' },
          // On screen here, anchored to her — this is the event that moves.
          { kind: 'cmd', line: 3, cmd: 'put', subjects: ['clover'], position: 'ruby', beside: 'right', facing: null },
          { kind: 'chunk', line: 4, text: 'A beat.', duration_s: 1 },
        ],
      },
      {
        line: 5,
        place: 'pond',
        time: 'dusk',
        plate: plateOf('pond', [[60, 80], [90, 80], [90, 100], [60, 100]]),
        steps: [{ kind: 'chunk', line: 6, text: 'The pond.', duration_s: 1 }],
      },
      {
        line: 7,
        place: 'glade',
        time: 'night',
        plate: plateOf('glade', [[0, 80], [40, 80], [40, 100], [0, 100]]),
        steps: [{ kind: 'chunk', line: 8, text: 'The glade.', duration_s: 1 }],
      },
    ],
  };
}

const placedX = (timeline, slug) => timeline.events
  .find((event) => event.op === 'place' && event.slug === slug)?.x;

/**
 * Mounts that are meant to be refused, one dom for all of them.
 *
 * Each returns a thunk rather than a promise so a refusal thrown by the mount
 * itself and one that reaches `ready` read the same way at the call site.
 */
async function doorman(t) {
  const dom = installDom();
  const audio = installAudio();
  const players = [];
  t.after(() => {
    for (const player of players) player.destroy();
  });
  t.after(() => {
    audio.restore();
    dom.restore();
  });

  const whole = read(STEM, 'bundle');
  return (options) => async () => {
    const player = createStoryPlayer(document.createElement('div'), {
      story: { ...whole, scenes: whole.scenes.slice(0, 1) },
      assetBase: ASSET_BASE,
      plates: platesOf(whole),
      stream: { scenes: 3 },
      ...options,
    });
    players.push(player);
    await player.ready;
  };
}

/**
 * A player mounted on a PREFIX, the way a host watching a writer mounts one:
 * the manifest's plates and scene count in hand, the scenes still coming.
 */
async function mount(t, { published = 1, stream = { scenes: 3 }, whole = read(STEM, 'bundle') } = {}) {
  const dom = installDom();
  const frames = virtualFrames();
  const audioFakes = installAudio();
  // Registered before the fakes are taken away, because these run in the order
  // they were added: a player torn down after `cancelAnimationFrame` had gone
  // back to node's own would take the real one with it.
  let handle = null;
  t.after(() => handle?.destroy());
  t.after(() => {
    audioFakes.restore();
    frames.restore();
    dom.restore();
  });

  const plates = platesOf(whole);
  const host = document.createElement('div');
  handle = createStoryPlayer(host, {
    story: { ...whole, scenes: whole.scenes.slice(0, published) },
    assetBase: ASSET_BASE,
    plates,
    stream,
  });
  await handle.ready;

  const root = host.shadowRoot;
  const sceneAt = (index) => structuredClone(whole.scenes[index]);
  return {
    handle,
    frames,
    scene: sceneAt,
    // The same length the runtime is playing, compiled the way it compiled it.
    durationOf: (count) => compileTimeline(
      { ...whole, scenes: whole.scenes.slice(0, count) },
      { plates },
    ).duration_ms,
    appendScene: (scene) => handle.appendScene(typeof scene === 'number' ? sceneAt(scene) : scene),
    finishStory: (status) => handle.finishStory(status),
    waiting: findByClass(root, 'waiting-overlay'),
    end: findByClass(root, 'end-overlay'),
    badge: findByClass(root, 'story-scene'),
    subtitle: findByClass(root, 'subtitle'),
    total: findByClass(root, 'time-total'),
    // The schedule the player is really playing, taken out the way a bug report
    // takes it — the only view of it a host or a test has from outside.
    timeline: () => downloadSession(root),
    video: findByClass(root, 'plate-video'),
    audio: audioFakes.opened,
    toggle: findByClass(root, 'play-button'),
    start: () => findByClass(root, 'start-button').dispatch('click'),
  };
}
