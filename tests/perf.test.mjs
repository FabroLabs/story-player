/**
 * The measurements, and the three ways a measurement lies: a threshold that
 * fires on the opening's first bad frames, a missing instrument reported as a
 * zero, and a number that belonged to some other scene.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GAP_MS,
  LAG_PROBE_MS,
  SLOW_FRAME_MS,
  SLOW_FRAME_SHARE,
  createPerfRecorder,
  createSlowFrameWatch,
  frameHistogram,
  nextTierDown,
  percentile,
} from '../browser/v0/app/perf.mjs';

function fakeLog() {
  const entries = [];
  return { entries, append(entry) { entries.push(entry); return entry; } };
}

function throwingLog() {
  return { entries: [], append() { throw new Error('the panel is gone'); } };
}

function fakeScope({
  entryTypes = ['long-animation-frame'],
  observeThrows = false,
  heapBytes = null,
  observer = true,
  timers: hasTimers = true,
} = {}) {
  const observers = [];
  const timers = [];
  class FakePerformanceObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }

    observe(options) {
      if (observeThrows) throw new Error('refused');
      this.options = options;
      this.connected = true;
    }

    disconnect() {
      this.connected = false;
    }

    emit(...durations) {
      this.emitEntries(...durations.map((duration) => ({ duration })));
    }

    emitEntries(...entries) {
      this.callback({ getEntries: () => entries });
    }
  }
  FakePerformanceObserver.supportedEntryTypes = entryTypes;

  const performanceLike = { now: () => 0 };
  if (heapBytes !== null) performanceLike.memory = { usedJSHeapSize: heapBytes };

  const scope = { observers, timers, performance: performanceLike };
  if (observer) scope.PerformanceObserver = FakePerformanceObserver;
  if (hasTimers) {
    scope.setInterval = (fn, ms) => timers.push({ fn, ms, cleared: false });
    scope.clearInterval = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  }
  return scope;
}

/** A scope whose clock the test moves by hand. */
function clockedScope(options) {
  const scope = fakeScope(options);
  const state = { at: 0 };
  scope.performance.now = () => state.at;
  return [scope, state];
}

/** Frames `deltaMs` apart, from 0 to `untilMs` inclusive. */
function drawFor(perf, untilMs, deltaMs) {
  for (let t = 0; t <= untilMs; t += deltaMs) perf.frame(t);
}

test('a percentile is a frame somebody actually waited through', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20);
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(percentile([], 0.5), null, 'no frames is not a fast frame');
});

test('percentiles compare frame times as numbers, not as words', () => {
  assert.equal(percentile([9, 9, 9, 100], 0.95), 100, 'a lexicographic sort answers 9');
  assert.equal(percentile([100, 9], 0.5), 9);
  const values = [100, 9];
  percentile(values, 0.5);
  assert.deepEqual(values, [100, 9], 'the caller keeps its own order');
});

test('frames land in the bucket they fall under, and the tail has its own', () => {
  assert.deepEqual(frameHistogram([10, 17, 18, 34, 35, 120]), {
    '<=17': 2, '<=25': 1, '<=34': 1, '<=50': 1, '<=100': 0, '>100': 1,
  });
  assert.deepEqual(frameHistogram([75, 100, 101]), {
    '<=17': 0, '<=25': 0, '<=34': 0, '<=50': 0, '<=100': 2, '>100': 1,
  }, 'the last edge is a bucket, not a boundary nothing can reach');
  assert.deepEqual(frameHistogram([]), {
    '<=17': 0, '<=25': 0, '<=34': 0, '<=50': 0, '<=100': 0, '>100': 0,
  });
});

test('the window must be full before the rule can fire', () => {
  const watch = createSlowFrameWatch();
  let fired = false;
  for (let t = 0; t < 5000; t += 100) fired = watch.sample(t, 50) || fired;
  assert.equal(fired, false, 'every frame slow, but only 4.9 s of them');
  assert.ok(watch.size() > 0, 'the samples are being kept, not thrown away');
  assert.equal(watch.sample(5000, 50), true);
});

