/** Host guide presentation only; board geometry and timeline policy stay intact. */
import { SLATE } from '../../policy.mjs';
const round = value => Math.round(value * 100) / 100;

/** Fixed feet and centre preserve the original corner through every clip. */
export function lessonGuideBox(width, height) {
  const size = height * .32;
  return {
    dx: round(width * SLATE.companion.centreXPct / 100 - size / 2),
    dy: round(height * SLATE.companion.feetPct / 100 - size),
    dw: round(size), dh: round(size),
  };
}
