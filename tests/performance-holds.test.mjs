/**
 * A performance holds on its last frame for what it reached and has not got — a line still
 * downloading, a cut whose sheets are not decoded — and goes on the moment they land.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoryPlayer } from '../browser/embed.mjs';
import { installDom, virtualFrames } from './_dom.mjs';

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

function twoScenes() {
  return {
    title: 'Two scenes',
    performance: { kind: 'wht', resolution: [1000, 562.5], required_capabilities: ['transform'] },
    assets: {
      one: { type: 'image', media: 'pack/one.png', width: 100, height: 100 },
      two: { type: 'image', media: 'pack/two.png', width: 100, height: 100 },
    },
    scenes: [
      { id: 'a', setting_id: 'room', start_ms: 0, end_ms: 2000, nodes: [{ id: 'n', asset: 'one', x: 100, y: 100, width: 100 }] },
      { id: 'b', setting_id: 'room', start_ms: 2000, end_ms: 4000, nodes: [{ id: 'n', asset: 'two', x: 100, y: 100, width: 100 }] },
    ],
    audio: [
      { id: 'first', kind: 'narration', media: 'pack/first.m4a', start_ms: 0, duration_ms: 400, text: 'one', volume: 1 },
      { id: 'second', kind: 'narration', media: 'pack/second.m4a', start_ms: 500, duration_ms: 400, text: 'two', volume: 1 },
      { id: 'third', kind: 'narration', media: 'pack/third.m4a', start_ms: 3000, duration_ms: 500, text: 'three', volume: 1 },
    ],
  };
}

/** Every request answers at once, except the files a test holds back until it lets them go. */
function heldFetch() {
  const blocked = new Set();
  const waiting = [];
  const requested = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);
    if ([...blocked].some((name) => href.endsWith(name))) await new Promise((resolve) => { waiting.push({ href, resolve }); });
    return { ok: true, status: 200, blob: async () => ({ pixels: { width: 100, height: 100 } }), arrayBuffer: async () => new ArrayBuffer(8) };
  };
  return {
    requested,
    block: (name) => blocked.add(name),
    release(name) {
      blocked.delete(name);
      for (const entry of waiting.filter(({ href }) => href.endsWith(name))) {
        waiting.splice(waiting.indexOf(entry), 1);
        entry.resolve();
      }
    },
  };
}

function installAudio() {
  const prior = globalThis.Audio;
  const made = [];
  globalThis.Audio = class {
    constructor() { this.currentTime = 0; this.paused = true; made.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {} removeAttribute() {} load() {}
  };
  return { made, restore: () => { globalThis.Audio = prior; } };
}

function byClass(node, name) {
  if (node?.className === name) return node;
  for (const child of node?.children ?? []) { const found = byClass(child, name); if (found) return found; }
  return null;
}

async function mount(t, block = []) {
  const dom = installDom(); t.after(dom.restore);
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = make(tag);
    if (tag === 'canvas') {
      const get = node.getContext.bind(node);
      node.getContext = (kind) => { const context = get(kind); context.transform = () => {}; return context; };
    }
    return node;
  };
  const network = heldFetch();
  for (const name of block) network.block(name);
  const audio = installAudio(); t.after(audio.restore);
  const frames = virtualFrames(); t.after(frames.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story: twoScenes(), assetBase: 'https://storage.example/', chrome: 'host' });
  t.after(() => player.destroy());
  await player.ready;
  await player.play();
  await settle();
  return { player, network, audio, frames, hold: byClass(host.shadowRoot, 'hold-overlay'), note: byClass(host.shadowRoot, 'media-note') };
}

test('a cut whose sheets are not decoded holds on the last frame, then shows the whole scene', async (t) => {
  const { player, network, frames, hold } = await mount(t, ['pack/two.png']);
  frames.advanceTo(1000);
  assert.equal(player.getState().sceneIndex, 0);
  frames.advanceTo(2300);
  assert.equal(player.getState().sceneIndex, 0, 'the next scene was shown without its sheet');
  assert.equal(player.getState().tMs, 1999, 'the story ran past a cut it could not show');
  assert.equal(player.getState().playing, true, 'a hold is not a pause');
  frames.advanceTo(9000);
  assert.equal(player.getState().tMs, 1999, 'the clock ran on during the hold');
  assert.equal(hold.hidden, true, 'the spinner came up at once');
  await new Promise((resolve) => { setTimeout(resolve, 350); });
  assert.equal(hold.hidden, false, 'a hold longer than a blink shows no spinner');
  network.release('pack/two.png');
  await settle(); await settle();
  frames.advanceTo(9100);
  assert.equal(player.getState().sceneIndex, 1, 'the scene did not come when its sheet landed');
  assert.equal(player.getState().tMs, 2099, 'the story did not continue from where it held');
  assert.equal(hold.hidden, true);
});

test('a line that has not landed holds the story at its cue, and starts from its first word', async (t) => {
  const { player, network, audio, frames } = await mount(t, ['pack/third.m4a']);
  frames.advanceTo(2500);
  assert.equal(player.getState().sceneIndex, 1, 'the next scene was prepared while the first played');
  frames.advanceTo(3300);
  assert.equal(player.getState().tMs, 2999, 'the story ran into a line it could not play');
  const opened = audio.made.length;
  network.release('pack/third.m4a');
  await settle(); await settle();
  frames.advanceTo(3350);
  assert.equal(player.getState().tMs, 3049);
  assert.equal(audio.made.length, opened + 1, 'the line was not opened once it landed');
  assert.equal(audio.made.at(-1).currentTime, 0, 'the line did not start from its first word');
  assert.equal(audio.made.at(-1).paused, false);
});

test('a hold that never ends stops the story with a note, and play asks again', async (t) => {
  const { player, network, frames, note } = await mount(t, ['pack/two.png']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  frames.advanceTo(2300);
  assert.equal(player.getState().tMs, 1999);
  t.mock.timers.tick(20_000);
  assert.equal(player.getState().playing, false, 'a hold that cannot end kept the transport on playing');
  assert.match(note.textContent, /could not be loaded/);
  network.release('pack/two.png');
  await settle(); await settle();
  await player.play();
  await settle(); await settle();
  frames.advanceTo(2400);
  assert.equal(player.getState().sceneIndex, 1);
  assert.equal(player.getState().playing, true);
});

test('pausing during a hold stays paused when what it waited for lands', async (t) => {
  const { player, network, frames } = await mount(t, ['pack/two.png']);
  frames.advanceTo(2300);
  player.pause();
  assert.equal(player.getState().playing, false);
  network.release('pack/two.png');
  await settle(); await settle();
  frames.advanceTo(4000);
  assert.equal(player.getState().playing, false, 'the landing restarted a story the viewer paused');
  assert.equal(player.getState().tMs, 1999);
});
