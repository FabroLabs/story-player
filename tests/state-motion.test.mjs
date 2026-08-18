import assert from 'node:assert/strict';
import test from 'node:test';

import { cubicBezierEasing, easeCamera, easeIn } from '../browser/v0/core/state/bezier.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';

/**
 * What happens BETWEEN the events.
 *
 * The corpus pins the instants the timeline names; this pins the milliseconds
 * in between, which are the ones a 24 fps loop spends nearly all of its time
 * in. The story below is hand-built for arithmetic that can be checked by hand:
 * a stage 1000 px wide, one band at stand line 90 drawn at full size and one at
 * 55 drawn at half, and a walk from one to the other.
 */

const PLATE = {
  resolution: [1000, 1000],
  default_zone: 'near',
  poster: 'bucket/poster.png',
  video: 'bucket/plate.mp4',
  zones: [
    { name: 'near', depth: 1, scale: 1, surface: 'floor', polygon: [[0, 80], [100, 80], [100, 100], [0, 100]] },
    { name: 'far', depth: 2, scale: 0.5, surface: 'floor', polygon: [[0, 50], [100, 50], [100, 60], [0, 60]] },
  ],
};

// 20 cm at 10 px/cm is 200 px on the near band and half that on the far one.
const CAST = {
  walker: { height_cm: 20, clips: { idle_right: CLIP(), walk_right: CLIP() } },
  blocker: { height_cm: 20, clips: { idle_right: CLIP() } },
};

function CLIP() {
  return { spritesheet: 'bucket/sheet.png', grid: [4, 1], fps: 8, frames: 4 };
}

function story(events) {
  return {
    bundle: {
      storylang_version: 0,
      title: 'a walk',
      cast: CAST,
      objects: {},
      audio: { sfx: {}, bgm: {} },
      scenes: [{ line: 1, place: 'clearing', plate: PLATE, steps: [] }],
    },
    timeline: {
      timeline_version: 1,
      storylang_version: 0,
      title: 'a walk',
      duration_ms: 4000,
      events: [
        stage(0, 'scene', { place: 'clearing' }),
        step(0, 'put', { subjects: ['walker'], position: 'center', zone: null, beside: null }),
        stage(0, 'place', { slug: 'walker', x: 10, clip: 'idle_right' }),
        ...events,
      ],
    },
  };
}

function stage(tMs, op, payload) {
  return { t_ms: tMs, source: 'stage', op, scene_index: 0, line: null, ...payload };
}

function step(tMs, cmd, detail) {
  return { t_ms: tMs, source: 'step', kind: 'cmd', cmd, scene_index: 0, line: 2, detail };
}

const WALK = story([
  step(1000, 'move', { subjects: ['walker'], target: 'right_edge', zone: 'far' }),
  stage(1000, 'move', { slug: 'walker', x: 90, clip: 'walk_right', duration_ms: 2000 }),
  stage(3000, 'settle', { slug: 'walker', clip: 'idle_right' }),
]);

function walkerAt(tMs, { bundle, timeline } = WALK) {
  return stateAt(timeline, bundle, tMs).actors.find((actor) => actor.slug === 'walker');
}

test('a walk between bands interpolates x, size and stand line together', () => {
  assert.deepEqual(pose(walkerAt(1000)), { x: 10, feetY: 90, heightPx: 200 });
  assert.deepEqual(pose(walkerAt(1500)), { x: 30, feetY: 81.25, heightPx: 175 });
  assert.deepEqual(pose(walkerAt(2000)), { x: 50, feetY: 72.5, heightPx: 150 });
  assert.deepEqual(pose(walkerAt(3000)), { x: 90, feetY: 55, heightPx: 100 });
  // Nothing moves after the settle, and the arrival is the published x exactly.
  assert.deepEqual(pose(walkerAt(3999)), { x: 90, feetY: 55, heightPx: 100 });
  assert.equal(walkerAt(2000).moving, true);
  assert.equal(walkerAt(3000).moving, false);
});

// The cell is anchored bottom-centre, so interpolating `top` and `height`
// linearly — which is what the DOM stage transitioned — leaves the feet on a
// straight line between the two stand lines. Here that line is 90 → 55.
test('the feet track a straight line between the two stand lines', () => {
  for (let tMs = 1000; tMs <= 3000; tMs += 25) {
    const progress = (tMs - 1000) / 2000;
    assert.ok(Math.abs(walkerAt(tMs).feetY - (90 - (35 * progress))) < 1e-9, `feet left the line at ${tMs} ms`);
  }
});

