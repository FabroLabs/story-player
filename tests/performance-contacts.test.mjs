import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceFixture } from './_performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';

test('contact calibration is required only for reachable attached frames and exact release', () => {
  const story = performanceFixture(),
    hero = story.scenes[0].nodes[0],
    apple = story.scenes[0].nodes[1];
  hero.clip = { fps: 0.5, frames: [0, 1], loop: true };
  story.assets.hero.contacts.hand[1] = null;
  story.assets.idle = { ...story.assets.hero, contacts: {} };
  hero.segments = [
    { start_ms: 2000, end_ms: 4000, asset: 'idle', clip: { hold: 0 } },
  ];
  assert.doesNotThrow(() => compileTimeline(story));
  hero.segments[0].start_ms = 1000;
  assert.throws(() => compileTimeline(story), /contact/);
  delete apple.path;
  assert.doesNotThrow(() => compileTimeline(story));
  hero.segments[0].start_ms = 999;
  assert.throws(() => compileTimeline(story), /contact/);
});

test('hold, selected frames, loop and nonloop ranges use actual frame selection', () => {
  const story = performanceFixture(),
    hero = story.scenes[0].nodes[0],
    apple = story.scenes[0].nodes[1];
  story.assets.hero.contacts.hand[1] = null;
  hero.clip = { hold: 0 };
  assert.doesNotThrow(() => compileTimeline(story));
  hero.clip = { fps: 120, frames: [0], loop: true };
  assert.doesNotThrow(() => compileTimeline(story));
  hero.clip = { fps: 2, frames: [0, 1], loop: false };
  apple.attach.end_ms = 500;
  delete apple.path;
  assert.doesNotThrow(() => compileTimeline(story));
  apple.attach.end_ms = 501;
  assert.throws(() => compileTimeline(story), /contact/);
});
