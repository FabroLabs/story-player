import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { buildCdn } from '../../scripts/build-cdn.mjs';
import { lessonGuideBox } from '../../browser/v0/app/stage/lesson-guide-layout.mjs';
import { buildDrawList } from '../../browser/v0/app/stage/draw-list.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURES = path.join(ROOT, 'tests', 'e2e', 'fixtures');
const COMMIT = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const requests = [];
let temporary;
let application;
let storage;

test.beforeAll(async () => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-browser-'));
  await buildCdn({ commit: COMMIT, outfile: path.join(temporary, 'story-player.js') });
  await build({
    absWorkingDir: ROOT,
    bundle: true,
    format: 'iife',
    outfile: path.join(temporary, 'react-runtime.js'),
    platform: 'browser',
    stdin: {
      contents: [
        "import * as React from 'react';",
        "import { createRoot } from 'react-dom/client';",
        'globalThis.React = React;',
        'globalThis.ReactDOM = { createRoot };',
      ].join('\n'),
      loader: 'js',
      resolveDir: ROOT,
    },
    target: ['es2022'],
  });
  storage = await listen(storageHandler);
  application = await listen(applicationHandler);
});

test.afterAll(async () => {
  await Promise.all([close(application?.server), close(storage?.server)]);
  if (temporary) fs.rmSync(temporary, { force: true, recursive: true });
});

test.beforeEach(() => { requests.length = 0; });

// What these two cover in a REAL browser and nothing else does: two players on
// one page, the React adapter under StrictMode, and the media request log of a
// story driven from its begin button to its end overlay.
test('plain JavaScript mounts two players, plays qualified media, and destroys/remounts cleanly', async ({ page }) => {
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);

  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.locator('#first .start-button')).toBeEnabled();
  await expect(page.locator('#second .start-button')).toBeEnabled();
  expect(await page.locator('#first').evaluate((host) => host.shadowRoot.mode)).toBe('open');
  expect(await page.evaluate(() => ({
    commit: FabroStoryPlayer.build.commit,
    frozen: Object.isFrozen(FabroStoryPlayer),
    storyTitle: window.__story.title,
  }))).toEqual({ commit: COMMIT, frozen: true, storyTitle: 'The CDN Moon' });

  await page.locator('#first .start-button').click();
  await expect.poll(() => page.evaluate(() => window.__seenSubtitles)).toContain(
    'The moon remembered every safe path home.',
  );
  await expect(page.locator('#second .start-ceremony')).not.toHaveClass(/is-gone/);
  await expect(page.locator('#second .end-overlay')).toBeHidden();

  expect(requests.some(({ path: requestPath }) => requestPath === '/jobs/e2e/story.json')).toBe(true);
  expect(requests.some(({ path: requestPath }) => requestPath === '/fairytale-assets/media/poster.svg')).toBe(true);
  expect(requests.some(({ path: requestPath }) => requestPath === '/fairytale-assets/media/plate.webm')).toBe(true);
  expect(requests.some(({ path: requestPath }) => requestPath === '/jobs/e2e/audio/narration.wav')).toBe(true);
  const storyRequest = requests.find(({ path: requestPath }) => requestPath === '/jobs/e2e/story.json');
  expect(storyRequest.origin).toBe(application.url);

  await page.evaluate(() => window.__remountFirst());
  await expect(page.locator('#first .start-button')).toBeEnabled();
  await page.waitForTimeout(700);
  await expect(page.locator('#first .end-overlay')).toBeHidden();
  await expect(page.locator('#second .start-button')).toBeEnabled();
  expect(await page.locator('#first').evaluate((host) => host.shadowRoot.children.length)).toBeGreaterThan(0);
  await page.locator('#first .start-button').click();
  await expect(page.locator('#first .end-overlay')).toBeVisible();
});

