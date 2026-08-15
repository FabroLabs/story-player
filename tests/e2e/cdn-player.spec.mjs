import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { buildCdn } from '../../scripts/build-cdn.mjs';

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
  const routes = new Map([
    ['/story-player/stable/story-player.js', file(path.join(temporary, 'story-player.js'), 'text/javascript; charset=utf-8')],
    ['/jobs/e2e/story.json', file(path.join(FIXTURES, 'story.json'), 'application/json; charset=utf-8')],
    ['/fairytale-assets/media/poster.svg', file(path.join(FIXTURES, 'media', 'poster.svg'), 'image/svg+xml')],
    ['/fairytale-assets/media/plate.webm', file(path.join(FIXTURES, 'media', 'plate.webm.txt'), 'video/webm')],
    ['/jobs/e2e/audio/narration.wav', {
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
