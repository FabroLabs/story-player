import test from 'node:test';
import assert from 'node:assert/strict';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { createStateCursor } from '../browser/v0/core/state/cursor.mjs';
import { performerFor } from '../browser/performers.mjs';

import { performanceFixture } from './_performance.mjs';

test('performance dispatch and compilation need no StoryLang marker', () => {
  const story = performanceFixture();
  assert.equal(typeof performerFor(story), 'function');
  const timeline = compileTimeline(story);
  assert.equal(timeline.duration_ms, 4000);
  assert.equal(timeline.performance_kind, 'wht');
  assert.deepEqual(compileTimeline(story), timeline);
  assert.equal(Object.hasOwn(timeline, 'storylang_version'), false);
});

test('contact, exact release, flight and endpoint hold are pure functions of time', () => {
  const story = performanceFixture(),
    timeline = compileTimeline(story);
  const node = (t) =>
    stateAt(timeline, story, t).renderNodes.find((n) => n.id === 'apple');
  assert.deepEqual(node(0).position, [120, 140]);
  assert.deepEqual(node(1000).position, [120, 140]);
  assert.deepEqual(node(1500).position, [210, 120]);
  assert.deepEqual(node(2500).position, [300, 200]);
  const cursor = createStateCursor(timeline, story);
  for (const t of [3999, 1000, 500, 1500, 0, 2500, 4000])
    assert.deepEqual(cursor.at(t), stateAt(timeline, story, t));
  assert.equal(stateAt(timeline, story, 500).subtitle, 'Hi Sam');
});

test('missing contacts, unknown fields and unsupported capabilities refuse before playback', () => {
  for (const change of [
    (s) => s.performance.required_capabilities.push('execute-js'),
    (s) => (s.scenes[0].nodes[0].callback = 'run()'),
    (s) => (s.assets.hero.contacts.hand[1] = null),
    (s) => (s.scenes[0].nodes[1].attach.node = 'absent'),
    (s) => (s.scenes[0].nodes[0].x = NaN),
  ]) {
    const story = performanceFixture();
    change(story);
    assert.throws(() => compileTimeline(story));
  }
});

test('same appearance can belong to distinct actors, parent cycles cannot compile', () => {
  const story = performanceFixture();
  story.scenes[0].nodes.push({
    id: 'friend',
    asset: 'hero',
    x: 500,
    y: 200,
    height: 100,
  });
  const state = stateAt(compileTimeline(story), story, 0);
  assert.equal(state.renderNodes.filter((n) => n.asset === 'hero').length, 2);
  story.scenes[0].nodes[0].parent = 'apple';
  assert.throws(() => compileTimeline(story), /cycle/i);
});
