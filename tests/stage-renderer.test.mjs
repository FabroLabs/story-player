/**
 * The renderer, tested directly for the first time.
 *
 * `placeCharacter` sets four things from the band a character stands in: their
 * drawn size, the polygon their feet land on, what they are painted in front
 * of, and how the band re-spreads around them. `moveCharacter` set none of
 * them — so `move(rabbit, zone=back_road)` walked the sprite to the far band's
 * x while it kept the near band's size, stand line and paint depth. The whole
 * suite was green, the goldens were green, and the manual had just been
 * rewritten to teach the behaviour that did not exist.
 *
 * These tests exist against the DOM fake in `_dom.mjs` rather than a browser,
 * so they say nothing about how it LOOKS. They say the renderer asked the
 * band the same four questions on a walk that it asks on a placement, which
 * is the part that was missing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { spriteHeightForCm } from '../browser/v0/app/stage/presentation-policy.mjs';
import { floorYAtX } from '../browser/v0/core/geometry.mjs';
import { PLATE_PARALLAX, StageRenderer, plateFraming } from '../browser/v0/app/stage/stage-renderer.mjs';
import { fakeStageElements, installDom, px } from './_dom.mjs';

const BEAR = { height_cm: 110, display_name: 'Bear', clips: { idle: CLIP(), walk: CLIP() } };
const OWL = { height_cm: 40, display_name: 'Owl', clips: { idle: CLIP() } };

function CLIP() {
  // spritesheet is empty on purpose: `#verifySprite` returns immediately
  // for a falsy url, so no Image load is pending and no timer outlives a test.
  return { spritesheet: '', columns: 1, rows: 1, frame_count: 1, fps: 1 };
}

function band(name, depth, scale, top) {
  // a flat horizontal strip: floorYAtX returns `top` anywhere across it
  return {
    name,
    surface: 'floor',
    depth,
    scale,
    description: '',
    polygon: [[0, top], [100, top], [100, top + 5], [0, top + 5]],
  };
}

const PLATE = {
  resolution: [1920, 1080],
  poster: null,
  video: null,
  default_zone: 'front',
  zones: [band('front', 1, 1.0, 90), band('middle', 2, 0.5, 70), band('back', 3, 0.25, 55)],
};

function stageOn(scene = { place: 'dell', plate: PLATE, line: 1 }, options = {}) {
  const dom = installDom();
  const elements = fakeStageElements();
  const warnings = [];
  const stage = new StageRenderer(elements, (detail) => warnings.push(detail), options);
  stage.showScene(scene);
  // resolve the plate's video wait so its 6s timeout does not outlive the test
  elements.video.dispatch('canplay');
  return { stage, elements, warnings, dom };
}

/** The sprite element for the nth character appended to the sprite layer. */
function spriteAt(elements, index) {
  return elements.sprites.children[index];
}

async function walk(stage, element, slug, options) {
  const motion = stage.moveCharacter(slug, {
    clipKey: 'walk', settleClipKey: 'idle', durationSeconds: 0.1, ...options,
  });
  // the listener is registered synchronously, before the first await
  assert.equal(element.listenerCount('transitionend'), 1, 'no transition was awaited');
  element.dispatch('transitionend');
  await motion;
}

test('a character walking into a farther band is drawn at that band size', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const bear = spriteAt(elements, 0);
    assert.equal(px(bear.style.width), spriteHeightForCm(110), 'front band draws full size');

    await walk(stage, bear, 'bear', { x: 40, zoneName: 'middle' });

    assert.equal(
      px(bear.style.width), spriteHeightForCm(110) * 0.5,
      'a walk into the middle band must resize the sprite — it kept the front size',
    );
    assert.equal(px(bear.style.height), spriteHeightForCm(110) * 0.5);
  } finally {
    dom.restore();
  }
});

test('a character walking into a farther band stands on that band, not the one they left', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const bear = spriteAt(elements, 0);
    const before = px(bear.style.top);

    await walk(stage, bear, 'bear', { x: 40, zoneName: 'middle' });

    // feet = top + height. Derived through `floorYAtX` rather than hardcoded:
    // the sampling rule inside a polygon is geometry's business, and a test
    // that restated it would be pinning the rule twice and the walk not at all.
    const middle = PLATE.zones.find((zone) => zone.name === 'middle');
    const feet = px(bear.style.top) + px(bear.style.height);
    assert.equal(
      Math.round(feet), Math.round((floorYAtX(middle.polygon, 40) / 100) * 1080),
      'feet are not on the middle band',
    );
    assert.notEqual(px(bear.style.top), before);
  } finally {
    dom.restore();
  }
});

