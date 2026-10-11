/**
 * A performance's sound effects are played from memory through one audio context, not from an
 * element each: decoded ahead under a byte cap, skipped rather than waited for, and never the
 * reason a story stops.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoryPlayer } from '../browser/embed.mjs';
import { createEffectPlayer } from '../browser/v0/app/effect-player.mjs';
import {
  EFFECTS_AHEAD_MS, EFFECTS_BUDGET_BYTES, EFFECT_MAX_MS, createEffectStore,
} from '../browser/v0/app/effect-store.mjs';
import { createMediaScheduler } from '../browser/v0/app/media-scheduler.mjs';
import { installDom, virtualFrames } from './_dom.mjs';

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const effect = (id, startMs, media = `pack/${id}.wav`, durationMs = 300) => (
  { id, kind: 'sfx', media, start_ms: startMs, duration_ms: durationMs, volume: 0.8 }
);

/** A store whose files weigh what the test says: `frames` two-channel frames, eight bytes each. */
function storeOf(cues, { frames = () => 100, fails = () => null, ...options } = {}) {
  const fetched = [];
  const warnings = [];
  const store = createEffectStore(cues, {
    fetchFile: async (source) => {
      fetched.push(source);
      const failure = fails(source, fetched.filter((name) => name === source).length);
      if (failure) throw failure;
      return source;
    },
    decode: async (source) => ({ source, length: frames(source), numberOfChannels: 2 }),
    onWarning: (detail) => warnings.push(detail),
    ...options,
  });
  return { store, fetched, warnings };
}

test('the numbers a phone was promised: eight megabytes, thirty seconds ahead, nothing over five seconds', () => {
  assert.equal(EFFECTS_BUDGET_BYTES, 8 * 1024 * 1024);
  assert.equal(EFFECTS_AHEAD_MS, 30_000);
  assert.equal(EFFECT_MAX_MS, 5_000);
});

test('an effect file is fetched and decoded once, however many cues play it', async () => {
  const cues = [effect('a', 1000, 'pack/pop.wav'), effect('b', 2000, 'pack/pop.wav'), effect('c', 3000, 'pack/pop.wav')];
  const { store, fetched } = storeOf(cues);
  store.start(0);
  await settle();
  assert.deepEqual(fetched, ['pack/pop.wav']);
  assert.ok(store.buffer(cues[0]));
  assert.equal(store.buffer(cues[0]), store.buffer(cues[2]), 'the second play decoded the file again');
});

test('before start nothing is fetched and no effect is the store’s to play', async () => {
  const cues = [effect('a', 1000)];
  const { store, fetched } = storeOf(cues);
  await settle();
  assert.deepEqual(fetched, []);
  assert.equal(store.covers(cues[0]), false);
  store.start(0);
  assert.equal(store.covers(cues[0]), true);
});

test('effects are decoded in playing order, and no further than the reach', async () => {
  const cues = [effect('far', 40_000), effect('near', 1000), effect('mid', 20_000)];
  const { store, fetched } = storeOf(cues);
  store.start(0);
  await settle(); await settle();
  assert.deepEqual(fetched, ['pack/near.wav', 'pack/mid.wav'], 'an effect past the reach was decoded, or the order was not the story’s');
  store.advance(15_000);
  await settle();
  assert.ok(store.buffer(cues[0]), 'an effect that came into reach was not decoded');
});

test('two files are fetched at a time, and no more', async () => {
  const cues = [effect('a', 1000), effect('b', 2000), effect('c', 3000)];
  const landing = [];
  const asked = [];
  const store = createEffectStore(cues, {
    fetchFile: (source) => { asked.push(source); return new Promise((resolve) => { landing.push(() => resolve(source)); }); },
    decode: async (source) => ({ source, length: 100, numberOfChannels: 2 }),
  });
  store.start(0);
  await settle();
  assert.deepEqual(asked, ['pack/a.wav', 'pack/b.wav'], 'one file at a time cannot keep ahead of a busy story on a slow link');
  landing[0]();
  await settle();
  assert.deepEqual(asked, ['pack/a.wav', 'pack/b.wav', 'pack/c.wav']);
});

test('the cap counts what is on its way: two fetches together cannot overrun it', async () => {
  const cues = [effect('a', 1000), effect('b', 2000), effect('c', 3000)];
  // 800 bytes each against 1600: the two fetched together are all the room there is.
  const { store, fetched } = storeOf(cues, { budgetBytes: 1600, bytesPerMs: 800 / 300 });
  store.start(0);
  for (let turn = 0; turn < 4; turn += 1) await settle();
  assert.deepEqual(fetched, ['pack/a.wav', 'pack/b.wav']);
  assert.ok(store.bytes <= 1600);
});

