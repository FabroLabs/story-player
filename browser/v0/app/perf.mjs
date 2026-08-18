/**
 * What playback actually felt like on the machine it ran on.
 *
 * A 50 ms frame is not a number anybody sees in a test: it is a child asking
 * why the fox jumps. This is the only place the player measures itself — how
 * long each animation frame took, how late the event loop was, how many frames
 * the video decoder threw away — and it writes what it finds into the event
 * log, one entry per scene, so a log downloaded from a slow phone says WHERE it
 * was slow instead of "it was slow".
 *
 * `frame()` is fed EVERY animation frame, not every drawn one. The draw loop
 * redraws only when the picture changed and never faster than the tier's
 * cadence, so the interval between two DRAWS is 42 ms on a perfectly healthy
 * machine — measuring that against a 34 ms threshold would demote every device
 * ever made. What is being measured here is whether the browser is keeping up
 * with its own display: one rAF callback per refresh, 17 ms apart when it is,
 * which is what the bucket edges below are shaped around. A caller that draws
 * on its own cadence passes its own `slowFrameMs`.
 *
 * Two things this deliberately is not:
 *
 *   it never draws, loads, or decides what is on screen. The only thing it can
 *   change is the tier, through `onDemote`, and only downwards — a player that
 *   promoted itself back would see-saw between two bad pictures, and the second
 *   one always arrives mid-sentence
 *
 *   it never throws into the loop that calls it, and it never reports a missing
 *   instrument as a zero. A browser with no `long-animation-frame`, a video
 *   with no quality API, a `performance` with no `memory` and one with no
 *   `now()` are all normal; each is recorded as what it is — `observer:
 *   "none"`, a `null`, an absent field — so that "nothing was slow" and
 *   "nothing was measured" cannot be read as each other.
 */

const MEGABYTE = 1024 * 1024;

// A frame that misses 34 ms has missed two of a 60 Hz display's refreshes. One
// in five of them, held for five seconds, is what a person calls "it keeps
// catching" rather than a hiccup they never mention.
export const SLOW_FRAME_MS = 34;
export const SLOW_FRAME_SHARE = 0.2;
export const DEMOTION_WINDOW_MS = 5_000;

// Nothing that is genuinely one frame takes a second: a gap this long is a loop
// that was stopped — a pause, a hidden tab, a story that ended. Counted as what
// it is rather than logged as the worst frame of the scene, because `max` is a
// number the device gate reads.
export const GAP_MS = 1_000;

// The probe asks a timer to come back every quarter second; how late it is, is
// how long the main thread was busy with something that was not this player.
export const LAG_PROBE_MS = 250;

// Upper edges in milliseconds; everything above the last one lands in its own
// bucket. Frozen, because a histogram whose buckets moved between two runs
// cannot be compared with itself — which is the only thing it is for.
export const FRAME_BUCKETS_MS = Object.freeze([17, 25, 34, 50, 100]);

// A tier only ever falls, and only one step at a time.
export const TIER_ORDER = Object.freeze(['high', 'mid', 'low']);

// The two entry types that actually measure a long frame. Anything else the
// observer reports about itself means nothing was measured at all.
const MEASURING_OBSERVERS = Object.freeze(['long-animation-frame', 'longtask']);

export function nextTierDown(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index >= 0 && index < TIER_ORDER.length - 1 ? TIER_ORDER[index + 1] : null;
}

/**
 * The nearest-rank percentile of `values`.
 *
 * Nearest-rank rather than an interpolating definition, because the answer has
 * to be a frame somebody actually waited through: an interpolated 41.3 ms is a
 * frame that never happened, and the number is read as evidence.
 */