for (const width of [390, 798]) {
  for (const debug of [false, true]) {
    test(`closed debug drawer cannot scroll the native stage at ${width}px (debug=${debug})`, async ({ page }) => {
      await page.goto(`${application.url}/plain-js.html`);
      await page.evaluate(() => window.__mounted);
      await page.evaluate(async ({ width, debug, assetBase }) => {
        const host = document.body.appendChild(document.createElement('div'));
        host.id = 'debug-probe';
        Object.assign(host.style, { width: `${width}px`, position: 'fixed', top: '0', left: '0', zIndex: '100' });
        window.__debugProbe = FabroStoryPlayer.createStoryPlayer(host, { story: window.__story, assetBase, debug });
        await window.__debugProbe.ready;
      }, { width, debug, assetBase: storage.url });
      if (debug) await page.locator('#debug-probe .debug-panel [aria-label="close event log"]').click();
      await page.locator('#debug-probe .start-button').click();
      await page.evaluate(() => window.__debugProbe.pause());
      await page.locator('#debug-probe .cc-button').click();

      const geometry = () => page.locator('#debug-probe').evaluate((host) => {
        host.scrollLeft = 10000;
        const root = host.shadowRoot;
        const shell = root.querySelector('.player-shell').getBoundingClientRect();
        const panel = root.querySelector('.debug-panel');
        return { width: host.clientWidth, scrollWidth: host.scrollWidth, scrollLeft: host.scrollLeft,
          shellLeft: shell.left, hostLeft: host.getBoundingClientRect().left,
          panelDisplay: getComputedStyle(panel).display, open: panel.getAttribute('aria-hidden') === 'false' };
      });
      const closed = await geometry();
      expect(closed.scrollWidth).toBe(closed.width);
      expect(closed.scrollLeft).toBe(0);
      expect(closed.shellLeft).toBe(closed.hostLeft);
      expect(closed.panelDisplay).toBe('none');
      if (debug) {
        await page.locator('#debug-probe .stage-actions [aria-label="open event log"]').click();
        await expect(page.locator('#debug-probe .debug-panel')).toBeVisible();
        await expect(page.locator('#debug-probe .debug-panel')).toHaveAttribute('aria-hidden', 'false');
        await page.waitForTimeout(350);
        const opened = await geometry();
        expect(opened.open).toBe(true);
        expect(opened.scrollWidth).toBe(opened.width);
        expect(opened.scrollLeft).toBe(0);
        await page.locator('#debug-probe .debug-panel [aria-label="close event log"]').click();
        await expect(page.locator('#debug-probe .debug-panel')).toBeHidden();
        expect(await geometry()).toMatchObject({ scrollLeft: 0, panelDisplay: 'none', open: false });
      }
      await page.evaluate(() => window.__debugProbe.destroy());
    });
  }
}

/**
 * The one thing no fake can answer about a card: whether the layer a real
 * browser lays out really leaves the screen.
 *
 * `.card-layer` is displayed by a rule of its own, and any `display:` beats the
 * UA rule behind `hidden` — the trap every other overlay in this player is
 * spelled out for. Miss it and the unit suite stays green while a child watches
 * the whole story behind an opaque rectangle.
 *
 * The films here are the server's deterministic invalid video body, which is the
 * other half of what this proves: a card a real browser refuses to decode has to
 * cost the story nothing.
 */
test('a card comes up over the story, and a card a browser refuses does not keep it', async ({ page }) => {
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);
  await expect(page.locator('#third .start-button')).toBeEnabled();
  await expect(page.locator('#third .card-layer')).toBeHidden();

  // Read inside the click's own tick: the ceremony withdraws and the card comes
  // up synchronously, and the browser's refusal of the film is an event that
  // has not been dispatched yet.
  const onTheClick = await page.evaluate(() => {
    const root = document.querySelector('#third').shadowRoot;
    root.querySelector('.start-button').click();
    const layer = root.querySelector('.card-layer');
    return {
      hidden: layer.hidden,
      display: getComputedStyle(layer).display,
      video: root.querySelector('.card-video').getAttribute('src'),
      muted: root.querySelector('.card-video').muted,
      skip: getComputedStyle(root.querySelector('.card-skip')).visibility,
      controls: root.querySelector('.controls').hidden,
    };
  });
  expect(onTheClick.hidden).toBe(false);
  expect(onTheClick.display).not.toBe('none');
  expect(onTheClick.video).toBe(`${storage.url}/fairytale-assets/media/card.webm`);
  expect(onTheClick.muted).toBe(true);
  expect(onTheClick.skip).toBe('visible');
  expect(onTheClick.controls).toBe(true);

  // Both of the card's own objects were asked for, under the storage base and
  // nowhere else.
  await expect
    .poll(() => requests.filter(({ path: requestPath }) => requestPath.includes('card')).length)
    .toBeGreaterThan(0);
  expect(requests.some(({ path: requestPath }) => requestPath === '/fairytale-assets/media/card.webm')).toBe(true);

  // The film cannot be decoded, so the phase ends on it — and the story it was
  // holding back plays through to its end.
  await expect(page.locator('#third .end-overlay')).toBeVisible();
  await expect(page.locator('#third .card-layer')).toBeHidden();
  await expect(page.locator('#third .controls')).toBeVisible();
});

test('unsafe media is refused in the Shadow DOM without making an escaped request', async ({ page }) => {
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);
  const result = await page.evaluate(async () => {
    const host = document.body.appendChild(document.createElement('div'));
    const story = structuredClone(window.__story);
    story.scenes[0].plate.poster = '../escape.svg';
    const player = FabroStoryPlayer.createStoryPlayer(host, {
      story,
      assetBase: window.__assetBase,
    });
    try {
      await player.ready;
      return { error: null };
    } catch (error) {
      return {
        error: error.message,
        visible: host.shadowRoot.querySelector('.load-status').textContent,
      };
    }
  });

  expect(result.error).toMatch(/invalid media path/);
  expect(result.visible).toMatch(/invalid media path/);
  expect(requests.some(({ path: requestPath }) => requestPath.includes('escape'))).toBe(false);
});