// Every other test here feeds round numbers, and round numbers hid a rule that
// could only fire when one frame landed EXACTLY `windowMs` after another. Real
// animation frames are 16.7 ms apart and never do.
test('the rule fires on frames that do not land on round milliseconds', () => {
  const watch = createSlowFrameWatch();
  let fired = false;
  for (let t = 0; t < 8_000; t += 66.7) fired = watch.sample(t, 66.7) || fired;
  assert.equal(fired, true, 'five seconds of nothing but slow frames did not demote');
});

test('a stop longer than the window opens a new one, not a full one', () => {
  const watch = createSlowFrameWatch();
  for (let t = 0; t < 3_000; t += 16.7) watch.sample(t, 16.7);
  // A minute later — a pause, a hidden tab, a phone that locked — and the first
  // frame back costs 40 ms, which is what waking up costs. One slow frame is
  // 100% of a window that only looks full because it is holding one sample.
  assert.equal(watch.sample(63_000, 40), false, 'one slow frame after a pause demoted a healthy machine');
  assert.equal(watch.sample(63_040, 40), false);
});

test('a recorder is paused until the story plays, so the gate is not our lag', () => {
  const log = fakeLog();
  const [scope, clock] = clockedScope();
  const perf = createPerfRecorder({ log, scope });
  perf.scene(0);
  // A viewer who left the begin ceremony open for a minute: the browser clamps
  // a background tab's timers to a second, and none of it is this player's
  // lateness.
  clock.at = 60_000;
  scope.timers[0].fn();
  perf.frame(60_000);
  perf.frame(60_016);
  perf.flush();

  assert.equal(log.entries.at(-1).lag_p95_ms, null, 'idling at the gate was reported as a jammed main thread');
});

test('a frame exactly at the threshold has not missed it', () => {
  const watch = createSlowFrameWatch({ windowMs: 400 });
  let fired = false;
  for (const t of [0, 100, 200, 300, 400]) fired = watch.sample(t, SLOW_FRAME_MS) || fired;
  assert.equal(fired, false, 'a device locked at exactly 30 fps keeps its picture');
});

test('the share is one in five, and one in four is more than that', () => {
  assert.equal(SLOW_FRAME_SHARE, 0.2);
  const fires = (windowMs, slowAt, ticks) => {
    const watch = createSlowFrameWatch({ windowMs });
    let fired = false;
    for (const t of ticks) fired = watch.sample(t, slowAt.has(t) ? 50 : 10) || fired;
    return fired;
  };
  assert.equal(
    fires(400, new Set([200]), [0, 100, 200, 300, 400]),
    false,
    '1 of 5 is exactly 20%, and the rule says more than',
  );
  assert.equal(fires(300, new Set([100]), [0, 100, 200, 300]), true, '1 of 4 is 25%');
});

test('a fired window is cleared: the next demotion earns its own five seconds', () => {
  const watch = createSlowFrameWatch({ windowMs: 400 });
  for (const t of [0, 100, 200, 300, 400]) watch.sample(t, 50);
  assert.equal(watch.size(), 0);
  assert.equal(watch.sample(500, 50), false, 'one frame is not a window');
});

test('a tier only falls, and only one step', () => {
  assert.equal(nextTierDown('high'), 'mid');
  assert.equal(nextTierDown('mid'), 'low');
  assert.equal(nextTierDown('low'), null);
  assert.equal(nextTierDown('nonsense'), null);
});

test('a scene reports the frames it drew', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  for (const t of [0, 10, 30, 70, 80]) perf.frame(t);
  perf.scene(1);

  const entry = log.entries.at(-1);
  assert.equal(entry.kind, 'perf');
  assert.equal(entry.scene_index, 0);
  assert.equal(entry.reason, 'scene');
  assert.equal(entry.tier, 'high');
  assert.equal(entry.frames, 4, 'four deltas out of five timestamps');
  assert.equal(entry.slow_frames, 1);
  assert.equal(entry.gaps, 0);
  assert.equal(entry.bad_timestamps, 0);
  assert.deepEqual(entry.frame_ms, { p50: 10, p95: 40, max: 40 });
  assert.deepEqual(entry.frame_histogram, {
    '<=17': 2, '<=25': 1, '<=34': 0, '<=50': 1, '<=100': 0, '>100': 0,
  });
});