export function percentile(values, fraction) {
  if (!values.length) return null;
  // Numeric, not the default lexicographic sort: `[9, 100]` compares as
  // "100" < "9" and would report a 100 ms stall as a 9 ms p95.
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Frame deltas counted into `edges`, labelled by the edge they fell under. */
export function frameHistogram(deltas, edges = FRAME_BUCKETS_MS) {
  const last = edges[edges.length - 1];
  const above = '>' + last;
  const counts = {};
  for (const edge of edges) counts['<=' + edge] = 0;
  counts[above] = 0;
  for (const delta of deltas) {
    const edge = edges.find((candidate) => delta <= candidate);
    counts[edge === undefined ? above : '<=' + edge] += 1;
  }
  return counts;
}

/**
 * The demotion rule: more than `slowShare` of the frames in a full `windowMs`
 * were slower than `slowFrameMs`.
 *
 * The window must be FULL before it can fire. Three bad frames while a scene's
 * sheets decode is every story's opening, and a player that dropped a tier
 * there would spend the whole first scene proving it was right to.
 */
export function createSlowFrameWatch({
  windowMs = DEMOTION_WINDOW_MS,
  slowFrameMs = SLOW_FRAME_MS,
  slowShare = SLOW_FRAME_SHARE,
} = {}) {
  let samples = [];
  return {
    sample(tMs, deltaMs) {
      samples.push({ t: tMs, slow: deltaMs > slowFrameMs });
      while (samples.length > 1 && tMs - samples[0].t > windowMs) samples.shift();
      if (tMs - samples[0].t < windowMs) return false;
      const slow = samples.filter((sample) => sample.slow).length;
      if (slow / samples.length <= slowShare) return false;
      // Cleared rather than kept: the next demotion earns its own five seconds,
      // measured on the tier we just moved to.
      samples = [];
      return true;
    },
    size() {
      return samples.length;
    },
  };
}

/**
 * The recorder the runtime feeds: `frame()` on every animation frame, `scene()`
 * at a scene boundary, `pause()`/`resume()` when the story stops and starts,
 * `watchVideo()` once the plate exists, `destroy()` at the end.
 */
export function createPerfRecorder({
  log,
  tier = 'high',
  scope = globalThis,
  now = () => scope.performance?.now?.(),
  onDemote = () => {},
  signal = null,
  slowFrameMs = SLOW_FRAME_MS,
} = {}) {
  let currentTier = tier;
  let sceneIndex = null;
  let deltas = [];
  let maxDelta = 0;
  let gaps = 0;
  let badTimestamps = 0;
  let lastFrameMs = null;
  let longFrames = 0;
  let longestFrameMs = 0;
  let lagSamples = [];
  let lagDue = null;
  let paused = false;
  let video = null;
  let videoBaseline = null;
  let videoRefused = false;
  let destroyed = false;

  const watch = createSlowFrameWatch({ slowFrameMs });
  const observer = observeLongFrames(scope, (durationMs) => {
    // An entry with no duration is not a measurement; counting it would report
    // "two long frames, the longest of them 0 ms".
    if (!Number.isFinite(durationMs)) return;
    longFrames += 1;
    if (durationMs > longestFrameMs) longestFrameMs = durationMs;
  });
  const measuring = MEASURING_OBSERVERS.includes(observer.kind);
  const lagTimer = startLagProbe();

  // An `AbortSignal` that is already aborted never fires `abort`, and a
  // recorder built after teardown would keep its observer and its interval for
  // the life of the tab. Every other module here checks this first.
  if (signal?.aborted) destroy();
  else signal?.addEventListener('abort', () => destroy(), { once: true });

  return { frame, scene, pause, resume, flush, watchVideo, tier: () => currentTier, destroy };

  function frame(timeMs) {
    if (destroyed) return;
    if (!Number.isFinite(timeMs)) {
      // A caller wired wrong and a frozen player both produce a scene with no
      // frames; counted, they read differently.
      badTimestamps += 1;
      return;
    }
    if (lastFrameMs !== null) {
      const delta = timeMs - lastFrameMs;
      if (delta > GAP_MS) gaps += 1;
      else if (delta > 0) {
        // A timestamp that did not advance is the same frame reported twice (a
        // resumed tab does this); a 0 ms frame would read as a fast machine.
        deltas.push(delta);
        if (delta > maxDelta) maxDelta = delta;
        if (watch.sample(timeMs, delta)) demote();
      }
    }
    lastFrameMs = timeMs;
  }

  function scene(index) {
    if (destroyed) return;
    writeSection('scene');
    sceneIndex = index;
    reset();
    lastFrameMs = null;
  }

  /** The story stopped: no lag is being caused by us, and no frame spans this. */
  function pause() {
    if (destroyed) return;
    paused = true;
    lastFrameMs = null;
  }

  function resume() {
    if (destroyed) return;
    paused = false;
    lastFrameMs = null;
    // Re-based, or the whole pause is reported as one enormous late tick.
    if (lagTimer !== null) lagDue = finiteNow() ?? lagDue;
  }

  function watchVideo(element) {
    video = element;
    videoBaseline = readVideoQuality();
  }

  /**
   * Close the open section and write it. Returns `null` when there is nothing
   * to say — no scene has opened and nothing was measured — or when the
   * recorder is already torn down, which would otherwise write an empty scene.
   */
  function flush(reason = 'scene') {
    if (destroyed) return null;
    return writeSection(reason);
  }

  function writeSection(reason) {
    if (sceneIndex === null && !measuredSomething()) return null;
    const entry = {
      kind: 'perf',
      scene_index: sceneIndex,
      reason,
      tier: currentTier,
      frames: deltas.length,
      slow_frames: deltas.filter((delta) => delta > slowFrameMs).length,
      gaps,
      bad_timestamps: badTimestamps,
      frame_ms: {
        p50: round(percentile(deltas, 0.5)),
        p95: round(percentile(deltas, 0.95)),
        max: deltas.length ? round(maxDelta) : null,
      },
      frame_histogram: frameHistogram(deltas),
      // Both halves, because p95 alone cannot tell one 900 ms stall from a main
      // thread that is jammed for the whole scene, and those are different bugs.
      lag_p50_ms: round(percentile(lagSamples, 0.5)),
      lag_p95_ms: round(percentile(lagSamples, 0.95)),
      long_frames: measuring ? longFrames : null,
      long_frame_max_ms: measuring ? round(longestFrameMs) : null,
      observer: observer.kind,
    };
    const quality = readVideoQuality();
    if (quality && videoBaseline) {
      entry.video_dropped = sinceBaseline(quality.dropped, videoBaseline.dropped);
      entry.video_total = sinceBaseline(quality.total, videoBaseline.total);
    }
    if (videoRefused) entry.video_quality = 'refused';
    const heap = scope.performance?.memory?.usedJSHeapSize;
    if (Number.isFinite(heap)) entry.heap_mb = Math.round(heap / MEGABYTE);
    log.append(entry);
    videoBaseline = quality;
    reset();
    return entry;
  }

  function destroy() {
    if (destroyed) return;
    // Flipped FIRST: if writing the last section throws, the guards must still
    // be closed, or a queued animation frame lands on a torn-down recorder.
    destroyed = true;
    try {
      writeSection('destroy');
    } catch {
      // The log is where a failure would be reported, and the log is what
      // failed. Releasing the instruments is what is left to get right.
    } finally {
      observer.disconnect();
      if (lagTimer !== null) scope.clearInterval?.(lagTimer);
    }
  }

  function demote() {
    const next = nextTierDown(currentTier);
    if (!next) return;
    const from = currentTier;
    // The evidence belongs to the tier that produced it. Flushed before the
    // switch, or the log blames the tier that was supposed to fix the problem.
    writeSection('demote');
    currentTier = next;
    log.append({ kind: 'perf', scene_index: sceneIndex, reason: 'tier', from, to: next });
    onDemote(next);
  }

  function measuredSomething() {
    return deltas.length > 0
      || lagSamples.length > 0
      || longFrames > 0
      || gaps > 0
      || badTimestamps > 0;
  }

  function reset() {
    deltas = [];
    maxDelta = 0;
    gaps = 0;
    badTimestamps = 0;
    longFrames = 0;
    longestFrameMs = 0;
    lagSamples = [];
  }

  function readVideoQuality() {
    if (!video) return null;
    try {
      const quality = video.getVideoPlaybackQuality?.();
      if (!quality) return null;
      return {
        dropped: quality.droppedVideoFrames ?? 0,
        total: quality.totalVideoFrames ?? 0,
      };
    } catch {
      // A plate that refuses to answer is not a plate that dropped no frames.
      videoRefused = true;
      return null;
    }
  }

  function startLagProbe() {
    if (typeof scope.setInterval !== 'function') return null;
    const start = finiteNow();
    // With no clock, `at - due` is 0 for ever, and the log would say the main
    // thread was never late on a device where nothing timed it.
    if (start === null) return null;
    lagDue = start + LAG_PROBE_MS;
    return scope.setInterval(() => {
      const at = finiteNow();
      if (at === null) return;
      // Nothing is playing, so nothing here is our lateness — and a background
      // tab clamps timers to a second, which would read as a jammed main thread.
      if (!paused) lagSamples.push(Math.max(0, at - lagDue));
      // Re-based on arrival, not accumulated: one 900 ms stall is one late
      // tick, not a debt every later tick reports again.
      lagDue = at + LAG_PROBE_MS;
    }, LAG_PROBE_MS);
  }

  function finiteNow() {
    const at = now();
    return Number.isFinite(at) ? at : null;
  }
}

/**
 * Frames counted since the baseline — or since the media resource restarted.
 *
 * `VideoPlaybackQuality`'s counters belong to the RESOURCE, and the plate swaps
 * its source at every scene. A counter below its baseline is a new video, not a
 * negative number of dropped frames.
 */
function sinceBaseline(current, base) {
  return current >= base ? current - base : current;
}

/**
 * The long-frame observer, and WHICH one — `long-animation-frame` where it
 * exists, `longtask` where it does not, and the reason there is neither.
 *
 * `none` (the browser lists no usable entry type) and `refused` (it listed one
 * and then would not observe it) are different lines in a bug report, so they
 * are different values here rather than one silent zero.
 */
function observeLongFrames(scope, onLongFrame) {
  const Observer = scope.PerformanceObserver;
  const supported = Observer?.supportedEntryTypes ?? [];
  const type = MEASURING_OBSERVERS.find((candidate) => supported.includes(candidate));
  if (!type) return { kind: 'none', disconnect() {} };
  try {
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) onLongFrame(entry.duration);
    });
    // `buffered` so the long frames of the mount itself — the most expensive
    // moment there is — are not the ones that go unmeasured.
    observer.observe({ type, buffered: true });
    return { kind: type, disconnect: () => observer.disconnect() };
  } catch {
    return { kind: 'refused', disconnect() {} };
  }
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}
