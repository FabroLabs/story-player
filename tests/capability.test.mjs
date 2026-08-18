/**
 * Which tier a machine lands on, that the numbers a tier stands for are the
 * ones already shipped elsewhere, and that a hostile browser gets an answer
 * rather than an exception.
 *
 * A second definition of the DPR ceiling or of the byte budget does not throw:
 * it picks sheets for one density and draws them at another, and the only
 * symptom is a slightly soft picture nobody can trace back. A probe that throws
 * is louder and worse — it kills the mount that its own `supported: false` was
 * written to rescue.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DRAW_HZ,
  LOW_CORE_COUNT,
  LOW_TIER_DPR_CAP,
  LOW_TIER_DRAW_HZ,
  MID_CORE_COUNT,
  MID_DEVICE_MEMORY_GB,
  probeCapability,
  tierSettings,
} from '../browser/v0/app/capability.mjs';
import { DPR_CAP } from '../browser/v0/app/assets/rendition-picker.mjs';
import {
  DEFAULT_BUDGET_BYTES,
  SMALL_DEVICE_BUDGET_BYTES,
} from '../browser/v0/app/assets/bitmap-cache.mjs';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** A window with a working canvas and whatever hardware the test describes. */
function fakeWindow({
  deviceMemory,
  hardwareConcurrency,
  devicePixelRatio = 1,
  reducedMotion = false,
  canvas = 'ok',
  imageBitmap = true,
  matchMedia = 'ok',
  hardware = 'ok',
} = {}) {
  const navigatorLike = {};
  if (hardware === 'throws') {
    Object.defineProperty(navigatorLike, 'deviceMemory', {
      get() { throw new Error('fingerprinting blocked'); },
    });
  } else {
    if (deviceMemory !== undefined) navigatorLike.deviceMemory = deviceMemory;
    if (hardwareConcurrency !== undefined) navigatorLike.hardwareConcurrency = hardwareConcurrency;
  }

  const win = {
    navigator: navigatorLike,
    devicePixelRatio,
    document: {
      createElement: () => {
        if (canvas === 'element-throws') throw new Error('locked down');
        if (canvas === 'absent') return null;
        return {
          getContext: (kind) => {
            if (canvas === 'throws') throw new Error('blocked');
            if (canvas === 'null') return null;
            return kind === '2d' ? {} : null;
          },
        };
      },
    },
  };
  if (matchMedia === 'throws') win.matchMedia = () => { throw new Error('blocked'); };
  else if (matchMedia === 'ok') {
    win.matchMedia = (query) => ({ matches: reducedMotion && query === REDUCED_MOTION });
  }
  if (imageBitmap) win.createImageBitmap = () => {};
  return win;
}

test('a roomy machine is high, and says nothing argued otherwise', () => {
  const probe = probeCapability(fakeWindow({ deviceMemory: 8, hardwareConcurrency: 8 }));
  assert.equal(probe.tier, 'high');
  assert.deepEqual(probe.reasons, []);
  assert.equal(probe.bitmapBudget, DEFAULT_BUDGET_BYTES);
  assert.equal(probe.shadows, true);
});

test('4 GB or 4 cores is mid; 3 GB or 2 cores is low, and each names its signal', () => {
  assert.equal(probeCapability(fakeWindow({ deviceMemory: 4, hardwareConcurrency: 8 })).tier, 'mid');
  assert.equal(probeCapability(fakeWindow({ deviceMemory: 8, hardwareConcurrency: 4 })).tier, 'mid');
  assert.equal(probeCapability(fakeWindow({ deviceMemory: 3, hardwareConcurrency: 8 })).tier, 'low');
  assert.equal(probeCapability(fakeWindow({ deviceMemory: 8, hardwareConcurrency: 2 })).tier, 'low');

  assert.deepEqual(
    probeCapability(fakeWindow({ deviceMemory: 3, hardwareConcurrency: 8 })).reasons,
    ['device-memory-low'],
  );
  assert.deepEqual(
    probeCapability(fakeWindow({ deviceMemory: 4, hardwareConcurrency: 4 })).reasons,
    ['device-memory-mid', 'cores-mid'],
  );
});