test('a section inherits nothing from the one before it', () => {
  const log = fakeLog();
  const [scope, clock] = clockedScope({ entryTypes: ['longtask'] });
  const perf = createPerfRecorder({ log, scope });
  perf.scene(0);
  perf.frame(0);
  perf.frame(200);
  scope.observers[0].emit(300);
  clock.at = 900;
  scope.timers[0].fn();

  perf.frame(GAP_MS + 300);
  perf.frame();

  perf.scene(1);
  perf.frame(1000);
  perf.frame(1010);
  perf.flush();

  const second = log.entries.at(-1);
  assert.equal(second.frame_ms.max, 10, 'the worst frame of scene 0 is not scene 1 problem');
  assert.equal(second.long_frames, 0);
  assert.equal(second.long_frame_max_ms, 0);
  assert.equal(second.lag_p95_ms, null);
  assert.equal(second.gaps, 0);
  assert.equal(second.bad_timestamps, 0);
  assert.equal(second.frames, 1, 'the first timestamp of a scene is a mark, not a frame');
});

test('frame times keep one decimal', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  perf.frame(0);
  perf.frame(16.7);
  perf.flush();
  assert.equal(log.entries.at(-1).frame_ms.max, 16.7);
});

test('a timestamp that did not advance is the same frame reported twice', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  perf.frame(100);
  perf.frame(100);
  perf.frame(100);
  perf.flush();
  assert.equal(log.entries.at(-1).frames, 0, 'a 0 ms frame would read as a fast machine');
});

test('a timestamp that is not a number is counted, not swallowed', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  perf.frame();
  perf.frame(Number.NaN);
  perf.frame('soon');
  perf.flush();
  const entry = log.entries.at(-1);
  assert.equal(entry.bad_timestamps, 3);
  assert.equal(entry.frames, 0, 'which on its own looks exactly like a frozen scene');
});

test('a stopped loop is a gap, not the worst frame of the scene', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  perf.frame(0);
  perf.frame(GAP_MS + 1);
  perf.frame(GAP_MS + 18);
  perf.flush();
  const entry = log.entries.at(-1);
  assert.equal(entry.gaps, 1);
  assert.equal(entry.frames, 1);
  assert.equal(entry.frame_ms.max, 17, 'max is a number the device gate reads');
});

test('a pause does not become a frame, and its silence is not our lag', () => {
  const log = fakeLog();
  const [scope, clock] = clockedScope();
  const perf = createPerfRecorder({ log, scope });
  // A recorder starts paused — it is built at mount, and the ceremony a viewer
  // leaves open is not lateness this player caused. The story playing is what
  // opens the probe.
  perf.resume();
  perf.scene(0);
  perf.frame(0);
  perf.frame(16);
  perf.pause();
  clock.at = 60_000;
  scope.timers[0].fn();
  perf.resume();
  perf.frame(60_000);
  perf.frame(60_016);
  perf.flush();

  const entry = log.entries.at(-1);
  assert.equal(entry.frames, 2);
  assert.equal(entry.gaps, 0, 'the chain was broken, so there is no gap to report either');
  assert.equal(entry.frame_ms.max, 16);
  assert.equal(entry.lag_p95_ms, null, 'nothing was playing, so nothing here was our lateness');
});

test('frames measured before the first scene are evidence, not noise', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  assert.equal(perf.flush(), null, 'nothing measured and no scene open');
  assert.deepEqual(log.entries, []);

  perf.frame(0);
  perf.frame(20);
  const entry = perf.flush();
  assert.equal(entry.scene_index, null);
  assert.equal(entry.frames, 1);
});

test('five seconds of slow frames drops one tier, and files the evidence under it', () => {
  const log = fakeLog();
  const demoted = [];
  const perf = createPerfRecorder({ log, scope: fakeScope(), onDemote: (tier) => demoted.push(tier) });
  perf.scene(0);
  drawFor(perf, 5100, 100);

  assert.deepEqual(demoted, ['mid']);
  assert.equal(perf.tier(), 'mid');

  const evidence = log.entries.find((entry) => entry.reason === 'demote');
  assert.equal(evidence.tier, 'high', 'the frames were drawn on high, not on the tier that fixes it');
  assert.equal(evidence.frames, 51);
  assert.equal(evidence.frame_ms.max, 100);

  const marker = log.entries.find((entry) => entry.reason === 'tier');
  assert.deepEqual(marker, {
    kind: 'perf', scene_index: 0, reason: 'tier', from: 'high', to: 'mid',
  });
});

