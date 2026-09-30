/**
 * A performance holds on its last frame for what it reached and has not got — a line still
 * downloading, a cut whose sheets are not decoded — and goes on the moment they land.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoryPlayer } from '../browser/embed.mjs';
import { fetchAssetBlob } from '../browser/v0/app/assets/asset-request.mjs';
import { installDom, virtualFrames } from './_dom.mjs';

const settle = () => new Promise((resolve) => { setImmediate(resolve); });

function twoScenes(side = 100, sounds = []) {
  return {
    title: 'Two scenes',
    performance: { kind: 'wht', resolution: [1000, 562.5], required_capabilities: ['transform'] },
    assets: {
      one: { type: 'image', media: 'pack/one.png', width: side, height: side },
      two: { type: 'image', media: 'pack/two.png', width: side, height: side },
    },
    scenes: [
      { id: 'a', setting_id: 'room', start_ms: 0, end_ms: 2000, nodes: [{ id: 'n', asset: 'one', x: 100, y: 100, width: 100 }] },
      { id: 'b', setting_id: 'room', start_ms: 2000, end_ms: 4000, nodes: [{ id: 'n', asset: 'two', x: 100, y: 100, width: 100 }] },
    ],
    audio: [
      { id: 'first', kind: 'narration', media: 'pack/first.m4a', start_ms: 0, duration_ms: 400, text: 'one', volume: 1 },
      { id: 'second', kind: 'narration', media: 'pack/second.m4a', start_ms: 500, duration_ms: 400, text: 'two', volume: 1 },
      { id: 'third', kind: 'narration', media: 'pack/third.m4a', start_ms: 3000, duration_ms: 500, text: 'three', volume: 1 },
      ...sounds,
    ],
  };
}

/** Every request answers at once, except the files a test holds back until it lets them go, or never has. */
function heldFetch(side = 100, missing = []) {
  const blocked = new Set();
  const waiting = [];
  const requested = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);
    if ([...blocked].some((name) => href.endsWith(name))) await new Promise((resolve) => { waiting.push({ href, resolve }); });
    if (missing.some((name) => href.endsWith(name))) return { ok: false, status: 404 };
    return { ok: true, status: 200, blob: async () => ({ pixels: { width: side, height: side } }), arrayBuffer: async () => new ArrayBuffer(8) };
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
    constructor() { this.currentTime = 0; this.paused = true; this.removed = false; made.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {} load() {}
    removeAttribute() { this.removed = true; }
  };
  return { made, restore: () => { globalThis.Audio = prior; } };
}

function byClass(node, name) {
  if (node?.className === name) return node;
  for (const child of node?.children ?? []) { const found = byClass(child, name); if (found) return found; }
  return null;
}

async function mount(t, block = [], { side = 100, sounds = [], chrome = 'host', missing = [] } = {}) {
  const dom = installDom(); t.after(dom.restore);
  const make = document.createElement.bind(document);
  const contexts = [];
  document.createElement = (tag) => {
    const node = make(tag);
    if (tag === 'canvas') {
      const get = node.getContext.bind(node);
      node.getContext = (kind) => { const context = get(kind); context.transform = () => {}; contexts.push(context); return context; };
    }
    return node;
  };
  // Pictures on the canvas now: the images the last paint drew.
  const drawnImages = () => {
    const calls = contexts.find((context) => context.calls.some(([name]) => name === 'clearRect'))?.calls ?? [];
    const from = calls.findLastIndex(([name]) => name === 'clearRect');
    return calls.slice(from + 1).filter(([name]) => name === 'drawImage').length;
  };
  const network = heldFetch(side, missing);
  for (const name of block) network.block(name);
  const audio = installAudio(); t.after(audio.restore);
  const frames = virtualFrames(); t.after(frames.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story: twoScenes(side, sounds), assetBase: 'https://storage.example/', chrome });
  t.after(() => player.destroy());
  await player.ready;
  await player.play();
  await settle();
  return {
    player, network, audio, frames, drawnImages, root: host.shadowRoot,
    hold: byClass(host.shadowRoot, 'hold-overlay'), note: byClass(host.shadowRoot, 'media-note'),
  };
}