test('the caller-supplied React factory renders the same classic player under StrictMode', async ({ page }) => {
  await page.goto(`${application.url}/react.html`);
  await page.evaluate(() => window.__mounted);
  const host = page.locator('#react-player');
  await expect(host).toHaveAttribute('data-consumer', 'react');
  await expect(page.locator('#react-player .start-button')).toBeEnabled();
  await expect(page.locator('iframe')).toHaveCount(0);

  await page.locator('#react-player .start-button').click();
  await expect(page.locator('#react-player .end-overlay')).toBeVisible();
  await page.evaluate(() => window.__reactRoot.unmount());
  await expect(host).toHaveCount(0);
});

async function storageHandler(request, response) {
  const url = new URL(request.url, 'http://storage.test');
  requests.push({ method: request.method, origin: request.headers.origin ?? null, path: url.pathname });
  if (url.pathname === '/fairytale-assets/media/stalled.svg') {
    response.writeHead(200, {
      'Content-Type': 'image/svg+xml', 'Content-Length': '1000',
      'Access-Control-Allow-Origin': '*',
    });
    response.flushHeaders();
    return; // reproduce headers arriving while the body never completes
  }
  const routes = new Map([
    ['/story-player/stable/story-player.js', file(path.join(temporary, 'story-player.js'), 'text/javascript; charset=utf-8')],
    ['/jobs/e2e/story.json', file(path.join(FIXTURES, 'story.json'), 'application/json; charset=utf-8')],
    ['/fairytale-assets/media/poster.svg', file(path.join(FIXTURES, 'media', 'poster.svg'), 'image/svg+xml')],
    ['/fairytale-assets/media/plate.webm', file(path.join(FIXTURES, 'media', 'plate.webm.txt'), 'video/webm')],
    // The cards' own two objects: a separate path for the same deterministic
    // bodies, so "the card asked for its film" is a different request from "the
    // scene asked for its plate".
    ['/fairytale-assets/media/card.webm', file(path.join(FIXTURES, 'media', 'plate.webm.txt'), 'video/webm')],
    ['/jobs/e2e/audio/narration.wav', {
      body: Buffer.from(fs.readFileSync(path.join(FIXTURES, 'media', 'narration.wav.b64'), 'utf8').trim(), 'base64'),
      type: 'audio/wav',
    }],
    ['/jobs/e2e/audio/card-music.wav', {
      body: Buffer.from(fs.readFileSync(path.join(FIXTURES, 'media', 'narration.wav.b64'), 'utf8').trim(), 'base64'),
      type: 'audio/wav',
    }],
  ]);
  const route = routes.get(url.pathname);
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (!route) return send(response, 404, Buffer.from('not found'), 'text/plain', request.method);
  return send(response, 200, route.body, route.type, request.method);
}

test('an unfinished image body fails within the opening deadline and a fresh mount recovers', async ({ page }) => {
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);
  await page.clock.install();
  let stalledFetches = 0;
  page.on('request', request => {
    if (request.resourceType() === 'fetch' && request.url().endsWith('/stalled.svg')) stalledFetches++;
  });
  const stalledResponse = response => response.url().endsWith('/stalled.svg');
  const firstHeaders = page.waitForResponse(stalledResponse);
  await page.evaluate(() => {
    const story = structuredClone(window.__story);
    story.scenes[0].plate.poster = 'fairytale-assets/media/stalled.svg';
    const host = document.body.appendChild(document.createElement('div'));
    host.id = 'stalled';
    window.failedPlayer = FabroStoryPlayer.createStoryPlayer(host, {story, assetBase: window.__assetBase});
    window.failedPlayer.ready.then(() => { window.openingResult = 'ready'; }, error => { window.openingResult = error.name; });
  });
  // Observe player fetch attempts, not transparent transport retries; headers
  // must reach the browser before this advances a BODY-stall deadline.
  await firstHeaders;
  expect(stalledFetches).toBe(1);
  const retryHeaders = page.waitForResponse(stalledResponse);
  await page.clock.fastForward(15_000);
  await retryHeaders;
  expect(stalledFetches).toBe(2);
  await page.clock.fastForward(15_000);
  await expect.poll(() => page.evaluate(() => window.openingResult)).toBe('TimeoutError');
  expect(stalledFetches).toBe(2);
  await page.evaluate(async () => {
    window.failedPlayer.destroy();
    const next = FabroStoryPlayer.createStoryPlayer(document.querySelector('#stalled'), {
      story: window.__story, assetBase: window.__assetBase,
    });
    await next.ready;
  });
  await expect(page.locator('#stalled .start-button')).toBeEnabled();
});