test('a character walking into a farther band is repainted behind the one they left', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('owl', OWL, 60, 'idle', null, 'middle');
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const owl = spriteAt(elements, 0);
    const bear = spriteAt(elements, 1);
    assert.ok(
      Number(bear.style.zIndex) > Number(owl.style.zIndex),
      'depth 1 should start in front of depth 2',
    );

    await walk(stage, bear, 'bear', { x: 40, zoneName: 'back' });

    assert.ok(
      Number(bear.style.zIndex) < Number(owl.style.zIndex),
      'the bear walked to the back band and is still painted in front of the owl',
    );
  } finally {
    dom.restore();
  }
});

test('a character walking into an occupied band is spread apart from who is already there', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('owl', OWL, 50, 'idle', null, 'middle');
    stage.placeCharacter('bear', BEAR, 90, 'idle', null, 'front');
    const owl = spriteAt(elements, 0);
    const bear = spriteAt(elements, 1);

    // walk the bear onto exactly the owl's x, in the owl's band
    await walk(stage, bear, 'bear', { x: 50, zoneName: 'middle' });

    assert.notEqual(
      px(bear.style.left), px(owl.style.left),
      'two characters in one band were left standing on the same spot',
    );
  } finally {
    dom.restore();
  }
});

test('a walk that names no band leaves the character in the one they were in', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'middle');
    const bear = spriteAt(elements, 0);
    const size = px(bear.style.width);

    await walk(stage, bear, 'bear', { x: 20, zoneName: null });

    assert.equal(px(bear.style.width), size, 'walking sideways is not walking away from the camera');
  } finally {
    dom.restore();
  }
});

test('placing a character still does what it did before', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'back');
    const bear = spriteAt(elements, 0);
    assert.equal(px(bear.style.width), spriteHeightForCm(110) * 0.25);
    assert.equal(bear.attributes['aria-label'], 'Bear');
    assert.equal(bear.style.opacity, '1');
  } finally {
    dom.restore();
  }
});

test('a prop is drawn, at its band size, on its band', () => {
  // The whole object path could be deleted green: `placeObject` → an immediate
  // `return`, or `backgroundSize: cover` instead of `contain`, and 145/145
  // still passed. The word `placeObject` appeared in no .mjs test.
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeObject('lamp', { svg: 'https://assets/lamp.svg', height_cm: 40 }, 30, 'middle');
    const lamp = spriteAt(elements, 0);

    assert.ok(lamp, 'no element was appended for the prop');
    assert.equal(px(lamp.style.width), spriteHeightForCm(40) * 0.5, 'drawn at the front size');
    assert.match(lamp.style.backgroundImage, /lamp\.svg/);
    assert.equal(lamp.style.backgroundSize, 'contain', 'cover would crop the artwork');
  } finally {
    dom.restore();
  }
});

test('a prop takes room in its band, so a character is not drawn on top of it', () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeObject('lamp', { svg: 'https://assets/lamp.svg', height_cm: 40 }, 50, 'front');
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const [lamp, bear] = elements.sprites.children;

    assert.notEqual(px(bear.style.left), px(lamp.style.left));
  } finally {
    dom.restore();
  }
});

test('the walk tweens size and stand line, it does not pop on arrival', () => {
  // The nine-line argument above `motionTransition` is that all four
  // properties must interpolate together to keep the feet on a straight line.
  // Reverting to `left, top` only left every test green, because they assert
  // the size AFTER transitionend, which is identical either way.
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const bear = spriteAt(elements, 0);
    const motion = stage.moveCharacter('bear', {
      x: 40, zoneName: 'middle', clipKey: 'walk', settleClipKey: 'idle', durationSeconds: 0.4,
    });

    for (const property of ['left', 'top', 'width', 'height']) {
      assert.match(
        bear.style.transition, new RegExp(`\\b${property}\\b`),
        `${property} does not tween, so the sprite pops on arrival`,
      );
    }
    bear.dispatch('transitionend');
    return motion;
  } finally {
    dom.restore();
  }
});

/**
 * The camera, tested directly for the first time.
 *
 * Until now it aimed through `transform-origin` and had no test at all — only
 * source-text pins on its two constants. That held while there were two camera
 * commands and both set the origin at a moment the scale made the change
 * invisible. It cannot survive a pan: `transform-origin` is not transitioned, so
 * an op that moves it while magnified snaps the picture mid-move.
 *
 * So the camera is one scale and one offset in a single `transform`, and a plate
 * point `p` lands at `scale * p + offset`. These tests read that mapping back off
 * the fake DOM and assert what it does to actual points rather than pinning the
 * CSS string: the string is one implementation of the mapping, and the mapping is
 * what anybody reproducing this camera has to match.
 */

