/**
 * A performance's narration, downloaded whole and held in memory while the story is open.
 *
 * A line's file used to be opened only when its cue was due, and the wait for it came out of the
 * line's first words. Here every narration file is fetched in playing order from the moment the
 * story is prepared — a few megabytes a story — and a line is played from memory. The runtime
 * holds the story at a line whose bytes have not landed (`timeline-player.mjs`), so nothing is cut
 * to catch up.
 *
 * Before `start` nothing is fetched and every line counts as ready, playing from its own URL: a
 * scheduler nobody prepared streams exactly as it did before this existed.
 *
 * A failed fetch is tried again, a second later and then less often, for as long as the story is
 * open. What gives up is the hold waiting on it, and it says so.
 */

const PARALLEL = 2;
const RETRY_MS = [1000, 2000, 4000, 8000];

export function createAudioStore(cues, { fetchFile = fetchWhole } = {}) {
  const entries = new Map();
  for (const cue of cues) {
    const source = cue.url ?? cue.media;
    if (typeof source !== 'string' || !source || entries.has(source)) continue;
    entries.set(source, { source, startMs: cue.start_ms, endMs: cue.end_ms ?? cue.start_ms + cue.duration_ms,
      url: null, loading: false, retryAt: 0, failures: 0, waiters: [] });
  }
  const timers = new Set();
  // Waiting for every line to have landed or failed once — what the pictures' download waits on.
  let settledWaiters = [];
  let started = false;
  let destroyed = false;
  let playheadMs = 0;
  let loading = 0;

  return { start, seek, ready, url, whenReady, whenAll, destroy };

  /** Begin downloading, from the line at `fromMs` onwards, then the ones before it. */
  function start(fromMs = 0) {
    if (destroyed) return;
    started = true;
    seek(fromMs);
  }

  /** The playhead moved: the lines ahead of it come first. */
  function seek(tMs) {
    playheadMs = tMs;
    pump();
  }

  function ready(cue) {
    const entry = entries.get(cue.url ?? cue.media);
    return !started || !entry || entry.url !== null;
  }

  /** What to play: the bytes in memory once they have landed, the file's own URL until then. */
  function url(cue) {
    const source = cue.url ?? cue.media;
    return entries.get(source)?.url ?? source;
  }

  function whenReady(cue) {
    if (ready(cue)) return Promise.resolve();
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
    return !started || [...entries.values()].every((entry) => entry.url !== null || entry.failures > 0);
  }

  function destroy() {
    destroyed = true;
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
      if (entry.url !== null || entry.loading || entry.retryAt > now) continue;
      if (entry.endMs > playheadMs) { if (!ahead || entry.startMs < ahead.startMs) ahead = entry; }
      else if (!behind || entry.startMs < behind.startMs) behind = entry;
    }
    return ahead ?? behind;
  }

  async function load(entry) {
    entry.loading = true;
    loading += 1;
    try {
      const landed = await fetchFile(entry.source);
      if (destroyed) {
        if (landed.startsWith('blob:')) URL.revokeObjectURL(landed);
        return;
      }
      entry.url = landed;
      for (const resolve of entry.waiters) resolve();
      entry.waiters = [];
    } catch {
      if (destroyed) return;
      const wait = RETRY_MS[Math.min(entry.failures, RETRY_MS.length - 1)];
      entry.failures += 1;
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
async function fetchWhole(source) {
  const response = await fetch(source, { credentials: 'omit', mode: 'cors' });
  if (!response.ok) throw new Error(`audio ${source} answered ${response.status}`);
  const blob = await response.blob();
  try {
    return URL.createObjectURL(blob);
  } catch {
    return source;
  }
}