async function applicationHandler(request, response) {
  const url = new URL(request.url, 'http://application.test');
  if (url.pathname === '/react-runtime.js') {
    const route = file(path.join(temporary, 'react-runtime.js'), 'text/javascript; charset=utf-8');
    return send(response, 200, route.body, route.type, request.method);
  }
  const fixture = url.pathname === '/plain-js.html'
    ? 'plain-js.html'
    : url.pathname === '/react.html' ? 'react.html' : null;
  if (!fixture) return send(response, 404, Buffer.from('not found'), 'text/plain', request.method);
  const html = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8')
    .replaceAll('__PLAYER_URL__', `${storage.url}/story-player/stable/story-player.js`)
    .replaceAll('__STORY_URL__', `${storage.url}/jobs/e2e/story.json`)
    .replaceAll('__ASSET_BASE__', `${storage.url}/`)
    .replaceAll('__REACT_URL__', `${application.url}/react-runtime.js`);
  return send(response, 200, Buffer.from(html), 'text/html; charset=utf-8', request.method);
}

function file(target, type) {
  return { body: fs.readFileSync(target), type };
}

function send(response, status, body, type, method) {
  response.statusCode = status;
  response.setHeader('Content-Length', String(body.length));
  response.setHeader('Content-Type', type);
  response.end(method === 'HEAD' ? undefined : body);
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      Promise.resolve(handler(request, response)).catch((error) => {
        response.statusCode = 500;
        response.end(error.message);
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}


test('Farm phone captions sit above the timeline with visible controls', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);
  const bounds = await page.evaluate(async (assetBase) => {
    const host = document.body.appendChild(document.createElement('div'));
    host.style.width = '358px';
    const story = structuredClone(window.__story);
    const svg = story.scenes[0].plate.poster;
    story.cast = {};
    story.objects = Object.fromEntries(['animal_cow','farm_view_wide_cow'].map(slug=>[slug,{svg,height_cm:35}]));
    story.scenes = [{...story.scenes[0],steps:[
      {kind:'cmd',cmd:'put',subjects:['animal_cow'],objects:['animal_cow'],position:'center'},
      {kind:'cmd',cmd:'board',subjects:[],cards:['animal_cow','farm_view_wide_cow'],prompt:'Cow'},
      {kind:'cmd',cmd:'pause',seconds:10}]}];
    const handle = FabroStoryPlayer.createStoryPlayer(host,{story,assetBase});
    await handle.ready;
    const root = host.shadowRoot;
    root.querySelector('.start-button').click();
    handle.pause();
    const frame = root.querySelector('.stage-frame');
    frame.classList.remove('is-bare');
    root.querySelector('.subtitle').textContent = 'The happy cow is standing in the green meadow.';
    root.querySelector('.subtitle-wrap').hidden = false;
    await new Promise(resolve => setTimeout(resolve, 400));
    const text = root.querySelector('.subtitle').getBoundingClientRect();
    const scrub = root.querySelector('.scrub').getBoundingClientRect();
    const result = {farm:frame.classList.contains('has-farm-overlay'),bottom:text.bottom,top:text.top,timeline:scrub.top,frameTop:frame.getBoundingClientRect().top};
    handle.destroy();
    return result;
  }, storage.url);
  expect(bounds.farm).toBe(true);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.timeline);
  expect(bounds.top).toBeGreaterThanOrEqual(bounds.frameTop);
});

test('a world opens without a board, reveals real garden wood and restores identical pixels after a seek', async ({ page }) => {
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);
  const result = await page.evaluate(async assetBase => {
    const host = document.body.appendChild(document.createElement('div'));
    host.style.width = '960px';
    const story = structuredClone(window.__story), svg = story.scenes[0].plate.poster;
    story.cast = { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
      clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } };
    story.objects = Object.fromEntries(['garden', 'ball', 'one', 'two', 'three', 'four'].map(slug => [slug, { svg, height_cm: 30 }]));
    story.scenes[0].steps = [{ kind: 'cmd', cmd: 'put', subjects: ['helper'] },
      { kind: 'cmd', cmd: 'board', cards: ['one', 'two', 'three', 'four'], subjects: [], prompt: '' },
      { kind: 'cmd', cmd: 'pause', seconds: 8 }];
    const handle = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase, board: {
      layout: 'lesson-guide', guide: 'helper', world: {
        background: 'garden', board: { style: 'garden', panel: [.1, .4, .8, .44] }, actor_box: [.82, .94, .4],
        phases: [
          { id: 'outdoors', start_ms: 0, end_ms: 2000, mode: 'world', props: [{ slug: 'ball', keyframes: [
            { at: 0, box: [.2, .8, .1, .1] }, { at: 1, box: [.6, .8, .1, .1] },
          ] }] },
          { id: 'teaching', start_ms: 2000, end_ms: 8000, mode: 'lesson', props: [] },
        ],
      },
    } });
    await handle.ready;
    host.shadowRoot.querySelector('.start-button').click(); handle.pause();
    const canvas = host.shadowRoot.querySelector('.stage-canvas'), ctx = canvas.getContext('2d');
    const pixel = (x, y) => Array.from(ctx.getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1).data);
    handle.seek(1000);
    const outdoors = canvas.toDataURL(), outdoorPanel = pixel(.5, .46), outdoorEdge = pixel(.02, .46);
    handle.seek(3000);
    const lessonPanel = pixel(.5, .46), lessonEdge = pixel(.02, .46), wood = pixel(.5, .411);
    handle.seek(1000);
    const same = canvas.toDataURL() === outdoors;
    handle.destroy();
    return { outdoorPanel, outdoorEdge, lessonPanel, lessonEdge, wood, same };
  }, storage.url);
  expect(result.outdoorPanel).toEqual([16, 21, 45, 255]);
  expect(result.lessonPanel).toEqual([255, 248, 231, 255]);
  expect(result.wood).toEqual([217, 173, 112, 255]);
  expect(result.lessonEdge).toEqual(result.outdoorEdge);
  expect(result.same).toBe(true);
});