/** The camera's framing, parsed back out of the one transform it writes. */
function framing(elements) {
  const written = elements.camera.style.transform;
  const parts = written.match(/^translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\(([\d.]+)\)$/);
  assert.ok(parts, `the camera wrote something no client could read: ${written}`);
  return { x: Number(parts[1]), y: Number(parts[2]), scale: Number(parts[3]) };
}

/** Where a plate point ends up on screen, in percent of the stage. */
function lands(frame, point) {
  return { x: (frame.scale * point.x) + frame.x, y: (frame.scale * point.y) + frame.y };
}

/** The stage still fills the frame — nothing behind the camera shows through. */
function covers(frame) {
  const near = lands(frame, { x: 0, y: 0 });
  const far = lands(frame, { x: 100, y: 100 });
  return near.x <= 1e-3 && near.y <= 1e-3 && far.x >= 100 - 1e-3 && far.y >= 100 - 1e-3;
}

const SLOW_MOVE = 'transform 2400ms cubic-bezier(.2,.72,.24,1)';

test('a push holds the point it names exactly where that point already was', () => {
  const { stage, elements, dom } = stageOn();
  try {
    for (const point of [{ x: 0, y: 0 }, { x: 20, y: 80 }, { x: 61.505, y: 94.056 }, { x: 100, y: 100 }]) {
      stage.pushIn(point, 'slow');
      const frame = framing(elements);
      assert.equal(frame.scale, 1.55, 'a push is the pinned push scale');
      const landed = lands(frame, point);
      assert.ok(
        Math.abs(landed.x - point.x) < 1e-3 && Math.abs(landed.y - point.y) < 1e-3,
        `push about ${JSON.stringify(point)} slid it to ${JSON.stringify(landed)}`,
      );
      assert.ok(covers(frame), 'a push uncovered the stage');
    }
    assert.equal(elements.camera.style.transition, SLOW_MOVE);
  } finally {
    dom.restore();
  }
});

test('omitting the speed is slow on every camera command, not medium', () => {
  // The bundle carries `speed: null` for an unnamed speed and the player is
  // where that becomes a number. It resolved to `medium` for as long as the
  // camera had two commands; a bedtime camera's resting pace is the slow one.
  const { stage, elements, dom } = stageOn();
  try {
    stage.pushIn({ x: 50, y: 90 });
    assert.equal(elements.camera.style.transition, SLOW_MOVE);
    stage.pullOut();
    assert.equal(elements.camera.style.transition, SLOW_MOVE);
    stage.panTo(20);
    assert.equal(elements.camera.style.transition, SLOW_MOVE);
  } finally {
    dom.restore();
  }
});

test('a pull out and a scene reset both land on the one framing 1x allows', () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.pushIn({ x: 20, y: 80 }, 'medium');
    stage.pullOut('medium');
    assert.deepEqual(framing(elements), { x: 0, y: 0, scale: 1 });
    assert.equal(elements.camera.style.transition, 'transform 1400ms cubic-bezier(.2,.72,.24,1)');

    stage.pushIn({ x: 20, y: 80 }, 'slow');
    stage.resetCamera();
    assert.deepEqual(framing(elements), { x: 0, y: 0, scale: 1 });
    assert.equal(elements.camera.style.transition, 'none', 'a reset is a snap, not a move');
    assert.equal(elements.camera.style.transformOrigin, '0 0', 'the origin must never move again');
  } finally {
    dom.restore();
  }
});

test('a shot is a cut: the size it names, applied with no easing at all', () => {
  const { stage, elements, dom } = stageOn();
  try {
    // the numbers a 25 cm rabbit on the near band resolves to, handed in as the
    // director hands them: a shot's scale is never looked up any more
    stage.setShot('close', { x: 40, y: 90 }, 2.048);
    assert.equal(framing(elements).scale, 2.048);
    assert.equal(elements.camera.style.transition, 'none');

    stage.setShot('medium', { x: 40, y: 90 }, 1.024);
    const medium = framing(elements);
    assert.equal(medium.scale, 1.024);
    assert.equal(elements.camera.style.transition, 'none');
    assert.ok(
      Math.abs(lands(medium, { x: 40, y: 90 }).x - 40) < 1e-3,
      'a shot holds its subject where they stand, the same arithmetic a push uses',
    );

    // a wide frames nobody, so it has no point to hold and opens on everything
    stage.setShot('wide', null, 1);
    assert.deepEqual(framing(elements), { x: 0, y: 0, scale: 1 });
  } finally {
    dom.restore();
  }
});

