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

test('opening narration leaves bandwidth for pictures until the viewer begins', async () => {
  const network = manualFetch();
  const store = createAudioStore(cues, network);
  store.prime(cues.slice(0, 2));
  assert.deepEqual(network.pending.map(p => p.source), ['a.m4a', 'b.m4a']);
  network.answer('a.m4a');
  network.answer('b.m4a');
  await settle();
  assert.deepEqual(network.pending, [], 'later narration competed with opening images');
  assert.equal(store.ready(cues[2]), false);
  store.start(0);
  assert.deepEqual(network.pending.map(p => p.source), ['c.m4a', 'd.m4a']);
  store.destroy();
});

test('explicit opening narration beyond the look-ahead lands without waiting for playback to advance', async () => {
  const network = manualFetch();
  const intro = { ...cues[0], media: 'intro.m4a' };
  const middle = { ...cues[1], media: 'middle.m4a', start_ms: 90_000 };
  const outro = { ...cues[2], media: 'outro.m4a', start_ms: 167_938 };
  const store = createAudioStore([intro, middle, outro], network);
  try {
    // Learn can have only an intro and an outro: prepare waits for both.
    store.prime([intro, outro]);
    assert.deepEqual(network.pending.map(p => p.source), ['intro.m4a', 'outro.m4a']);
    const prepared = Promise.all([store.whenReady(intro), store.whenReady(outro)]);
    network.answer('intro.m4a');
    network.answer('outro.m4a');
    await prepared;
    await settle();
    assert.equal(store.ready(outro), true);
    assert.deepEqual(network.pending, [], 'an unprimed cue competed with opening images');

    store.start(0);
    assert.deepEqual(network.pending, [], 'normal playback lost its look-ahead after priming');
    store.advance(40_000);
    assert.deepEqual(network.pending.map(p => p.source), ['middle.m4a']);
  } finally {
    store.destroy();
  }
});

test('distant primed lines still download only two at a time', async () => {
  const network = manualFetch();
  const opening = cues.slice(0, 3).map((cue, i) => ({ ...cue, start_ms: i * 90_000 }));
  const store = createAudioStore(opening, network);
  try {
    store.prime(opening);
    assert.deepEqual(network.pending.map(p => p.source), ['a.m4a', 'b.m4a']);
    network.answer('a.m4a');
    await settle();
    assert.deepEqual(network.pending.map(p => p.source), ['b.m4a', 'c.m4a']);
  } finally {
    store.destroy();
  }
});

test('destroy aborts active narration downloads', () => {
  const signals = [];
  const store = createAudioStore(cues, {fetchFile: (_source, {signal}) => {
    signals.push(signal);
    return new Promise(() => {});
  }});
  store.start();
  store.destroy();
  assert.equal(signals.length, 2);
  assert.ok(signals.every(signal => signal.aborted));
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

test('a line the store does not have is missing: not asked for again, and nobody is left waiting on it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const network = manualFetch();
  const store = createAudioStore(cues.slice(0, 2), network);
  store.start(0);
  let waited = false;
  void store.whenReady(cues[0]).then(() => { waited = true; });
  assert.equal(store.missing(cues[0]), false);
  const at = network.pending.findIndex((p) => p.source === 'a.m4a');
  network.pending.splice(at, 1)[0].reject(Object.assign(new Error('asset answered 404'), { retryable: false }));
  await settle();
  assert.equal(store.missing(cues[0]), true);
  assert.equal(store.ready(cues[0]), false, 'a line that is not here was called ready');
  assert.equal(waited, true, 'a hold was left waiting on a line that will never come');
  t.mock.timers.tick(60_000);
  assert.equal(network.pending.some((p) => p.source === 'a.m4a'), false, 'a file the store does not have was asked for again');
  assert.equal(store.missing(cues[1]), false);
  store.destroy();
});

test('a line whose own download went silent is stalled: nobody waits on it, and it is still asked for again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const network = manualFetch();
  const store = createAudioStore(cues.slice(0, 1), network);
  store.start(0);
  let waited = false;
  void store.whenReady(cues[0]).then(() => { waited = true; });
  network.pending.splice(0, 1)[0].reject(new DOMException('Story assets stopped downloading.', 'TimeoutError'));
  await settle();
  assert.equal(store.stalled(cues[0]), true);
  assert.equal(store.missing(cues[0]), false, 'a line that may still come was written off for good');
  assert.equal(waited, true, 'a hold was left waiting on a download that had gone silent');
  t.mock.timers.tick(1000);
  assert.deepEqual(network.pending.map((p) => p.source), ['a.m4a'], 'a stalled line was not asked for again');
  network.answer('a.m4a');
  await settle();
  assert.equal(store.stalled(cues[0]), false);
  assert.equal(store.ready(cues[0]), true);
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

test('lines beyond the look-ahead wait until the story comes near them, and do not hold the pictures back', async () => {
  const network = manualFetch();
  const far = [
    { id: 'near', kind: 'narration', media: 'near.m4a', start_ms: 0, duration_ms: 1000 },
    { id: 'far', kind: 'narration', media: 'far.m4a', start_ms: 90_000, duration_ms: 1000 },
  ];
  const store = createAudioStore(far, network);
  store.start(0);
  let settled = false;
  void store.whenAll().then(() => { settled = true; });
  assert.deepEqual(network.pending.map((p) => p.source), ['near.m4a'], 'a line a minute and a half away took the link');
  network.answer('near.m4a');
  await settle();
  assert.equal(settled, true, 'the pictures waited for a line nobody needs yet');
  store.advance(20_000);
  assert.deepEqual(network.pending, [], 'the line was fetched long before it was near');
  store.advance(40_000);
  assert.deepEqual(network.pending.map((p) => p.source), ['far.m4a']);
  store.destroy();
});