test('generated board art stays visible while a foreground object docks without a pixel jump', async ({ page }) => {
  await page.route('**/fairytale-assets/media/board-art.svg', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect x="20" y="20" width="1560" height="860" fill="#f7ebd0"/></svg>' }));
  await page.route('**/fairytale-assets/media/transfer-apple.svg', route => route.fulfill({ contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#e94c3a"/></svg>' }));
  await page.goto(`${application.url}/plain-js.html`);
  await page.evaluate(() => window.__mounted);
  const result = await page.evaluate(async assetBase => {
    const host = document.body.appendChild(document.createElement('div')); host.style.width = '960px';
    const story = structuredClone(window.__story), svg = story.scenes[0].plate.poster;
    story.cast = { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
      clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } };
    story.objects = { garden: { svg }, letter: { svg },
      art: { svg: 'fairytale-assets/media/board-art.svg' }, apple: { svg: 'fairytale-assets/media/transfer-apple.svg' } };
    story.scenes[0].steps = [{ kind: 'cmd', cmd: 'put', subjects: ['helper'] },
      { kind: 'cmd', cmd: 'board', cards: ['letter', 'apple'], subjects: [], prompt: '' },
      { kind: 'cmd', cmd: 'pause', seconds: 10 }];
    const handle = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase, board: {
      layout: 'lesson-guide', guide: 'helper', world: {
        background: 'garden', actor_box: [.9, .94, .4], board: { style: 'garden', panel: [.1, .4, .8, .44], art: 'art', art_box: [.05, .25, .9, .7] },
        phases: [
          { id: 'opening', start_ms: 0, end_ms: 1000, mode: 'world', props: [] },
          { id: 'transfer', start_ms: 1000, end_ms: 5000, mode: 'lesson',
            content_opacity: [{ at: 0, opacity: 0 }, { at: .5, opacity: 1 }, { at: 1, opacity: 1 }],
            props: [{ slug: 'apple', cards: ['letter', 'apple'], card_index: 2, hide_card_image: true, keyframes: [
              { at: 0, box: [.2, .8, .15, .2] }, { at: .75, anchor: 'card', box: [.5, .5, 1, 1] }, { at: 1, anchor: 'card', box: [.5, .5, 1, 1] },
            ] }] },
          { id: 'teaching', start_ms: 5000, end_ms: 8000, mode: 'lesson', props: [] },
          { id: 'friends', start_ms: 8000, end_ms: 10000, mode: 'lesson', content_opacity: 0,
            props: [{ slug: 'apple', keyframes: [{ at: 0, box: [.5, .46, .1, .1] }, { at: 1, box: [.5, .46, .1, .1] }] }] },
        ],
      },
    } });
    await handle.ready; host.shadowRoot.querySelector('.start-button').click(); handle.pause();
    const canvas = host.shadowRoot.querySelector('.stage-canvas'), ctx = canvas.getContext('2d');
    const pixel = (x, y) => Array.from(ctx.getImageData(Math.round(x * canvas.width), Math.round(y * canvas.height), 1, 1).data);
    handle.seek(4500); const landed = canvas.toDataURL(), firstArt = pixel(.5, .46);
    handle.seek(5000); const handoffSame = canvas.toDataURL() === landed, nextArt = pixel(.5, .46);
    handle.seek(9000); const foreground = pixel(.5, .46), persistent = pixel(.4, .46);
    handle.seek(4500); const reverseSame = canvas.toDataURL() === landed;
    handle.destroy(); return { firstArt, nextArt, foreground, persistent, handoffSame, reverseSame };
  }, storage.url);
  expect(result.firstArt).toEqual([247, 235, 208, 255]);
  expect(result.nextArt).toEqual(result.firstArt);
  expect(result.persistent).toEqual(result.firstArt);
  expect(result.foreground).toEqual([233, 76, 58, 255]);
  expect(result.handoffSame).toBe(true);
  expect(result.reverseSame).toBe(true);
});

for (const width of [390, 960]) for (const presentation of ['default', 'spotlight', 'spotlight-reduced']) {
  test(`world answer cues ${presentation} remain neutral during thinking and restore exact paused pixels at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: presentation === 'spotlight-reduced' ? 'reduce' : 'no-preference' });
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${application.url}/plain-js.html`);
    await page.evaluate(() => window.__mounted);
    const cards = ['one', 'two', 'three', 'four'];
    const board = { layout: 'lesson-guide', guide: 'helper', world: {
      background: 'garden', actor_box: [.92, .97, .28],
      board: { style: 'garden', panel: [.15, .305, .70, .525], content: {
        cards: [.015, .045, .97, .72], prompt: [.04, .80, .92, .18],
      } },
      phases: [{ id: 'lesson', start_ms: 0, end_ms: 8000, mode: 'lesson', props: [] }],
      cues: [
        { id: 'pause', kind: 'thinking', start_ms: 2000, end_ms: 4000, cards },
        { id: 'reveal', kind: 'reveal', start_ms: 4000, end_ms: 5800, cards, answer_index: 3,
          ...(presentation === 'default' ? {} : { presentation: 'spotlight' }) },
      ],
    } };
    const geometry = buildDrawList({ tMs: 1900, plate: { resolution: [1920, 1080] }, actors: [],
      slate: { mode: 'cards', cards, focus: null, prompt: 'Find three' } }, undefined, null, board).commands.find(c => c.op === 'slate').cards;
    const result = await page.evaluate(async ({ assetBase, width, board, geometry }) => {
      const host = document.body.appendChild(document.createElement('div')); host.style.width = `${width - 16}px`;
      const story = structuredClone(window.__story), svg = story.scenes[0].plate.poster;
      story.cast = { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
        clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } };
      story.objects = Object.fromEntries(['garden', 'one', 'two', 'three', 'four'].map(slug => [slug, { svg }]));
      story.scenes[0].steps = [{ kind: 'cmd', cmd: 'put', subjects: ['helper'] },
        { kind: 'cmd', cmd: 'board', cards: ['one', 'two', 'three', 'four'], subjects: [], prompt: 'Find three' },
        { kind: 'cmd', cmd: 'pause', seconds: 8 }];
      const handle = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase, board });
      await handle.ready; host.shadowRoot.querySelector('.start-button').click(); handle.pause();
      const canvas = host.shadowRoot.querySelector('.stage-canvas'), ctx = canvas.getContext('2d');
      const crop = (card, inset = 0) => {
        const scale = canvas.width / 1920;
        return Array.from(ctx.getImageData(Math.round((card.dx + card.dw * inset) * scale),
          Math.round((card.dy + card.dh * inset) * scale), Math.round(card.dw * (1 - 2 * inset) * scale),
          Math.round(card.dh * (1 - 2 * inset) * scale)).data).join(',');
      };
      handle.seek(1900); const before = canvas.toDataURL(), cores = geometry.map(card => crop(card, .1)), target = crop(geometry[2]);
      handle.seek(2500); const thinking = canvas.toDataURL(), neutral = geometry.every((card, index) => crop(card, .1) === cores[index]);
      handle.seek(2700); const breathChanges = canvas.toDataURL() !== thinking;
      handle.seek(4225); const peak = canvas.toDataURL(), answerChanges = crop(geometry[2]) !== target;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const burstColorsVisible = [[232, 173, 36], [41, 153, 142], [229, 109, 89]].every(color => {
        let count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (color.every((channel, offset) => Math.abs(channel - pixels[index + offset]) < 10)) count++;
        }
        return count >= 2;
      });
      const distractorsStable = [0, 1, 3].every(index => crop(geometry[index], .1) === cores[index]);
      handle.seek(4320); const revealMoves = canvas.toDataURL() !== peak;
      handle.seek(5800); const finished = canvas.toDataURL() === before;
      handle.seek(4225); const seekSame = canvas.toDataURL() === peak;
      handle.seek(2500); const thinkingSame = canvas.toDataURL() === thinking;
      handle.destroy(); return { neutral, breathChanges, answerChanges, burstColorsVisible, distractorsStable, revealMoves, finished, seekSame, thinkingSame };
    }, { assetBase: storage.url, width, board, geometry });
    expect(result).toEqual({ neutral: true, breathChanges: true, answerChanges: true, burstColorsVisible: presentation === 'default', distractorsStable: true,
      revealMoves: presentation !== 'spotlight-reduced',
      finished: true, seekSame: true, thinkingSame: true });
  });
}