test('no pan can uncover the stage, from any framing toward any target', () => {
  const { stage, elements, dom } = stageOn();
  try {
    const openers = [
      ['wide', () => stage.setShot('wide', null, 1)],
      ['medium', () => stage.setShot('medium', { x: 50, y: 90 }, 1.71)],
      ['close', () => stage.pushIn({ x: 50, y: 90 }, 'slow')],
    ];
    // two of the targets are off-plate on purpose: a travel anchor is -8 or 108
    for (const [name, open] of openers) {
      for (const target of [0, 50, 100, -8, 108]) {
        open();
        stage.panTo(target, 'slow');
        assert.ok(covers(framing(elements)), `pan from ${name} to x ${target} uncovered the stage`);
      }
    }
  } finally {
    dom.restore();
  }
});

test('a pan at 1x has to magnify before it can move, and reaches further inside a push', () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.setShot('wide', null, 1);
    assert.equal(framing(elements).x, 0, 'there is exactly one framing at 1x');
    stage.panTo(90, 'slow');
    const open = framing(elements);
    assert.equal(open.scale, 1.25, 'a pan lifts to the pinned pan scale floor to buy itself room');
    assert.ok(open.x < 0, 'and then actually moves');
    // a pan is horizontal: lifting the scale keeps the middle of the frame
    // where it was rather than diving at the stand line it was handed
    // 50 − 1.25 × 50: the plate's middle, re-solved against the lifted scale
    assert.equal(open.y, -12.5, 'the height drifted — a pan must not tilt');
    assert.ok(Math.abs(lands(open, { x: 50, y: 50 }).y - 50) < 1e-3, 'the plate centre left the frame centre');

    stage.pushIn({ x: 50, y: 90 }, 'slow');
    const held = framing(elements).y;
    stage.panTo(90, 'slow');
    const pushed = framing(elements);
    assert.equal(pushed.y, held, 'a pan inside a push must not change the height it was framed at');
    assert.equal(pushed.scale, 1.55, 'a pan inside a push keeps the push');
    assert.ok(
      Math.abs(pushed.x) > Math.abs(open.x),
      'the room to move is 100*(scale-1), so a pushed-in pan must travel further',
    );
  } finally {
    dom.restore();
  }
});

test('a shot is applied at the scale it is handed, not at the one in the table', () => {
  // Every other test passed a size and let the table answer, so deleting
  // `scale ??` from `setShot` left both suites green — the browser would have
  // played every close-up at the retired 1.55x while the published timeline said
  // 3.41x, which is precisely the disagreement the resolved scale exists to stop.
  const { stage, elements, dom } = stageOn();
  try {
    stage.resetCamera();
    stage.setShot('close', { x: 50, y: 90 }, 3.4133333333333336);
    // read back off the rendered transform, which is written at 6 places
    assert.equal(framing(elements).scale, 3.413333, 'the handed scale was ignored');
    assert.notEqual(framing(elements).scale, 1.55, 'the table answered instead of the subject');

    // and a `medium` is handed one too — the director resolves all three sizes
    stage.setShot('medium', { x: 50, y: 90 }, 1.7066666666666668);
    assert.equal(framing(elements).scale, 1.706667);

    // the transition is still a cut, whatever the scale
    assert.equal(elements.camera.style.transition, 'none');
  } finally {
    dom.restore();
  }
});

test('a push never pulls back, however close the camera already is', () => {
  // `shot(close, who)` lands wherever that character has to be framed, and an
  // absolute 1.55x after one is a push that visibly RETREATS. The corpus asks for
  // exactly that pair: a close on the rabbit, then a push at the right edge.
  const { stage, elements, dom } = stageOn();
  try {
    stage.resetCamera();
    stage.setShot('close', { x: 56.368, y: 94.056 }, 2.048);
    stage.pushIn({ x: 66.686, y: 94.102 }, 'medium');

    const pushed = framing(elements);
    assert.equal(pushed.scale, 2.048, 'the push undid the close-up it was pushing from');
    // it is still a MOVE, not a no-op: the point it holds changed, so the
    // picture travels even though the closeness stays
    assert.equal(elements.camera.style.transition, 'transform 1400ms cubic-bezier(.2,.72,.24,1)');

    // and from anywhere wider it is the push scale, exactly as before
    stage.resetCamera();
    stage.pushIn({ x: 50, y: 90 }, 'slow');
    assert.equal(framing(elements).scale, 1.55);
  } finally {
    dom.restore();
  }
});

