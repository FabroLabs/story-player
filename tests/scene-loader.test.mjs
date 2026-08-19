/**
 * What a scene loads, in what order, and what it says when something is broken.
 *
 * The corpus tests are the ones that matter: seven real stories, 161 sheets,
 * and the plan is checked against the timeline they were compiled from rather
 * than against a fixture written to agree with the code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSceneLoader,
  maxCameraScale,
  planAssets,
  sceneAssetPlan,
} from '../browser/v0/app/assets/scene-loader.mjs';
import { PAN_SCALE_FLOOR, PUSH_SCALE } from '../browser/v0/policy.mjs';
import { createStoryPlayer } from '../browser/embed.mjs';
import { STEMS, read } from './_parity.mjs';
import { installDom } from './_dom.mjs';

/** Every `slug clip` pair an op names, and the ones replaced in the same ms. */
function clipsNamedBy(timeline, sceneIndex) {
  const named = new Set();
  const lastAtInstant = new Map();
  for (const event of timeline.events) {
    if (event.source !== 'stage' || event.scene_index !== sceneIndex || !event.clip) continue;
    named.add(`${event.slug} ${event.clip}`);
    lastAtInstant.set(`${event.slug} ${event.t_ms}`, `${event.slug} ${event.clip}`);
  }
  const visible = new Set(lastAtInstant.values());
  return { named, replacedSameInstant: [...named].filter((key) => !visible.has(key)) };
}

function fakeCache({ fails = () => false } = {}) {
  const loaded = [];
  let kept = [];
  let inFlight = 0;
  let peak = 0;
  return {
    loaded,
    kept: () => kept,
    peakInFlight: () => peak,
    keep(urls) { kept = [...urls]; },
    async load(url) {
      loaded.push(url);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // One turn of the loop, so a caller that fires everything at once is
      // visibly different from one that waits.
      await Promise.resolve();
      inFlight -= 1;
      if (fails(url)) throw new Error(`asset ${url} answered 404`);
      return { width: 8, height: 8 };
    },
  };
}

function stripRenditions(bundle) {
  const stripped = structuredClone(bundle);
  for (const character of Object.values(stripped.cast)) {
    for (const clip of Object.values(character.clips)) delete clip.renditions;
  }
  return stripped;
}

test('the corpus draws every clip that is ever on screen, and asks for no PNG', () => {
  let sheets = 0;
  let replaced = 0;
  for (const stem of STEMS) {
    const bundle = read(stem, 'bundle');
    const timeline = read(stem, 'timeline');
    for (const [sceneIndex] of bundle.scenes.entries()) {
      const plan = sceneAssetPlan(timeline, bundle, sceneIndex, {});
      const planned = new Set(plan.sheets.map((sheet) => `${sheet.slug} ${sheet.clip}`));
      const { named, replacedSameInstant } = clipsNamedBy(timeline, sceneIndex);
      replaced += replacedSameInstant.length;

      for (const key of named) {
        if (replacedSameInstant.includes(key)) {
          assert.equal(planned.has(key), false, `${stem} ${sceneIndex}: ${key} is never drawn for a millisecond`);
          continue;
        }
        assert.ok(planned.has(key), `${stem} scene ${sceneIndex} draws ${key} and did not plan for it`);
      }
      assert.equal(planned.size, named.size - replacedSameInstant.length, `${stem} ${sceneIndex} planned a sheet nothing draws`);

      for (const sheet of plan.sheets) {
        sheets += 1;
        assert.match(sheet.url, /\/mobile\/sprites\/[^/]+\.webp$/, 'a rendition, never the original');
        assert.ok([200, 320, 384, 512].includes(sheet.tier));
      }
    }
  }
  // Measured, so a test that quietly stops covering the corpus fails loudly.
  assert.equal(sheets, 161, 'the corpus draws 161 sheets across its 24 scenes');
  assert.equal(replaced, 3, 'three clips in the corpus are replaced in the same millisecond they are set');
});