for (const width of [390, 1280]) {
  test(`lesson guide leaves long native captions beside its full cell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${application.url}/plain-js.html`);
    await page.evaluate(() => window.__mounted);
    const result = await page.evaluate(async ({ assetBase, guide, width }) => {
      const host = document.body.appendChild(document.createElement('div'));
      host.style.width = `${width - 16}px`;
      const handle = FabroStoryPlayer.createStoryPlayer(host, {
        story: window.__story, assetBase, board: { layout: 'lesson-guide', guide: 'helper' },
      });
      await handle.ready;
      const root = host.shadowRoot;
      const frame = root.querySelector('.stage-frame');
      frame.classList.add('is-bare');
      const text = root.querySelector('.subtitle');
      text.textContent = "C! Bibo, can you bring it back? Ooh, it's heavy! There we go!";
      root.querySelector('.subtitle-wrap').hidden = false;
      await new Promise(resolve => setTimeout(resolve, 220));
      const caption = text.getBoundingClientRect();
      const stage = frame.getBoundingClientRect();
      const style = getComputedStyle(text);
      const ordinaryText = document.querySelector('#first').shadowRoot.querySelector('.subtitle');
      const ordinaryStyle = getComputedStyle(ordinaryText);
      const scale = stage.width / 1920;
      const bounds = { enabled: frame.classList.contains('has-lesson-guide'),
        captionRight: caption.right, captionLeft: caption.left, captionTop: caption.top,
        stageLeft: stage.left, stageTop: stage.top, guideLeft: stage.left + guide.dx * scale,
        font: style.fontSize, lineHeight: style.lineHeight,
        ordinaryFont: ordinaryStyle.fontSize, ordinaryLineHeight: ordinaryStyle.lineHeight };
      handle.setSubtitles(false);
      bounds.ccHidden = root.querySelector('.subtitle-wrap').hidden;
      handle.destroy();
      bounds.classAfterDestroy = frame.classList.contains('has-lesson-guide');
      return bounds;
    }, { assetBase: storage.url, width, guide: lessonGuideBox(1920, 1080) });
    console.log(JSON.stringify({ captionGuideGeometry: width, ...result }));
    expect(result.captionRight).toBeLessThan(result.guideLeft);
    expect(result.enabled).toBe(true);
    expect(result.captionLeft).toBeGreaterThanOrEqual(result.stageLeft);
    expect(result.captionTop).toBeGreaterThanOrEqual(result.stageTop);
    expect(result.font).toBe(width <= 400 ? '13px' : result.ordinaryFont);
    expect(result.lineHeight).toBe(width <= 400 ? '16.9px' : result.ordinaryLineHeight);
    expect(result.ccHidden).toBe(true);
    expect(result.classAfterDestroy).toBe(false);
  });
}