test('the renderer refuses a shot size of its own accord, prototype names included', () => {
  // The second lock: the director refuses an unknown size first, so nothing in a
  // normal run reaches this — which is exactly why it was silent. `SHOT_SCALES`
  // is a plain object, so `'constructor'` resolved to a FUNCTION that `?? wide`
  // never rescued, and the scale went to the transform as NaN.
  const { stage, elements, warnings, dom } = stageOn();
  try {
    stage.resetCamera();
    const home = framing(elements);

    stage.setShot('closeup', { x: 40, y: 90 });
    stage.setShot('constructor', { x: 40, y: 90 });

    assert.deepEqual(framing(elements), home, 'an unknown size moved the camera');
    assert.deepEqual(warnings.map((warning) => [warning.policy, warning.size]), [
      ['camera-shot-size-unknown', 'closeup'],
      ['camera-shot-size-unknown', 'constructor'],
    ]);
  } finally {
    dom.restore();
  }
});

test('a framing that is not a number is refused, so the camera never latches a NaN', async () => {
  // A ride is aimed by the WALK, not by the director's own resolution: `board.move`
  // leaves `x` undefined for a target it cannot place, and `exit_anchor_pct` is raw
  // catalog copied straight through. `translate(NaN%, …)` is a declaration the
  // browser drops WHOLE, so the camera hard-cuts out of its push to a flat 1x —
  // and the old code kept the NaN in `#framing`, so every later pan read it back.
  const { stage, elements, warnings, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const bear = spriteAt(elements, 0);
    stage.resetCamera();
    stage.pushIn({ x: 40, y: 90 }, 'slow');
    const held = framing(elements);
    assert.equal(held.scale, 1.55);

    stage.follow('bear');
    await walk(stage, bear, 'bear', { x: undefined, zoneName: 'front', durationSeconds: 1 });

    assert.deepEqual(framing(elements), held, 'an unaimed ride moved the camera anyway');
    assert.deepEqual(
      warnings.map((warning) => warning.policy),
      ['camera-framing-unusable'],
      'the camera refused a framing and said nothing about it',
    );

    // and the framing it kept is still a real one, so the next pan is not poisoned
    stage.panTo(70, 'medium');
    const after = framing(elements);
    assert.ok(Number.isFinite(after.x) && Number.isFinite(after.scale) && covers(after));
  } finally {
    dom.restore();
  }
});

test('a follow ride pans over the walk it rides, and lets go when its subject leaves', async () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    const bear = spriteAt(elements, 0);
    stage.resetCamera();

    // nobody is being followed yet, so a walk is only a walk
    await walk(stage, bear, 'bear', { x: 30, zoneName: 'front' });
    assert.deepEqual(framing(elements), { x: 0, y: 0, scale: 1 }, 'an unfollowed walk moved the camera');

    stage.follow('bear');
    await walk(stage, bear, 'bear', { x: 80, zoneName: 'front', durationSeconds: 1.5 });
    const riding = framing(elements);
    assert.equal(
      elements.camera.style.transition, 'transform 1500ms cubic-bezier(.2,.72,.24,1)',
      'a ride runs on the clock of the walk it rides, so the two arrive together',
    );
    assert.equal(riding.scale, 1.25, 'a ride is a pan, pan scale floor and all');
    assert.ok(riding.x < 0 && covers(riding));

    // the camera sees them out, and then has nobody left to follow
    const departure = stage.departCharacter('bear', { x: 108, y: 97, clipKey: 'walk', durationSeconds: 0.5 });
    assert.equal(elements.camera.style.transition, 'transform 500ms cubic-bezier(.2,.72,.24,1)');
    bear.dispatch('transitionend');
    await departure;
    const afterExit = framing(elements);

    // NO resetCamera here on purpose: the cut releases the ride too, so calling
    // it would make this pass whether or not the departure ever let go — which
    // is exactly how the first version of this test passed while the release
    // line was deleted. The walk below asks for x 20, which is a DIFFERENT
    // framing from the one the walk-off left behind, so a ride that outlived
    // its subject cannot hide.
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    await walk(stage, spriteAt(elements, 0), 'bear', { x: 20, zoneName: 'front' });
    assert.deepEqual(framing(elements), afterExit, 'the ride outlived its subject');
  } finally {
    dom.restore();
  }
});

test('a scene reset releases the ride as well as the framing', () => {
  const { stage, elements, dom } = stageOn();
  try {
    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    stage.follow('bear');
    stage.resetCamera();
    const motion = stage.moveCharacter('bear', {
      x: 10, zoneName: 'front', clipKey: 'walk', settleClipKey: 'idle', durationSeconds: 1,
    });
    assert.deepEqual(framing(elements), { x: 0, y: 0, scale: 1 }, 'a ride survived the cut');
    spriteAt(elements, 0).dispatch('transitionend');
    return motion;
  } finally {
    dom.restore();
  }
});