test('a scene is planned at the magnification it actually reaches', () => {
  const push = read('golden_push_dusk', 'timeline');
  const pushBundle = read('golden_push_dusk', 'bundle');
  assert.equal(sceneAssetPlan(push, pushBundle, 0, {}).cameraScale, 1.55, 'a push-in magnifies to the push scale');
  assert.equal(sceneAssetPlan(push, pushBundle, 1, {}).cameraScale, 1, 'a scene with no camera op stays wide');

  const shot = read('golden_camera_moves', 'timeline');
  const shotBundle = read('golden_camera_moves', 'bundle');
  assert.equal(
    sceneAssetPlan(shot, shotBundle, 0, {}).cameraScale,
    2.048,
    'a close-up is framed by its subject, so its scale is on the wire and the plan reads it',
  );
});

test('the camera term reaches the tier, and a close-up is what proves it', () => {
  const timeline = read('golden_camera_moves', 'timeline');
  const bundle = read('golden_camera_moves', 'bundle');
  const plan = sceneAssetPlan(timeline, bundle, 0, {});

  // A `close` on a 25 cm rabbit is 512/250 = 2.048 on the wire, and the whole
  // point of the 512 tier is that this scene does not come back soft. Drop the
  // camera term from the size the picker is asked for and these are 320s.
  assert.deepEqual(plan.sheets.map((sheet) => sheet.tier), [512, 320, 512, 512, 512]);
  for (const sheet of plan.sheets) {
    assert.equal(sheet.wantedPx, sheet.drawnHeightPx * plan.cameraScale);
  }
});

test('each camera op contributes the magnification it can reach, and nothing else', () => {
  assert.equal(maxCameraScale([]), 1);
  assert.equal(maxCameraScale([{ op: 'pan' }]), PAN_SCALE_FLOOR, 'a pan lifts the scale before it can move at all');
  assert.equal(maxCameraScale([{ op: 'push_in' }]), PUSH_SCALE);
  assert.equal(maxCameraScale([{ op: 'push_in' }, { op: 'pan' }]), PUSH_SCALE, 'a pan after a push holds the push');
  assert.equal(maxCameraScale([{ op: 'shot', scale: 3.2 }, { op: 'pull_out' }]), 3.2, 'a pull-out does not un-magnify the past');
  assert.equal(maxCameraScale([{ op: 'shot', scale: null }, { op: 'camera_reset' }]), 1);
  assert.equal(maxCameraScale([{ op: 'move', duration_ms: 900 }]), 1, 'a walk is not a camera op');
});

test('more magnification never picks a smaller sheet', () => {
  const timeline = read('the_owls_quiet_friend', 'timeline');
  const bundle = read('the_owls_quiet_friend', 'bundle');
  const wide = sceneAssetPlan(timeline, bundle, 1, { fitScale: 0.5 });
  const dense = sceneAssetPlan(timeline, bundle, 1, { fitScale: 0.5, dpr: 2 });

  assert.equal(wide.sheets.length, dense.sheets.length);
  let sharper = 0;
  for (const [index, sheet] of wide.sheets.entries()) {
    assert.ok(dense.sheets[index].tier >= sheet.tier, `${sheet.clip} lost resolution when the screen gained it`);
    if (dense.sheets[index].tier > sheet.tier) sharper += 1;
  }
  assert.ok(sharper > 0, 'doubling the device pixel ratio changed nothing, so this proves nothing');
});

test('the poster comes first, then the sheets, then the props', () => {
  const timeline = read('golden_heal_travel', 'timeline');
  const bundle = read('golden_heal_travel', 'bundle');
  const plan = sceneAssetPlan(timeline, bundle, 1, {});
  const assets = planAssets(plan);

  assert.equal(plan.props.length, 1, 'this scene puts one prop on the stage');
  assert.deepEqual(assets.map(({ asset }) => asset), ['poster', 'sheet', 'sheet', 'prop']);
  assert.equal(assets[0].url, bundle.scenes[1].plate.poster);
});