test('the cap holds: what has played goes first, and what does not fit waits its turn', async () => {
  const cues = [effect('a', 1000), effect('b', 2000), effect('c', 3000), effect('d', 4000)];
  // 800 bytes each against 2000: two fit, a third does not.
  const { store } = storeOf(cues, { budgetBytes: 2000, bytesPerMs: 800 / 300 });
  store.start(0);
  for (let turn = 0; turn < 4; turn += 1) await settle();
  assert.ok(store.buffer(cues[0]) && store.buffer(cues[1]));
  assert.equal(store.buffer(cues[2]), null, 'a third effect was decoded past the cap');
  assert.ok(store.bytes <= 2000);
  // `a` has played and nothing asks for it again: it makes room for `c`.
  store.advance(1500);
  for (let turn = 0; turn < 4; turn += 1) await settle();
  assert.equal(store.buffer(cues[0]), null, 'an effect nobody needs again kept its memory');
  assert.ok(store.buffer(cues[2]), 'the room an effect left was not used');
  assert.ok(store.bytes <= 2000);
});

test('an effect that plays again inside the reach keeps its memory', async () => {
  const cues = [effect('a1', 1000, 'pack/a.wav'), effect('b', 2000), effect('c', 3000), effect('a2', 5000, 'pack/a.wav')];
  const { store, fetched } = storeOf(cues, { budgetBytes: 2000, bytesPerMs: 800 / 300 });
  store.start(0);
  for (let turn = 0; turn < 4; turn += 1) await settle();
  store.advance(2500);
  for (let turn = 0; turn < 4; turn += 1) await settle();
  assert.ok(store.buffer(cues[3]), 'an effect still to be played again was dropped');
  assert.equal(fetched.filter((name) => name === 'pack/a.wav').length, 1);
  assert.equal(store.buffer(cues[1]), null, 'the played effect stayed and the coming one waited');
  assert.ok(store.buffer(cues[2]));
});

test('an effect longer than five seconds is not the store’s: it streams as it always did', async () => {
  const cues = [effect('long', 1000, 'pack/long.wav', 5001), effect('short', 1000, 'pack/short.wav', 5000)];
  const { store, fetched } = storeOf(cues);
  store.start(0);
  await settle(); await settle();
  assert.equal(store.covers(cues[0]), false);
  assert.equal(store.covers(cues[1]), true);
  assert.deepEqual(fetched, ['pack/short.wav']);
});

test('a file that fails is asked for again, and named once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cues = [effect('a', 1000)];
  const { store, fetched, warnings } = storeOf(cues, { fails: (source, attempt) => (attempt < 3 ? new TypeError('network') : null) });
  store.start(0);
  await settle();
  assert.equal(store.buffer(cues[0]), null);
  t.mock.timers.tick(1000);
  await settle();
  t.mock.timers.tick(2000);
  await settle(); await settle();
  assert.equal(fetched.length, 3);
  assert.ok(store.buffer(cues[0]), 'the file landed and was not decoded');
  assert.equal(warnings.length, 1, 'one broken file was named more than once');
  assert.equal(warnings[0].asset, 'sfx');
  assert.equal(warnings[0].cue, 'a');
});

test('a file the store does not have is not asked for twice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const gone = Object.assign(new Error('asset answered 404'), { retryable: false });
  const cues = [effect('a', 1000), effect('b', 2000)];
  const { store, fetched, warnings } = storeOf(cues, { fails: (source) => (source === 'pack/a.wav' ? gone : null) });
  store.start(0);
  await settle(); await settle();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(fetched.filter((name) => name === 'pack/a.wav').length, 1);
  assert.equal(warnings.length, 1);
  assert.ok(store.buffer(cues[1]), 'one missing file kept the others from landing');
});

test('the store says how many files it has, so a story with none needs no player', () => {
  assert.equal(storeOf([effect('long', 0, 'pack/long.wav', 9000), { id: 'bed', kind: 'ambience', media: 'pack/bed.wav', start_ms: 0, duration_ms: 100 }]).store.size, 0);
  assert.equal(storeOf([effect('a', 0, 'pack/pop.wav'), effect('b', 500, 'pack/pop.wav'), effect('c', 900)]).store.size, 2);
});