/**
 * The far plane, built and then switched off.
 *
 * The plate and the cast are one flat picture: every camera move slides them
 * together, so a push into a forest is a photograph being enlarged. The cure is
 * to let the plate take only a fraction `k` of the camera's move, so the gap
 * between the planes reads as depth — which is what `plateFraming` computes and
 * `PLATE_PARALLAX` sets.
 *
 * It ships at 1: locked. Measured on `golden_push_dusk`, the cast is drawn the
 * same 105.9 px wide at the top of a push at every k — the near plane never
 * changes — while the plate reads 1694 px at 1 and 1153 px at 0.1. The cast is a
 * tenth of the frame, so the plate IS what the eye measures the move against, and
 * weakening it spends the push instead of buying depth. The constant carries the
 * rest of that reasoning, and what a plate would need to earn a smaller number.
 *
 * Which is the whole difficulty for these tests: at k = 1 `plateFraming` is the
 * identity, so anything reached only through the renderer would pass over a
 * deleted body. The algebra is therefore pinned directly and across parallaxes,
 * and stays pinned while the plate is locked. The renderer's own tests then pin
 * what survives being switched off — that the plate is written at all, on one
 * clock, from one corner, and home again on a cut.
 */

const PARALLAXES = [1, 0.72, 0.5, 0.3];

/** The plate's own transform: the difference it carries, not what it comes to. */
function plateLocal(elements) {
  const written = elements.plate.style.transform;
  const parts = written.match(/^translate\((-?[\d.]+)%, (-?[\d.]+)%\) scale\(([\d.]+)\)$/);
  assert.ok(parts, `the plate wrote something no client could read: ${written}`);
  return { x: Number(parts[1]), y: Number(parts[2]), scale: Number(parts[3]) };
}

/** The plate hanging under the camera, as the browser will compose the two. */
function compose(camera, local) {
  return {
    x: (camera.scale * local.x) + camera.x,
    y: (camera.scale * local.y) + camera.y,
    scale: camera.scale * local.scale,
  };
}

/** Every framing the camera can settle on, taken off the renderer rather than typed. */
function everyFraming() {
  const { stage, elements, dom } = stageOn();
  try {
    return [
      ['a wide open', () => stage.resetCamera()],
      ['a push at the near corner', () => stage.pushIn({ x: 0, y: 0 }, 'slow')],
      ['a push at the centre', () => stage.pushIn({ x: 50, y: 90 }, 'slow')],
      ['a push at the far corner', () => stage.pushIn({ x: 100, y: 100 }, 'slow')],
      ['a medium shot', () => stage.setShot('medium', { x: 20, y: 80 }, 1.71)],
      ['a close shot', () => stage.setShot('close', { x: 96, y: 93 }, 3.41)],
      ['a pan off a wide open', () => { stage.resetCamera(); stage.panTo(0, 'slow'); }],
      ['a pan the other way', () => { stage.resetCamera(); stage.panTo(100, 'slow'); }],
      ['a pan inside a push', () => { stage.pushIn({ x: 50, y: 90 }, 'slow'); stage.panTo(5, 'slow'); }],
    ].map(([what, aim]) => {
      aim();
      return { what, near: framing(elements) };
    });
  } finally {
    dom.restore();
  }
}

test('the far plane takes the camera move scaled by the parallax, at every parallax', () => {
  for (const k of PARALLAXES) {
    for (const { what, near } of everyFraming()) {
      const far = compose(near, plateFraming(near, k));
      const expected = { x: k * near.x, y: k * near.y, scale: 1 + (k * (near.scale - 1)) };
      for (const key of ['x', 'y', 'scale']) {
        assert.ok(
          Math.abs(far[key] - expected[key]) < 1e-9,
          `k ${k}, ${what}: the plate's ${key} is ${far[key]}, not the ${k} share ${expected[key]}`,
        );
      }
    }
  }
});