test('the window is measured on the frame that arrived, not the one before it', () => {
  const demoted = [];
  const perf = createPerfRecorder({
    log: fakeLog(), scope: fakeScope(), onDemote: (tier) => demoted.push(tier),
  });
  perf.scene(0);
  drawFor(perf, 5000, 100);
  assert.deepEqual(demoted, [], 'the first sample is at t=100, so the window closes at 5100');
  perf.frame(5100);
  assert.deepEqual(demoted, ['mid']);
});

test('a demotion during the opening still says what justified it', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  drawFor(perf, 5100, 100);

  const evidence = log.entries.find((entry) => entry.reason === 'demote');
  assert.equal(evidence.scene_index, null);
  assert.equal(evidence.frames, 51, 'a verdict with its evidence deleted is unanswerable');
  assert.equal(log.entries.find((entry) => entry.reason === 'tier').to, 'mid');
});

test('the tier falls one step at a time and stops at low', () => {
  const log = fakeLog();
  const demoted = [];
  const perf = createPerfRecorder({ log, scope: fakeScope(), onDemote: (tier) => demoted.push(tier) });
  perf.scene(0);
  drawFor(perf, 15400, 100);

  assert.deepEqual(demoted, ['mid', 'low']);
  assert.equal(perf.tier(), 'low');
  assert.equal(
    log.entries.filter((entry) => entry.reason === 'tier').length,
    2,
    'the third bad window has nowhere left to go and says nothing',
  );
});

test('a recorder built on a tier starts there and does not fall through the floor', () => {
  const log = fakeLog();
  const demoted = [];
  const perf = createPerfRecorder({
    log, scope: fakeScope(), tier: 'low', onDemote: (tier) => demoted.push(tier),
  });
  perf.scene(0);
  drawFor(perf, 5100, 100);
  perf.flush();

  assert.equal(perf.tier(), 'low');
  assert.deepEqual(demoted, []);
  assert.equal(log.entries.at(-1).tier, 'low');
});

test('a caller that draws on its own cadence brings its own threshold', () => {
  const log = fakeLog();
  const demoted = [];
  const perf = createPerfRecorder({
    log, scope: fakeScope(), slowFrameMs: 120, onDemote: (tier) => demoted.push(tier),
  });
  perf.scene(0);
  drawFor(perf, 6000, 100);
  perf.flush();

  assert.deepEqual(demoted, [], '100 ms is healthy when the loop asked for 120');
  assert.equal(log.entries.at(-1).slow_frames, 0);
});

test('the slow-frame threshold is the one the tier gate is written against', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  perf.frame(0);
  perf.frame(SLOW_FRAME_MS);
  perf.frame(SLOW_FRAME_MS * 2 + 1);
  perf.flush();
  assert.equal(log.entries.at(-1).slow_frames, 1, 'exactly 34 ms has not missed 34 ms');
});

test('which long-frame observer ran is recorded, and it asks for the buffered ones', () => {
  const scope = fakeScope({ entryTypes: ['longtask', 'long-animation-frame'] });
  const perf = createPerfRecorder({ log: fakeLog(), scope });
  assert.deepEqual(
    scope.observers[0].options,
    { type: 'long-animation-frame', buffered: true },
    'the richer type wins, and the mount own long frames are not the ones that go unmeasured',
  );
  perf.destroy();

  const log = fakeLog();
  const legacy = fakeScope({ entryTypes: ['longtask'] });
  const older = createPerfRecorder({ log, scope: legacy });
  older.scene(0);
  legacy.observers[0].emit(120, 60);
  older.flush();
  assert.equal(log.entries.at(-1).observer, 'longtask');
  assert.equal(log.entries.at(-1).long_frames, 2);
  assert.equal(log.entries.at(-1).long_frame_max_ms, 120);
  older.destroy();
});

