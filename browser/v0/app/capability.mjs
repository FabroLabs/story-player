/**
 * What this machine can be asked for, decided once before the first frame.
 *
 * The player draws the same picture everywhere; what changes between a laptop
 * and a four-year-old phone is how much of it can be paid for. This module
 * answers that in one object — a tier and the four numbers the tier implies —
 * so that "is this device weak" is asked in exactly one place instead of being
 * re-guessed by the cache, the rendition picker and the draw loop separately.
 *
 * It decides nothing else. It never draws, never loads, never touches the
 * stage, and the numbers it returns are read by other modules rather than
 * pushed onto them; `perf.mjs` may lower the tier later, and `tierSettings`
 * gives the new numbers without probing the machine a second time.
 *
 * It also never throws. A probe whose whole job is to select the fallback for a
 * browser that cannot draw must not kill the mount when that browser turns out
 * to be hostile in a way it did not predict — the child gets nothing, where the
 * degraded path would have given them the story.
 *
 * The three source numbers it does NOT invent:
 *
 *   `dprCap` and the two byte budgets already exist and are already published
 *   behaviour — the rendition picker chooses tiers against `DPR_CAP`, and the
 *   bitmap cache halves its budget on `deviceMemory <= 3`. They are imported
 *   here, not restated, because two definitions of the same ceiling drift and
 *   the drift is invisible: sheets chosen for one density, drawn at another.
 */

import { DPR_CAP } from './assets/rendition-picker.mjs';
import {
  DEFAULT_BUDGET_BYTES,
  SMALL_DEVICE_BUDGET_BYTES,
  SMALL_DEVICE_MEMORY_GB,
} from './assets/bitmap-cache.mjs';

// The draw loop's ceiling: redraw only when the picture changed, and never
// more than this many times a second.
export const DEFAULT_DRAW_HZ = 24;

// Half of it, exactly — the loop skips every other tick, and the work per
// second halves with it. A camera move is visibly stepped at 12 Hz; a device
// on this tier was already dropping more frames than that, unevenly, which is
// the difference between "slow" and "broken" to the person watching.
export const LOW_TIER_DRAW_HZ = 12;

// A weak device with a 3x screen is asked for a third fewer pixels than the
// ladder's own ceiling would give it. Always below `DPR_CAP`, or the tier for
// the machines that cannot keep up would ask them for more.
export const LOW_TIER_DPR_CAP = 1.5;

// Fewer than three cores means the compositor, the video decoder and this
// player are taking turns.
export const LOW_CORE_COUNT = 2;
export const MID_CORE_COUNT = 4;
export const MID_DEVICE_MEMORY_GB = 4;

/**
 * The numbers a tier stands for.
 *
 * `mid` costs the picture nothing: it halves the decoded-sheet budget and
 * changes nothing else, because memory is what reloads a tab out from under a
 * child, and paying for it with a few extra re-decodes is invisible. Only
 * `low` changes what is drawn.
 */
export function tierSettings(tier) {
  if (tier === 'low') {
    return {
      dprCap: LOW_TIER_DPR_CAP,
      drawHz: LOW_TIER_DRAW_HZ,
      bitmapBudget: SMALL_DEVICE_BUDGET_BYTES,
      shadows: false,
    };
  }
  return {
    dprCap: DPR_CAP,
    drawHz: DEFAULT_DRAW_HZ,
    bitmapBudget: tier === 'mid' ? SMALL_DEVICE_BUDGET_BYTES : DEFAULT_BUDGET_BYTES,
    shadows: true,
  };
}

