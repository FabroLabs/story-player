/**
 * A performance's short sound effects, decoded ahead of the story and held to a byte budget.
 *
 * Each effect FILE is fetched and decoded once, in playing order, as far ahead as `EFFECTS_AHEAD_MS`
 * and no further than the budget allows; a story plays the same pop forty times from one buffer.
 * Decoded sound is not its download — a second of it is some 380 KB — so the store is sized in
 * decoded bytes, one number for every device: a phone's webview is the one it has to fit.
 *
 * What has played and is not asked for again inside the reach makes room for what is coming. What
 * still does not fit waits, and an effect that has not been decoded by its cue is simply not
 * played (`performance-media-scheduler.mjs`): the story never waits for an effect.
 *
 * Before `start` nothing is fetched and no effect is the store's, so a scheduler nobody began
 * plays every effect from an element as it did before this existed. An effect longer than
 * `EFFECT_MAX_MS` is never the store's: that is a track, and tracks stream.
 */

import { fetchAssetBlob } from './assets/asset-request.mjs';

export const EFFECTS_BUDGET_BYTES = 8 * 1024 * 1024;
export const EFFECTS_AHEAD_MS = 30_000;
export const EFFECT_MAX_MS = 5_000;

// What a millisecond of sound is taken to weigh before its file has been decoded: 48 kHz, two
// channels, four bytes a sample. Once decoded, a file is counted at what it really is.
const ASSUMED_BYTES_PER_MS = 384;
const BYTES_PER_SAMPLE = 4;
// Two files at a time, as the narration is fetched: one alone could not keep a minute's effects
// ahead of the story on a link that takes a second to answer for each.
const PARALLEL = 2;
const RETRY_MS = [1000, 2000, 4000, 8000];

export function createEffectStore(cues, {
  decode,
  fetchFile = fetchBytes,
  budgetBytes = EFFECTS_BUDGET_BYTES,
  aheadMs = EFFECTS_AHEAD_MS,
  bytesPerMs = ASSUMED_BYTES_PER_MS,
  onWarning = () => {},
} = {}) {
  const entries = new Map();
  for (const cue of cues) {
    const source = sourceOf(cue);
    if (cue.kind !== 'sfx' || !source || !(cue.duration_ms <= EFFECT_MAX_MS)) continue;
    const entry = entries.get(source) ?? {
      source, cue: cue.id, starts: [], buffer: null, bytes: cue.duration_ms * bytesPerMs,
      loading: false, waiting: false, gone: false, failures: 0,
    };
    entry.starts.push(cue.start_ms);
    entries.set(source, entry);
  }
  for (const entry of entries.values()) entry.starts.sort((a, b) => a - b);
  const timers = new Set();
  const controller = new AbortController();
  let started = false;
  let destroyed = false;
  let loading = 0;
  let playheadMs = 0;
  let heldBytes = 0;
  // What the files on their way are taken to weigh: room promised before it is used.
  let comingBytes = 0;

  return {
    start, seek, advance, covers, buffer, destroy,
    get bytes() { return heldBytes; },
    /** How many effect files this story has for the store: none, and nothing here is needed. */
    get size() { return entries.size; },
  };

  /** Begin decoding, from the effects at `fromMs` onwards. */
  function start(fromMs = 0) {
    if (destroyed) return;
    started = true;
    seek(fromMs);
  }

  /** The playhead moved: what it is heading for comes first. */
  function seek(tMs) {
    playheadMs = tMs;
    pump();
  }

  function advance(tMs) {
    playheadMs = tMs;
    pump();
  }

  /** Whether this effect is played from here at all, decoded yet or not. */
  function covers(cue) {
    return started && entries.has(sourceOf(cue));
  }

  function buffer(cue) {
    return entries.get(sourceOf(cue))?.buffer ?? null;
  }

  function destroy() {
    destroyed = true;
    controller.abort();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const entry of entries.values()) entry.buffer = null;
    heldBytes = 0;
  }

  function pump() {
    while (started && !destroyed && loading < PARALLEL) {
      const entry = next();
      if (!entry) return;
      void load(entry);
    }
  }

  /**
   * The file the story needs soonest that is not here, if there is room for it.
   *
   * Nearest first and never around it: a later, smaller file decoded in its place would be the
   * one holding the room when the nearer one's cue came.
   */
  function next() {
    let nearest = null;
    for (const entry of entries.values()) {
      if (entry.buffer || entry.loading || entry.waiting || entry.gone) continue;
      const due = nextUse(entry);
      if (due === null || due > playheadMs + aheadMs) continue;
      if (!nearest || due < nearest.due) nearest = { entry, due };
    }
    if (!nearest) return null;
    makeRoom(nearest.entry.bytes, false);
    return heldBytes + comingBytes + nearest.entry.bytes <= budgetBytes ? nearest.entry : null;
  }

  /**
   * Let go of decoded files until `bytes` more would fit: those with no play left in reach, the
   * one needed furthest off first. With `anything`, the ones in reach as well — a file that
   * turned out bigger than it was taken to be must not push the store over its budget.
   */
  function makeRoom(bytes, anything) {
    const held = [...entries.values()].filter((entry) => entry.buffer)
      .map((entry) => ({ entry, due: nextUse(entry) ?? Number.POSITIVE_INFINITY }))
      .filter(({ due }) => anything || due > playheadMs + aheadMs)
      .sort((a, b) => b.due - a.due);
    for (const { entry } of held) {
      if (heldBytes + comingBytes + bytes <= budgetBytes) return;
      entry.buffer = null;
      heldBytes -= entry.bytes;
    }
  }

  /** The first cue of this file still ahead of the playhead, or `null` when it has played out. */
  function nextUse(entry) {
    return entry.starts.find((startMs) => startMs >= playheadMs) ?? null;
  }

  async function load(entry) {
    const promised = entry.bytes;
    entry.loading = true;
    loading += 1;
    comingBytes += promised;
    try {
      const decoded = await decode(await fetchFile(entry.source, { signal: controller.signal }));
      comingBytes -= promised;
      if (destroyed) return;
      entry.buffer = decoded;
      entry.bytes = decoded.length * decoded.numberOfChannels * BYTES_PER_SAMPLE;
      heldBytes += entry.bytes;
      makeRoom(0, true);
    } catch (error) {
      comingBytes -= promised;
      if (destroyed) return;
      failed(entry, error);
    } finally {
      entry.loading = false;
      loading -= 1;
      pump();
    }
  }

  /**
   * A file the store does not have does not arrive by asking again; any other failure is asked
   * again, a second later and then less often. Either way it is named once, and stops nothing.
   */
  function failed(entry, error) {
    if (entry.failures === 0) {
      onWarning({
        type: 'media', asset: 'sfx', cue: entry.cue,
        message: `Sound effect could not be loaded: ${error?.message ?? error}`,
      });
    }
    entry.failures += 1;
    if (error?.retryable === false) {
      entry.gone = true;
      return;
    }
    entry.waiting = true;
    const timer = setTimeout(() => {
      timers.delete(timer);
      entry.waiting = false;
      pump();
    }, RETRY_MS[Math.min(entry.failures - 1, RETRY_MS.length - 1)]);
    timers.add(timer);
  }
}

function sourceOf(cue) {
  const source = cue.url ?? cue.media;
  return typeof source === 'string' && source ? source : null;
}

function fetchBytes(source, { signal }) {
  return fetchAssetBlob(source, { signal, body: 'arrayBuffer' });
}
