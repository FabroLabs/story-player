import test from 'node:test';
import assert from 'node:assert/strict';
import { performanceFixture } from './_performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';

const controls = [
  ['light phase', 'lights', 'phase', [{ x: 10, y: 10, radius: 5, color: '#ff0000', period_ms: 1000 }]],
  ['particle seed', 'particles', 'seed', { count: 2, color: '#ff0000', start_ms: 0, end_ms: 4000 }],
  ...['offset', 'ease_in_ms', 'ease_out_ms'].map((field) => [
    `travel ${field}`, 'travel', field, { start_ms: 0, end_ms: 4000, speed: 20 },
  ]),
];

function withControl(effect, field, base, value) {
  const story = performanceFixture();
  story.scenes[0].nodes.splice(1);
  const control = structuredClone(base);
  (Array.isArray(control) ? control[0] : control)[field] = value;
  story.scenes[0].nodes[0][effect] = control;
  return story;
}

for (const [name, effect, field, base] of controls) {
  test(`compiler rejects malformed ${name} before evaluation`, () => {
    for (const value of ['bad', '2', null, false, {}, [], NaN, Infinity, -Infinity]) {
      const story = withControl(effect, field, base, value);
      assert.throws(() => compileTimeline(story), /invalid finite number/, `${name}: ${JSON.stringify(value)}`);
    }
  });
  test(`valid ${name} stays finite under forward/reverse/replay`, () => {
    for (const value of field.startsWith('ease_') ? [0, -2.5, 250.5, 8000] : [0, -2.5, 2.5]) {
      const story = withControl(effect, field, base, value);
      const timeline = compileTimeline(story);
      const times = [0, 500, 3999];
      const states = times.map((t) => stateAt(timeline, story, t));
      const numbers = [];
      JSON.stringify(states, (_key, item) => {
        if (typeof item === 'number') numbers.push(item);
        return item;
      });
      assert.ok(numbers.length > 0 && numbers.every(Number.isFinite));
      for (const i of [2, 1, 0, 1, 2]) {
        assert.deepEqual(stateAt(timeline, story, times[i]), states[i]);
      }
    }
  });
}