for (const fallbackFont of [null, 'monospace']) {
  test(`the full shapes explanation clears all four fixed cards and the guide on a phone (${fallbackFont ?? 'native font'})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${application.url}/plain-js.html`);
    await page.evaluate(() => window.__mounted);
    const board = buildDrawList({ plate: { resolution: [1920, 1080] }, actors: [],
      slate: { mode: 'cards', cards: ['one', 'two', 'three', 'four'], focus: null, prompt: 'A B C D' },
    }).commands.find(command => command.op === 'slate');
    const result = await page.evaluate(async ({ assetBase, cardBottom, guide, fallbackFont }) => {
      const host = document.body.appendChild(document.createElement('div'));
      host.style.width = '374px';
      const story = structuredClone(window.__story);
      const svg = story.scenes[0].plate.poster;
      story.cast = { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
        clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } };
      story.objects = Object.fromEntries(['one', 'two', 'three', 'four'].map(slug => [slug, { svg, height_cm: 30 }]));
      story.scenes[0].steps = [{ kind: 'cmd', cmd: 'put', subjects: ['helper'] },
        { kind: 'cmd', cmd: 'board', cards: ['one', 'two', 'three', 'four'], subjects: [], prompt: 'A B C D' },
        { kind: 'chunk', text: "Every letter has two shapes: a big uppercase and a little lowercase. Let's discover their names and sounds!", duration_s: 8 }];
      const handle = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase,
        board: { layout: 'lesson-guide', guide: 'helper' } });
      await handle.ready;
      const root = host.shadowRoot;
      // Wider fallback metrics reproduce the extra caption line seen on Linux.
      if (fallbackFont) root.querySelector('.subtitle').style.fontFamily = fallbackFont;
      root.querySelector('.start-button').click(); handle.pause(); handle.seek(1000); handle.setSubtitles(true);
      const frame = root.querySelector('.stage-frame'); frame.classList.add('is-bare');
      await new Promise(resolve => setTimeout(resolve, 220));
      const stage = frame.getBoundingClientRect(), text = root.querySelector('.subtitle');
      const caption = text.getBoundingClientRect(), style = getComputedStyle(text);
      const result = { top: caption.top, bottom: caption.bottom, height: caption.height, stageBottom: stage.bottom, right: caption.right, cardBottom: stage.top + stage.height * cardBottom,
        guideLeft: stage.left + guide.dx / 1920 * stage.width, font: style.fontSize, lineHeight: style.lineHeight,
        ordinaryFont: getComputedStyle(document.querySelector('#first').shadowRoot.querySelector('.subtitle')).fontSize };
      handle.destroy(); return result;
    }, { assetBase: storage.url, fallbackFont, cardBottom: Math.max(...board.cards.map(card => card.dy + card.dh)) / 1080,
      guide: lessonGuideBox(1920, 1080) });
    console.log(JSON.stringify({ phoneShapesCaption: result, fallbackFont }));
    expect(result.top).toBeGreaterThanOrEqual(result.cardBottom);
    expect(result.right).toBeLessThan(result.guideLeft);
    expect(result.font).toBe('13px');
    expect(result.lineHeight).toBe('16.9px');
    expect(result.ordinaryFont).toBe('15px');
    expect(result.bottom).toBeLessThan(result.stageBottom);
  });
}

