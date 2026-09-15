import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceFixture } from './_performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { projectPoint } from '../browser/v0/core/performance/projection.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
test('data-only shapes and projected screen children share the parent screen mapping', () => {
  const story = performanceFixture();
  story.performance.required_capabilities.push('shapes', 'projection');
  story.assets.screen = {
    type: 'shape',
    width: 100,
    height: 100,
    shape: { kind: 'roundrect', radius: 5, fill: '#ffedda' },
  };
  story.scenes[0].nodes.push({
    id: 'screen',
    asset: 'screen',
    x: 0,
    y: 0,
    width: 100,
    projection: {
      corners: [
        [0, 0],
        [200, 0],
        [180, 100],
        [20, 100],
      ],
    },
  });
  story.scenes[0].nodes.push({
    id: 'self',
    asset: 'prop',
    parent: 'screen',
    x: 75,
    y: 75,
    width: 20,
  });
  const state = stateAt(compileTimeline(story), story, 0);
  const screen = state.renderNodes.find((n) => n.id === 'screen'),
    child = state.renderNodes.find((n) => n.id === 'self');
  assert.equal(screen.shape.kind, 'roundrect');
  assert.deepEqual(
    child.projection,
    [
      [0.65, 0.65],
      [0.85, 0.65],
      [0.85, 0.85],
      [0.65, 0.85],
    ].map(([u, v]) => projectPoint(screen.projection, u, v)),
  );
  assert.equal(child.projectionMesh.length, 8 * 12 * 6);
  assert.equal(child.projectionClips.length, 2);
});

test('unsupported projected effects and degenerate planes are refused before drawing', () => {
  const story = performanceFixture();
  story.scenes[0].nodes[1].projection = {
    corners: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
  };
  assert.throws(() => compileTimeline(story), /combination/);
  delete story.scenes[0].nodes[1].glow;
  story.scenes[0].nodes[1].projection.corners = [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  assert.throws(() => compileTimeline(story), /projected plane/);
});
