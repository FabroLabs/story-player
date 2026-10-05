/**
 * A bedtime story's moonlit wind-down and the moon's dimming, drawn by the
 * player: the arithmetic, the phase, and a whole mount through the public API.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { createPlayerTemplate } from '../browser/template.mjs';
import { readPostStory, secondsLeft, skyOpacity, windDownOver, windDownSeconds } from '../browser/v0/app/wind-down.mjs';
import { createWindDownPhase } from '../browser/v0/app/wind-down-phase.mjs';
import { findByClass, installDom } from './_dom.mjs';
import { performanceFixture } from './_performance.mjs';

const POST = Object.freeze({
  phase: 'host',
  starts_at_ms: 4000,
  duration_ms: 60_000,
  background_asset: 'sky',
  base_color: '#020304',
  dim_overlay: { color: '#020304', opacity: 0.3 },
  reveal: { duration_ms: 3000, easing: 'smoothstep' },
  ambience: { media: 'fairytale-assets/bed.m4a', from_ms: 4000, to_ms: 64_000, volume: 0.8 },
});

function bedtimeStory(post = POST) {
  const story = performanceFixture();
  story.performance.kind = 'bedtime';
  story.scenes.at(-1).end_ms = 4000;
  story.assets.sky = { type: 'image', media: 'fairytale-assets/sky.png', width: 100, height: 56 };
  story.metadata = { ...(story.metadata ?? {}), post_story: post };
  return story;
}

test('a bedtime story says what follows it, and anything else says nothing', () => {
  const post = readPostStory(bedtimeStory());
  assert.equal(post.skyMedia, 'fairytale-assets/sky.png');
  assert.deepEqual(post.ambience, { media: 'fairytale-assets/bed.m4a', fromMs: 4000, toMs: 64_000, volume: 0.8 });
  assert.equal(post.revealMs, 3000);
  assert.equal(post.dimOpacity, 0.3);

  assert.equal(readPostStory({ ...bedtimeStory(), performance: { kind: 'wht' } }), null);
  assert.equal(readPostStory(bedtimeStory({ ...POST, background_asset: 'nowhere' })), null);
  assert.equal(readPostStory(bedtimeStory({ ...POST, ambience: { ...POST.ambience, to_ms: 10 } })), null);
  // A colour ends up in an inline style: anything that is not one is the default.
  assert.equal(readPostStory(bedtimeStory({ ...POST, base_color: 'red; background: url(x)' })).baseColor, '#020304');
});

test('the sky comes up over the reveal, and the countdown counts what is left', () => {
  const post = readPostStory(bedtimeStory());
  assert.equal(skyOpacity(post, 4), 0);
  assert.equal(skyOpacity(post, 5.5), 0.5);
  assert.equal(skyOpacity(post, 7), 1);
  assert.equal(windDownSeconds(post), 60);
  assert.equal(secondsLeft(post, 4), 60);
  assert.equal(secondsLeft(post, 63.2), 1);
  assert.equal(windDownOver(post, 64, false), true);
  assert.equal(windDownOver(post, 63.97, true), true, 'a sound that stopped just short of its end has run out');
  assert.equal(windDownOver(post, 63.97, false), false);
});

test('the phase raises the sky, plays on, stops into the quiet, and leaves for the story', async (t) => {
  const { elements, audio, phase, changes } = bench(t);

  assert.equal(phase.phase(), null);
  phase.prime();
  assert.equal(audio.muted, true, 'the begin gesture was not spent silently');
  await settle();
  assert.equal(audio.paused, true, 'a primed bed kept sounding under the story');
  assert.equal(audio.muted, false);

  const settled = phase.begin({ playing: true });
  assert.equal(phase.phase(), 'winddown');
  assert.equal(elements.sky.hidden, false);
  assert.equal(elements.layer.style.opacity, '0', 'the sky did not come up from its base colour');
  assert.equal(audio.currentTime, 4, 'the bed did not carry on from where the story left it');
  assert.equal(audio.paused, false);
  assert.equal(elements.times.textContent, 'Wind-down · 1:00 left');
  audio.fire('playing');
  assert.equal(elements.frame.classList.contains('is-sounding'), true);
  assert.equal(elements.toggle.getAttribute('aria-label'), 'pause');

  assert.equal(phase.toggle(), true);
  assert.equal(audio.paused, true);
  audio.fire('pause');
  assert.equal(elements.toggle.getAttribute('aria-label'), 'resume');

  elements.stop.dispatch('click');
  assert.equal(phase.phase(), 'quiet');
  assert.equal(elements.chip.textContent, 'Stopped');
  assert.equal(elements.sky.hidden, false, 'the sky went with the sound');
  assert.equal(elements.toggle.getAttribute('aria-label'), 'replay');
  assert.equal(phase.toggle(), false, 'play in the quiet is the story’s replay, not the sound’s');

  phase.leave();
  assert.equal(phase.phase(), null);
  assert.equal(elements.sky.hidden, true);
  assert.deepEqual(changes, ['winddown', 'quiet', null]);
  assert.equal(await Promise.race([settled, settle().then(() => 'pending')]), 'pending',
    'a played wind-down let the end screen in');
});

test('a wind-down that runs out ends on the quiet, saying so', async (t) => {
  const { elements, audio, phase } = bench(t);
  phase.begin({ playing: true });
  audio.fire('ended');
  assert.equal(phase.phase(), 'quiet');
  assert.equal(elements.chip.textContent, 'Sleep well');
  assert.equal(elements.times.textContent, 'Wind-down · 0:00 left');
});

test('a paused arrival at the end raises the sky and waits for play', (t) => {
  const { elements, audio, phase } = bench(t);
  phase.begin({ playing: false });
  assert.equal(phase.phase(), 'winddown');
  assert.equal(audio.paused, true);
  assert.equal(elements.toggle.getAttribute('aria-label'), 'resume');
});

test('a sound that cannot play gives the end back to the runtime', async (t) => {
  const { elements, audio, phase } = bench(t);
  const settled = phase.begin({ playing: true });
  audio.fire('error');
  await settled;
  assert.equal(phase.phase(), null);
  assert.equal(elements.sky.hidden, true);
});

test('a hidden page pauses the wind-down, and destroy lets the sound go', (t) => {
  const { audio, phase } = bench(t);
  phase.begin({ playing: true });
  document.visibilityState = 'hidden';
  document.dispatch('visibilitychange');
  assert.equal(audio.paused, true);
  phase.destroy();
  assert.equal(audio.removed, true);
  assert.equal(document.listenerCount('visibilitychange'), 0);
});

test('a bedtime mount plays its own wind-down, reports it, and replays out of it', async (t) => {
  const { host, player } = await mount(t, { dim: true });
  const frame = findByClass(host.shadowRoot, 'stage-frame');
  assert.equal(player.getState().afterStory, null, 'a build that plays the wind-down does not say so');
  assert.equal(findByClass(host.shadowRoot, 'dim-button').hidden, false);
  assert.equal(frame.classList.contains('is-dimmed'), true, 'the host’s dimming was not applied');
  findByClass(host.shadowRoot, 'dim-button').dispatch('click');
  assert.equal(frame.classList.contains('is-dimmed'), false);

  await player.play();
  player.seek(player.getTimeline().duration_ms);
  assert.equal(player.getState().ended, true);
  assert.equal(player.getState().afterStory, 'winddown');
  assert.equal(findByClass(host.shadowRoot, 'end-overlay').hidden, true, 'the end screen covered the sky');

  findByClass(host.shadowRoot, 'stop-button').dispatch('click');
  assert.equal(player.getState().afterStory, 'quiet');

  findByClass(host.shadowRoot, 'play-button').dispatch('click');
  assert.equal(player.getState().afterStory, null);
  assert.equal(player.getState().ended, false);
  assert.equal(findByClass(host.shadowRoot, 'sky').hidden, true);
});

test('a host that draws its own chrome draws its own bedtime too', async (t) => {
  const { host, player } = await mount(t, { chrome: 'host' });
  assert.equal(findByClass(host.shadowRoot, 'dim-button').hidden, true);
  player.seek(player.getTimeline().duration_ms);
  assert.equal(player.getState().afterStory, null);
  assert.equal(findByClass(host.shadowRoot, 'sky').hidden, true);
});

test('a dimming that is not true or false is refused at the mount', async (t) => {
  const dom = installDom();
  installQuietAudio(t);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story: bedtimeStory(), assetBase: 'https://storage.example/', dim: 'yes' });
  await assert.rejects(player.ready, /dim must be true or false/);
  player.destroy();
  dom.restore();
});

/** Let promise callbacks run. */
function settle() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

