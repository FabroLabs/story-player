import test from 'node:test';
import assert from 'node:assert/strict';
import { allCapabilitiesFixture } from './_all-performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
test('all-capability interactions are finite and deterministic under reversed seeks and replay', () => {
  const story = allCapabilitiesFixture(),
    timeline = compileTimeline(story);
  const times = [
    0, 1, 199, 200, 499, 999, 1000, 1001, 1499, 1500, 1999, 2000, 2499, 2500,
    2999, 3000, 3999, 4000,
  ];
  const states = times.map((t) => stateAt(timeline, story, t));
  const finite = (v) =>
    typeof v === 'number'
      ? Number.isFinite(v)
      : Array.isArray(v)
        ? v.every(finite)
        : v && typeof v === 'object'
          ? Object.values(v).every(finite)
          : true;
  assert.ok(states.every(finite));
  for (const i of [...times.keys()].reverse())
    assert.deepEqual(stateAt(timeline, story, times[i]), states[i]);
  const at = (t) => stateAt(timeline, story, t).renderNodes;
  assert.equal(at(2500).find((n) => n.id === 'hero').frame, 1);
  assert.equal(at(1500).find((n) => n.id === 'hero').water.line, 80);
  assert.equal(at(1500).find((n) => n.id === 'remote').projection.length, 4);
  assert.equal(at(1500).find((n) => n.id === 'apple').particles.length, 12);
  assert.equal(
    at(1500).find((n) => n.id === 'background').travel.tiles.length,
    4,
  );
  assert.equal(at(1500).find((n) => n.id === 'badge').space, 'screen');
  assert.ok(
    at(999).findIndex((n) => n.id === 'apple') >
      at(999).findIndex((n) => n.id === 'hero'),
  );
  assert.ok(
    at(1000).findIndex((n) => n.id === 'apple') <
      at(1000).findIndex((n) => n.id === 'hero'),
  );
});
test('compiled instructions are carried in the document and stale instructions refuse', () => {
  const story = allCapabilitiesFixture();
  story.instructions = compileTimeline(story);
  assert.deepEqual(compileTimeline(story), story.instructions);
  story.instructions.events[0].scene.nodes[0].x += 10;
  assert.throws(() => compileTimeline(story), /instructions/);
});
