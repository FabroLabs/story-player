import assert from 'node:assert/strict';
import test from 'node:test';

import { ActorRegistry } from '../browser/v0/app/stage/actor-registry.mjs';
import { waitForActorAction } from '../browser/v0/app/stage/action-wait.mjs';
import {
  CLOSE_SCALE_CEILING,
  SPRITE_SOURCE_PX,
  SHOT_SUBJECT_PX,
  subjectFramedScale,
  drawnSpriteHeightPx,
  spriteHeightForCm,
} from '../browser/v0/app/stage/presentation-policy.mjs';
import { SpriteAssetTracker } from '../browser/v0/app/stage/sprite-assets.mjs';

test('invalidates a pending move when a later clip replacement supersedes it', () => {
  const registry = new ActorRegistry();
  const ruby = { name: 'ruby' };
  registry.attach('ruby', ruby);
  const move = registry.begin('ruby');

  registry.supersede('ruby');

  assert.equal(registry.isCurrent(move), false);
});

test('cannot remove a replacement actor when an old-scene departure settles late', () => {
  const registry = new ActorRegistry();
  const oldRuby = { scene: 1 };
  registry.attach('ruby', oldRuby);
  const departure = registry.begin('ruby');
  registry.clear();

  const newRuby = { scene: 2 };
  registry.attach('ruby', newRuby);

  assert.equal(registry.remove(departure), false);
  assert.equal(registry.get('ruby'), newRuby);
});

test('superseding a motion settles its wait without a later timeout warning', async () => {
  const registry = new ActorRegistry();
  registry.attach('ruby', {});
  const move = registry.begin('ruby');
  const pending = cancellableWait(move);

  registry.supersede('ruby');

  assert.deepEqual(await pending.result, { timedOut: false, value: { cancelled: true } });
  pending.fireDeadline();
  assert.equal(pending.warningCount(), 0);
});

test('clearing a scene settles old departure waits without a timeout warning', async () => {
  const registry = new ActorRegistry();
  registry.attach('ruby', {});
  const departure = registry.begin('ruby');
  const pending = cancellableWait(departure);

  registry.clear();

  assert.deepEqual(await pending.result, { timedOut: false, value: { cancelled: true } });
  pending.fireDeadline();
  assert.equal(pending.warningCount(), 0);
});

test('treats a slow spritesheet as recoverable and warns only once before late success', () => {
  const assets = new SpriteAssetTracker();
  assets.start('sprite.png');

  assert.deepEqual(assets.markSlow('sprite.png'), { state: 'slow', placeholder: true, warn: true });
  assert.deepEqual(assets.markSlow('sprite.png'), { state: 'slow', placeholder: true, warn: false });
  assert.deepEqual(assets.markReady('sprite.png'), { state: 'ready', placeholder: false, warn: false });
});

test('keeps a truly failed spritesheet on its placeholder and logs the url once', () => {
  const assets = new SpriteAssetTracker();
  assets.start('broken.png');

  assert.deepEqual(assets.markFailed('broken.png'), { state: 'failed', placeholder: true, warn: true });
  assert.deepEqual(assets.markReady('broken.png'), { state: 'failed', placeholder: true, warn: false });
  assert.deepEqual(assets.markFailed('broken.png'), { state: 'failed', placeholder: true, warn: false });
});

test('keeps tiny cast readable while scaling larger cast from height', () => {
  assert.equal(spriteHeightForCm(12), 120); // ruby / robin
  assert.equal(spriteHeightForCm(25), 250); // clover / rabbit
  assert.equal(spriteHeightForCm(15), 150); // bramble / hedgehog
  assert.equal(spriteHeightForCm(1.5), 72); // flicker / firefly minimum
  assert.equal(spriteHeightForCm(35), 350); // owl — the tallest cast ruby ever staged
});