test('a destroyed store keeps nothing that lands afterwards', async () => {
  const cues = [effect('a', 1000)];
  const { store } = storeOf(cues);
  store.start(0);
  store.destroy();
  await settle();
  assert.equal(store.buffer(cues[0]), null);
  assert.equal(store.bytes, 0);
});

/** An AudioContext that records what was started on it. */
function installAudioContext({ runs = true } = {}) {
  const prior = globalThis.AudioContext;
  const made = [];
  globalThis.AudioContext = class {
    constructor() {
      this.state = 'suspended';
      this.destination = { name: 'speakers' };
      this.sources = [];
      this.gains = [];
      made.push(this);
    }
    resume() { if (runs && this.state !== 'closed') this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    decodeAudioData(bytes) { return Promise.resolve({ bytes, length: 100, numberOfChannels: 2 }); }
    createBufferSource() {
      const source = {
        buffer: null, started: false, stopped: false, to: null,
        connect(node) { this.to = node; }, disconnect() {},
        start() { this.started = true; }, stop() { this.stopped = true; },
      };
      this.sources.push(source);
      return source;
    }
    createGain() {
      const gain = { gain: { value: 1 }, to: null, connect(node) { this.to = node; }, disconnect() {} };
      this.gains.push(gain);
      return gain;
    }
  };
  return { made, restore: () => { globalThis.AudioContext = prior; } };
}

test('the player starts one source for a play, at the cue’s volume, into the speakers', async () => {
  const audio = installAudioContext();
  try {
    const player = createEffectPlayer();
    assert.equal(player.usable(), false, 'a player nobody unlocked was usable');
    player.unlock();
    await settle();
    assert.equal(player.usable(), true);
    const buffer = { length: 100, numberOfChannels: 2 };
    player.play(buffer, 0.4);
    const [context] = audio.made;
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].buffer, buffer);
    assert.equal(context.sources[0].started, true);
    assert.equal(context.gains[0].gain.value, 0.4);
    assert.equal(context.sources[0].to, context.gains[0]);
    assert.equal(context.gains[0].to, context.destination);
    player.unlock();
    assert.equal(audio.made.length, 1, 'a second unlock made a second context');
  } finally {
    audio.restore();
  }
});

test('stopAll stops what sounds; a hold suspends the context and a resume brings it back; destroy closes it', async () => {
  const audio = installAudioContext();
  try {
    const player = createEffectPlayer();
    player.unlock();
    await settle();
    player.play({ length: 1, numberOfChannels: 1 }, 1);
    const [context] = audio.made;
    player.hold();
    assert.equal(context.state, 'suspended');
    assert.equal(player.usable(), true, 'a held player is still the way effects are played');
    player.resume();
    assert.equal(context.state, 'running');
    assert.equal(context.sources[0].stopped, false, 'a hold ended the effect it was meant to keep');
    player.stopAll();
    assert.equal(context.sources[0].stopped, true);
    player.destroy();
    assert.equal(context.state, 'closed');
    assert.equal(player.usable(), false);
  } finally {
    audio.restore();
  }
});

test('where there is no web audio, or its context will not run, the player is never usable', async () => {
  const none = createEffectPlayer({ globalObject: {} });
  none.unlock();
  await settle();
  assert.equal(none.usable(), false);
  assert.equal(none.canDecode(), false);
  const audio = installAudioContext({ runs: false });
  try {
    const blocked = createEffectPlayer();
    blocked.unlock();
    await settle();
    assert.equal(blocked.canDecode(), true);
    assert.equal(blocked.usable(), false, 'a context that never ran was trusted with the effects');
  } finally {
    audio.restore();
  }
});

