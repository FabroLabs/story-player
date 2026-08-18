/**
 * The byte budget, and the two things that must never happen under it:
 * evicting a sheet that is on screen, and decoding the same sheet twice.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_BUDGET_BYTES,
  SMALL_DEVICE_BUDGET_BYTES,
  createBitmapCache,
  decodeDrawable,
  defaultBudgetBytes,
} from '../browser/v0/app/assets/bitmap-cache.mjs';

/** A decoded sheet of `side` x `side` pixels: `side * side * 4` bytes. */
function fakeBitmap(side) {
  return { width: side, height: side, closed: false, close() { this.closed = true; } };
}

function countingDecoder(sides = {}) {
  const calls = [];
  return {
    calls,
    decode: async (url) => {
      calls.push(url);
      return fakeBitmap(sides[url] ?? 10);
    },
  };
}

test('a decoded sheet is measured in decoded bytes, not in download size', async () => {
  const { decode } = countingDecoder({ 'a.webp': 1000 });
  const cache = createBitmapCache({ decode });

  await cache.load('a.webp');
  assert.equal(cache.bytes, 1000 * 1000 * 4, 'a 1000px square is 4 MB of RAM, whatever the file weighed');
  assert.equal(cache.size, 1);
});

test('two asks for the same sheet share one decode, and a hit costs none', async () => {
  const { calls, decode } = countingDecoder();
  const cache = createBitmapCache({ decode });

  const [first, second] = await Promise.all([cache.load('a.webp'), cache.load('a.webp')]);
  assert.equal(first, second);
  assert.deepEqual(calls, ['a.webp'], 'the second ask joined the flight instead of starting one');

  await cache.load('a.webp');
  assert.deepEqual(calls, ['a.webp']);
  assert.equal(cache.get('a.webp'), first);
  assert.equal(cache.get('missing.webp'), null);
});

test('over budget, the least recently used goes first — and is closed, not dropped', async () => {
  const { decode } = countingDecoder({ 'a.webp': 100, 'b.webp': 100, 'c.webp': 100 });
  const oneSheet = 100 * 100 * 4;
  const cache = createBitmapCache({ decode, budgetBytes: oneSheet * 2 });

  const a = await cache.load('a.webp');
  const b = await cache.load('b.webp');
  cache.get('a.webp'); // touching `a` makes `b` the oldest
  await cache.load('c.webp');

  assert.deepEqual([cache.has('a.webp'), cache.has('b.webp'), cache.has('c.webp')], [true, false, true]);
  assert.equal(cache.bytes, oneSheet * 2);
  assert.equal(b.closed, true, 'an evicted bitmap whose backing store is never released is still resident');
  assert.equal(a.closed, false, 'a bitmap still in the cache must not be closed');
});

test('a lowered budget evicts at once, and never the scene on screen', async () => {
  const { decode } = countingDecoder({ 'a.webp': 100, 'b.webp': 100, 'c.webp': 100 });
  const oneSheet = 100 * 100 * 4;
  const reports = [];
  const cache = createBitmapCache({
    decode, budgetBytes: oneSheet * 3, onOverBudget: (detail) => reports.push(detail),
  });
  cache.keep(['a.webp']);
  const a = await cache.load('a.webp');
  const b = await cache.load('b.webp');
  await cache.load('c.webp');
  assert.equal(cache.bytes, oneSheet * 3);

  // A demotion lowers the ceiling mid-story. Waiting for the next decode would
  // hold the old one through exactly the minutes that caused the demotion.
  cache.setBudget(oneSheet);
  assert.deepEqual([cache.has('a.webp'), cache.has('b.webp'), cache.has('c.webp')], [true, false, false]);
  assert.equal(b.closed, true);
  assert.equal(a.closed, false, 'the scene on screen was evicted by a lower budget');
  assert.deepEqual(reports, []);

  // Below what the kept scene alone costs, the cache says so rather than
  // pretending the ceiling holds.
  cache.setBudget(1);
  assert.equal(cache.has('a.webp'), true);
  assert.deepEqual(reports.at(-1), { heldBytes: oneSheet, budgetBytes: 1, kept: 1 });
});