test('a long-frame entry with no duration is not a measurement', () => {
  const log = fakeLog();
  const scope = fakeScope({ entryTypes: ['longtask'] });
  const perf = createPerfRecorder({ log, scope });
  perf.scene(0);
  scope.observers[0].emitEntries({ duration: undefined }, { duration: 40 });
  perf.flush();
  assert.equal(log.entries.at(-1).long_frames, 1, 'two long frames whose longest was 0 ms is a lie');
  assert.equal(log.entries.at(-1).long_frame_max_ms, 40);
});

test('an observer that never ran reports nothing, not zero', () => {
  for (const [label, scope] of [
    ['none', fakeScope({ entryTypes: [] })],
    ['refused', fakeScope({ observeThrows: true })],
    ['absent', fakeScope({ observer: false })],
  ]) {
    const log = fakeLog();
    const perf = createPerfRecorder({ log, scope });
    perf.scene(0);
    perf.flush();
    const entry = log.entries.at(-1);
    assert.equal(entry.long_frames, null, label);
    assert.equal(entry.long_frame_max_ms, null, label);
  }

  const log = fakeLog();
  const refused = createPerfRecorder({ log, scope: fakeScope({ observeThrows: true }) });
  refused.scene(0);
  refused.flush();
  assert.equal(log.entries.at(-1).observer, 'refused', 'denied and absent are different bug reports');

  const blindLog = fakeLog();
  const blind = createPerfRecorder({ log: blindLog, scope: fakeScope({ entryTypes: [] }) });
  blind.scene(0);
  blind.flush();
  assert.equal(blindLog.entries.at(-1).observer, 'none');
});

test('dropped video frames are counted per section, not since the page loaded', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  const counters = { dropped: 5, total: 100 };
  perf.scene(0);
  perf.watchVideo({
    getVideoPlaybackQuality: () => ({
      droppedVideoFrames: counters.dropped,
      totalVideoFrames: counters.total,
    }),
  });
  counters.dropped = 8;
  counters.total = 220;
  perf.scene(1);

  assert.equal(log.entries.at(-1).video_dropped, 3);
  assert.equal(log.entries.at(-1).video_total, 120);

  counters.dropped = 1;
  counters.total = 40;
  perf.flush();
  assert.equal(
    log.entries.at(-1).video_dropped,
    1,
    'a counter below its baseline is a new resource, not a negative number of dropped frames',
  );
  assert.equal(log.entries.at(-1).video_total, 40);
});

test('a plate with no quality API leaves the fields out rather than reporting zero', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  perf.scene(0);
  perf.watchVideo({});
  perf.flush();
  const entry = log.entries.at(-1);
  assert.equal('video_dropped' in entry, false);
  assert.equal('video_quality' in entry, false);
});

test('a plate that refuses to answer says so, and does not throw into the runtime', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope() });
  const video = { getVideoPlaybackQuality() { throw new Error('detached'); } };
  perf.scene(0);
  assert.doesNotThrow(() => perf.watchVideo(video));
  assert.doesNotThrow(() => perf.scene(1));
  const entry = log.entries.at(-1);
  assert.equal(entry.video_quality, 'refused');
  assert.equal('video_dropped' in entry, false);
});

test('the heap is reported where the browser has one, and omitted where it does not', () => {
  const withHeap = fakeLog();
  const measured = createPerfRecorder({ log: withHeap, scope: fakeScope({ heapBytes: 50 * 1024 * 1024 }) });
  measured.scene(0);
  measured.flush();
  assert.equal(withHeap.entries.at(-1).heap_mb, 50);

  const withoutHeap = fakeLog();
  const blind = createPerfRecorder({ log: withoutHeap, scope: fakeScope() });
  blind.scene(0);
  blind.flush();
  assert.equal('heap_mb' in withoutHeap.entries.at(-1), false);
});

test('the lag probe reports how late a tick was, and re-bases on arrival', () => {
  const log = fakeLog();
  const [scope, clock] = clockedScope();
  const perf = createPerfRecorder({ log, scope });
  const timer = scope.timers[0];
  assert.equal(timer.ms, LAG_PROBE_MS);

  perf.resume();
  perf.scene(0);
  clock.at = 1000;
  timer.fn();
  clock.at = 1250;
  timer.fn();
  clock.at = 1500;
  timer.fn();
  perf.flush();

  const entry = log.entries.at(-1);
  assert.equal(entry.lag_p95_ms, 750, 'one 750 ms stall');
  assert.equal(entry.lag_p50_ms, 0, 'a debt carried forward would report 750 for ever');
});