/** The scheduler's elements, as `performance-audio.test.mjs` fakes them. */
function installElements() {
  const prior = globalThis.Audio;
  const made = [];
  globalThis.Audio = class {
    constructor() { this.paused = true; this.ended = false; this.currentTime = 0; this.listeners = {}; made.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    fire(type) { for (const fn of this.listeners[type] ?? []) fn(); }
    removeAttribute() {}
    load() {}
  };
  return { made, restore: () => { globalThis.Audio = prior; } };
}

const withEffects = {
  performance: { kind: 'wht' },
  audio: [
    { id: 'bed', kind: 'ambience', media: 'pack/bed.wav', start_ms: 0, end_ms: 20000, duration_ms: 20000, volume: 1 },
    effect('pop', 2000),
    effect('again', 4000, 'pack/pop.wav'),
  ],
};

/** A scheduler with its effects in memory, begun as the runtime begins one. */
async function begun({ land = true, output = null } = {}) {
  const player = createEffectPlayer();
  const landing = [];
  const store = createEffectStore(withEffects.audio, {
    fetchFile: (source) => (land ? Promise.resolve(source) : new Promise((resolve) => { landing.push(() => resolve(source)); })),
    decode: async (source) => ({ source, length: 100, numberOfChannels: 2 }),
  });
  const warnings = [];
  const scheduler = createMediaScheduler({
    bundle: withEffects, timeline: {}, effects: { store, player }, output, onWarning: (detail) => warnings.push(detail),
  });
  scheduler.unlock();
  await settle();
  scheduler.resume();
  await settle(); await settle();
  return { scheduler, store, player, warnings, landing };
}

test('the gate starts on the opening’s effects, so the first one is in memory when the story begins', async () => {
  const elements = installElements();
  const audio = installAudioContext();
  try {
    const opening = { performance: { kind: 'wht' }, audio: [effect('fanfare', 0)] };
    const player = createEffectPlayer();
    const store = createEffectStore(opening.audio, { decode: player.decode, fetchFile: async (source) => source });
    const scheduler = createMediaScheduler({ bundle: opening, timeline: {}, effects: { store, player } });
    void scheduler.prepare();
    await settle(); await settle();
    assert.ok(store.buffer(opening.audio[0]), 'the opening’s effect was not decoded at the gate');
    assert.equal(audio.made.length, 1);
    assert.equal(audio.made[0].state, 'suspended', 'the context was started before the viewer began the story');
    scheduler.unlock();
    scheduler.resume();
    scheduler.advance(0, 1);
    assert.equal(audio.made.length, 1, 'beginning the story made a second context');
    assert.equal(audio.made[0].sources.length, 1, 'the story’s first effect was missed');
    scheduler.destroy();
  } finally {
    audio.restore();
    elements.restore();
  }
});

test('an effect at its cue is played from memory, and no element is opened for it', async () => {
  const elements = installElements();
  const audio = installAudioContext();
  try {
    const { scheduler } = await begun();
    scheduler.advance(1999, 2001);
    const [context] = audio.made;
    assert.equal(context.sources.length, 1, 'the effect did not sound');
    assert.equal(context.sources[0].buffer.source, 'pack/pop.wav');
    assert.equal(context.gains[0].gain.value, 0.8);
    assert.deepEqual(elements.made.map((media) => media.src), ['pack/bed.wav'], 'an element was opened for an effect');
    scheduler.advance(3999, 4001);
    assert.equal(context.sources.length, 2);
    assert.equal(context.sources[1].buffer, context.sources[0].buffer, 'the same file was decoded twice');
    assert.equal(elements.made.length, 1);
    scheduler.destroy();
  } finally {
    audio.restore();
    elements.restore();
  }
});

test('an effect not decoded by its cue is skipped: no element, no hold, no warning', async () => {
  const elements = installElements();
  const audio = installAudioContext();
  try {
    const { scheduler, warnings } = await begun({ land: false });
    assert.equal(scheduler.blocker(1900, 2100), null, 'the story was asked to hold for an effect');
    scheduler.advance(1999, 2001);
    assert.equal(audio.made[0].sources.length, 0);
    assert.equal(elements.made.length, 1, 'an element was opened for an effect that had not landed');
    assert.deepEqual(warnings, []);
    scheduler.destroy();
  } finally {
    audio.restore();
    elements.restore();
  }
});

test('pause stops an effect, a hold keeps it for the resume, and a seek stops it and lets its cue play again', async () => {
  const elements = installElements();
  const audio = installAudioContext();
  try {
    const { scheduler } = await begun();
    const [context] = audio.made;
    scheduler.advance(1999, 2001);
    scheduler.hold();
    assert.equal(context.state, 'suspended');
    assert.equal(context.sources[0].stopped, false, 'a hold ended an effect that goes on with the story');
    scheduler.resume();
    assert.equal(context.state, 'running');
    scheduler.pause();
    assert.equal(context.sources[0].stopped, true, 'a pause left an effect sounding');
    scheduler.resume();
    scheduler.advance(3999, 4001);
    scheduler.seek(1000);
    assert.equal(context.sources[1].stopped, true, 'a seek left an effect sounding');
    scheduler.advance(1999, 2001);
    assert.equal(context.sources.length, 3, 'a cue crossed again after a seek did not play');
    scheduler.destroy();
  } finally {
    audio.restore();
    elements.restore();
  }
});

test('a recording keeps an element for every effect: its tap hears elements', async () => {
  const elements = installElements();
  const audio = installAudioContext();
  try {
    const opened = [];
    const output = { audio() { const media = new globalThis.Audio(); opened.push(media); return media; } };
    const { scheduler } = await begun({ output });
    scheduler.advance(1999, 2001);
    assert.equal(opened.some((media) => media.src === 'pack/pop.wav'), true, 'the recording did not hear the effect');
    assert.equal(audio.made.every((context) => context.sources.length === 0), true);
    scheduler.destroy();
  } finally {
    audio.restore();
    elements.restore();
  }
});

test('without web audio an effect is an element, as it was', async () => {
  const elements = installElements();
  const prior = globalThis.AudioContext;
  delete globalThis.AudioContext;
  try {
    const { scheduler } = await begun();
    scheduler.advance(1999, 2001);
    assert.deepEqual(elements.made.map((media) => media.src), ['pack/bed.wav', 'pack/pop.wav']);
    assert.equal(elements.made[1].paused, false);
    scheduler.destroy();
  } finally {
    if (prior) globalThis.AudioContext = prior;
    elements.restore();
  }
});

test('a scheduler handed no effects opens an element for each, exactly as before', () => {
  const elements = installElements();
  const audio = installAudioContext();
  try {
    const scheduler = createMediaScheduler({ bundle: withEffects, timeline: {} });
    scheduler.unlock();
    scheduler.resume();
    scheduler.advance(1999, 2001);
    assert.deepEqual(elements.made.map((media) => media.src), ['pack/bed.wav', 'pack/pop.wav']);
    assert.equal(audio.made.length, 0, 'a context was made for a scheduler with no effects in memory');
    scheduler.destroy();
  } finally {
    audio.restore();
    elements.restore();
  }
});

// The whole player, as `performance-holds.test.mjs` mounts it.

function oneScene(sounds) {
  return {
    title: 'One scene',
    performance: { kind: 'wht', resolution: [1000, 562.5], required_capabilities: ['transform'] },
    assets: { one: { type: 'image', media: 'pack/one.png', width: 100, height: 100 } },
    scenes: [{ id: 'a', setting_id: 'room', start_ms: 0, end_ms: 6000, nodes: [{ id: 'n', asset: 'one', x: 100, y: 100, width: 100 }] }],
    audio: [
      { id: 'first', kind: 'narration', media: 'pack/first.m4a', start_ms: 0, duration_ms: 400, text: 'one', volume: 1 },
      ...sounds,
    ],
  };
}

function byClass(node, name) {
  if (node?.className === name) return node;
  for (const child of node?.children ?? []) { const found = byClass(child, name); if (found) return found; }
  return null;
}

async function mount(t, { sounds, missing = [], failing = [], refusing = [] }) {
  const dom = installDom(); t.after(dom.restore);
  // A performance paints through `transform`, which the fake canvas does not have.
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = make(tag);
    if (tag === 'canvas') {
      const get = node.getContext.bind(node);
      node.getContext = (kind) => { const context = get(kind); context.transform = () => {}; return context; };
    }
    return node;
  };
  const requested = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);
    if (missing.some((name) => href.endsWith(name))) return { ok: false, status: 404 };
    return { ok: true, status: 200, blob: async () => ({ pixels: { width: 100, height: 100 } }), arrayBuffer: async () => new ArrayBuffer(8) };
  };
  const prior = globalThis.Audio;
  const made = [];
  // An element whose file is in `failing` says so the way a browser does: an `error` event.
  globalThis.Audio = class {
    constructor() { this.currentTime = 0; this.paused = true; this.listeners = {}; made.push(this); }
    set src(value) {
      this.address = value;
      if (failing.some((name) => String(value).endsWith(name))) {
        queueMicrotask(() => {
          this.error = { code: 4, message: '' };
          for (const fn of this.listeners.error ?? []) fn();
        });
      }
    }
    get src() { return this.address; }
    play() {
      this.paused = false;
      // A device that will not start sound without a gesture says so by rejecting `play()`.
      if (refusing.some((name) => String(this.address).endsWith(name))) {
        return Promise.reject(Object.assign(new Error('play() failed: the user did not interact with the document first'), { name: 'NotAllowedError' }));
      }
      return Promise.resolve();
    }
    pause() { this.paused = true; }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    load() {}
    removeAttribute() {}
  };
  t.after(() => { globalThis.Audio = prior; });
  const frames = virtualFrames(); t.after(frames.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story: oneScene(sounds), assetBase: 'https://storage.example/', chrome: 'host' });
  t.after(() => player.destroy());
  await player.ready;
  await player.play();
  await settle();
  return { player, frames, made, requested, note: byClass(host.shadowRoot, 'media-note') };
}