test('a push holds its point on both planes, and separates everything else', () => {
  const point = { x: 30, y: 88 };
  const { stage, elements, dom } = stageOn();
  let near;
  try {
    stage.pushIn(point, 'slow');
    near = framing(elements);
  } finally {
    dom.restore();
  }

  for (const k of PARALLAXES) {
    const far = compose(near, plateFraming(near, k));

    // A character stands ON the plate, so a plate that moved out from under the
    // point a push framed would pull the ground away with the push.
    const ground = lands(far, point);
    assert.ok(
      Math.abs(ground.x - point.x) < 1e-9 && Math.abs(ground.y - point.y) < 1e-9,
      `k ${k}: the push slid its own subject's ground to ${JSON.stringify(ground)}`,
    );

    // Away from that point the planes come apart by (1 - k)(scale - 1) of the
    // distance. That separation is the effect — and at any k below 1 it is also
    // the bill, because it is exactly how far a bystander's feet leave the ground.
    const elsewhere = { x: 90, y: 20 };
    const apart = Math.abs(lands(far, elsewhere).x - lands(near, elsewhere).x);
    const owed = (1 - k) * (near.scale - 1) * Math.abs(elsewhere.x - point.x);
    assert.ok(Math.abs(apart - owed) < 1e-9, `k ${k}: the planes are ${apart}% apart, owed ${owed}%`);
    assert.equal(apart === 0, k === 1, `k ${k}: locked planes and a moving plate are not the same thing`);
  }
});

test('no parallax uncovers the stage, at any framing or anywhere inside a move', () => {
  // Coverage at both ends of a move implies nothing about the middle: the browser
  // tweens the two transforms independently, so what is on screen is their
  // PRODUCT — quadratic in the progress, and a quadratic through two safe points
  // can still dip. It does not dip, but that is a fact about these numbers and
  // not a theorem, so it is asserted rather than argued.
  //
  // "These numbers" is now a smaller set than the camera's, and that is the point:
  // the far plane was derived when the tightest framing in the language was the
  // 1.55x push. A subject-framed close-up reaches 3.41x, and a move between it and
  // a push at the opposite corner DOES dip — measured 45% of the way through at
  // k = 0.3. Nothing ships that way (the parallax is 1, so the plate is never
  // written at all), so this is a limit on switching it on rather than a bug on
  // screen: the far plane has to be re-derived for the wider scale range first,
  // and it is registered in `backlog-camera-visibility.md`. The law is asserted
  // over what the far plane was built for, and the exclusion is named here rather
  // than quietly dropped.
  const CARRIES = 1.55;
  const between = (a, b, t) => ({
    x: a.x + ((b.x - a.x) * t),
    y: a.y + ((b.y - a.y) * t),
    scale: a.scale + ((b.scale - a.scale) * t),
  });

  const all = everyFraming();
  const settled = all.filter(({ near }) => near.scale <= CARRIES);
  assert.deepEqual(
    all.filter(({ near }) => near.scale > CARRIES).map(({ what }) => what),
    ['a medium shot', 'a close shot'],
    'exactly the two subject-framed shots are outside what the far plane was derived for',
  );
  for (const k of PARALLAXES) {
    const states = settled.map(({ what, near }) => ({ what, near, local: plateFraming(near, k) }));
    for (const from of states) {
      for (const to of states) {
        for (let step = 0; step <= 40; step += 1) {
          const t = step / 40;
          const mid = compose(between(from.near, to.near, t), between(from.local, to.local, t));
          assert.ok(
            covers(mid),
            `k ${k}: the far plane uncovered the stage ${Math.round(t * 100)}% from ${from.what} to ${to.what}`,
          );
        }
      }
    }
  }
});

test('the far plane ships off, and off means untouched — not moved by zero', () => {
  // Not a restatement of the constant: it is the constant AND what the renderer
  // does with it. A plate written `scale(1)` on every move is still a plate the
  // compositor has been told to expect a move from, and it would carry that layer
  // for the whole session for nothing. Turning the parallax down turns this red,
  // which is the point — the bill (a spent push, and feet leaving the ground away
  // from the held point) is written where the number is, and gets re-read first.
  assert.equal(PLATE_PARALLAX, 1, 'the plate parallax moved — re-read the constant and this test together');

  const { stage, elements, dom } = stageOn();
  try {
    for (const aim of [
      () => stage.pushIn({ x: 0, y: 0 }, 'slow'),
      () => stage.pushIn({ x: 100, y: 100 }, 'slow'),
      () => stage.setShot('close', { x: 40, y: 90 }, 3.41),
      () => stage.panTo(90, 'slow'),
      () => stage.pullOut('slow'),
      () => stage.resetCamera(),
    ]) {
      aim();
      // every property the renderer set, whatever it was named — a test that
      // listed the three it expects would miss a fourth.
      const written = Object.fromEntries(
        Object.entries(elements.plate.style).filter(([, value]) => typeof value !== 'function'),
      );
      assert.deepEqual(written, {}, 'the switched-off far plane was written to anyway');
      assert.equal(
        elements.plate.classList.contains('is-parallaxed'), false,
        'the compositor was promised a move the plate is never going to make',
      );
    }
  } finally {
    dom.restore();
  }

  // The other half of "untouched" is in CSS, where nothing above can see it: a
  // `will-change` on the unconditional rule hands the plate its own compositor
  // layer for the whole session whatever the renderer does or does not write, and
  // every assertion in this file would stay green over it.
  const css = fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8');
  const [, always] = css.match(/\.plate-layer \{([^}]*)\}/) ?? [];
  assert.ok(always, 'player/styles.css no longer declares a plain .plate-layer rule — re-read it by hand');
  for (const hint of ['will-change', 'transform:']) {
    assert.equal(
      always.includes(hint), false,
      `.plate-layer carries "${hint}" unconditionally, so the layer exists switched off: {${always}}`,
    );
  }
  assert.match(
    css, /\.plate-layer\.is-parallaxed \{[^}]*will-change: transform;[^}]*\}/,
    'the compositor hint lost the condition that made it worth having',
  );
});

