import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NO_FLOOR_STAND_Y,
  SIDE_FRACTION,
  STAND_FRACTION,
} from '../browser/v0/core/geometry.mjs';
import {
  CLOSE_SCALE_CEILING,
  MINIMUM_SPRITE_HEIGHT_PX,
  SHOT_SUBJECT_PX,
  SPRITE_KNEE_CM,
  SPRITE_PX_PER_CM,
  SPRITE_PX_PER_CM_ABOVE_KNEE,
  SPRITE_SOURCE_PX,
} from '../browser/v0/app/stage/presentation-policy.mjs';
import {
  BESIDE_NUDGE_PCT,
  CAMERA_DURATIONS_MS,
  DEFAULT_EXIT_X_PCT,
  DEFAULT_STAGE_RESOLUTION,
  DEPARTURE_DEADLINE_MS,
  DUCKED_MUSIC_VOLUME,
  DUCK_FADE_MS,
  MINIMUM_DEPARTURE_SECONDS,
  MINIMUM_MOVE_SECONDS,
  MOVE_X_PCT_PER_SECOND,
  MUSIC_FADE_MS,
  MUSIC_VOLUME,
  NARRATION_GRACE_MS,
  PAN_SCALE_FLOOR,
  PLATE_PARALLAX,
  PUSH_SCALE,
  SHOT_SIZES,
} from '../browser/v0/policy.mjs';
import { V0_POLICY } from '../tooling/v0.mjs';

test('V0_POLICY is composed from the constants the player implementation consumes', () => {
  assert.deepEqual(V0_POLICY.geometry, {
    sideFraction: SIDE_FRACTION,
    standFraction: STAND_FRACTION,
    noFloorStandY: NO_FLOOR_STAND_Y,
  });
  assert.deepEqual(V0_POLICY.presentation, {
    spritePxPerCm: SPRITE_PX_PER_CM,
    spriteKneeCm: SPRITE_KNEE_CM,
    spritePxPerCmAboveKnee: SPRITE_PX_PER_CM_ABOVE_KNEE,
    minimumSpriteHeightPx: MINIMUM_SPRITE_HEIGHT_PX,
    spriteSourcePx: SPRITE_SOURCE_PX,
    closeScaleCeiling: CLOSE_SCALE_CEILING,
    shotSubjectPx: SHOT_SUBJECT_PX,
  });
  assert.deepEqual(V0_POLICY.stage, {
    defaultResolution: DEFAULT_STAGE_RESOLUTION,
    pushScale: PUSH_SCALE,
    panScaleFloor: PAN_SCALE_FLOOR,
    shotSizes: SHOT_SIZES,
    cameraDurationsMs: CAMERA_DURATIONS_MS,
    plateParallax: PLATE_PARALLAX,
  });
  assert.deepEqual(V0_POLICY.movement, {
    besideNudgePct: BESIDE_NUDGE_PCT,
    xPctPerSecond: MOVE_X_PCT_PER_SECOND,
    minimumMoveSeconds: MINIMUM_MOVE_SECONDS,
    minimumDepartureSeconds: MINIMUM_DEPARTURE_SECONDS,
    defaultExitXPct: DEFAULT_EXIT_X_PCT,
    departureDeadlineMs: DEPARTURE_DEADLINE_MS,
  });
  assert.deepEqual(V0_POLICY.audio, {
    musicVolume: MUSIC_VOLUME,
    duckedMusicVolume: DUCKED_MUSIC_VOLUME,
    musicFadeMs: MUSIC_FADE_MS,
    duckFadeMs: DUCK_FADE_MS,
    narrationGraceMs: NARRATION_GRACE_MS,
  });
});

test('there is no fast camera speed to publish', () => {
  assert.equal(Object.hasOwn(V0_POLICY.stage.cameraDurationsMs, 'fast'), false);
});
