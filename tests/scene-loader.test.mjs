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
  KEEP_CADENCE_MS,
  createSceneLoader,
  maxCameraScale,
  planAssets,
  sceneAssetPlan,
  sceneKeepUrls,
} from '../browser/v0/app/assets/scene-loader.mjs';
import { SMALL_DEVICE_BUDGET_BYTES, createBitmapCache } from '../browser/v0/app/assets/bitmap-cache.mjs';
import { sceneSheets } from '../browser/v0/app/stage/canvas-stage.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { PAN_SCALE_FLOOR, PUSH_SCALE } from '../browser/v0/policy.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStoryPlayer } from '../browser/embed.mjs';
import { STEMS, read } from './_parity.mjs';
import {
  FRAMES_PER_CHUNK,
  POSTER,
  chunkedFixture,
  decodeFrom,
  decodedSizes,
  lateEntryFixture,
  withoutChunks,
} from './_chunked.mjs';
import { installDom } from './_dom.mjs';

const name = (url) => String(url).split('/').pop();

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
  const held = new Set();
  let kept = [];
  let inFlight = 0;
  let peak = 0;
  return {
    loaded,
    kept: () => kept,
    peakInFlight: () => peak,
    keep(urls) { kept = [...urls]; },
    has(url) { return held.has(url); },
    async load(url) {
      loaded.push(url);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // One turn of the loop, so a caller that fires everything at once is
      // visibly different from one that waits.
      await Promise.resolve();
      inFlight -= 1;
      if (fails(url)) throw new Error(`asset ${url} answered 404`);
      // Residency is the real cache's answer to `has`, and it remembers no
      // failure: a broken asset is not held, so nothing stops it being asked
      // for again except the caller.
      held.add(url);
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

test('the gate takes the chunks its opening draws, and the first chunk of everything else', async () => {
  const { bundle, timeline } = chunkedFixture();
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache });

  await loader.loadScene(0, {}, { keep: true });

  assert.deepEqual(cache.loaded.map(name), [
    'dell.jpg',
    // Pip and bo are idling when the scene opens: the chunk under the playhead
    // and the one after it, which is the window the budget was measured for.
    'pip-idle-512-c0.webp',
    'pip-idle-512-c1.webp',
    'bo-idle-512-c0.webp',
    'bo-idle-512-c1.webp',
    // Moss's whole clip is shorter than one chunk, so the window is one object.
    'moss-idle-512-c0.webp',
    // Pip waves later in the scene. Its opening chunk is FETCHED, so the pose
    // is in the browser's cache before the story reaches it...
    'pip-wave-512-c0.webp',
  ]);
  assert.deepEqual(
    cache.kept().map(name),
    [
      'dell.jpg',
      'pip-idle-512-c0.webp', 'pip-idle-512-c1.webp',
      'bo-idle-512-c0.webp', 'bo-idle-512-c1.webp',
      'moss-idle-512-c0.webp',
    ],
    '...and is NOT kept: five characters times two chunks is the whole budget beside the poster',
  );
  assert.equal(
    cache.loaded.some((url) => /512\.webp$/.test(url)),
    false,
    'bo\'s whole 81-frame sheet at 512 is 85 MB — more than the budget on its own, which is the bug',
  );
});

test('a scene warmed ahead takes one chunk per clip and nothing else', async () => {
  const { bundle, timeline } = chunkedFixture();
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache });

  await loader.loadScene(0, {}, { concurrency: 1 });

  assert.deepEqual(cache.loaded.map(name), [
    'dell.jpg',
    'pip-idle-512-c0.webp', 'bo-idle-512-c0.webp', 'moss-idle-512-c0.webp', 'pip-wave-512-c0.webp',
  ], 'a scene the story has not reached needs the chunk it opens on, not the loop it settles into');
  assert.deepEqual(cache.kept(), [], 'a scene being warmed ahead is not the scene on screen');
});

