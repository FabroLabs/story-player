import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceFixture } from './_performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { resolveStoryAssets } from '../browser/v0/app/urls.mjs';
import {
  sceneAssetPlan,
  planAssets,
  createSceneLoader,
} from '../browser/v0/app/assets/scene-loader.mjs';
import { buildDrawList } from '../browser/v0/app/stage/draw-list.mjs';
import { paintDrawList } from '../browser/v0/app/stage/canvas-stage.mjs';
import { fakeContext } from './_dom.mjs';

test('WHT resolves every external asset under the trusted root and enumerates scene dependencies', () => {
  const raw = performanceFixture();
  const story = resolveStoryAssets(raw, 'https://storage.example/');
  assert.equal(
    story.assets.prop.url,
    'https://storage.example/fairytale-assets/apple.png',
  );
  assert.equal(story.assets.prop.media, raw.assets.prop.media);
  assert.equal(
    story.audio[0].url,
    'https://storage.example/fabro-packs/test/line.m4a',
  );
  const plan = sceneAssetPlan(compileTimeline(story), story, 0);
  assert.equal(planAssets(plan).length, 2);
  raw.assets.prop.media = '../escape.png';
  assert.throws(() => resolveStoryAssets(raw, 'https://storage.example/'));
});

test('browser executes the shared source rectangle, transform and layer ordering', () => {
  const story = resolveStoryAssets(
    performanceFixture(),
    'https://storage.example/',
  );
  const list = buildDrawList(stateAt(compileTimeline(story), story, 1500));
  assert.deepEqual(
    list.commands.map((c) => c.id),
    ['hero', 'apple'],
  );
  const context = fakeContext();
  context.transform = (...args) => context.calls.push(['transform', ...args]);
  paintDrawList(context, list, { lookup: () => ({ width: 200, height: 100 }) });
  assert.equal(context.of('drawImage').length, 2);
  assert.ok(
    context.calls.some(
      (c) => c[0] === 'transform' && c[5] === 200 && c[6] === 110,
    ),
  );
});

test('WHT remote image failure rejects the scene gate instead of claiming readiness', async () => {
  const story = resolveStoryAssets(
    performanceFixture(),
    'https://storage.example/',
  );
  const cache = {
    keep() {},
    has() {
      return false;
    },
    load: async () => {
      throw new Error('404');
    },
  };
  const loader = createSceneLoader({
    timeline: compileTimeline(story),
    bundle: story,
    cache,
  });
  await assert.rejects(loader.loadScene(0), /404/);
});