test('a budget that is not a budget changes nothing', async () => {
  const { decode, calls } = countingDecoder({ 'a.webp': 100 });
  const cache = createBitmapCache({ decode, budgetBytes: 100 * 100 * 4 });
  await cache.load('a.webp');

  for (const value of [Number.NaN, 0, -5, undefined, 100 * 100 * 4]) cache.setBudget(value);
  assert.equal(cache.has('a.webp'), true, 'a nonsense budget threw the cache away');
  assert.deepEqual(calls, ['a.webp']);
});

test('the scene on screen is never evicted, however tight the budget', async () => {
  const { decode } = countingDecoder({ 'a.webp': 100, 'b.webp': 100, 'c.webp': 100 });
  const cache = createBitmapCache({ decode, budgetBytes: 1 });

  cache.keep(['a.webp']);
  await cache.load('a.webp');
  await cache.load('b.webp');
  await cache.load('c.webp');

  assert.equal(cache.has('a.webp'), true, 'evicting a sheet that is drawing blanks a character to save nothing');
  assert.equal(cache.has('b.webp'), false);
  assert.equal(cache.has('c.webp'), true, 'the sheet just handed to the caller is not evicted behind their back');
});

test('a sheet bigger than the whole budget is still returned open', async () => {
  const { decode } = countingDecoder({ 'huge.webp': 4608 });
  const cache = createBitmapCache({ decode, budgetBytes: 48 * 1024 * 1024 });

  const huge = await cache.load('huge.webp');

  assert.ok(cache.bytes > 48 * 1024 * 1024, 'a 4608px square is 81 MB — this is the case that matters');
  assert.equal(huge.closed, false, 'evicting the sheet it just decoded hands the drawer a closed bitmap');
  assert.equal(cache.has('huge.webp'), true);
});

test('a budget that cannot be met says so instead of quietly not holding', async () => {
  const reports = [];
  const { decode } = countingDecoder({ 'a.webp': 100, 'b.webp': 100 });
  const cache = createBitmapCache({
    decode, budgetBytes: 1, onOverBudget: (detail) => reports.push(detail),
  });

  cache.keep(['a.webp', 'b.webp']);
  await cache.load('a.webp');
  await cache.load('b.webp');

  assert.equal(cache.bytes, 2 * 100 * 100 * 4, 'both are on screen, so neither may go');
  assert.equal(reports.length, 2);
  assert.deepEqual(reports.at(-1), { heldBytes: cache.bytes, budgetBytes: 1, kept: 2 });
});

test('a decode that lands after destroy is closed, not stored', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const bitmap = fakeBitmap(10);
  const cache = createBitmapCache({ decode: async () => { await pending; return bitmap; } });

  const loading = cache.load('a.webp');
  cache.destroy();
  release();

  await assert.rejects(loading, (error) => error.name === 'AbortError');
  assert.equal(bitmap.closed, true, 'the bytes this module exists to bound were leaked');
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

test('a failed decode is not remembered as a failure — the next scene may ask again', async () => {
  let attempts = 0;
  const cache = createBitmapCache({
    decode: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('asset a.webp answered 503');
      return fakeBitmap(10);
    },
  });

  await assert.rejects(cache.load('a.webp'), /503/);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
  await cache.load('a.webp');
  assert.equal(cache.has('a.webp'), true);
  assert.equal(attempts, 2);
});

test('destroy closes every bitmap it is holding and forgets the bytes', async () => {
  const { decode } = countingDecoder();
  const cache = createBitmapCache({ decode });
  const bitmap = await cache.load('a.webp');

  cache.destroy();
  assert.equal(bitmap.closed, true);
  assert.equal(cache.size, 0);
  assert.equal(cache.bytes, 0);
});

/**
 * The default decoder, with the browser stubbed: this is the only path that
 * ever touches the network, and both of its branches ship.
 */