test('the gate loads the whole first scene, counts it, and keeps it in the cache', async () => {
  const timeline = read('golden_push_dusk', 'timeline');
  const bundle = read('golden_push_dusk', 'bundle');
  const cache = fakeCache();
  const progress = [];
  const loader = createSceneLoader({ timeline, bundle, cache });

  const result = await loader.loadScene(0, {}, { keep: true, onProgress: (done, total) => progress.push([done, total]) });

  assert.deepEqual(result, { total: 3, failed: 0 }, 'the poster and both of scene 1\'s sheets');
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
  assert.deepEqual(cache.kept(), cache.loaded, 'the scene on screen is what the cache holds on to');
});

test('a broken asset is one line in the log, and the story still opens', async () => {
  const timeline = read('golden_push_dusk', 'timeline');
  const bundle = read('golden_push_dusk', 'bundle');
  const cache = fakeCache({ fails: (url) => url.endsWith('.webp') });
  const warnings = [];
  const loader = createSceneLoader({ timeline, bundle, cache, onWarning: (detail) => warnings.push(detail) });

  const first = await loader.loadScene(0, {});
  assert.equal(first.failed, 2);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].type, 'media');
  assert.equal(warnings[0].asset, 'sheet');
  assert.match(warnings[0].message, /answered 404/);

  await loader.loadScene(0, {});
  assert.equal(warnings.length, 2, 'the same broken sheet said the same thing twice');
});

test('destroying the player stops the gate rather than finishing it', async () => {
  const timeline = read('ruby_and_the_gentle_dark', 'timeline');
  const bundle = read('ruby_and_the_gentle_dark', 'bundle');
  const controller = new AbortController();
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache, signal: controller.signal });

  const running = loader.loadScene(0, {}, { onProgress: () => controller.abort() });
  await assert.rejects(running, (error) => error.name === 'AbortError');
});

test('later scenes are warmed in playing order, one at a time', async () => {
  const timeline = read('golden_push_dusk', 'timeline');
  const bundle = read('golden_push_dusk', 'bundle');
  const cache = fakeCache();
  const scenes = [];
  const loader = createSceneLoader({ timeline, bundle, cache });

  await loader.queueRemainingScenes(1, {}, { onScene: (index, total) => scenes.push([index, total]) });

  assert.deepEqual(scenes, [[1, 3], [2, 2]]);
  assert.equal(loader.sceneCount(), 3);
  assert.equal(
    cache.peakInFlight(),
    1,
    'warming ahead in parallel starves the narration and the video the viewer is watching now',
  );
  assert.deepEqual(cache.kept(), [], 'a scene being warmed ahead is not the scene on screen');
});

test('the warm queue asks what the viewport is at every scene, not once at the start', async () => {
  // The queue outlives a tier demotion: it is started at `begin()` and still
  // running minutes later, when the machine may have been put on a cheaper
  // tier or the window resized. Holding the numbers it was started with, it
  // spends the rest of the story fetching sheets the scene will not be opened
  // with — on exactly the devices that demoted.
  const timeline = read('golden_push_dusk', 'timeline');
  const bundle = read('golden_push_dusk', 'bundle');
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache });
  // A stage big enough that the two ceilings land on different rungs of the
  // ladder — and neither of them on the rung a viewport of nothing would pick,
  // which is what a plan built from the function object itself comes out as.
  let dprCap = 2;
  const viewport = () => ({ fitScale: 2, dpr: 3, dprCap });
  let boundary = 0;

  await loader.queueRemainingScenes(1, viewport, {
    onScene: (index) => {
      // Demoted between the two scenes, the way the recorder does it.
      if (index !== 1) return;
      boundary = cache.loaded.length;
      dprCap = 1.5;
    },
  });

  const urls = (view) => [...new Set(loader.plan(2, view).sheets.map((sheet) => sheet.url))];
  const demoted = new Set(urls({ fitScale: 2, dpr: 3, dprCap: 1.5 }));
  assert.notDeepEqual(
    [...demoted],
    urls({ fitScale: 2, dpr: 3, dprCap: 2 }),
    'the two ceilings choose the same sheets: this proves nothing',
  );
  assert.notDeepEqual(
    [...demoted],
    urls({}),
    'the demoted plan is the one a viewport of nothing gives: this proves nothing',
  );
  const warmed = cache.loaded.slice(boundary).filter((url) => url.includes('/sprites/'));
  assert.ok(warmed.length > 0, 'the last scene was warmed with no sheets at all');
  assert.deepEqual(
    warmed.filter((url) => !demoted.has(url)),
    [],
    'the queue warmed the last scene with the sheets of the tier the story had left',
  );
});

