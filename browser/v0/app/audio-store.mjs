/**
 * A performance's narration, downloaded whole and held in memory while the story is open.
 *
 * A line's file used to be opened only when its cue was due, and the wait for it came out of the
 * line's first words. Here every narration file is fetched in playing order from the moment the
 * story begins, up to a minute ahead of the playhead, and a line is played from memory. The
 * opening primes only its first lines, and the look-ahead keeps the rest from competing with the
 * next scenes' pictures. The runtime
 * holds the story at a line whose bytes have not landed (`timeline-player.mjs`), so nothing is cut
 * to catch up.
 *
 * Before `start` nothing is fetched and every line counts as ready, playing from its own URL: a
 * scheduler nobody prepared streams exactly as it did before this existed.
 *
 * A failed fetch is tried again, a second later and then less often, for as long as the story is
 * open; the hold waiting on it is what gives up, and the story goes on without the line. A file
 * the store does not have is not asked for again: the line is `missing`, and nobody waits on it.
 */

import { fetchAssetBlob } from './assets/asset-request.mjs';

const PARALLEL = 2;
// Lines further ahead than this wait their turn: early on, the next scenes' pictures are what a slow
// link is short of, and a line is small and quick once it is near.
const LOOKAHEAD_MS = 60_000;
const RETRY_MS = [1000, 2000, 4000, 8000];

export function createAudioStore(cues, { fetchFile = fetchWhole } = {}) {
  const entries = new Map();
  for (const cue of cues) {
    const source = cue.url ?? cue.media;
    if (typeof source !== 'string' || !source || entries.has(source)) continue;
    entries.set(source, { source, startMs: cue.start_ms, endMs: cue.end_ms ?? cue.start_ms + cue.duration_ms,
      url: null, loading: false, retryAt: 0, failures: 0, gone: false, stalled: false, waiters: [] });
  }
  const timers = new Set();
  // Waiting for every line to have landed or failed once — what the pictures' download waits on.
  let settledWaiters = [];
  let started = false;
  let destroyed = false;
  let playheadMs = 0;
  let loading = 0;
  let priming = null;
  const controller = new AbortController();

  return { prime, start, seek, advance, ready, missing, stalled, url, whenReady, whenAll, destroy };

  /** Download only the opening's required lines until a viewer begins. */
  function prime(opening) {
    if (destroyed) return;
    priming = new Set(opening.map(cue => cue.url ?? cue.media));
    started = true;
    pump();
  }

  /** Begin downloading, from the line at `fromMs` onwards, then the ones before it. */
  function start(fromMs = 0) {
    if (destroyed) return;
    priming = null;
    started = true;
    seek(fromMs);
  }

  /** The playhead moved: the lines ahead of it come first. */
  function seek(tMs) {
    priming = null;
    playheadMs = tMs;
    pump();
  }

  /** The story played on: lines coming into the look-ahead may start downloading. */
  function advance(tMs) {
    playheadMs = tMs;
    if (loading < PARALLEL) pump();
  }

  function ready(cue) {
    const entry = entries.get(cue.url ?? cue.media);
    return !started || !entry || entry.url !== null;
  }

  /** The store does not have this line's file: it will not land, and the story goes on without it. */
  function missing(cue) {
    return entries.get(cue.url ?? cue.media)?.gone === true;
  }

  /**
   * This line's own download went silent for as long as a request is given. It is still asked for
   * again, but the story has waited its wait: nobody holds on it until it lands.
   */
  function stalled(cue) {
    return entries.get(cue.url ?? cue.media)?.stalled === true;
  }

  /** What to play: the bytes in memory once they have landed, the file's own URL until then. */
  function url(cue) {
    const source = cue.url ?? cue.media;
    return entries.get(source)?.url ?? source;
  }

  function whenReady(cue) {
    if (ready(cue) || missing(cue) || stalled(cue)) return Promise.resolve();
    const entry = entries.get(cue.url ?? cue.media);
    return new Promise((resolve) => { entry.waiters.push(resolve); });
  }

  /**
   * Every line here, or tried once and failed: what the pictures' download waits behind. A line
   * that keeps failing is retried on, but must not keep every later scene from being downloaded.
   */
  function whenAll() {
    if (allSettled()) return Promise.resolve();
    return new Promise((resolve) => { settledWaiters.push(resolve); });
  }

  function allSettled() {
    return !started || [...entries.values()].every((entry) => entry.url !== null || entry.failures > 0 || later(entry));
  }

  function destroy() {
    destroyed = true;
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const entry of entries.values()) {
      if (entry.url?.startsWith('blob:')) URL.revokeObjectURL(entry.url);
      entry.waiters = [];
    }
    settledWaiters = [];
  }

  function pump() {
    while (started && !destroyed && loading < PARALLEL) {
      const entry = next();
      if (!entry) return;
      void load(entry);
    }
  }

  /** The first line not here yet that is still ahead of the playhead, else the earliest one left. */
  function next() {
    const now = Date.now();
    let ahead = null;
    let behind = null;
    for (const entry of entries.values()) {
      if (priming && !priming.has(entry.source)) continue;
      if (later(entry)) continue;
      if (entry.url !== null || entry.loading || entry.gone || entry.retryAt > now) continue;
      if (entry.endMs > playheadMs) { if (!ahead || entry.startMs < ahead.startMs) ahead = entry; }
      else if (!behind || entry.startMs < behind.startMs) behind = entry;
    }
    return ahead ?? behind;
  }

  function later(entry) {
    return entry.startMs > playheadMs + LOOKAHEAD_MS;
  }

  async function load(entry) {
    entry.loading = true;
    loading += 1;
    try {
      const landed = await fetchFile(entry.source, { signal: controller.signal });
      if (destroyed) {
        if (landed.startsWith('blob:')) URL.revokeObjectURL(landed);
        return;
      }
      entry.url = landed;
      entry.stalled = false;
      for (const resolve of entry.waiters) resolve();
      entry.waiters = [];
    } catch (error) {
      if (destroyed) return;
      const wait = RETRY_MS[Math.min(entry.failures, RETRY_MS.length - 1)];
      entry.failures += 1;
      entry.gone = error?.retryable === false;
      entry.stalled = error?.name === 'TimeoutError';
      if (entry.gone || entry.stalled) {
        for (const resolve of entry.waiters) resolve();
        entry.waiters = [];
      }
      if (entry.gone) return;
      entry.retryAt = Date.now() + wait;
      const timer = setTimeout(() => { timers.delete(timer); pump(); }, wait);
      timers.add(timer);
    } finally {
      entry.loading = false;
      loading -= 1;
      if (!destroyed && allSettled()) {
        for (const resolve of settledWaiters) resolve();
        settledWaiters = [];
      }
      pump();
    }
  }
}

/**
 * The whole file, as a URL an `<audio>` can play from memory.
 *
 * Where the environment cannot mint an object URL for what came back, the file's own URL stands
 * in: its bytes have arrived, and nothing better can be done with them there.
 */
async function fetchWhole(source, { signal }) {
  const blob = await fetchAssetBlob(source, { signal });
  try {
    return URL.createObjectURL(blob);
  } catch {
    return source;
  }
}
