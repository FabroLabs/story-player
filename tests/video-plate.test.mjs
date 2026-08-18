/**
 * The background plate: one `<video>`, aimed by the camera, honest when it
 * cannot play.
 *
 * Everything here is about what a viewer sees when the video does NOT arrive —
 * a poster that stays, a story that keeps its time, a refusal that is a
 * postponement rather than a failure. The happy path is one assertion; the rest
 * of the file is the four ways a plate lets a story down.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PLATE_READY_TIMEOUT_MS, createVideoPlate } from '../browser/v0/app/stage/video-plate.mjs';
import { fakeStageElements, installDom } from './_dom.mjs';

const SCENE = {
  poster: 'https://storage.example/fairytale-assets/posters/dell.jpg',
  video: 'https://storage.example/fairytale-assets/plates/dell.mp4',
};

function harness(t, { play } = {}) {
  const dom = installDom();
  t.after(dom.restore);
  const timers = new Map();
  let nextTimer = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, milliseconds) => {
    nextTimer += 1;
    timers.set(nextTimer, { callback, milliseconds });
    return nextTimer;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  });

  const elements = fakeStageElements();
  const plays = [];
  if (play) {
    elements.video.play = () => {
      plays.push(plays.length);
      return play(plays.length - 1);
    };
  } else {
    const original = elements.video.play;
    elements.video.play = () => { plays.push(plays.length); return original(); };
  }
  const warnings = [];
  const plate = createVideoPlate(elements, { onWarning: (detail) => warnings.push(detail) });
  t.after(() => plate.destroy());
  return {
    elements,
    plate,
    warnings,
    plays,
    timers,
    fire: () => [...timers.values()].forEach(({ callback }) => callback()),
  };
}

test('a scene sets the poster and the source, and plays as soon as it is asked to', (t) => {
  const { elements, plate, plays } = harness(t);
  plate.play();
  plate.showScene(SCENE);

  assert.match(elements.poster.style.backgroundImage, /dell\.jpg/);
  assert.equal(elements.video.src, SCENE.video);
  assert.equal(elements.video.poster, SCENE.poster);
  // Played on the spot rather than after a readiness event: a muted loop is
  // allowed to start by every autoplay policy there is, and waiting cost every
  // scene opening a round trip.
  assert.equal(plays.length, 1);
  assert.equal(elements.video.paused, false);
});

test('the poster hands over only when the first frame is really on screen', (t) => {
  const { elements, plate } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  assert.equal(elements.video.classList.contains('is-ready'), false);

  // `playing`, not `canplay`: `canplay` means the browser thinks it could
  // start, and crossfading on it shows a black rectangle where the first frame
  // has not been decoded yet.
  elements.video.dispatch('playing');

  assert.equal(elements.video.classList.contains('is-ready'), true);
  assert.equal(elements.poster.classList.contains('is-ready'), true);
});

test('a scene cut takes the last scene’s plate off the screen', (t) => {
  // `.plate-poster.is-ready` is `opacity: 0` and `.plate-video.is-ready` is
  // `opacity: 1`, so a cut that left both standing shows the OLD video, frozen
  // on its last frame, while the new source loads — with the new scene's poster
  // hidden behind it. The poster is the whole fallback this module is built on.
  const { elements, plate } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  elements.video.dispatch('playing');
  assert.equal(elements.video.classList.contains('is-ready'), true);

  plate.showScene({ ...SCENE, video: 'https://storage.example/plates/next.mp4' });

  assert.equal(elements.video.classList.contains('is-ready'), false);
  assert.equal(elements.poster.classList.contains('is-ready'), false);
});

test('a plate that fails leaves the poster on screen and says so once', (t) => {
  const { elements, plate, warnings } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  elements.video.dispatch('playing');
  elements.video.dispatch('error');

  assert.equal(elements.video.classList.contains('is-ready'), false);
  assert.equal(elements.poster.classList.contains('is-ready'), false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].asset, 'plate-video');
  assert.equal(warnings[0].url, SCENE.video);
  assert.match(warnings[0].message, /poster is what the scene shows/);
});

test('a plate nobody has asked to play cannot be late', (t) => {
  // The begin gate and every pause put a scene on the stage with playback not
  // running. A deadline armed by the SCENE rather than by the request reports a
  // perfectly good plate as broken six seconds into a begin screen, and the log
  // stops meaning "a real failure".
  const { plate, warnings, timers, fire } = harness(t);
  plate.showScene(SCENE);
  assert.equal(timers.size, 0);
  fire();
  assert.deepEqual(warnings, []);

  plate.play();
  assert.deepEqual([...timers.values()].map(({ milliseconds }) => milliseconds), [PLATE_READY_TIMEOUT_MS]);
  plate.pause();
  assert.equal(timers.size, 0, 'a paused plate is still being timed');
});

test('a plate that never starts is named, and the next scene cancels that deadline', (t) => {
  const { plate, warnings, timers, fire } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  assert.deepEqual([...timers.values()].map(({ milliseconds }) => milliseconds), [PLATE_READY_TIMEOUT_MS]);

  plate.showScene({ ...SCENE, video: 'https://storage.example/plates/next.mp4' });
  fire();

  // The first scene's deadline belongs to a scene nobody is watching any more;
  // firing it would report the plate that is on screen right now as broken.
  assert.deepEqual(warnings.map(({ url }) => url), ['https://storage.example/plates/next.mp4']);
});

test('a plate that arrives cancels its own deadline', (t) => {
  const { elements, plate, warnings, timers, fire } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  elements.video.dispatch('playing');

  assert.equal(timers.size, 0);
  fire();
  assert.deepEqual(warnings, []);
});

test('the camera is written once per framing, not once per frame', (t) => {
  const { elements, plate } = harness(t);
  const written = [];
  Object.defineProperty(elements.plate.style, 'transform', {
    get: () => written.at(-1),
    set: (value) => written.push(value),
  });

  plate.aim({ scale: 1, x: 0, y: 0 });
  plate.aim({ scale: 1, x: 0, y: 0 });
  plate.aim({ scale: 1.5500001, x: -27.500049, y: -12 });
  plate.aim({ scale: 1.55, x: -27.5, y: -12 });
  plate.aim({ scale: Number.NaN, x: 0, y: 0 });

  // Rounded to the picture, so the last bits of an eased float are not a move.
  // A framing that is not three numbers opens wide — the same answer the canvas
  // above gives the same input, because a cast drawn wide over a ground still
  // pushed in is a plausible-looking picture with the feet off the floor.
  assert.deepEqual(written, [
    'translate(0%, 0%) scale(1)',
    'translate(-27.5%, -12%) scale(1.55)',
    'translate(0%, 0%) scale(1)',
  ]);
  assert.equal(elements.plate.style.transformOrigin, '0 0');
});

test('a blocked autoplay is a postponement: the next touch tries again', (t) => {
  let refuse = true;
  const { elements, plate, warnings, plays, timers, fire } = harness(t, {
    play: () => {
      if (!refuse) return Promise.resolve();
      refuse = false;
      return Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
    },
  });
  plate.play();
  plate.showScene(SCENE);

  return Promise.resolve().then(() => {
    assert.equal(plays.length, 1);
    assert.match(warnings[0].message, /next touch/);
    // and it is not ALSO reported as late six seconds later: one event, one
    // line. The two would contradict each other in the operator's log.
    assert.equal(timers.size, 0);
    fire();
    assert.equal(warnings.length, 1);
    elements.frame.dispatch('pointerdown');
    assert.equal(plays.length, 2, 'the plate did not try again on the gesture it was waiting for');
    // and the retry is disarmed, so a second touch is not a second play
    elements.frame.dispatch('pointerdown');
    assert.equal(plays.length, 2);
  });
});

test('a refusal that is not the autoplay policy is a failure, not a promise', (t) => {
  // "It will start on the next touch" is a promise the player cannot keep for a
  // codec this device cannot decode, and a touch that changes nothing reads as
  // a broken player rather than as a broken file.
  const { elements, plate, warnings, plays } = harness(t, {
    play: () => Promise.reject(Object.assign(new Error('cannot decode'), { name: 'NotSupportedError' })),
  });
  plate.play();
  plate.showScene(SCENE);

  return Promise.resolve().then(() => {
    assert.match(warnings[0].message, /would not start \(NotSupportedError\)/);
    assert.doesNotMatch(warnings[0].message, /next touch/);
    elements.frame.dispatch('pointerdown');
    assert.equal(plays.length, 1, 'a gesture retried a plate that was never refused a gesture');
  });
});

test('pausing stops the plate and leaves it where it is', (t) => {
  const { elements, plate } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  plate.pause();
  assert.equal(elements.video.paused, true);

  // A scene arriving while the story is paused must not start playing: the
  // picture is frozen, and a background that keeps moving under it is the
  // exact desynchronisation this design exists to prevent.
  plate.showScene({ ...SCENE, video: 'https://storage.example/plates/next.mp4' });
  assert.equal(elements.video.paused, true);
});

test('destroy pauses, detaches the source and leaves no listeners behind', (t) => {
  const { elements, plate } = harness(t);
  plate.play();
  plate.showScene(SCENE);
  assert.ok(elements.video.listenerCount('playing') > 0);

  plate.destroy();

  assert.equal(elements.video.paused, true);
  assert.equal(elements.video.src, '');
  assert.equal(elements.video.listenerCount('playing'), 0);
  assert.equal(elements.video.listenerCount('error'), 0);
  // and it is idempotent, the way every other destroy in this player is
  plate.destroy();
});