test('a tick that arrives early is not negative lateness', () => {
  const log = fakeLog();
  const [scope, clock] = clockedScope();
  const perf = createPerfRecorder({ log, scope });
  perf.resume();
  perf.scene(0);
  clock.at = 100;
  scope.timers[0].fn();
  perf.flush();
  assert.equal(log.entries.at(-1).lag_p95_ms, 0);
});

test('a scope with no clock does not report a main thread that was never timed', () => {
  const log = fakeLog();
  const scope = fakeScope();
  delete scope.performance.now;
  const perf = createPerfRecorder({ log, scope });
  assert.equal(scope.timers.length, 0, 'a probe with no clock measures nothing, so it does not run');
  perf.scene(0);
  perf.frame(0);
  perf.frame(20);
  perf.flush();
  assert.equal(log.entries.at(-1).lag_p95_ms, null);
  assert.equal(log.entries.at(-1).frames, 1, 'frames carry their own timestamps and still work');
});

test('a scope with no timers still records frames', () => {
  const log = fakeLog();
  const perf = createPerfRecorder({ log, scope: fakeScope({ timers: false }) });
  perf.scene(0);
  perf.frame(0);
  perf.frame(20);
  perf.destroy();
  assert.equal(log.entries.at(-1).frames, 1);
  assert.equal(log.entries.at(-1).lag_p95_ms, null);
});

test('destroy writes the last section, disconnects and stops measuring', () => {
  const log = fakeLog();
  const scope = fakeScope();
  const perf = createPerfRecorder({ log, scope });
  perf.scene(0);
  perf.frame(0);
  perf.frame(20);
  perf.destroy();

  assert.equal(log.entries.at(-1).reason, 'destroy');
  assert.equal(log.entries.at(-1).frames, 1);
  assert.equal(scope.observers[0].connected, false);
  assert.equal(scope.timers[0].cleared, true);

  const written = log.entries.length;
  perf.scene(1);
  perf.destroy();
  assert.equal(log.entries.length, written, 'a destroyed recorder writes nothing more');
});

test('an animation frame that lands after destroy cannot re-tier a player that is gone', () => {
  const log = fakeLog();
  const demoted = [];
  const perf = createPerfRecorder({ log, scope: fakeScope(), onDemote: (tier) => demoted.push(tier) });
  perf.scene(0);
  perf.destroy();
  const written = log.entries.length;

  drawFor(perf, 6000, 100);
  assert.deepEqual(demoted, []);
  assert.equal(perf.tier(), 'high');
  assert.equal(log.entries.length, written);
});

test('a teardown that cannot be written still releases the instruments', () => {
  const scope = fakeScope();
  const perf = createPerfRecorder({ log: throwingLog(), scope });
  perf.scene(0);
  perf.frame(0);
  perf.frame(20);

  assert.doesNotThrow(() => perf.destroy());
  assert.equal(scope.observers[0].connected, false, 'the observer would count into a dead recorder');
  assert.equal(scope.timers[0].cleared, true, 'the probe would fire for the life of the tab');
});

test('an aborted signal destroys the recorder the same way', () => {
  const log = fakeLog();
  const controller = new AbortController();
  const perf = createPerfRecorder({ log, scope: fakeScope(), signal: controller.signal });
  perf.scene(0);
  perf.frame(0);
  perf.frame(20);
  controller.abort();
  assert.equal(log.entries.at(-1).reason, 'destroy');
  assert.equal(perf.tier(), 'high');
});

test('a signal that is already aborted never gets a recorder running', () => {
  const log = fakeLog();
  const scope = fakeScope();
  const controller = new AbortController();
  controller.abort();
  const perf = createPerfRecorder({ log, scope, signal: controller.signal });

  assert.equal(scope.observers[0].connected, false, 'an aborted signal never fires abort');
  assert.equal(scope.timers[0].cleared, true);
  perf.scene(0);
  perf.frame(0);
  perf.frame(20);
  perf.flush();
  assert.deepEqual(log.entries, []);
});