test('the window follows the playhead, and holding it is what fetches the next chunk', async () => {
  const { bundle, timeline } = chunkedFixture();
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache });
  const plan = loader.plan(0, {});

  await loader.loadScene(0, {}, { keep: true });
  const gated = cache.loaded.length;

  // Three seconds in: pip is twelve frames into a 12 fps idle — chunk three of
  // six — and bo is thirty-six frames into theirs. None of those four objects
  // were in the gate's window.
  loader.holdScene(0, {}, stateAt(timeline, bundle, 3000).actors);

  assert.deepEqual(cache.kept().map(name), [
    'dell.jpg',
    'pip-idle-512-c3.webp', 'pip-idle-512-c4.webp',
    'bo-idle-512-c9.webp', 'bo-idle-512-c10.webp',
    'moss-idle-512-c0.webp',
  ]);
  assert.deepEqual(
    cache.loaded.slice(gated).map(name),
    ['pip-idle-512-c3.webp', 'pip-idle-512-c4.webp', 'bo-idle-512-c9.webp', 'bo-idle-512-c10.webp'],
    'what is already decoded is not asked for again',
  );

  // The wave starts at six seconds and pip is three frames into it at seven:
  // its first chunk, and the next, and the idle chunks are free to go.
  loader.holdScene(0, {}, stateAt(timeline, bundle, 7000).actors);
  assert.deepEqual(cache.kept().map(name), [
    'dell.jpg',
    'pip-wave-512-c0.webp', 'pip-wave-512-c1.webp',
    'bo-idle-512-c0.webp', 'bo-idle-512-c1.webp',
    'moss-idle-512-c0.webp',
  ]);

  // A clip loops, and so does its ladder: the chunk after the last is the first.
  loader.holdScene(0, {}, [{ slug: 'pip', clip: 'wave', frame: 8 }]);
  assert.deepEqual(
    cache.kept().map(name),
    ['dell.jpg', 'pip-wave-512-c2.webp', 'pip-wave-512-c0.webp'],
  );
});

test('a chunk that will not load is asked for once, not on every cadence tick', async () => {
  const { bundle, timeline } = chunkedFixture();
  const broken = 'fairytale-assets/mobile/sprites/pip-idle-512-c3.webp';
  const cache = fakeCache({ fails: (url) => url === broken });
  const warnings = [];
  const loader = createSceneLoader({
    timeline, bundle, cache, onWarning: (detail) => warnings.push(detail),
  });
  const actors = stateAt(timeline, bundle, 3000).actors;

  for (let tick = 0; tick < 5; tick += 1) {
    loader.holdScene(0, {}, actors);
    await Promise.resolve();
    await Promise.resolve();
  }

  assert.equal(cache.loaded.filter((url) => url === broken).length, 1, 'the cache remembers no failure; this must');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, `asset ${broken} answered 404`);
  assert.deepEqual(
    { asset: warnings[0].asset, slug: warnings[0].slug, clip: warnings[0].clip },
    { asset: 'sheet', slug: 'pip', clip: 'idle' },
    'a chunk key is content-addressed: without the character and clip the line names nothing anyone can act on',
  );

  // A dropped connection is not a missing object, and the cache says so itself:
  // it remembers no failure so a later scene "is free to try again on a link
  // that may have come back". Opening a scene is that later moment.
  await loader.loadScene(0, {}, { keep: true });
  loader.holdScene(0, {}, actors);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(cache.loaded.filter((url) => url === broken).length, 2, 'the scene opened and nothing tried again');
  assert.equal(warnings.length, 1, 'the second attempt failed too, and said the same thing twice');
});

test('a scene that opens on a line of narration still keeps the cast that arrives after it', async () => {
  const { bundle, timeline } = lateEntryFixture();
  const cache = fakeCache();
  const loader = createSceneLoader({ timeline, bundle, cache });

  await loader.loadScene(0, {}, { keep: true });

  // Every scene begins with a `scene` op and a subtitle at t=0. Counted from the
  // first sample rather than the first sample with anybody in it, this scene
  // opens on an empty stage: the sprites the gate just decoded would be
  // evictable the moment they land, and `bitmap-cache`'s own promise — that the
  // current scene's sheets are kept — would be false for it.
  assert.deepEqual(cache.kept().map(name), [
    'dell.jpg',
    'pip-idle-512-c0.webp', 'pip-idle-512-c1.webp',
    'bo-idle-512-c0.webp', 'bo-idle-512-c1.webp',
  ]);
});