function installBrowser({ status = 200, bitmap = true, imageDecodes = true } = {}) {
  const saved = {
    fetch: globalThis.fetch,
    createImageBitmap: globalThis.createImageBitmap,
    Image: globalThis.Image,
  };
  const inits = [];
  const revoked = [];
  const images = [];
  const createdUrls = [];
  globalThis.fetch = async (url, init) => {
    inits.push({ url: String(url), init });
    return { ok: status >= 200 && status < 300, status, blob: async () => ({ blob: true }) };
  };
  globalThis.createImageBitmap = async () => {
    if (!bitmap) throw new Error('the blob was refused');
    return fakeBitmap(16);
  };
  globalThis.Image = class {
    constructor() {
      this.listeners = new Map();
      this.width = 32;
      this.height = 32;
      images.push(this);
    }

    addEventListener(type, handler) { this.listeners.set(type, handler); }

    removeAttribute() { this.detached = true; }

    decode() {
      return imageDecodes ? Promise.resolve() : Promise.reject(new Error('broken image'));
    }
  };
  const savedCreate = URL.createObjectURL;
  const savedRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => {
    const url = `blob:sheet-${createdUrls.length}`;
    createdUrls.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);

  return {
    inits,
    revoked,
    createdUrls,
    images,
    restore() {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
      URL.createObjectURL = savedCreate;
      URL.revokeObjectURL = savedRevoke;
    },
  };
}

test('the default decoder asks once, without credentials, and says what a refusal was', async (t) => {
  const browser = installBrowser();
  t.after(browser.restore);

  const drawable = await decodeDrawable('https://storage.example/a.webp');

  assert.equal(drawable.width, 16);
  assert.equal(browser.inits.length, 1, 'one request feeds both decode paths');
  assert.equal(browser.inits[0].init.mode, 'cors', 'a non-CORS fetch taints the canvas the sheet is drawn on');
  assert.equal(browser.inits[0].init.credentials, 'omit');
});

test('a status that is not a sheet is an error naming the asset and the code', async (t) => {
  const browser = installBrowser({ status: 404 });
  t.after(browser.restore);

  await assert.rejects(
    decodeDrawable('https://storage.example/a.webp'),
    /asset https:\/\/storage\.example\/a\.webp answered 404/,
  );
});

test('a browser that refuses the blob decodes the same bytes through an Image', async (t) => {
  const browser = installBrowser({ bitmap: false });
  t.after(browser.restore);

  const drawable = await decodeDrawable('https://storage.example/a.webp');

  assert.equal(drawable, browser.images[0], 'the fallback returns something drawImage accepts');
  assert.equal(browser.inits.length, 1, 'the fallback must not cost a second download');
  assert.deepEqual(browser.revoked, browser.createdUrls, 'a blob URL nobody revokes is held for the life of the page');
});

test('when both decode paths fail, the message carries the first refusal', async (t) => {
  const browser = installBrowser({ bitmap: false, imageDecodes: false });
  t.after(browser.restore);

  await assert.rejects(
    decodeDrawable('https://storage.example/a.webp'),
    /createImageBitmap refused it: the blob was refused/,
  );
  assert.deepEqual(browser.revoked, browser.createdUrls);
});

test('destroying the player mid-decode stops the image and revokes its blob', async (t) => {
  const browser = installBrowser({ bitmap: false, imageDecodes: false });
  t.after(browser.restore);
  const controller = new AbortController();
  globalThis.Image = class extends globalThis.Image {
    decode() { return new Promise(() => {}); }
  };

  const decoding = decodeDrawable('https://storage.example/a.webp', { signal: controller.signal });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();

  await assert.rejects(decoding, (error) => error.name === 'AbortError');
  assert.deepEqual(browser.revoked, browser.createdUrls);
  assert.equal(browser.images.at(-1).detached, true, 'the browser kept decoding a sheet for a dead player');
});

test('a device that says it has little memory is given half the budget', () => {
  assert.equal(defaultBudgetBytes({ deviceMemory: 2 }), SMALL_DEVICE_BUDGET_BYTES);
  assert.equal(defaultBudgetBytes({ deviceMemory: 3 }), SMALL_DEVICE_BUDGET_BYTES);
  assert.equal(defaultBudgetBytes({ deviceMemory: 8 }), DEFAULT_BUDGET_BYTES);
  assert.equal(defaultBudgetBytes({}), DEFAULT_BUDGET_BYTES, 'a browser that will not say is not a small one');
  assert.equal(defaultBudgetBytes(undefined), DEFAULT_BUDGET_BYTES);
});