test('an effect whose element fails does not stop the story', async (t) => {
  const prior = globalThis.AudioContext;
  delete globalThis.AudioContext;
  t.after(() => { if (prior) globalThis.AudioContext = prior; });
  const { player, frames, note } = await mount(t, { sounds: [effect('pop', 1000)], failing: ['pack/pop.wav'] });
  frames.advanceTo(1200);
  await settle(); await settle();
  frames.advanceTo(2000);
  assert.equal(player.getState().playing, true, 'a sound effect that could not be played stopped the story');
  assert.equal(player.getState().tMs, 2000);
  assert.equal(note.textContent ?? '', '');
});

test('a background track whose element fails is silence, and the story goes on', async (t) => {
  const prior = globalThis.AudioContext;
  delete globalThis.AudioContext;
  t.after(() => { if (prior) globalThis.AudioContext = prior; });
  const late = { id: 'late', kind: 'ambience', media: 'pack/bed.wav', start_ms: 1000, end_ms: 5000, duration_ms: 4000, volume: 1 };
  const { player, frames, made, note } = await mount(t, { sounds: [late], failing: ['pack/bed.wav'] });
  for (let wall = 300; wall <= 2400; wall += 300) {
    frames.advanceTo(wall);
    await settle();
  }
  assert.equal(player.getState().playing, true, 'a track that could not be played stopped the story');
  assert.equal(player.getState().tMs, 2400);
  assert.doesNotMatch(note.textContent ?? '', /Required story audio failed/);
  assert.equal(made.filter((media) => String(media.src ?? '').endsWith('pack/bed.wav')).length, 1, 'the broken track was opened again and again');
});