test('the far side of each band is still high — a good laptop is not demoted', () => {
  // Written as literals on purpose: an edge expressed as `MID_CORE_COUNT + 1`
  // moves with the constant it is supposed to be pinning.
  for (const memory of [5, 6, 7]) {
    assert.equal(
      probeCapability(fakeWindow({ deviceMemory: memory, hardwareConcurrency: 8 })).tier,
      'high',
      `${memory} GB`,
    );
  }
  for (const cores of [5, 6, 7]) {
    assert.equal(
      probeCapability(fakeWindow({ deviceMemory: 8, hardwareConcurrency: cores })).tier,
      'high',
      `${cores} cores`,
    );
  }
});

test('three cores is mid, not low', () => {
  const probe = probeCapability(fakeWindow({ deviceMemory: 8, hardwareConcurrency: 3 }));
  assert.equal(probe.tier, 'mid');
  assert.deepEqual(probe.reasons, ['cores-mid']);
});

test('the band edges are the documented ones', () => {
  assert.equal(LOW_CORE_COUNT, 2);
  assert.equal(MID_CORE_COUNT, 4);
  assert.equal(MID_DEVICE_MEMORY_GB, 4);
});

test('a low signal wins outright: the mid signals are not also collected', () => {
  const probe = probeCapability(fakeWindow({ deviceMemory: 2, hardwareConcurrency: 2 }));
  assert.equal(probe.tier, 'low');
  assert.deepEqual(probe.reasons, ['device-memory-low', 'cores-low']);
});

test('a browser that reports neither number is high — absence is not weakness', () => {
  const probe = probeCapability(fakeWindow());
  assert.equal(probe.tier, 'high');
  assert.equal(probe.deviceMemory, null);
  assert.equal(probe.cores, null);
  assert.deepEqual(probe.reasons, []);
});

test('the hardware it read is the hardware it reports', () => {
  const probe = probeCapability(fakeWindow({ deviceMemory: 8, hardwareConcurrency: 4 }));
  assert.equal(probe.deviceMemory, 8);
  assert.equal(probe.cores, 4, 'swapped, every bug report reads the wrong machine');
});

test('the probe publishes the numbers of the tier it just decided', () => {
  for (const [tier, win] of [
    ['low', fakeWindow({ deviceMemory: 2, hardwareConcurrency: 8 })],
    ['mid', fakeWindow({ deviceMemory: 4, hardwareConcurrency: 8 })],
    ['high', fakeWindow({ deviceMemory: 8, hardwareConcurrency: 8 })],
  ]) {
    const { dprCap, drawHz, bitmapBudget, shadows, tier: decided } = probeCapability(win);
    assert.equal(decided, tier);
    assert.deepEqual({ dprCap, drawHz, bitmapBudget, shadows }, tierSettings(tier), tier);
  }
});

test('a dense screen is reported and does not demote: dprCap already bounds it', () => {
  const probe = probeCapability(
    fakeWindow({ deviceMemory: 8, hardwareConcurrency: 8, devicePixelRatio: 3 }),
  );
  assert.equal(probe.dpr, 3);
  assert.equal(probe.tier, 'high');
  assert.equal(probe.dprCap, DPR_CAP);
});

test('reduced motion is reported and does not demote: motion is the content', () => {
  const probe = probeCapability(
    fakeWindow({ deviceMemory: 8, hardwareConcurrency: 8, reducedMotion: true }),
  );
  assert.equal(probe.reducedMotion, true);
  assert.equal(probe.tier, 'high');
  assert.equal(probe.drawHz, DEFAULT_DRAW_HZ);
  assert.equal(
    probeCapability(fakeWindow({ reducedMotion: false })).reducedMotion,
    false,
    'the query asked for is the one that means "reduce"',
  );
});

test('a nonsense devicePixelRatio reads as 1 rather than poisoning the cap', () => {
  assert.equal(probeCapability(fakeWindow({ devicePixelRatio: 0 })).dpr, 1);
  assert.equal(probeCapability(fakeWindow({ devicePixelRatio: -2 })).dpr, 1);
  assert.equal(probeCapability(fakeWindow({ devicePixelRatio: Number.NaN })).dpr, 1);
});

