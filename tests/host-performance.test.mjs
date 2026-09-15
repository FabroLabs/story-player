import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoryPlayer } from '../browser/embed.mjs';
import { createVideoPlate } from '../browser/v0/app/stage/video-plate.mjs';
import { performanceFixture } from './_performance.mjs';
import { fakeStageElements, installDom } from './_dom.mjs';

function byClass(node, name) {
  if (node.className === name) return node;
  for (const child of node.children ?? []) { const found = byClass(child, name); if (found) return found; }
}

test('host transport controls and observes the same WHT clock, including seek/end/replay and teardown', async (t) => {
  const dom = installDom(); t.after(dom.restore);
  const make = document.createElement.bind(document);
  document.createElement = tag => {
    const node = make(tag);
    if (tag === 'canvas') { const get = node.getContext.bind(node); node.getContext = kind => {
      const ctx = get(kind); ctx.transform = (...args) => ctx.calls.push(['transform', ...args]); return ctx;
    }; }
    return node;
  };
  const priorAudio = globalThis.Audio;
  globalThis.Audio = class {
    constructor() { this.currentTime = 0; this.paused = true; }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    addEventListener() {} removeAttribute() {} load() {}
  };
  t.after(() => { globalThis.Audio = priorAudio; });
  const story = performanceFixture();
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {story, assetBase: 'https://storage.example/', chrome: 'host'});
  t.after(() => player.destroy());
  await player.ready;
  const values = [], unsubscribe = player.subscribe(s => values.push(s));
  const duration = player.getTimeline().duration_ms;
  assert.equal(player.getState().started, false);
  assert.equal(byClass(host.shadowRoot, 'start-ceremony').style.display, 'none');
  assert.equal(byClass(host.shadowRoot, 'controls').style.display, 'none');
  await player.play();
  assert.equal(player.getState().playing, true);
  assert.equal(player.getState().started, true);
  player.pause(); player.seek(1500);
  assert.equal(player.getState().tMs, 1500);
  assert.equal(player.getState().playing, false);
  assert.equal(values.at(-1).tMs, 1500);
  player.setSubtitles(false);
  assert.equal(byClass(host.shadowRoot, 'subtitle-wrap').hidden, true);
  player.seek(duration);
  assert.equal(player.getState().ended, true);
  await player.play();
  assert.equal(player.getState().ended, false);
  assert(player.getState().tMs < 100);
  player.toggle(); assert.equal(player.getState().playing, false);
  unsubscribe(); const count = values.length;
  player.seek(300); assert.equal(values.length, count);
  player.destroy(); player.play(); player.seek(0);
  assert.equal(values.length, count);
});

test('an absent plate removes src and never plays the document URL', (t) => {
  const dom = installDom(); t.after(dom.restore);
  const elements = fakeStageElements();
  let assigned = null, plays = 0;
  Object.defineProperty(elements.video, 'src', {get: () => assigned === '' ? 'https://host.example/story' : assigned,
    set: value => { assigned = value; }});
  elements.video.play = () => { plays++; return Promise.resolve(); };
  elements.video.removeAttribute = () => { assigned = null; };
  const plate = createVideoPlate(elements);
  t.after(() => plate.destroy());
  plate.showScene(null); plate.play();
  assert.equal(plays, 0);
  assert.equal(assigned, null);
  assert.equal(elements.video.hidden, true);
});
