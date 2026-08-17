import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as embed from '../browser/embed.mjs';
import * as tooling from '../tooling/v0.mjs';

const ROOT = new URL('../', import.meta.url);
const EXPECTED_TOOLING_EXPORTS = [
  'MINIMUM_SPRITE_HEIGHT_PX',
  'NO_FLOOR_STAND_Y',
  'SIDE_FRACTION',
  'SPRITE_PX_PER_CM',
  'STAND_FRACTION',
  'TIMELINE_OPS',
  'V0_POLICY',
  'compileTimeline',
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

test('the source embed facade exposes only the framework-neutral API', () => {
  assert.deepEqual(Object.keys(embed).sort(), ['createStoryPlayer', 'resolveMediaUrl']);
});

test('the removed standalone, host, and shell entry points stay absent', () => {
  for (const path of [
    'browser/index.html',
    'browser/host.mjs',
    'browser/shell/main.mjs',
    'browser/shell/performers.mjs',
    'browser/shell/urls.mjs',
  ]) assert.equal(fs.existsSync(new URL(path, ROOT)), false, `${path} came back`);

  const embedSource = fs.readFileSync(new URL('browser/embed.mjs', ROOT), 'utf8');
  assert.doesNotMatch(embedSource, /storyUrl|\bfetch\s*\(/);
  const appSource = fs.readFileSync(new URL('browser/v0/app/main.mjs', ROOT), 'utf8');
  const templateSource = fs.readFileSync(new URL('browser/template.mjs', ROOT), 'utf8');
  assert.doesNotMatch(appSource, /document\.title|document\.getElementById|window\.location/);
  assert.doesNotMatch(templateSource, /\bid\s*:/, 'the Shadow DOM template reintroduced document-global ids');
});

// The op table replaced a list of stage METHOD names, which only ever described
// how one renderer happened to be written. These are the events themselves —
// what every client, this one included, reads to know what it must draw.
test('v0 tooling keeps the exact semantics every client consumes', () => {
  assert.deepEqual(Object.keys(tooling).sort(), EXPECTED_TOOLING_EXPORTS.sort());
  assert.equal(typeof tooling.compileTimeline, 'function');
  assert.deepEqual(tooling.TIMELINE_OPS, [
    'scene', 'place', 'place_object', 'clip', 'move', 'settle', 'depart',
    'exit', 'push_in', 'pull_out', 'shot', 'pan', 'camera_reset', 'subtitle',
    'end',
  ]);
  assert.ok(Object.isFrozen(tooling.TIMELINE_OPS));
  assertDeeplyFrozen(tooling.V0_POLICY);
  assert.deepEqual(tooling.V0_POLICY, {
    version: 0,
    geometry: {
      sideFraction: { left_edge: 0.1, left_third: 0.3, center: 0.5, right_third: 0.7, right_edge: 0.9 },
      standFraction: 0.5,
      noFloorStandY: 86,
    },
    presentation: {
      spritePxPerCm: 10,
      spriteKneeCm: 40,
      spritePxPerCmAboveKnee: 10 / 7,
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
});

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const nested of Object.values(value)) assertDeeplyFrozen(nested);
}
