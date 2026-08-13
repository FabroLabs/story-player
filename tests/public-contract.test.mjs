import assert from 'node:assert/strict';
import test from 'node:test';

import * as host from '../browser/host.mjs';
import { StageRenderer } from '../browser/v0/app/stage/stage-renderer.mjs';
import * as tooling from '../tooling/v0.mjs';

const EXPECTED_TOOLING_EXPORTS = [
  'EventLog',
  'MINIMUM_SPRITE_HEIGHT_PX',
  'NO_FLOOR_STAND_Y',
  'PlaybackDirector',
  'SIDE_FRACTION',
  'SPRITE_PX_PER_CM',
  'STAND_FRACTION',
  'V0_POLICY',
  'V0_STAGE_METHODS',
  'desiredFacing',
  'floorSpan',
  'floorYAtX',
  'frameCell',
  'frameIndexAt',
  'selectFacingClip',
  'selectLocomotion',
  'sideX',
  'spriteHeightForCm',
  'zoneNamed',
];

test('host exposes only the stable host integration facade', () => {
  assert.deepEqual(Object.keys(host).sort(), [
    'normalizeAssetBase',
    'resolveAssetKey',
    'resolveStoryUrl',
  ]);
});

test('v0 tooling exposes exactly the versioned renderer semantics', () => {
  assert.deepEqual(Object.keys(tooling).sort(), EXPECTED_TOOLING_EXPORTS.sort());
});

test('V0_STAGE_METHODS is the frozen director-to-stage contract', () => {
  assert.deepEqual(tooling.V0_STAGE_METHODS, [
    'departCharacter',
    'floorY',
    'follow',
    'followOff',
    'moveCharacter',
    'panTo',
    'placeCharacter',
    'placeObject',
    'pullOut',
    'pushIn',
    'resetCamera',
    'setCharacterClip',
    'setShot',
    'setSubtitle',
    'showEnd',
    'showScene',
  ]);
  assert.ok(Object.isFrozen(tooling.V0_STAGE_METHODS));
  assert.deepEqual(
    tooling.V0_STAGE_METHODS.filter((method) => typeof StageRenderer.prototype[method] !== 'function'),
    [],
  );
});

test('V0_POLICY publishes the exact deeply frozen v0 numbers', () => {
  assert.deepEqual(tooling.V0_POLICY, {
    version: 0,
    geometry: {
      sideFraction: {
        left_edge: 0.1,
        left_third: 0.3,
        center: 0.5,
        right_third: 0.7,
        right_edge: 0.9,
      },
      standFraction: 0.5,
      noFloorStandY: 86,
    },
    presentation: {
      spritePxPerCm: 10,
      spriteKneeCm: 40,
      spritePxPerCmAboveKnee: 100 / 70,
      minimumSpriteHeightPx: 72,
      spriteSourcePx: 512,
      closeScaleCeiling: 3.5,
      shotSubjectPx: { medium: 256, close: 512 },
    },
    stage: {
      defaultResolution: [1920, 1080],
      pushScale: 1.55,
      panScaleFloor: 1.25,
      shotSizes: { wide: 1, medium: null, close: null },
      cameraDurationsMs: { slow: 2400, medium: 1400 },
      plateParallax: 1,
    },
    movement: {
      besideNudgePct: 0.01,
      xPctPerSecond: 22,
      minimumMoveSeconds: 0.25,
      minimumDepartureSeconds: 0.35,
      defaultExitXPct: { left: -8, right: 108 },
      departureDeadlineMs: 5000,
    },
    audio: {
      musicVolume: 0.38,
      duckedMusicVolume: 0.14,
      musicFadeMs: 850,
      duckFadeMs: 220,
      narrationGraceMs: 4000,
    },
  });
  assert.equal(Object.hasOwn(tooling.V0_POLICY.stage.cameraDurationsMs, 'fast'), false);
  assertDeeplyFrozen(tooling.V0_POLICY);
});

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}