function bench(t) {
  const dom = installDom();
  const audios = installQuietAudio(t);
  const host = document.createElement('div');
  const elements = createPlayerTemplate(host.attachShadow({ mode: 'open' })).windDown;
  const changes = [];
  const phase = createWindDownPhase({
    elements,
    post: readPostStory(bedtimeStory()),
    resolve: (media) => `https://storage.example/${media}`,
    onChange: (next) => changes.push(next),
  });
  t.after(() => {
    phase.destroy();
    dom.restore();
  });
  return { elements, audio: audios.at(-1), phase, changes };
}

async function mount(t, options = {}) {
  const dom = installDom();
  installQuietAudio(t);
  // A performance draws with `transform`, which the suite's 2D context only
  // records when asked to.
  const make = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = make(tag);
    if (tag === 'canvas') {
      const get = node.getContext.bind(node);
      node.getContext = (kind) => {
        const context = get(kind);
        context.transform = (...args) => context.calls.push(['transform', ...args]);
        return context;
      };
    }
    return node;
  };
  const host = document.createElement('div');
  const player = createStoryPlayer(host, { story: bedtimeStory(), assetBase: 'https://storage.example/', ...options });
  t.after(() => {
    player.destroy();
    dom.restore();
  });
  await player.ready;
  return { host, player };
}

/** An `Audio` that records what it was asked and fires what a test tells it to. */
function installQuietAudio(t) {
  const opened = [];
  const original = globalThis.Audio;
  globalThis.Audio = class {
    constructor(url) {
      this.src = url ?? '';
      this.paused = true;
      this.muted = false;
      this.currentTime = 0;
      this.volume = 1;
      this.removed = false;
      this.listeners = new Map();
      opened.push(this);
    }
    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }
    removeEventListener(type, handler) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((one) => one !== handler));
    }
    fire(type) { for (const handler of this.listeners.get(type) ?? []) handler({ type }); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name) { if (name === 'src') this.removed = true; }
  };
  t.after(() => { globalThis.Audio = original; });
  return opened;
}