test('a clip runs on its own clock, from the instant it was put on', () => {
  // 8 fps over 4 frames: a quarter of a second per cell, wrapping every half.
  assert.deepEqual(cells(walkerAt(1000)), { frame: 0, cell: [0, 0] });
  assert.deepEqual(cells(walkerAt(1125)), { frame: 1, cell: [1, 0] });
  assert.deepEqual(cells(walkerAt(1500)), { frame: 0, cell: [0, 0] });
  assert.deepEqual(cells(walkerAt(3125)), { frame: 1, cell: [1, 0] });
});

test('a clip the bundle does not carry keeps the one already showing, and says so', () => {
  const missing = story([stage(1000, 'clip', { slug: 'walker', clip: 'astonished_left' })]);
  assert.equal(walkerAt(1500, missing).clip, 'idle_right');
  assert.equal(walkerAt(1500, missing).clipMissing, true);
  assert.equal(walkerAt(999, missing).clipMissing, false);
});

// Crowding runs at placements, and a placement can land in the middle of
// somebody else's walk. The browser answered that by re-aiming the transition
// from wherever the picture had got to, over the full duration again — while
// the walk's own settle stayed where the schedule had always put it, so the
// last stretch is a cut rather than a glide. Ugly, published, and faithfully
// reproduced: a client that smooths it disagrees with the reference.
test('a walker shoved by a placement is re-aimed from where the picture is', () => {
  const shoved = story([
    step(1000, 'move', { subjects: ['walker'], target: 'center', zone: null }),
    stage(1000, 'move', { slug: 'walker', x: 50, clip: 'walk_right', duration_ms: 2000 }),
    step(2000, 'put', { subjects: ['blocker'], position: 45, zone: null, beside: null }),
    stage(2000, 'place', { slug: 'blocker', x: 45, clip: 'idle_right' }),
    stage(3000, 'settle', { slug: 'walker', clip: 'idle_right' }),
  ]);
  // Two 200 px cells on a 1000 px stage are 20% wide each, so 45 and 50 overlap
  // by 15%: the later-placed blocker keeps its x and the walker is pushed to 65.
  assert.equal(walkerAt(1999, shoved).x, 29.98);
  assert.equal(walkerAt(2000, shoved).x, 30);
  assert.equal(walkerAt(2500, shoved).x, 38.75);
  assert.equal(walkerAt(3000, shoved).x, 65);
  assert.equal(stateAt(shoved.timeline, shoved.bundle, 3000).actors.find((a) => a.slug === 'blocker').x, 45);
});

test('a departure fades on its own clock', () => {
  const leaving = story([
    stage(1000, 'depart', { slug: 'walker', x: 108, y: 97, clip: 'walk_right', duration_ms: 1000 }),
  ]);
  assert.equal(walkerAt(1000, leaving).opacity, 1);
  assert.equal(walkerAt(1500, leaving).opacity, 1 - easeIn(0.5));
  assert.equal(walkerAt(2000, leaving).opacity, 0);
  assert.equal(walkerAt(2000, leaving).x, 108);
  // The exit anchor's own y, not the band's stand line.
  assert.equal(walkerAt(2000, leaving).feetY, 97);
});

// The shove re-aims the walk, and must not hand the fade a new clock with it:
// somebody halfway out of the picture does not become solid again because
// another character was placed next to them.
test('and the fade survives being shoved', () => {
  const shoved = story([
    stage(1000, 'depart', { slug: 'walker', x: 40, y: 97, clip: 'walk_right', duration_ms: 2000 }),
    step(2000, 'put', { subjects: ['blocker'], position: 35, zone: null, beside: null }),
    stage(2000, 'place', { slug: 'blocker', x: 35, clip: 'idle_right' }),
  ]);
  assert.equal(walkerAt(2000, shoved).opacity, 1 - easeIn(0.5), 'the fade restarted');
  assert.equal(walkerAt(3000, shoved).opacity, 0, 'the fade did not finish on its own clock');
  // Shoved right by the blocker that arrived on its left, and re-aimed from
  // where the picture was — so the position is still gliding at 3000, when the
  // fade is already over. Two clocks, which is the whole point.
  assert.equal(walkerAt(2000, shoved).x, 25);
  assert.equal(walkerAt(3000, shoved).x, 40);
  assert.equal(walkerAt(4000, shoved).x, 55);
});

