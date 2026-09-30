import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchAssetBlob, onAssetProgress, withAssetDeadline } from '../browser/v0/app/assets/asset-request.mjs';

const turn = () => new Promise(setImmediate);

/** A 200 whose body the test writes chunk by chunk. */
function trickle() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return {
    response: new Response(body, { headers: { 'content-type': 'image/png' } }),
    send: (text) => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
  };
}

test('a response with headers but a silent body times out and cancels', async (t) => {
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

test('a body that keeps arriving is never cut, however long it takes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stream = trickle();
  const fetch = t.mock.method(globalThis, 'fetch', async () => stream.response);
  const result = fetchAssetBlob('https://test/sheet.png');
  await turn();
  for (let chunk = 0; chunk < 6; chunk += 1) {
    stream.send('x');
    await turn();
    t.mock.timers.tick(10_000);
    await turn();
  }
  stream.end();
  const blob = await result;
  assert.equal(await blob.text(), 'xxxxxx', 'a download sixty seconds long was cut and started again');
  assert.equal(blob.type, 'image/png', 'the stored type was lost');
  assert.equal(fetch.mock.callCount(), 1);
});

test('a body that falls silent is cut after fifteen seconds and asked for once more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const streams = [];
  t.mock.method(globalThis, 'fetch', async () => { const stream = trickle(); streams.push(stream); return stream.response; });
  const result = fetchAssetBlob('https://test/sheet.png');
  const rejected = assert.rejects(result, { name: 'TimeoutError' });
  await turn();
  streams[0].send('x');
  await turn();
  t.mock.timers.tick(14_999);
  await turn();
  assert.equal(streams.length, 1, 'a body still inside its silence was cut');
  t.mock.timers.tick(1);
  await turn(); await turn();
  assert.equal(streams.length, 2, 'one retry');
  t.mock.timers.tick(15_000);
  await rejected;
});

test('every chunk that lands is told to whoever waits on the link', async (t) => {
  const stream = trickle();
  t.mock.method(globalThis, 'fetch', async () => stream.response);
  let heard = 0;
  const unwatch = onAssetProgress(() => { heard += 1; });
  t.after(unwatch);
  const result = fetchAssetBlob('https://test/sheet.png');
  await turn();
  stream.send('a');
  stream.send('b');
  stream.end();
  await result;
  assert.equal(heard, 2);
});
