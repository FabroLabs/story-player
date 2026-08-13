import assert from 'node:assert/strict';
import test from 'node:test';

import { EventLog } from '../browser/v0/core/event-log.mjs';
import { runStory } from '../browser/v0/core/scheduler.mjs';

test('runs scenes in order, blocks on chunks and pauses, and keeps together instant', async () => {
  let time = 0;
  const waits = [];
  const calls = [];
  const log = new EventLog(() => time);
  const clock = {
    now: () => time,
    wait: async (ms) => { waits.push(ms); time += ms; },
  };
  const story = {
    scenes: [
      {
        place: 'dell',
        steps: [
          { kind: 'chunk', line: 1, text: 'once' },
          { kind: 'cmd', line: 2, cmd: 'sound', name: 'pop' },
          { kind: 'together', line: 3, steps: [
            { kind: 'cmd', line: 4, cmd: 'emote', subjects: ['ruby'] },
            { kind: 'cmd', line: 5, cmd: 'music', name: 'calm' },
          ] },
          { kind: 'cmd', line: 6, cmd: 'pause', seconds: 1.5 },
        ],
      },
      { place: 'grove', steps: [] },
    ],
  };

  await runStory(story, {
    clock,
    log,
    beginScene: async (scene) => calls.push(`begin:${scene.place}`),
    endScene: async (scene) => calls.push(`end:${scene.place}`),
    playChunk: async (step) => { calls.push(`chunk:${step.text}`); time += 2000; },
    performCommand: (step) => calls.push(`cmd:${step.cmd}:${time}`),
  });

  assert.deepEqual(waits, [1500]);
  assert.deepEqual(calls, [
    'begin:dell', 'chunk:once', 'cmd:sound:2000', 'cmd:emote:2000', 'cmd:music:2000',
    'end:dell', 'begin:grove', 'end:grove',
  ]);
  assert.deepEqual(log.entries(), [
    { t_ms: 0, scene_index: 0, line: 1, kind: 'chunk', detail: { text: 'once' } },
    { t_ms: 2000, scene_index: 0, line: 2, kind: 'cmd', cmd: 'sound', detail: { name: 'pop' } },
    { t_ms: 2000, scene_index: 0, line: 3, kind: 'together', detail: {
      steps: [
        { kind: 'cmd', line: 4, cmd: 'emote', subjects: ['ruby'] },
        { kind: 'cmd', line: 5, cmd: 'music', name: 'calm' },
      ],
    } },
    { t_ms: 2000, scene_index: 0, line: 4, kind: 'cmd', cmd: 'emote', detail: { subjects: ['ruby'], together_line: 3 } },
    { t_ms: 2000, scene_index: 0, line: 5, kind: 'cmd', cmd: 'music', detail: { name: 'calm', together_line: 3 } },
    { t_ms: 2000, scene_index: 0, line: 6, kind: 'cmd', cmd: 'pause', detail: { seconds: 1.5 } },
  ]);
});

test('does not fire a following command until a pause wait resolves', async () => {
  let releasePause;
  const pauseGate = new Promise((resolve) => { releasePause = resolve; });
  const commands = [];
  const run = runStory({
    scenes: [{ place: 'dell', steps: [
      { kind: 'cmd', cmd: 'pause', seconds: 1 },
      { kind: 'cmd', cmd: 'sound', name: 'pop' },
    ] }],
  }, {
    clock: { now: () => 0, wait: () => pauseGate },
    log: new EventLog(() => 0),
    beginScene: async () => {},
    endScene: async () => {},
    playChunk: async () => {},
    performCommand: (step) => commands.push(step.cmd),
  });

  await Promise.resolve();
  assert.deepEqual(commands, []);
  releasePause();
  await run;
  assert.deepEqual(commands, ['sound']);
});

test('produces byte-identical event JSON for the same story and fake clock', async () => {
  const story = { scenes: [{ place: 'dell', steps: [{ kind: 'cmd', cmd: 'sound', name: 'pop' }] }] };
  const perform = () => {};

  const play = async () => {
    let time = 0;
    const log = new EventLog(() => time);
    await runStory(story, {
      clock: { now: () => time, wait: async (ms) => { time += ms; } },
      log,
      beginScene: async () => {},
      endScene: async () => {},
      playChunk: async () => {},
      performCommand: perform,
    });
    return JSON.stringify(log.toJSON());
  };

  assert.equal(await play(), await play());
});

test('dispatches together through one batch hook and stamps parent and children at one exact tick', async () => {
  let time = 40;
  const batches = [];
  const log = new EventLog(() => { time += 1; return time; });
  const steps = [
    { kind: 'cmd', line: 12, cmd: 'move', subjects: ['ruby'], target: 'clover' },
    { kind: 'cmd', line: 13, cmd: 'move', subjects: ['clover'], target: 'ruby' },
  ];

  await runStory({ scenes: [{ place: 'dell', steps: [{ kind: 'together', line: 11, steps }] }] }, {
    clock: { now: () => { time += 1; return time; }, wait: async () => {} },
    log,
    beginScene: async () => {},
    endScene: async () => {},
    playChunk: async () => {},
    performCommand: () => assert.fail('together children must use the batch hook'),
    performTogether: (children) => batches.push(children),
  });

  assert.deepEqual(batches, [steps]);
  assert.deepEqual(log.entries().map(({ t_ms }) => t_ms), [41, 41, 41]);
});