test('a device that refuses to play still stops the story under its note: a press on play can answer it', async (t) => {
  const prior = globalThis.AudioContext;
  delete globalThis.AudioContext;
  t.after(() => { if (prior) globalThis.AudioContext = prior; });
  const late = { id: 'late', kind: 'ambience', media: 'pack/bed.wav', start_ms: 1000, end_ms: 5000, duration_ms: 4000, volume: 1 };
  const { player, frames, note } = await mount(t, { sounds: [late], refusing: ['pack/bed.wav'] });
  for (let wall = 300; wall <= 1500; wall += 300) {
    frames.advanceTo(wall);
    await settle();
  }
  assert.equal(player.getState().playing, false, 'a refused sound did not stop the story');
  assert.match(note.textContent, /Required story audio failed/);
});

test('a story with no short effects makes no audio context', async (t) => {
  const audio = installAudioContext(); t.after(audio.restore);
  const long = effect('rain', 1000, 'pack/rain.wav', 9000);
  const { player, frames, made } = await mount(t, { sounds: [long] });
  frames.advanceTo(1500);
  assert.equal(audio.made.length, 0, 'a context was made for a story that has no effect to play from memory');
  assert.equal(made.some((media) => String(media.src ?? '').endsWith('pack/rain.wav')), true, 'a long effect was not streamed');
  assert.equal(player.getState().playing, true);
});

test('in the player, an effect is fetched once, played from memory, and its missing file stops nothing', async (t) => {
  const audio = installAudioContext(); t.after(audio.restore);
  const sounds = [effect('pop', 1000), effect('again', 2000, 'pack/pop.wav'), effect('gone', 3000)];
  const { player, frames, made, requested } = await mount(t, { sounds, missing: ['pack/gone.wav'] });
  for (let wall = 200; wall <= 3600; wall += 200) {
    frames.advanceTo(wall);
    await settle();
  }
  const [context] = audio.made;
  assert.equal(context.sources.length, 2, 'the two plays of the effect that landed did not both sound');
  assert.equal(requested.filter((href) => href.endsWith('pack/pop.wav')).length, 1);
  assert.equal(made.some((media) => String(media.src ?? '').endsWith('.wav')), false, 'an element was opened for an effect');
  assert.equal(player.getState().playing, true, 'a missing effect stopped the story');
  assert.equal(player.getState().tMs, 3600);
  player.destroy();
  assert.equal(context.state, 'closed', 'the context outlived the player');
});