test('a shot size is one picture, whatever size the character is', () => {
  // The point of framing by the subject instead of by a plate scale: a fixed
  // 1.55x drew a hedgehog at 21% of the frame and an owl at 50%, so one word
  // meant two different shots. Both sizes now land their subject at the height
  // they ask for, and the audience sees the same closeness either way.
  for (const size of ['medium', 'close']) {
    for (const heightCm of [15, 22, 25, 35]) {
      const drawn = drawnSpriteHeightPx(heightCm, null);
      const framed = Math.round(drawn * subjectFramedScale(drawn, size));
      // medium asks for less than close, so the big cast reaches it at 1x and
      // is simply already that big — the honest answer, asserted as `>=`.
      assert.ok(framed >= SHOT_SUBJECT_PX[size] || framed === drawn, `${size} at ${heightCm} cm: ${framed}`);
    }
  }

  // Literal numbers, independent of the constants: setting SPRITE_SOURCE_PX to
  // anything else has to fail here, which `SPRITE_SOURCE_PX / 150` would not.
  assert.equal(subjectFramedScale(150, 'close').toFixed(4), '3.4133'); // hedgehog
  assert.equal(subjectFramedScale(350, 'close').toFixed(4), '1.4629'); // owl
  assert.equal(subjectFramedScale(150, 'medium').toFixed(4), '1.7067');

  // `close` can never come out wider than `medium`, at any size, without a clamp
  // saying so — 512/h is simply never smaller than 256/h. The bear is what broke
  // this before both sizes were framed the same way: medium 1.25, close 1.024.
  for (let drawn = 40; drawn <= 600; drawn += 20) {
    assert.ok(
      subjectFramedScale(drawn, 'close') >= subjectFramedScale(drawn, 'medium'),
      `a close-up came out wider than a medium at ${drawn} px`,
    );
  }
});

test('a shot stops at the plate, not at the character', () => {
  // A 15 cm hedgehog on a quarter-scale back band is drawn 37.5 px tall, and
  // framing THAT at source size asks for 13.7x of a 1080p plate. The ceiling is
  // the background's tolerance, so past it a shot is as close as it can be
  // rather than as close as the sprite would allow.
  const far = drawnSpriteHeightPx(15, { scale: 0.25 });
  assert.equal(far, 37.5);
  assert.ok(SPRITE_SOURCE_PX / far > CLOSE_SCALE_CEILING, 'the fixture no longer reaches the ceiling');
  assert.equal(subjectFramedScale(far, 'close'), CLOSE_SCALE_CEILING);

  // Where it stops being one picture, stated rather than discovered: below about
  // 15 cm the ceiling arrives before the character's own resolution does, so a
  // 12 cm robin gets 3.5x — 39% of the frame against the 47% everybody taller
  // reaches. Still more than twice the 17% a flat 1.55x gave it.
  const robin = drawnSpriteHeightPx(12, null);
  assert.equal(subjectFramedScale(robin, 'close'), CLOSE_SCALE_CEILING);
  assert.ok(robin * CLOSE_SCALE_CEILING < SPRITE_SOURCE_PX);

  // and it never runs backwards: a character already bigger than the height a
  // size asks for is not shrunk to fit it, because a shot is a frame, not a crop.
  // A 110 cm bear is drawn 500 px — 46% of the stage — so he is ALREADY in a
  // close-up and a magnifying camera has nothing left to give.
  assert.equal(subjectFramedScale(spriteHeightForCm(110), 'medium'), 1);
  assert.equal(subjectFramedScale(SPRITE_SOURCE_PX * 2, 'close'), 1);

  // `wide` frames nobody, so it has no subject height to ask about
  assert.equal(subjectFramedScale(150, 'wide'), 1);
});

test('keeps the tallest characters inside the frame', () => {
  // The bug: a 110cm bear was 1100px on a 1080px stage and rendered off the top.
  // These are the exact numbers player/README.md publishes, so the slope above
  // the knee is pinned, not just bounded.
  assert.equal(spriteHeightForCm(110), 500); // bear — the world's tallest
  assert.equal(Math.round(spriteHeightForCm(100)), 486); // deer, swan
  assert.ok(spriteHeightForCm(110) <= 1080 / 2);

  // A bear is taller than a deer, and the curve must keep saying so.
  assert.ok(spriteHeightForCm(110) > spriteHeightForCm(100));

  // The knee joins two straight lines: below it nothing moved, and the curve
  // does not jump across it.
  assert.equal(spriteHeightForCm(40), 400);
  assert.ok(spriteHeightForCm(41) - spriteHeightForCm(40) < 10);
});

test('gives an unmeasured character the readable minimum rather than a NaN', () => {
  // Four characters in the forest carry no height_cm at all (task 22).
  for (const missing of [null, undefined, NaN, 0, -5, 'tall']) {
    assert.equal(spriteHeightForCm(missing), 72, `height ${String(missing)}`);
  }
  assert.equal(spriteHeightForCm(Infinity), 72);
});

function cancellableWait(action) {
  let deadline;
  let warnings = 0;
  const result = waitForActorAction(action, new Promise(() => {}), 500, {
    setTimer: (callback) => { deadline = callback; return 12; },
    clearTimer: () => {},
    onTimeout: () => { warnings += 1; },
  });
  return {
    result,
    fireDeadline: () => deadline(),
    warningCount: () => warnings,
  };
}
