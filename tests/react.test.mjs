import assert from 'node:assert/strict';
import test from 'node:test';

import React, { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { createReactStoryPlayer } from '../browser/react.mjs';

test('the React factory validates its caller-supplied hook surface', () => {
  assert.throws(() => createReactStoryPlayer({ createElement() {} }), /useEffect/);
});

test('caller-supplied React mounts, replaces, and unmounts the plain player under StrictMode', async (t) => {
  const browser = installBrowser();
  t.after(browser.restore);
  const StoryPlayer = createReactStoryPlayer(React);
  const target = document.querySelector('#root');
  const root = createRoot(target);
  t.after(() => root.unmount());

  await act(async () => {
    root.render(React.createElement(StrictMode, null, React.createElement(StoryPlayer, {
      story: story('First moon'),
      assetBase: 'https://storage.example/',
      className: 'story-slot',
      'data-owner': 'wizard',
      'aria-label': 'bedtime player',
    })));
    await settle();
  });

  const host = target.firstElementChild;
  assert.equal(host.className, 'story-slot');
  assert.equal(host.dataset.owner, 'wizard');
  assert.equal(host.getAttribute('aria-label'), 'bedtime player');
  assert.equal(host.shadowRoot.querySelector('h1').textContent, 'First moon');
  assert.ok(browser.assetRequests.includes('https://storage.example/assets/dell.jpg'));

  await act(async () => {
    root.render(React.createElement(StrictMode, null, React.createElement(StoryPlayer, {
      story: story('Second moon'),
      assetBase: 'https://storage.example/',
      className: 'story-slot',
    })));
    await settle();
  });
  assert.equal(target.firstElementChild, host, 'story replacement discarded the React-owned host');
  assert.equal(host.shadowRoot.querySelector('h1').textContent, 'Second moon');

  const beforeAssetReplace = browser.assetRequests.length;
  await act(async () => {
    root.render(React.createElement(StrictMode, null, React.createElement(StoryPlayer, {
      story: story('Second moon'),
      assetBase: 'https://other-storage.example/root',
      className: 'story-slot',
    })));
    await settle();
  });
  assert.equal(target.firstElementChild, host, 'asset-base replacement discarded the React-owned host');
  assert.ok(
    browser.assetRequests.slice(beforeAssetReplace)
      .includes('https://other-storage.example/root/assets/dell.jpg'),
  );

  await act(async () => {
    root.render(React.createElement(StrictMode, null, React.createElement(StoryPlayer, {
      story: story('Second moon'),
      assetBase: 'https://other-storage.example/root',
      debug: true,
      className: 'story-slot',
    })));
    await settle();
  });
  assert.equal(target.firstElementChild, host, 'debug replacement discarded the React-owned host');
  assert.equal(host.shadowRoot.querySelector('.debug-panel').getAttribute('aria-hidden'), 'false');

  await act(async () => root.unmount());
  assert.equal(host.shadowRoot.childNodes.length, 0, 'React cleanup left the plain player mounted');
});

function story(title) {
  return {
    storylang_version: 0,
    title,
    cast: {},
    objects: {},
    audio: { sfx: {}, bgm: {} },
    scenes: [{
      place: 'dell',
      plate: { poster: 'assets/dell.jpg', video: 'assets/dell.mp4' },
      steps: [],
    }],
  };
}

async function settle() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function installBrowser() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://app.example/' });
  const imageSources = [];
  const saved = new Map();
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    DOMException: dom.window.DOMException,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previousResizeObserver = globalThis.ResizeObserver;
  const previousImage = globalThis.Image;
  const previousFetch = globalThis.fetch;
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  // jsdom has no `fetch` worth the name and node's real one would leave this
  // suite asking the network for `storage.example`. Both asset seams answer
  // here, and what they were asked for is the assertion.
  const assetRequests = [];
  globalThis.fetch = async (url) => {
    assetRequests.push(String(url));
    return { ok: true, status: 200, blob: async () => ({ pixels: { width: 8, height: 8 } }) };
  };
  globalThis.createImageBitmap = async (blob) => ({
    width: blob?.pixels?.width ?? 1, height: blob?.pixels?.height ?? 1, close() {},
  });
  class ImmediateImage {
    #listeners = new Map();
    addEventListener(type, handler) { this.#listeners.set(type, handler); }
    removeAttribute() {}
    set src(value) {
      this.value = value;
      imageSources.push(value);
      queueMicrotask(() => this.#listeners.get('load')?.({ type: 'load', target: this }));
    }
  }
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Image = ImmediateImage;
  dom.window.Image = ImmediateImage;
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.HTMLMediaElement.prototype.pause = () => {};
  dom.window.HTMLMediaElement.prototype.load = () => {};
  dom.window.HTMLMediaElement.prototype.play = () => Promise.resolve();

  return {
    imageSources,
    assetRequests,
    restore() {
      if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
      else globalThis.ResizeObserver = previousResizeObserver;
      if (previousImage === undefined) delete globalThis.Image;
      else globalThis.Image = previousImage;
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
      if (previousCreateImageBitmap === undefined) delete globalThis.createImageBitmap;
      else globalThis.createImageBitmap = previousCreateImageBitmap;
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
      dom.window.close();
    },
  };
}