test('the gate fetches its scene all at once — somebody is watching the progress line', async () => {
  const timeline = read('golden_push_dusk', 'timeline');
  const bundle = read('golden_push_dusk', 'bundle');
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache });

  await loader.loadScene(0, {}, { keep: true });

  assert.equal(cache.peakInFlight(), 3, 'nothing else is competing for the link while the gate is shut');
});

/** One character, one clip, the whole ladder — so the tier fetched is visible. */
function ladderStory() {
  return {
    storylang_version: 0,
    title: 'One rabbit',
    cast: {
      rabbit: {
        height_cm: 15, // 150 stage px drawn, on a band that does not shrink it
        capability: { idle: { camera: 'idle' } },
        clips: {
          idle: {
            spritesheet: 'fairytale-assets/sprites/rabbit/idle/spritesheet.png',
            atlas: null,
            frames: 1,
            fps: 12,
            grid: [1, 1],
            renditions: {
              200: 'fairytale-assets/mobile/sprites/tier200.webp',
              320: 'fairytale-assets/mobile/sprites/tier320.webp',
              384: 'fairytale-assets/mobile/sprites/tier384.webp',
              512: 'fairytale-assets/mobile/sprites/tier512.webp',
            },
          },
        },
      },
    },
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      place: 'dell',
      plate: {
        poster: 'fairytale-assets/plates/dell.jpg',
        video: 'fairytale-assets/plates/dell.mp4',
      },
      steps: [{ kind: 'cmd', cmd: 'put', subjects: ['rabbit'], line: 1 }],
    }],
  };
}

async function tierFetchedAt(devicePixelRatio, t) {
  const dom = installDom();
  const saved = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = devicePixelRatio;
  t.after(() => {
    globalThis.devicePixelRatio = saved;
    dom.restore();
  });

  const player = createStoryPlayer(document.createElement('div'), {
    story: ladderStory(),
    assetBase: 'https://storage.example/',
  });
  await player.ready;
  player.destroy();
  return dom.fetched().filter((url) => url.includes('/mobile/sprites/'));
}

test('the mounted player fetches the tier its stage and screen actually need', async (t) => {
  // 150 px drawn, fit scale 1: one device pixel per stage pixel needs the 200
  // tier; two need 300, which only the 320 tier carries. If the viewport never
  // reached the picker, both of these would be the same sheet.
  assert.deepEqual(await tierFetchedAt(1, t), ['https://storage.example/fairytale-assets/mobile/sprites/tier200.webp']);
  assert.deepEqual(await tierFetchedAt(2, t), ['https://storage.example/fairytale-assets/mobile/sprites/tier320.webp']);
});

test('a bundle without renditions plays from the originals and says so once per clip', async () => {
  const timeline = read('golden_push_dusk', 'timeline');
  const bundle = stripRenditions(read('golden_push_dusk', 'bundle'));
  const cache = fakeCache();
  const warnings = [];
  const loader = createSceneLoader({ timeline, bundle, cache, onWarning: (detail) => warnings.push(detail) });

  await loader.loadScene(0, {});
  const sheets = loader.plan(0, {}).sheets;

  assert.equal(sheets.length, 2);
  for (const sheet of sheets) {
    assert.equal(sheet.tier, null);
    assert.match(sheet.url, /spritesheet\.png$/);
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message, /no renditions/);

  await loader.loadScene(0, {});
  assert.equal(warnings.length, 2, 'the same clip said it twice');
});
