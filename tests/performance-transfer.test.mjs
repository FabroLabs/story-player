import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceFixture } from './_performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
test('a transfer freezes the moving flipped receiver contact at the authored catch time', () => {
  const story = performanceFixture(),
    scene = story.scenes[0];
  scene.camera = {
    from: [500, 281.25, 1],
    to: [600, 300, 1.8],
    start_ms: 0,
    end_ms: 4000,
  };
  scene.nodes.push({
    id: 'receiver',
    asset: 'hero',
    x: 500,
    y: 200,
    height: 100,
    scale_x: -1,
    clip: { fps: 2, frames: [0, 1] },
    tracks: [
      {
        property: 'x',
        keys: [
          [0, 500],
          [2000, 600],
        ],
      },
    ],
  });
  scene.nodes[1].path.to = {
    node: 'receiver',
    contact: 'hand',
    at_ms: 2000,
    offset: [3, -2],
  };
  const timeline = compileTimeline(story);
  const ball = (t) =>
    stateAt(timeline, story, t).renderNodes.find((n) => n.id === 'apple');
  assert.deepEqual(ball(2000).position, [583, 138]);
  assert.deepEqual(ball(1500).position, [351.5, 89]);
  for (const t of [2000, 1500, 3000, 1000, 0])
    assert.deepEqual(
      ball(t),
      stateAt(timeline, story, t).renderNodes.find((n) => n.id === 'apple'),
    );
  const broken = structuredClone(story);
  broken.assets.hero.contacts.hand[0] = null;
  assert.throws(() => compileTimeline(broken), /contact/);
  scene.nodes[2].parent = 'apple';
  assert.throws(() => compileTimeline(story), /cycle/);
});
