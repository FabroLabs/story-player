/**
 * What the begin button waits for, and what it refuses to wait for.
 *
 * The gate is only worth having if it covers the first scene and nothing more:
 * gate too little and the story still assembles itself on screen, gate too
 * much and a viewer stares at a spinner while thirty sheets for scenes they
 * have not reached come down a 290 KB/s link.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { firstPaintAssets, preload, queueRemainingScenes, sceneAssets } from '../browser/v0/app/asset-preloader.mjs';

const STORY = {
  cast: {
    rabbit: {
      capability: {
        idle: { camera: 'idle' },
        happy: { left: 'happy_left', right: 'happy_right' },
        sad: { camera: 'sad' },
        move: { left: 'move_left', right: 'move_right' },
      },
      clips: {
        idle: { spritesheet: 'sheets/rabbit/idle.png' },
        happy_left: { spritesheet: 'sheets/rabbit/happy_left.png' },
        happy_right: { spritesheet: 'sheets/rabbit/happy_right.png' },
        sad: { spritesheet: 'sheets/rabbit/sad.png' },
        move_left: { spritesheet: 'sheets/rabbit/move_left.png' },
        move_right: { spritesheet: 'sheets/rabbit/move_right.png' },
      },
    },
    owl: {
      capability: { idle: { camera: 'idle' } },
      clips: { idle: { spritesheet: 'sheets/owl/idle.png' } },
    },
  },
  objects: { lamp: { svg: 'objects/lamp.svg' } },
  scenes: [
    {
      place: 'dell',
      plate: { poster: 'plates/dell.jpg', video: 'plates/dell.mp4' },
      steps: [
        { kind: 'cmd', cmd: 'put', subjects: ['rabbit'] },
        { kind: 'cmd', cmd: 'put', subjects: ['lamp'], objects: ['lamp'] },
        { kind: 'cmd', cmd: 'emote', subjects: ['rabbit'], emotion: 'happy' },
      ],
    },
    {
      place: 'grove',
      plate: { poster: 'plates/grove.jpg', video: 'plates/grove.mp4' },
      steps: [{ kind: 'cmd', cmd: 'put', subjects: ['owl'] }],
    },
  ],
};

test('the first scene gates on its poster, its props and only the verbs it uses', () => {
  const urls = sceneAssets(STORY, STORY.scenes[0]);

  assert.equal(urls[0], 'plates/dell.jpg', 'the poster is what a viewer looks at first');
  assert.ok(urls.includes('sheets/rabbit/idle.png'), 'idle is always reachable');
  assert.ok(urls.includes('sheets/rabbit/happy_left.png'), 'both facings of an emote it plays');
  assert.ok(urls.includes('sheets/rabbit/happy_right.png'));
  assert.ok(urls.includes('objects/lamp.svg'), 'a prop is on screen the instant it is put');

  assert.ok(!urls.includes('sheets/rabbit/sad.png'), 'this scene never plays sad');
  assert.ok(!urls.includes('sheets/owl/idle.png'), 'the owl is in the NEXT scene');
});

test('the plate video is never gated on', () => {
  // It streams, `#loadPlate` already waits on `canplay` with its own deadline,
  // and holding the begin button for tens of megabytes defeats the point.
  assert.ok(!sceneAssets(STORY, STORY.scenes[0]).includes('plates/dell.mp4'));
});

test('a walking character brings its locomotion sheets', () => {
  const scene = {
    plate: {},
    steps: [{ kind: 'cmd', cmd: 'move', subjects: ['rabbit'] }],
  };
  const urls = sceneAssets(STORY, scene);
  assert.ok(urls.includes('sheets/rabbit/move_left.png'));
  assert.ok(urls.includes('sheets/rabbit/move_right.png'));
});

test('subjects inside a together: are found too', () => {
  const scene = {
    plate: {},
    steps: [{ kind: 'together', steps: [{ kind: 'cmd', cmd: 'emote', subjects: ['rabbit'], emotion: 'sad' }] }],
  };
  assert.ok(sceneAssets(STORY, scene).includes('sheets/rabbit/sad.png'));
});

test('a broken asset never holds the gate shut', async () => {
  // Refusing to start a story over one missing sheet would be worse than the
  // pop-in this exists to remove; the renderer still warns when it draws.
  const load = (url) => (url.includes('happy_left') ? Promise.reject(new Error('404')) : Promise.resolve(url));
  const result = await preload(sceneAssets(STORY, STORY.scenes[0]), { load });

  assert.equal(result.failed, 1);
  assert.ok(result.total > 1);
});

test('progress counts every asset exactly once, ending at the total', async () => {
  const seen = [];
  const result = await preload(['a', 'b', 'c'], {
    load: (url) => Promise.resolve(url),
    onProgress: (done, total) => seen.push([done, total]),
  });

  assert.deepEqual(seen, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(result, { total: 3, failed: 0 });
});

test('an empty scene reports no work rather than hanging', async () => {
  assert.deepEqual(await preload([], { load: () => Promise.resolve() }), { total: 0, failed: 0 });
});

test('later scenes are queued one at a time, in playing order', async () => {
  // Sequential on purpose: these run DURING playback, and firing everything at
  // a slow link starves the narration and plate video the viewer is waiting on.
  let inFlight = 0;
  let peak = 0;
  const order = [];
  const load = (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    order.push(url);
    return Promise.resolve().then(() => { inFlight -= 1; });
  };

  const scenes = [];
  await queueRemainingScenes(STORY, { load, onScene: (index) => scenes.push(index) });

  // Scene 0 leads: the gate only covered its FIRST FRAME, so the rest of the
  // scene now playing outranks scenes nobody has reached. Gating all of scene 1
  // is 64 MB against the real bucket — 221 s of spinner — so the split is not
  // a preference, it is the only shape that both starts quickly and catches up.
  assert.deepEqual(scenes, [0, 1], 'the rest of the opening scene must come first');
  assert.equal(order[0], 'plates/dell.jpg', 'scene 0 leads the queue');
  assert.ok(order.includes('sheets/rabbit/sad.png') === false, 'scene 0 never plays sad');
  assert.ok(order.includes('sheets/owl/idle.png'), 'later scenes still arrive');
  assert.equal(peak, 1, `the background queue ran ${peak} requests at once — it must not starve narration`);
});

test('the gate is the first frame only, not everything the scene can reach', () => {
  // Measured against the real bucket: all of scene 1 is 20 assets and 64 MB
  // (~221 s at 290 KB/s) in front of a four-minute story. First paint is 7
  // assets and 14 MB. Anything that widens this back out has to answer for it.
  const gate = firstPaintAssets(STORY, STORY.scenes[0]);
  const whole = sceneAssets(STORY, STORY.scenes[0]);

  assert.ok(gate.includes('plates/dell.jpg'), 'the plate a viewer stares at');
  assert.ok(gate.includes('sheets/rabbit/idle.png'), 'the pose they open in');
  assert.ok(gate.includes('objects/lamp.svg'), 'a prop is there from the first frame');
  assert.ok(!gate.includes('sheets/rabbit/happy_left.png'), 'a later expression can stream');
  assert.ok(gate.length < whole.length, 'the gate must be smaller than the scene');
});