/**
 * Read the machine and answer with its tier, the numbers, and WHY.
 *
 * `reasons` is not decoration: a log that says a phone was put on `low` is
 * unanswerable without it, and "which signal did that" is the first question
 * anyone asks. Hardware signals come first, then everything the environment
 * refused to answer. An empty list means nothing argued for a lower tier and
 * nothing was unreadable.
 *
 * Device pixel ratio is reported and deliberately does not lower the tier. A
 * 3x screen is usually a good phone, and the cost of its density is already
 * bounded by `dprCap` — demoting for it would put every recent iPhone on the
 * tier built for the machines that cannot keep up.
 *
 * `prefers-reduced-motion` is reported for the runtime to honour where it can
 * (the opening flourish, not the story). It does not lower the tier either:
 * in this player motion is the content, and a still story is not a story.
 */
export function probeCapability(win = globalThis) {
  const hardware = readHardware(win);
  const canvas = probeCanvas2d(win);
  const motion = prefersReducedMotion(win);
  const { memory, cores } = hardware;
  const reasons = [];

  if (memory !== null && memory <= SMALL_DEVICE_MEMORY_GB) reasons.push('device-memory-low');
  if (cores !== null && cores <= LOW_CORE_COUNT) reasons.push('cores-low');
  const low = reasons.length > 0;
  if (!low) {
    if (memory !== null && memory <= MID_DEVICE_MEMORY_GB) reasons.push('device-memory-mid');
    if (cores !== null && cores <= MID_CORE_COUNT) reasons.push('cores-mid');
  }

  const tier = low ? 'low' : reasons.length > 0 ? 'mid' : 'high';
  for (const reason of [hardware.reason, canvas.reason, motion.reason]) {
    if (reason) reasons.push(reason);
  }
  return {
    supported: canvas.supported,
    imageBitmap: readImageBitmap(win),
    reducedMotion: motion.value,
    deviceMemory: memory,
    cores,
    dpr: hardware.dpr,
    tier,
    ...tierSettings(tier),
    reasons,
  };
}

/**
 * What the navigator says about the machine — or that it would not say.
 *
 * The properties are read behind a `try` because a hardened browser can install
 * a throwing getter where a number is expected, and a probe that dies there
 * takes the mount with it.
 */
function readHardware(win) {
  try {
    const navigatorLike = win?.navigator ?? null;
    return {
      memory: finiteOrNull(navigatorLike?.deviceMemory),
      cores: finiteOrNull(navigatorLike?.hardwareConcurrency),
      dpr: positiveOr(win?.devicePixelRatio, 1),
      reason: null,
    };
  } catch {
    return { memory: null, cores: null, dpr: 1, reason: 'hardware-unreadable' };
  }
}

/**
 * Can this browser give us a 2D context at all?
 *
 * A `false` here is not a tier — it is the fallback the whole canvas path has:
 * poster, subtitles and audio. Each refusal is a different value because they
 * read differently in a bug report: a browser with no `canvas` element is
 * ancient, one that refuses the element is locked down, and one that has the
 * element and refuses the context has run out of GPU memory or been told to
 * block fingerprinting.
 */
function probeCanvas2d(win) {
  let element;
  try {
    element = win?.document?.createElement?.('canvas');
  } catch {
    return { supported: false, reason: 'canvas-refused' };
  }
  if (!element) return { supported: false, reason: 'canvas-absent' };
  try {
    return element.getContext('2d')
      ? { supported: true, reason: null }
      : { supported: false, reason: 'canvas-2d-unavailable' };
  } catch {
    return { supported: false, reason: 'canvas-2d-refused' };
  }
}

/**
 * The preference, and whether it could be read at all.
 *
 * "No preference" is the safe reading when the query throws — the story plays
 * as authored — but it is recorded as unreadable rather than reported as a
 * genuine answer, for the same reason the canvas refusals are separated.
 */
function prefersReducedMotion(win) {
  try {
    return {
      value: win?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true,
      reason: null,
    };
  } catch {
    return { value: false, reason: 'reduced-motion-unreadable' };
  }
}

function readImageBitmap(win) {
  try {
    return typeof win?.createImageBitmap === 'function';
  } catch {
    return false;
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function positiveOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
