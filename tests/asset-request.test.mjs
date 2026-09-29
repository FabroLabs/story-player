import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAssetBlob, withAssetDeadline } from '../browser/v0/app/assets/asset-request.mjs';

test('a response with headers but an unfinished body times out and cancels', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = [];
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    signals.push(signal);
    return { ok: true, blob: () => new Promise(() => {}) };
  });
  const result = fetchAssetBlob('https://test/image.png');
  const rejected = assert.rejects(result, { name: 'TimeoutError' });
  await new Promise(setImmediate);
  t.mock.timers.tick(15_000);
  await new Promise(setImmediate);
  assert.equal(signals.length, 2, 'one retry');
  t.mock.timers.tick(15_000);
  await rejected;
  assert.ok(signals.every(signal => signal.aborted));
});

test('a transient server failure retries once and returns valid bytes', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? new Response('unavailable', { status: 503 }) : new Response('png'));
  assert.equal(await (await fetchAssetBlob('https://test/image.png')).text(), 'png');
  assert.equal(calls, 2);
});

test('a missing object is permanent and receives no automatic retry', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(fetchAssetBlob('https://test/missing.png'), /404/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('navigation cancels an in-progress body without retry', async (t) => {
  const controller = new AbortController();
  let requestSignal;
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => {
    requestSignal = signal;
    return { ok: true, blob: () => new Promise(() => {}) };
  });
  const result = fetchAssetBlob('https://test/image.png', { signal: controller.signal });
  const rejected = assert.rejects(result, { name: 'AbortError' });
  await new Promise(setImmediate);
  controller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
  assert.equal(fetch.mock.callCount(), 1);
});

test('the scene deadline cancels every child even if a decoder ignores cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const work = withAssetDeadline(child => { signal = child; return new Promise(() => {}); });
  const rejected = assert.rejects(work, { name: 'TimeoutError' });
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  await rejected;
  assert.equal(signal.aborted, true);
});