test('a pan brings its x to the middle, lifting the scale to reach at all', () => {
  const panned = story([
    stage(1000, 'pan', { x: 20, speed: 'medium', duration_ms: null }),
    stage(3000, 'pan', { x: 80, speed: null, duration_ms: 400 }),
  ]);
  const framing = (tMs) => stateAt(panned.timeline, panned.bundle, tMs).camera;
  // At 1x there is nowhere to move to — the offset interval is zero wide — so a
  // pan lifts to the pan floor first, and 1.25 buys 25% of the stage to cross.
  // x 20 asks for an offset of +25, which the clamp refuses: the near edge
  // would pull in. A pan does not tilt, so the height keeps the plate point
  // already in the middle.
  // A `pan_to` takes its speed word, and medium is 1400 ms.
  assert.deepEqual(framing(2400), { scale: 1.25, x: 0, y: -12.5 });
  assert.notDeepEqual(framing(1700), framing(2400), 'a medium pan was over before its 1400 ms');
  // A follow ride carries the walk's own milliseconds instead, so the camera
  // and the character arrive together.
  assert.deepEqual(framing(3400), { scale: 1.25, x: -25, y: -12.5 });
  assert.notDeepEqual(framing(3399), framing(3400), 'the ride was over before its own 400 ms');
});

test('no framing this player can reach ever uncovers the stage', () => {
  // The coverage law, swept rather than sampled. The DOM renderer's suite swept
  // it and went with the renderer; what is left here otherwise pins one scale
  // and two pan targets, and the two cases that law exists for are neither: a
  // pan out of a subject-framed close-up (scales past 3x are ordinary — a
  // hedgehog frames at 3.41x), and a pan aimed at an off-plate anchor, which is
  // exactly what a follow ride does when its subject walks out at -8 or 108.
  for (let scale = 1; scale <= 3.5; scale += 0.25) {
    for (let x = -8; x <= 108; x += 4) {
      const framed = story([
        stage(1000, 'shot', { size: 'close', x: 50, y: 50, scale }),
        stage(2000, 'pan', { x, speed: 'slow', duration_ms: null }),
      ]);
      const camera = stateAt(framed.timeline, framed.bundle, 4400).camera;
      const near = camera.x;
      const far = camera.x + (100 * camera.scale);
      assert.ok(
        near <= 0 && far >= 100 && camera.y <= 0 && camera.y + (100 * camera.scale) >= 100,
        `a pan to ${x} at ${scale}x showed the stage behind the plate: ${JSON.stringify(camera)}`,
      );
    }
  }
});

// A push composes off the framing the last op ASKED for, not off the picture:
// interrupting a pull-out that is still gliding down from 3x must not leave the
// push magnifying from wherever it happened to have got to.
test('the camera composes off what was asked for, not off what is on screen', () => {
  const interrupted = story([
    stage(1000, 'shot', { size: 'close', x: 50, y: 50, scale: 3 }),
    stage(1100, 'pull_out', { speed: 'slow' }),
    stage(1700, 'push_in', { x: 50, y: 50, speed: 'slow' }),
  ]);
  const framing = (tMs) => stateAt(interrupted.timeline, interrupted.bundle, tMs).camera;
  assert.ok(framing(1700).scale > 1.55, 'the pull-out had not yet reached the push scale');
  assert.equal(framing(4100).scale, 1.55, 'the push magnified from the picture instead of from 1x');
});

