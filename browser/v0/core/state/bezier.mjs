/**
 * The easing curves, evaluated instead of animated.
 *
 * A DOM stage handed its curves to the browser as CSS and never had to know
 * what they were worth at 1.4 s. `stateAt` is asked exactly that, for an
 * arbitrary t the caller may have seeked to, so the curve has to be a function
 * here — the same cubic Bézier CSS solves, solved the same way: find the
 * parameter whose x is the elapsed fraction, then read that parameter's y.
 *
 * Newton's method converges in a handful of steps on curves this tame; the
 * bisection fallback is for the ones where the slope goes flat, which is where
 * Newton walks off. Both are the standard solver, and neither is a place to be
 * clever: an easing that disagrees with CSS by a percent is a camera that
 * arrives a frame late, forever.
 */

const NEWTON_ITERATIONS = 8;
const NEWTON_MIN_SLOPE = 1e-3;
const SUBDIVISION_PRECISION = 1e-7;
const SUBDIVISION_MAX_ITERATIONS = 12;

export function cubicBezierEasing(x1, y1, x2, y2) {
  const sampleX = polynomial(x1, x2);
  const sampleY = polynomial(y1, y2);
  const slopeX = derivative(x1, x2);

  return (progress) => {
    if (!Number.isFinite(progress) || progress <= 0) return 0;
    if (progress >= 1) return 1;
    return sampleY(solveForX(progress));
  };

  function solveForX(x) {
    let t = x;
    for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
      const slope = slopeX(t);
      if (Math.abs(slope) < NEWTON_MIN_SLOPE) break;
      t -= (sampleX(t) - x) / slope;
    }
    if (t >= 0 && t <= 1 && Math.abs(sampleX(t) - x) < SUBDIVISION_PRECISION) return t;

    let low = 0;
    let high = 1;
    t = x;
    for (let iteration = 0; iteration < SUBDIVISION_MAX_ITERATIONS; iteration += 1) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < SUBDIVISION_PRECISION) return t;
      if (error > 0) high = t; else low = t;
      t = (low + high) / 2;
    }
    return t;
  }
}

// A cubic Bézier from (0,0) to (1,1) collapses to one polynomial per axis.
function polynomial(c1, c2) {
  const a = 1 - (3 * c2) + (3 * c1);
  const b = (3 * c2) - (6 * c1);
  const c = 3 * c1;
  return (t) => (((((a * t) + b) * t) + c) * t);
}

function derivative(c1, c2) {
  const a = 1 - (3 * c2) + (3 * c1);
  const b = (3 * c2) - (6 * c1);
  const c = 3 * c1;
  return (t) => ((((3 * a * t) + (2 * b)) * t) + c);
}

// The camera's own curve. `stage-renderer.mjs` writes the same four numbers as
// the CSS string `cubic-bezier(.2,.72,.24,1)`; the two say the same thing in two
// languages, and the CSS one goes away with the DOM stage.
export const easeCamera = cubicBezierEasing(0.2, 0.72, 0.24, 1);

// CSS `ease-in`, which is what a departure's opacity is transitioned with.
export const easeIn = cubicBezierEasing(0.42, 0, 1, 1);
