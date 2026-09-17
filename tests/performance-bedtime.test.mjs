import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
import { auditPerformance } from '../browser/v0/core/performance/audit.mjs';
import { performerFor } from '../browser/performers.mjs';

import { performanceFixture } from './_performance.mjs';

const COMPILER = fileURLToPath(new URL('../scripts/compile-performance.mjs', import.meta.url));

function bedtime(endMs = 4000) {
  const story = performanceFixture();
  story.performance.kind = 'bedtime';
  story.scenes.at(-1).end_ms = endMs;
  return story;
}

function compileCommand(story, ...args) {
  return spawnSync(process.execPath, [COMPILER, ...args], {
    input: JSON.stringify(story),
    encoding: 'utf8',
  });
}

test('bedtime is its own performance kind, played by the shared performer', () => {
  const story = bedtime();
  assert.equal(typeof performerFor(story), 'function');
  const timeline = compileTimeline(story);
  assert.equal(timeline.performance_kind, 'bedtime');
  assert.equal(auditPerformance(story).kind, 'bedtime');
  assert.equal(stateAt(timeline, story, 500).subtitle, 'Hi Sam');
});

test('only WHT keeps the five-minute limit', () => {
  // The first Bedtime story narrates for 617.36 s.
  assert.equal(compileTimeline(bedtime(617360)).duration_ms, 617360);
  const wht = performanceFixture();
  wht.scenes.at(-1).end_ms = 300001;
  assert.throws(() => compileTimeline(wht), /five minutes/);
});

test('an unknown kind is refused before playback', () => {
  const story = performanceFixture();
  story.performance.kind = 'lullaby';
  assert.throws(() => performerFor(story), /unsupported performance kind/);
  assert.throws(() => compileTimeline(story), /kind/);
});

test('instructions or a timeline compiled for another kind never play', () => {
  const wht = performanceFixture();
  const whtTimeline = compileTimeline(wht);
  assert.throws(
    () => compileTimeline({ ...bedtime(), instructions: whtTimeline }),
    /instructions do not match/,
  );
  assert.throws(() => stateAt(whtTimeline, bedtime(), 0), /timeline mismatch/);
  const story = bedtime();
  assert.throws(() => stateAt(compileTimeline(story), wht, 0), /timeline mismatch/);
});

test('the compiler command embeds bedtime instructions and refuses other kinds', () => {
  const story = bedtime();
  const compiled = compileCommand(story);
  assert.equal(compiled.status, 0, compiled.stderr);
  const instructions = JSON.parse(compiled.stdout);
  assert.equal(instructions.performance_kind, 'bedtime');
  assert.deepEqual(compileTimeline({ ...story, instructions }), instructions);
  const audit = compileCommand(story, '--audit');
  assert.equal(JSON.parse(audit.stdout).kind, 'bedtime');
  const other = { ...story, performance: { ...story.performance, kind: 'lullaby' } };
  const refused = compileCommand(other);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /expected WHT or bedtime performance JSON/);
});

test('the compiler command evaluates several states in one call', () => {
  const story = bedtime();
  const batch = compileCommand(story, '--states=0,500,1250.5');
  assert.equal(batch.status, 0, batch.stderr);
  const states = JSON.parse(batch.stdout);
  assert.equal(states.length, 3);
  assert.deepEqual(states[1], JSON.parse(compileCommand(story, '--state=500').stdout));
  assert.equal(states[1].subtitle, stateAt(compileTimeline(story), story, 500).subtitle);
  for (const bad of ['--states=0,,5', '--states=-1', '--states=1e3']) {
    const refused = compileCommand(story, bad);
    assert.equal(refused.status, 1, bad);
    assert.match(refused.stderr, /--states= expects comma-separated milliseconds/);
  }
});