test('a camera reset is a cut home, with or without a scene behind it', () => {
  const reset = story([
    stage(1000, 'push_in', { x: 20, y: 90, speed: 'slow' }),
    stage(2000, 'camera_reset', {}),
  ]);
  const framing = (tMs) => stateAt(reset.timeline, reset.bundle, tMs).camera;
  assert.notDeepEqual(framing(1999), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(framing(2000), { scale: 1, x: 0, y: 0 });
});

test('the camera eases from the picture, not from where it was headed', () => {
  const pushed = story([
    stage(1000, 'push_in', { x: 50, y: 50, speed: 'slow' }),
    stage(1600, 'pull_out', { speed: 'slow' }),
  ]);
  const framing = (tMs) => stateAt(pushed.timeline, pushed.bundle, tMs).camera;
  assert.deepEqual(framing(1000), { scale: 1, x: 0, y: 0 });
  // `push` holds the plate centre and magnifies to 1.55: 50 × (1 − 1.55).
  assert.deepEqual(framing(1599), scaled(easeCamera(0.599 / 2.4)));
  // Interrupted at 1600, the pull-out starts from the picture and not from 1.55.
  assert.deepEqual(framing(1600), scaled(easeCamera(0.6 / 2.4)));
  assert.deepEqual(framing(4000), { scale: 1, x: 0, y: 0 });
});

test('a shot is a cut, and an unknown size moves nothing', () => {
  const cut = story([
    stage(1000, 'shot', { size: 'close', x: 20, y: 90, scale: 2 }),
    stage(2000, 'shot', { size: 'enormous', x: 20, y: 90, scale: 9 }),
  ]);
  const framing = (tMs) => stateAt(cut.timeline, cut.bundle, tMs).camera;
  assert.deepEqual(framing(999), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(framing(1000), { scale: 2, x: -20, y: -90 });
  assert.deepEqual(framing(3000), { scale: 2, x: -20, y: -90 });
});

test('the easing solver is the curve, not an approximation of it', () => {
  // The one cubic Bézier whose answer is known everywhere.
  const identity = cubicBezierEasing(1 / 3, 1 / 3, 2 / 3, 2 / 3);
  for (let step_ = 0; step_ <= 100; step_ += 1) {
    assert.ok(Math.abs(identity(step_ / 100) - (step_ / 100)) < 1e-9, `identity bent at ${step_}%`);
  }
  for (const curve of [easeCamera, easeIn]) {
    assert.equal(curve(0), 0);
    assert.equal(curve(1), 1);
    assert.equal(curve(-1), 0);
    assert.equal(curve(2), 1);
    let previous = 0;
    for (let step_ = 1; step_ <= 100; step_ += 1) {
      const value = curve(step_ / 100);
      assert.ok(value >= previous, 'an easing curve went backwards');
      previous = value;
    }
  }
  // The camera's curve spends its speed early: over two thirds of the move is
  // done at half the time. That is what makes a push feel like it settles.
  assert.ok(easeCamera(0.5) > 0.9);
  assert.ok(easeIn(0.5) < 0.4);
});

test('the curves are the four control points the policy names, not a shape like them', () => {
  // Everything above holds for any curve of roughly this shape, and the two
  // published numbers are what the phone client re-implements from the same
  // documented `cubic-bezier(.2,.72,.24,1)`. Retuned quietly, every push, pan
  // and walk-off fade would sit a few percent from where the other client puts
  // it — for the whole middle of every transition, which is where a viewer
  // actually looks.
  //
  // Evaluated here in Bernstein form and bisected on x: different arithmetic
  // from the solver's Newton step, so this agrees with the CONTROL POINTS
  // rather than with the module.
  const curve = (x1, y1, x2, y2) => (progress) => {
    const axis = (c1, c2) => (t) => (3 * ((1 - t) ** 2) * t * c1) + (3 * (1 - t) * (t ** 2) * c2) + (t ** 3);
    const x = axis(x1, x2);
    const y = axis(y1, y2);
    let low = 0;
    let high = 1;
    for (let step_ = 0; step_ < 60; step_ += 1) {
      const middle = (low + high) / 2;
      if (x(middle) < progress) low = middle;
      else high = middle;
    }
    return y((low + high) / 2);
  };
  const camera = curve(0.2, 0.72, 0.24, 1);
  const departure = curve(0.42, 0, 1, 1);

  for (let step_ = 5; step_ <= 95; step_ += 5) {
    const at = step_ / 100;
    assert.ok(Math.abs(easeCamera(at) - camera(at)) < 1e-5, `the camera curve is no longer .2,.72,.24,1 at ${at}`);
    assert.ok(Math.abs(easeIn(at) - departure(at)) < 1e-5, `the departure fade is no longer ease-in at ${at}`);
  }
});

function pose({ x, feetY, heightPx }) {
  return { x, feetY, heightPx };
}

function cells({ frame, cell }) {
  return { frame, cell };
}

// Scale and offset ease SEPARATELY, exactly as a CSS transform interpolates its
// components — the offset is not recomputed from the half-eased scale. Written
// the same way here so the comparison is one arithmetic against itself rather
// than two spellings of 1.55 differing in the last bit of a double.
function scaled(eased) {
  const scale = 1 + ((1.55 - 1) * eased);
  const offset = (50 * (1 - 1.55)) * eased;
  return { scale, x: offset, y: offset };
}
