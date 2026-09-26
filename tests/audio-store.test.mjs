/**
 * A performance's narration, downloaded in playing order from the playhead and held in memory.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAudioStore } from '../browser/v0/app/audio-store.mjs';

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const cues = [
  { id: 'a', kind: 'narration', media: 'a.m4a', start_ms: 0, duration_ms: 1000 },
  { id: 'b', kind: 'narration', media: 'b.m4a', start_ms: 1000, duration_ms: 1000 },
  { id: 'c', kind: 'narration', media: 'c.m4a', start_ms: 2000, duration_ms: 1000 },
  { id: 'd', kind: 'narration', media: 'd.m4a', start_ms: 3000, duration_ms: 1000 },
];

/** A fetch whose every file waits until the test answers it. */
function manualFetch() {
  const pending = [];
  return {
    pending,
    fetchFile: (source) => new Promise((resolve, reject) => { pending.push({ source, resolve, reject }); }),
    answer(source) { const at = pending.findIndex((p) => p.source === source); pending.splice(at, 1)[0].resolve(`mem:${source}`); },
    fail(source) { const at = pending.findIndex((p) => p.source === source); pending.splice(at, 1)[0].reject(new Error('503')); },
  };
}

test('before it is started nothing is fetched and every line plays from its own URL', () => {
  const network = manualFetch();
  const store = createAudioStore(cues, network);
  assert.deepEqual(network.pending, []);
  assert.equal(store.ready(cues[0]), true);
  assert.equal(store.url(cues[0]), 'a.m4a');
});

test('lines download two at a time, from the playhead onwards, then the ones behind it', async () => {
  const network = manualFetch();
  const store = createAudioStore(cues, network);
  store.start(2500);
  assert.deepEqual(network.pending.map((p) => p.source), ['c.m4a', 'd.m4a']);
  assert.equal(store.ready(cues[2]), false);
  network.answer('c.m4a');
  await settle();
  assert.equal(store.ready(cues[2]), true);
  assert.equal(store.url(cues[2]), 'mem:c.m4a', 'a landed line did not play from memory');
  assert.deepEqual(network.pending.map((p) => p.source), ['d.m4a', 'a.m4a']);
  store.destroy();
});

test('a seek moves the lines ahead of the new playhead to the front', async () => {
  const network = manualFetch();
  const store = createAudioStore(cues, network);
  store.start(0);
  store.seek(3000);
  network.answer('a.m4a');
  await settle();
  assert.equal(network.pending.at(-1).source, 'd.m4a');
  store.destroy();
});

test('a failed line is asked for again later, and waiting on it resolves when it lands', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const network = manualFetch();
  const store = createAudioStore(cues.slice(0, 1), network);
  store.start(0);
  let landed = false;
  void store.whenReady(cues[0]).then(() => { landed = true; });
  network.fail('a.m4a');
  await settle();
  assert.deepEqual(network.pending, [], 'a failed line was asked for again at once');
  t.mock.timers.tick(1000);
  assert.deepEqual(network.pending.map((p) => p.source), ['a.m4a']);
  network.answer('a.m4a');
  await settle();
  assert.equal(landed, true);
  store.destroy();
});

test('every line here or tried once is enough for the pictures to start downloading', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const network = manualFetch();
  const store = createAudioStore(cues.slice(0, 2), network);
  store.start(0);
  let settled = false;
  void store.whenAll().then(() => { settled = true; });
  network.answer('a.m4a');
  await settle();
  assert.equal(settled, false);
  network.fail('b.m4a');
  await settle();
  assert.equal(settled, true, 'one failing line held back every later scene');
  assert.equal(store.ready(cues[1]), false, 'a failed line counted as here');
  store.destroy();
});