test('the cadence re-reads the window at least twice inside the shortest chunk there can be', () => {
  // Not a number copied from the constant: the shortest a chunk can hold the
  // stage is the smallest `frames_per_chunk` the encoder emits, played at the
  // fastest clip the corpus actually carries. A 30 fps clip landing in the
  // corpus one day fails here rather than stalling in somebody's browser.
  const fastestFps = Math.max(...STEMS.flatMap((stem) => Object
    .values(read(stem, 'bundle').cast)
    .flatMap((character) => Object.values(character.clips).map((clip) => clip.fps))));
  const shortestChunkMs = (1000 * Math.min(...Object.values(FRAMES_PER_CHUNK))) / fastestFps;

  assert.equal(fastestFps, 24, 'the corpus changed the fastest clip it carries');
  assert.ok(
    KEEP_CADENCE_MS * 2 <= shortestChunkMs,
    `${KEEP_CADENCE_MS} ms twice does not fit inside a ${Math.round(shortestChunkMs)} ms chunk:`
    + ' the next chunk would be asked for after it was already being drawn',
  );
});

test('the kept window fits the budget at the count it was measured for, and not past it', () => {
  const { bundle, timeline } = chunkedFixture();
  const sizes = decodedSizes(bundle);
  const plan = sceneAssetPlan(timeline, bundle, 0, {});
  const bytes = (urls) => urls.reduce((total, url) => {
    const { width, height } = sizes.get(url) ?? { width: 0, height: 0 };
    return total + (width * height * 4);
  }, 0);

  const poster = bytes([POSTER]);
  const held = bytes(sceneKeepUrls(plan, [{ slug: 'bo', clip: 'idle', frame: 0 }])) - poster;

  assert.equal(poster, 8_294_400, 'the poster decodes into the same cache, before a single sheet');
  assert.equal(held, 8_388_608, 'one character\'s window: two chunks of 2x2 cells at 512 px');
  // The engine sized every chunk against five characters on stage
  // (`MAX_ON_STAGE`, `tools/playerkit/renditions.py`) and this is that sum.
  assert.ok(poster + (5 * held) <= SMALL_DEVICE_BUDGET_BYTES, 'the count the chunk lengths were measured for does not fit');
  assert.equal(
    SMALL_DEVICE_BUDGET_BYTES - (poster + (5 * held)),
    94_208,
    'the slack at that count is 92 KB, and one 256 px prop on stage is three times it',
  );
  assert.ok(
    poster + (6 * held) > SMALL_DEVICE_BUDGET_BYTES,
    'six characters is over the budget and nothing here clamps it — `backlog-chunk-stall-is-silent.md`',
  );
});

test('a prop is kept while it is on stage, and not once it has gone', () => {
  const plan = { poster: 'dell.jpg', props: [{ slug: 'lantern', url: 'lantern.svg' }], sheets: [] };

  assert.deepEqual(
    sceneKeepUrls(plan),
    ['dell.jpg', 'lantern.svg'],
    'before there is a first frame the plan is all there is, and the gate decoded it anyway',
  );
  assert.deepEqual(sceneKeepUrls(plan, [{ slug: 'lantern', kind: 'object' }]), ['dell.jpg', 'lantern.svg']);
  assert.deepEqual(
    sceneKeepUrls(plan, [{ slug: 'pip', clip: 'idle', frame: 0 }]),
    ['dell.jpg'],
    'the budget has 92 KB of slack at five characters: a lantern nobody is holding cannot be in it',
  );
});

test('a chunk ladder that does not match the clip is refused once, and the scene still draws', async () => {
  const { bundle, timeline } = chunkedFixture();
  bundle.cast.pip.clips.idle.rendition_chunks[512].keys.pop();
  const cache = fakeCache();
  const warnings = [];
  const loader = createSceneLoader({
    timeline, bundle, cache, onWarning: (detail) => warnings.push(detail),
  });

  await loader.loadScene(0, {}, { keep: true });
  await loader.loadScene(0, {}, { keep: true });

  assert.equal(warnings.length, 1, 'said once per clip, not once per scene it appears in');
  assert.equal(warnings[0].message, 'chunk ladder unusable at 512 px; drawing from the whole rendition');
  assert.deepEqual(
    [...new Set(cache.loaded.filter((url) => url.includes('pip-idle')).map(name))],
    ['pip-idle-512.webp'],
    'the whole rendition is drawn instead — correct, and the memory it was cut up to save is what is lost',
  );
});