test('switching it on wires the plate to the same arithmetic the algebra tests pin', () => {
  // The bridge the pure tests cannot reach: that the renderer feeds `plateFraming`
  // the framing it just wrote and its own parallax. Nothing in the shipped build
  // takes this path — which is exactly why it needs a test that does.
  const parallax = 0.72;
  const { stage, elements, dom } = stageOn(undefined, { parallax });
  try {
    assert.ok(elements.plate.classList.contains('is-parallaxed'), 'an active far plane wants its layer');
    for (const aim of [
      () => stage.pushIn({ x: 20, y: 80 }, 'slow'),
      () => stage.setShot('close', { x: 96, y: 93 }, 3.41),
      () => stage.panTo(90, 'slow'),
    ]) {
      aim();
      const near = framing(elements);
      const far = compose(near, plateLocal(elements));
      const expected = { x: parallax * near.x, y: parallax * near.y, scale: 1 + (parallax * (near.scale - 1)) };
      // The scale is held far tighter than the offsets, because it is WRITTEN far
      // tighter: 6 places against 4. A scale multiplies every coordinate under it,
      // which is the whole reason for the extra places — and a single tolerance
      // loose enough for a 4-place offset (1e-3) is looser than the error the
      // 6 places exist to prevent, so `round(scale, 6)` → `round4(scale)` passed.
      const tolerance = { x: 1e-3, y: 1e-3, scale: 1e-5 };
      for (const key of ['x', 'y', 'scale']) {
        assert.ok(
          Math.abs(far[key] - expected[key]) < tolerance[key],
          `the plate's ${key} is ${far[key]}, not ${expected[key]}`,
        );
      }
    }
  } finally {
    dom.restore();
  }
});

test('both planes move on one clock — an eased move, a cut and a ride alike', async () => {
  const { stage, elements, dom } = stageOn(undefined, { parallax: 0.72 });
  try {
    // Two transitions started apart arrive apart, and a plate that arrives late
    // tears the picture rather than deepening it.
    const together = (what) => assert.equal(
      elements.plate.style.transition, elements.camera.style.transition, `${what}: the planes ran apart`,
    );

    stage.pushIn({ x: 50, y: 90 }, 'slow');
    together('a slow push');
    assert.equal(elements.plate.style.transition, SLOW_MOVE);

    stage.pullOut('medium');
    together('a medium pull out');

    stage.setShot('close', { x: 40, y: 90 }, 3.41);
    together('a shot');
    assert.equal(elements.plate.style.transition, 'none', 'a shot is a cut on both planes');

    stage.placeCharacter('bear', BEAR, 50, 'idle', null, 'front');
    stage.follow('bear');
    await walk(stage, spriteAt(elements, 0), 'bear', { x: 80, zoneName: 'front', durationSeconds: 1.5 });
    together('a follow ride');
    assert.equal(elements.plate.style.transition, 'transform 1500ms cubic-bezier(.2,.72,.24,1)');
  } finally {
    dom.restore();
  }
});

test('a scene reset takes the far plane home as well', () => {
  const { stage, elements, dom } = stageOn(undefined, { parallax: 0.72 });
  try {
    stage.pushIn({ x: 20, y: 80 }, 'slow');
    stage.resetCamera();
    assert.deepEqual(plateLocal(elements), { x: 0, y: 0, scale: 1 }, 'the plate stayed where the push left it');
    assert.equal(elements.plate.style.transition, 'none', 'a reset is a snap, not a move');
    assert.equal(elements.plate.style.transformOrigin, '0 0', 'both planes must measure from the same corner');
  } finally {
    dom.restore();
  }
});
