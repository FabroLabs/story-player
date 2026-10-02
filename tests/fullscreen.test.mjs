/**
 * The full-screen button: whose way of filling the screen it uses, and when it
 * is there at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createStoryPlayer } from '../browser/embed.mjs';
import { createFullscreen } from '../browser/v0/app/fullscreen.mjs';
import { fakeElement, findByClass, installDom } from './_dom.mjs';

const STORY = Object.freeze({
  storylang_version: 0,
  title: 'Moonlight',
  cast: {},
  objects: {},
  audio: { sfx: {}, bgm: {} },
  scenes: [{ place: 'dell', plate: { poster: 'assets/dell.jpg', video: 'assets/dell.mp4' }, steps: [] }],
});

test('a host that can fill the screen is asked, and says what happened', (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const button = fakeElement('button');
  button.hidden = true;
  const asked = [];
  const screenFill = createFullscreen({ button, target: fakeElement(), request: (on) => asked.push(on) });

  assert.equal(button.hidden, false, 'a host that can fill the screen got no button');
  button.dispatch('click');
  assert.deepEqual(asked, [true]);
  // An app turns the phone a beat later, or not at all: the button says what
  // the host reports, not what it was asked for.
  assert.equal(button.getAttribute('aria-pressed'), 'false');

  screenFill.set(true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.equal(button.getAttribute('aria-label'), 'exit full screen');
  button.dispatch('click');
  assert.deepEqual(asked, [true, false]);

  screenFill.destroy();
  button.dispatch('click');
  assert.deepEqual(asked, [true, false], 'a destroyed button still asked the host');
});

test('without one, the browser fills the screen with the player and turns a phone sideways', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const calls = [];
  document.fullscreenEnabled = true;
  document.fullscreenElement = null;
  document.exitFullscreen = async () => { calls.push('exit'); };
  const savedScreen = globalThis.screen;
  globalThis.screen = {
    orientation: {
      lock: async (orientation) => { calls.push(`lock ${orientation}`); },
      unlock: () => { calls.push('unlock'); },
    },
  };
  t.after(() => { globalThis.screen = savedScreen; });
  const target = fakeElement();
  target.ownerDocument = document;
  target.requestFullscreen = async (options) => { calls.push(`fill ${options?.navigationUI}`); };
  const button = fakeElement('button');
  const screenFill = createFullscreen({ button, target });

  assert.equal(button.hidden, false);
  button.dispatch('click');
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.deepEqual(calls, ['fill hide', 'lock landscape']);

  document.fullscreenElement = target;
  document.dispatch('fullscreenchange');
  assert.equal(button.getAttribute('aria-pressed'), 'true', 'the button did not hear the browser fill the screen');

  button.dispatch('click');
  assert.deepEqual(calls.slice(2), ['unlock', 'exit']);

  // Taken down mid-fullscreen: the page is not left filling the screen with an
  // empty box.
  calls.length = 0;
  screenFill.destroy();
  assert.deepEqual(calls, ['unlock', 'exit']);
  assert.equal(document.listenerCount('fullscreenchange'), 0, 'destroy left the browser listener behind');
});

test('where nothing can fill the screen there is no button', (t) => {
  // iPhone Safari has no element fullscreen, and a webview whose host passes
  // nothing has no way to turn the phone: a control that does nothing is worse
  // than its absence.
  const dom = installDom();
  t.after(dom.restore);
  const button = fakeElement('button');
  createFullscreen({ button, target: fakeElement() });
  assert.equal(button.hidden, true);
});

test('the mount hands the host its request, and the handle carries its answer back', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const asked = [];
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: STORY, assetBase: 'https://storage.example/', fullscreen: (on) => asked.push(on),
  });
  t.after(() => player.destroy());
  await player.ready;
  const button = findByClass(host.shadowRoot, 'fullscreen-button');

  assert.equal(button.hidden, false);
  button.dispatch('click');
  assert.deepEqual(asked, [true]);
  player.setFullscreen(true);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});

test('a full-screen request that is not a function is refused at the mount', async (t) => {
  const dom = installDom();
  t.after(dom.restore);
  const host = document.createElement('div');
  const player = createStoryPlayer(host, {
    story: STORY, assetBase: 'https://storage.example/', fullscreen: 'please',
  });
  await assert.rejects(player.ready, /fullscreen must be a function/);
  player.destroy();
});