test('a ladder that skips the tier this viewport draws is the same refusal', async () => {
  const { bundle, timeline } = chunkedFixture();
  delete bundle.cast.moss.clips.idle.rendition_chunks[512];
  const cache = fakeCache();
  const warnings = [];
  const loader = createSceneLoader({
    timeline, bundle, cache, onWarning: (detail) => warnings.push(detail),
  });

  await loader.loadScene(0, {}, { keep: true });

  // The engine emits all four tiers or none, so a clip carrying chunks at 200
  // and 320 but not at the tier this stage picked is a build fault too — and it
  // reaches the reader the same way: `sheetFor` refuses the ladder it cannot
  // read, and the whole rendition is drawn.
  assert.deepEqual(
    warnings.map((detail) => [detail.slug, detail.clip, detail.message]),
    [['moss', 'idle', 'chunk ladder unusable at 512 px; drawing from the whole rendition']],
  );
  assert.ok(cache.loaded.includes('fairytale-assets/mobile/sprites/moss-idle-512.webp'));
});

test('the chunk window holds a small device inside its budget, and the whole sheets do not', async () => {
  const { bundle, timeline } = chunkedFixture();
  const sizes = decodedSizes(bundle);
  const budget = SMALL_DEVICE_BUDGET_BYTES;

  async function play(storyBundle) {
    const overBudget = [];
    const cache = createBitmapCache({
      budgetBytes: budget,
      decode: decodeFrom(sizes),
      onOverBudget: (detail) => overBudget.push(detail),
    });
    const loader = createSceneLoader({ timeline, bundle: storyBundle, cache });
    await loader.loadScene(0, {}, { keep: true });

    let peak = 0;
    let missing = 0;
    let sprites = 0;
    // The picture the canvas would paint, built the way the runtime builds it —
    // NOT by asking the keep set which chunk it chose, which would be the same
    // answer twice and could not catch a consistently wrong one.
    const book = sceneSheets(loader.plan(0, {}), cache);
    // Twenty-four frames a second across the whole story. WHEN the runtime asks
    // is the runtime's own rule (`KEEP_CADENCE_MS`, and immediately when
    // somebody changes clip — `tests/timeline-player.test.mjs`); what is being
    // measured here is that the answer is right every time it does.
    for (let tMs = 0; tMs <= timeline.duration_ms; tMs += Math.round(1000 / 24)) {
      const state = stateAt(timeline, storyBundle, tMs);
      loader.holdScene(0, {}, state.actors);
      // The link is instant here: what is being measured is whether the RIGHT
      // objects are asked for, not how long they take to arrive.
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      peak = Math.max(peak, cache.bytes);
      for (const command of buildDrawList(state, book).commands) {
        if (command.op === 'missing') missing += 1;
        if (command.op !== 'sprite') continue;
        sprites += 1;
        if (!cache.get(command.url)) missing += 1;
      }
    }
    return { peak, missing, sprites, overBudget: overBudget.length };
  }

  const chunked = await play(bundle);
  assert.equal(chunked.overBudget, 0, 'not one instant where the kept set alone did not fit');
  assert.ok(
    chunked.peak <= budget,
    `held ${Math.round(chunked.peak / 1024 / 1024)} MB against a ${budget / 1024 / 1024} MB budget`,
  );
  assert.equal(chunked.sprites, 858, 'the run drew a different number of sprites than it used to');
  assert.equal(chunked.missing, 0, 'every sprite the canvas drew had its chunk decoded: no stand-in at a boundary');

  // The same story, the same loop, the whole-sheet ladder: this is the bug.
  const whole = await play(withoutChunks(bundle));
  assert.ok(whole.overBudget > 0, 'the budget is not tight enough for this fixture to prove anything');
  assert.ok(whole.peak > budget, 'a 26 MB sheet each for two characters does not fit 48 MB beside the poster');
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