test('the tier numbers are the ones already shipped, not a second copy', () => {
  assert.deepEqual(tierSettings('high'), {
    dprCap: DPR_CAP,
    drawHz: DEFAULT_DRAW_HZ,
    bitmapBudget: DEFAULT_BUDGET_BYTES,
    shadows: true,
  });
  assert.deepEqual(tierSettings('mid'), {
    dprCap: DPR_CAP,
    drawHz: DEFAULT_DRAW_HZ,
    bitmapBudget: SMALL_DEVICE_BUDGET_BYTES,
    shadows: true,
  });
  assert.deepEqual(tierSettings('low'), {
    dprCap: LOW_TIER_DPR_CAP,
    drawHz: LOW_TIER_DRAW_HZ,
    bitmapBudget: SMALL_DEVICE_BUDGET_BYTES,
    shadows: false,
  });
});

test('mid costs the picture nothing: only the byte budget moves', () => {
  const high = tierSettings('high');
  const mid = tierSettings('mid');
  assert.equal(mid.dprCap, high.dprCap);
  assert.equal(mid.drawHz, high.drawHz);
  assert.equal(mid.shadows, high.shadows);
  assert.notEqual(mid.bitmapBudget, high.bitmapBudget);
});

test('the low tier asks for less than the high one, on both axes', () => {
  assert.equal(LOW_TIER_DRAW_HZ * 2, DEFAULT_DRAW_HZ, 'the loop skips every other tick');
  assert.ok(LOW_TIER_DPR_CAP < DPR_CAP, 'a weak phone must not be asked for more pixels');
});

test('an unknown tier reads as high rather than throwing mid-mount', () => {
  assert.deepEqual(tierSettings('nonsense'), tierSettings('high'));
});

test('the canvas verdict is separate from the tier, and names which refusal it was', () => {
  const ok = probeCapability(fakeWindow());
  assert.equal(ok.supported, true);
  assert.deepEqual(ok.reasons, []);

  for (const [canvas, reason] of [
    ['absent', 'canvas-absent'],
    ['null', 'canvas-2d-unavailable'],
    ['throws', 'canvas-2d-refused'],
    ['element-throws', 'canvas-refused'],
  ]) {
    const probe = probeCapability(fakeWindow({ canvas }));
    assert.equal(probe.supported, false, canvas);
    assert.deepEqual(probe.reasons, [reason], canvas);
    assert.equal(probe.tier, 'high', 'a blocked context is a fallback, not a slow machine');
  }
});

test('the context asked for is a 2D one', () => {
  const win = fakeWindow();
  assert.equal(probeCapability(win).supported, true, 'asking for anything else fails everywhere');
});

test('a missing createImageBitmap is reported, not fatal — the cache decodes an Image', () => {
  assert.equal(probeCapability(fakeWindow({ imageBitmap: false })).imageBitmap, false);
  assert.equal(probeCapability(fakeWindow({ imageBitmap: false })).supported, true);
});

test('a preference that could not be read leaves a trace', () => {
  const probe = probeCapability(fakeWindow({ matchMedia: 'throws' }));
  assert.equal(probe.reducedMotion, false, 'the story plays as authored');
  assert.deepEqual(probe.reasons, ['reduced-motion-unreadable']);

  const absent = probeCapability(fakeWindow({ matchMedia: 'absent' }));
  assert.equal(absent.reducedMotion, false);
  assert.deepEqual(absent.reasons, [], 'a browser without matchMedia is not a browser that refused');
});

test('hardware behind a throwing getter answers instead of killing the mount', () => {
  const probe = probeCapability(fakeWindow({ hardware: 'throws' }));
  assert.equal(probe.tier, 'high');
  assert.equal(probe.deviceMemory, null);
  assert.equal(probe.cores, null);
  assert.deepEqual(probe.reasons, ['hardware-unreadable']);
});

test('reasons read hardware first, then whatever the browser would not answer', () => {
  const probe = probeCapability(fakeWindow({
    deviceMemory: 2, hardwareConcurrency: 8, canvas: 'null', matchMedia: 'throws',
  }));
  assert.deepEqual(probe.reasons, [
    'device-memory-low', 'canvas-2d-unavailable', 'reduced-motion-unreadable',
  ]);
});

test('probing a window with nothing on it answers instead of throwing', () => {
  const probe = probeCapability({});
  assert.equal(probe.supported, false);
  assert.equal(probe.tier, 'high');
  assert.equal(probe.dpr, 1);
  assert.equal(probe.imageBitmap, false);
});