test('a cut whose sheets are not decoded holds on the last frame, then shows the whole scene', async (t) => {
  const { player, network, frames, hold } = await mount(t, ['pack/two.png']);
  frames.advanceTo(1000);
  assert.equal(player.getState().sceneIndex, 0);
  frames.advanceTo(2300);
  assert.equal(player.getState().sceneIndex, 0, 'the next scene was shown without its sheet');
  assert.equal(player.getState().tMs, 2000, 'the story ran past a cut it could not show');
  assert.equal(player.getState().playing, true, 'a hold is not a pause');
  frames.advanceTo(9000);
  assert.equal(player.getState().tMs, 2000, 'the clock ran on during the hold');
  assert.equal(hold.hidden, true, 'the spinner came up at once');
  await new Promise((resolve) => { setTimeout(resolve, 350); });
  assert.equal(hold.hidden, false, 'a hold longer than a blink shows no spinner');
  network.release('pack/two.png');
  await settle(); await settle();
  frames.advanceTo(9100);
  assert.equal(player.getState().sceneIndex, 1, 'the scene did not come when its sheet landed');
  assert.equal(player.getState().tMs, 2100, 'the story did not continue from where it held');
  assert.equal(hold.hidden, true);
});

test('a line that has not landed holds the story at its cue, and starts from its first word', async (t) => {
  const { player, network, audio, frames } = await mount(t, ['pack/third.m4a']);
  frames.advanceTo(2500);
  assert.equal(player.getState().sceneIndex, 1, 'the next scene was prepared while the first played');
  frames.advanceTo(3300);
  assert.equal(player.getState().tMs, 3000, 'the story ran into a line it could not play');
  const opened = audio.made.length;
  network.release('pack/third.m4a');
  await settle(); await settle();
  frames.advanceTo(3350);
  assert.equal(player.getState().tMs, 3050);
  assert.equal(audio.made.length, opened + 1, 'the line was not opened once it landed');
  assert.equal(audio.made.at(-1).currentTime, 0, 'the line did not start from its first word');
  assert.equal(audio.made.at(-1).paused, false);
});