for (const width of [390, 1280]) {
  test(`comic guide captions move above fixed cards and restore after paused seeks at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${application.url}/plain-js.html`);
    await page.evaluate(() => window.__mounted);
    const result = await page.evaluate(async ({ assetBase, width }) => {
      const host = document.body.appendChild(document.createElement('div'));
      host.style.width = `${width - 16}px`;
      const story = structuredClone(window.__story);
      const svg = story.scenes[0].plate.poster;
      story.cast = { helper: { height_cm: 30, capability: { idle: { camera: 'idle' } },
        clips: { idle: { spritesheet: svg, frames: 1, fps: 1, grid: [1, 1] } } } };
      story.objects = Object.fromEntries(['one', 'two', 'three', 'four'].map(slug => [slug, { svg, height_cm: 30 }]));
      story.scenes[0].steps = [
        { kind: 'cmd', cmd: 'put', subjects: ['helper'] },
        { kind: 'cmd', cmd: 'board', cards: ['one', 'two', 'three', 'four'], subjects: [], prompt: '' },
        { kind: 'chunk', text: 'Look! Bibo runs, jumps, then sits on the board.', duration_s: 8 },
      ];
      const handle = FabroStoryPlayer.createStoryPlayer(host, { story, assetBase, board: {
        layout: 'lesson-guide', guide: 'helper', choreography: [{ id: 'running-caption', kind: 'run', caption: 'top',
          start_ms: 1000, end_ms: 5000, actor: { keyframes: [
            { at: 0, box: [.15, .99, .32] }, { at: 1, box: [1.12, .99, .32] },
          ] } }],
      } });
      await handle.ready;
      const root = host.shadowRoot;
      root.querySelector('.start-button').click(); handle.pause(); handle.seek(3000);
      handle.setSubtitles(true);
      const frame = root.querySelector('.stage-frame');
      frame.classList.add('is-bare');
      await new Promise(resolve => setTimeout(resolve, 220));
      const text = root.querySelector('.subtitle');
      const stage = frame.getBoundingClientRect();
      const bounds = text.getBoundingClientRect();
      const style = getComputedStyle(text);
      const ordinaryStyle = getComputedStyle(document.querySelector('#first').shadowRoot.querySelector('.subtitle'));
      const snapshot = { enabled: frame.classList.contains('has-top-guide-caption'), top: bounds.top, bottom: bounds.bottom,
        stageTop: stage.top, cardTop: stage.top + stage.height * .322565, actorTop: stage.top + stage.height * .67,
        font: style.fontSize, ordinaryFont: ordinaryStyle.fontSize, lineHeight: style.lineHeight,
        ordinaryLineHeight: ordinaryStyle.lineHeight };
      handle.seek(5000); snapshot.restoredAtEnd = !frame.classList.contains('has-top-guide-caption');
      snapshot.restoredTop = text.getBoundingClientRect().top;
      handle.seek(3000); snapshot.backwardTop = text.getBoundingClientRect().top;
      handle.seek(999); snapshot.restoredBefore = !frame.classList.contains('has-top-guide-caption');
      handle.seek(3000);
      text.textContent = '';
      snapshot.emptyCaptionHeight = root.querySelector('.subtitle-wrap').getBoundingClientRect().height;
      handle.setSubtitles(false); snapshot.ccHidden = root.querySelector('.subtitle-wrap').hidden;
      handle.destroy(); snapshot.classAfterDestroy = frame.classList.contains('has-top-guide-caption');
      return snapshot;
    }, { assetBase: storage.url, width });
    console.log(JSON.stringify({ comicCaptionGeometry: width, ...result }));
    expect(result.enabled).toBe(true);
    expect(result.top - result.stageTop).toBeCloseTo(12, 1);
    expect(result.bottom).toBeLessThan(result.cardTop);
    expect(result.bottom).toBeLessThan(result.actorTop);
    expect(result.font).toBe(width <= 400 ? '13px' : result.ordinaryFont);
    expect(result.lineHeight).toBe(width <= 400 ? '16.9px' : result.ordinaryLineHeight);
    expect(result.restoredAtEnd).toBe(true);
    expect(result.restoredTop).toBeGreaterThan(result.top);
    expect(result.backwardTop).toBeCloseTo(result.top, 1);
    expect(result.restoredBefore).toBe(true);
    expect(result.emptyCaptionHeight).toBe(0);
    expect(result.ccHidden).toBe(true);
    expect(result.classAfterDestroy).toBe(false);
  });
}
