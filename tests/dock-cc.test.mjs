import assert from 'node:assert/strict';
import test from 'node:test';
import { createStoryPlayer } from '../browser/embed.mjs';
import { installDom } from './_dom.mjs';
import { performanceFixture as fullPerformanceFixture } from './_performance.mjs';
const performanceFixture = () => {
  const story = fullPerformanceFixture();
  story.assets = {}; story.scenes[0].nodes = [];
  return story;
};

const assetBase = 'https://storage.example/';
const legacy = (text = '') => ({ storylang_version: 0, cast: {}, objects: {}, audio: { sfx: {}, bgm: {} },
  scenes: [{ place: 'dell', plate: { poster: 'assets/dell.jpg', video: 'assets/dell.mp4' },
    steps: [{ kind: 'chunk', line: 1, text, duration_s: 2 }] }],
});

function find(node, name) {
  if (node.className?.split(' ').includes(name)) return node;
  for (const child of node.children ?? []) { const found = find(child, name); if (found) return found; }
}

async function mount(t, story, options = {}) {
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story, assetBase, ...options });
  t.after(() => player.destroy());
  await player.ready;
  return { player, root: host.shadowRoot, cc: find(host.shadowRoot, 'cc-button') };
}

// A CC trapped in the Save menu, or a changing accessible name, makes this fail.
test('CC is a direct, named dock button and not a settings row', async t => {
  const dom = installDom(); t.after(dom.restore);
  const { root, cc } = await mount(t, legacy('Read along'));
  assert.equal(cc.getAttribute('aria-label'), 'Subtitles');
  assert.ok(cc.className.split(' ').includes('round-button'));
  assert.equal(cc.parent, find(root, 'side-buttons'));
  assert.deepEqual(find(root, 'settings-menu').children, [find(root, 'save-button')]);
  assert.equal(find(root, 'settings-button').hidden, true, 'unsupported Save leaves an empty gear');
});

test('CC is absent for text-free stories and present for narration or timed captions', async t => {
  const dom = installDom(); t.after(dom.restore);
  const timed = performanceFixture();
  timed.audio = [];
  timed.performance.required_capabilities.push('captions');
  timed.captions = [{ start_ms: 0, end_ms: 2000, text: 'A lyric' }];
  const silent = structuredClone(timed); silent.captions = [];
  for (const [story, hidden] of [[legacy(), true], [legacy('Read'), false],
    [performanceFixture(), false], [timed, false], [silent, true]]) {
    assert.equal((await mount(t, story)).cc.hidden, hidden);
  }
});

test('a growing story reveals CC when its first caption arrives', async t => {
  const dom = installDom(); t.after(dom.restore);
  const story = legacy();
  const { player, cc } = await mount(t, story, { stream: { scenes: 2 }, plates: {
    dell: { day: { zones: [{ id: 'ground', stand_y: 90 }], poster: 'assets/dell.jpg', video: 'assets/dell.mp4' } },
  } });
  assert.equal(cc.hidden, true);
  await player.appendScene(legacy('Now read along').scenes[0]);
  assert.equal(cc.hidden, false);
});

test('viewer CC changes notify only this handle, survive listener failures, unsubscribe and destroy', async t => {
  const dom = installDom(); t.after(dom.restore);
  const a = await mount(t, legacy('A'));
  const b = await mount(t, legacy('B'));
  const seen = [], other = [];
  assert.throws(() => a.player.subscribeSubtitles(null), /function/);
  a.player.subscribeSubtitles(() => { throw new Error('host preference store failed'); });
  const off = a.player.subscribeSubtitles(on => seen.push(on));
  b.player.subscribeSubtitles(on => other.push(on));
  a.player.setSubtitles(true);
  assert.deepEqual(seen, [], 'a host write fed back as a viewer change');
  a.cc.dispatch('click');
  assert.deepEqual(seen, [false]);
  assert.equal(find(a.root, 'subtitle-wrap').hidden, true);
  assert.equal(b.cc.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(other, []);
  assert.equal(a.cc.getAttribute('aria-label'), 'Subtitles');
  a.cc.dispatch('click');
  assert.deepEqual(seen, [false, true]);
  off();
  a.cc.dispatch('click');
  assert.deepEqual(seen, [false, true]);
  a.player.destroy();
  assert.equal(a.cc.dispatch('click'), 0);
  a.player.subscribeSubtitles(() => {})();
});

test('only a bedtime story exposes its own moon beside CC', async t => {
  const dom = installDom(); t.after(dom.restore);
  const story = performanceFixture(); story.performance.kind = 'bedtime';
  const { root } = await mount(t, story);
  const moon = find(root, 'dim-button');
  assert.equal(moon.hidden, false);
  assert.equal(moon.parent, find(root, 'side-buttons'));
  assert.ok(moon.className.split(' ').includes('round-button'));
  moon.dispatch('click');
  assert.equal(moon.getAttribute('aria-pressed'), 'true');
  assert.equal(find(root, 'stage-frame').classList.contains('is-dimmed'), true);
  assert.equal(find((await mount(t, performanceFixture())).root, 'dim-button').hidden, true);
});