test('a hold that never ends stops the story with a note, and play asks again', async (t) => {
  const { player, network, frames, note } = await mount(t, ['pack/two.png']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  frames.advanceTo(2300);
  assert.equal(player.getState().tMs, 2000);
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

test('a hold keeps waiting while bytes are still arriving, and gives up only once the link goes quiet', async (t) => {
  const { player, frames, note } = await mount(t, ['pack/two.png']);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  frames.advanceTo(2300);
  assert.equal(player.getState().tMs, 2000);
  // Something else on the link lands every fifteen seconds: slow, but alive.
  for (let wall = 0; wall < 60_000; wall += 15_000) {
    t.mock.timers.tick(15_000);
    await fetchAssetBlob('https://storage.example/pack/elsewhere.png');
  }
  assert.equal(player.getState().playing, true, 'a slow link still delivering was given up on');
  assert.doesNotMatch(note.textContent ?? '', /could not be loaded/);
  t.mock.timers.tick(20_000);
  assert.equal(player.getState().playing, false, 'a link gone quiet held the story for ever');
  assert.match(note.textContent, /could not be loaded/);
});

test('a file the store does not have ends the hold at once instead of waiting out the link', async (t) => {
  const { player, frames, note } = await mount(t, [], { missing: ['pack/two.png'] });
  frames.advanceTo(2300);
  await settle(); await settle(); await settle();
  assert.equal(player.getState().tMs, 2000);
  assert.equal(player.getState().playing, false, 'a missing file kept the story holding');
  assert.match(note.textContent, /could not be loaded/);
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
  assert.equal(player.getState().tMs, 2000);
});

test('a cut whose two scenes do not fit the budget together still lands, instead of trading sheets back and forth', async (t) => {
  // 4000² decodes to 64 MB: the old scene's sheet and the new one's cannot both be held in 96 MB.
  const { player, network, frames } = await mount(t, ['pack/two.png'], { side: 4000 });
  frames.advanceTo(2300);
  assert.equal(player.getState().tMs, 2000);
  network.release('pack/two.png');
  for (let wall = 2400; wall <= 3000; wall += 100) {
    await settle(); await settle();
    frames.advanceTo(wall);
  }
  assert.equal(player.getState().sceneIndex, 1, 'the cut kept holding: the old scene took its sheet back');
  assert.ok(player.getState().tMs > 2000, 'the story did not move on past the cut');
});

test('a paused seek into an unready scene and back keeps the scene on screen whole', async (t) => {
  // 4000² decodes to 64 MB: scene 1's sheet can only be decoded by pushing scene 0's out.
  const { player, network, frames, drawnImages } = await mount(t, ['pack/two.png'], { side: 4000 });
  frames.advanceTo(1000);
  player.pause();
  player.seek(2500);
  await settle();
  player.seek(1000);
  await settle();
  network.release('pack/two.png');
  for (let i = 0; i < 4; i += 1) await settle();
  assert.equal(player.getState().sceneIndex, 0);
  assert.ok(drawnImages() > 0, 'scene 0 was left drawn without its sheet');
});

test('seeking back out of a cut hold plays the scene on screen with its sheets', async (t) => {
  const { player, network, frames, drawnImages } = await mount(t, ['pack/two.png'], { side: 4000 });
  frames.advanceTo(2300);
  assert.equal(player.getState().tMs, 2000);
  player.seek(1000);
  await settle();
  network.release('pack/two.png');
  for (let wall = 2400; wall <= 3200; wall += 100) {
    await settle(); await settle();
    frames.advanceTo(wall);
  }
  const { sceneIndex, tMs, playing } = player.getState();
  assert.equal(sceneIndex, 0);
  assert.equal(playing, true);
  assert.ok(tMs > 1000 && tMs < 2000, `the story is not playing on in scene 0 (${tMs})`);
  // A still node is not repainted on its own; a moving one is, every frame. A pause repaints it.
  player.pause();
  assert.ok(drawnImages() > 0, 'scene 0 plays on without its sheet');
});

test('a sound effect just before a hold, or sounding when one begins, is heard after it', async (t) => {
  const sounds = [
    { id: 'bell', kind: 'sfx', media: 'pack/bell.wav', start_ms: 2500, duration_ms: 2000, volume: 1 },
    { id: 'knock', kind: 'sfx', media: 'pack/knock.wav', start_ms: 2900, duration_ms: 300, volume: 1 },
  ];
  const { network, audio, frames } = await mount(t, ['pack/third.m4a'], { sounds });
  const of = (name) => audio.made.find((media) => String(media.src).endsWith(name));
  frames.advanceTo(2600);
  const bell = of('bell.wav');
  assert.equal(bell?.paused, false, 'the bell did not start');
  frames.advanceTo(3300);
  assert.equal(of('knock.wav'), undefined, 'a sound was started on the frame the hold stopped it');
  assert.equal(bell.paused, true, 'the bell played on under the hold');
  assert.equal(bell.removed, false, 'the hold ended the bell instead of pausing it');
  network.release('pack/third.m4a');
  await settle(); await settle();
  frames.advanceTo(3350);
  assert.equal(bell.paused, false, 'the bell did not go on with the story');
  assert.equal(of('knock.wav')?.paused, false, 'the knock before the hold was lost');
});

test('dragging the bar out of a hold stays silent until the pointer lands', async (t) => {
  const { network, audio, frames, root } = await mount(t, ['pack/two.png'], { chrome: 'player' });
  frames.advanceTo(2300);
  const scrub = byClass(root, 'scrub');
  const box = scrub.getBoundingClientRect();
  const at = (fraction) => ({ clientX: box.left + (box.width * fraction), pointerId: 1 });
  const sounding = () => audio.made.filter((media) => !media.paused).length;
  // Every instant dragged across is inside the second line, 500–900 ms.
  scrub.dispatch('pointerdown', at(0.14));
  assert.equal(sounding(), 0, 'grabbing the bar out of the hold played sound');
  for (let step = 1; step <= 3; step += 1) {
    scrub.dispatch('pointermove', at(0.14 + (step * 0.01)));
    frames.advanceTo(2300 + (step * 50));
    assert.equal(sounding(), 0, 'the drag played sound');
  }
  scrub.dispatch('pointerup', at(0.18));
  network.release('pack/two.png');
  await settle();
  assert.ok(audio.made.some((media) => !media.paused), 'the landing did not place the sound');
});
