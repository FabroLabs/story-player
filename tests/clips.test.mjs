import assert from 'node:assert/strict';
import test from 'node:test';

import {
  desiredFacing,
  frameCell,
  frameIndexAt,
  selectFacingClip,
  selectLocomotion,
} from '../browser/v0/core/clips.mjs';

test('derives side-facing toward a target and camera-facing without one', () => {
  assert.equal(desiredFacing(40, 20), 'left');
  assert.equal(desiredFacing(40, 60), 'right');
  assert.equal(desiredFacing(50, 50), 'right');
  assert.equal(desiredFacing(50, null), 'camera');
});

test('selects the requested side clip before all fallbacks', () => {
  const capability = { happy: { left: 'happy-left', right: 'happy-right', camera: 'happy-camera' } };
  assert.equal(selectFacingClip(capability, 'happy', 'left'), 'happy-left');
});

test('selects an exact camera clip without logging a fallback', () => {
  const warnings = [];
  const capability = { happy: { camera: 'happy-camera', right: 'happy-right' } };

  assert.equal(selectFacingClip(capability, 'happy', 'camera', (detail) => warnings.push(detail)), 'happy-camera');
  assert.deepEqual(warnings, []);
});

test('falls back from a missing side to camera with one warning', () => {
  const warnings = [];
  const capability = { happy: { camera: 'happy-camera', right: 'happy-right' } };

  assert.equal(selectFacingClip(capability, 'happy', 'left', (detail) => warnings.push(detail)), 'happy-camera');
  assert.deepEqual(warnings, [{
    policy: 'facing-fallback',
    verb: 'happy',
    requested: 'left',
    selected: 'camera',
  }]);
});

test('falls back from a missing side to the opposite unmirrored clip with one warning', () => {
  const warnings = [];
  const capability = { happy: { right: 'happy-right' } };

  assert.equal(selectFacingClip(capability, 'happy', 'left', (detail) => warnings.push(detail)), 'happy-right');
  assert.deepEqual(warnings, [{
    policy: 'facing-fallback',
    verb: 'happy',
    requested: 'left',
    selected: 'right',
  }]);
});

test('turns toward the middle of the floor, not the middle of the plate', () => {
  const capability = { happy: { left: 'happy-left', right: 'happy-right' } };
  const facing = (subjectX, centerX) =>
    selectFacingClip(capability, 'happy', { requested: 'camera', subjectX, centerX }, () => {});

  // forest_firefly_fork's floor is 1.2..99.2, so `center` resolves to 50.215.
  // Judged against the plate's 50 a character standing there reads as
  // right-of-centre and turns left — away from everyone else on the floor.
  assert.equal(facing(50.215, 50.215), 'happy-right'); // dead centre still resolves right
  assert.equal(facing(50.215, 50), 'happy-left'); // what the plate midpoint used to say

  // A floor pinned to the right half: its middle is 75, so 60 is left of centre.
  assert.equal(facing(60, 75), 'happy-right');
  assert.equal(facing(80, 75), 'happy-left');

  // No centre supplied — the plate is the fallback, unchanged.
  assert.equal(facing(20, undefined), 'happy-right');
  assert.equal(facing(80, undefined), 'happy-left');
});

test('reports literal warning payloads for every missing-camera fallback', () => {
  const warnings = [];
  const warn = (detail) => warnings.push(detail);
  const capability = { happy: { left: 'happy-left', right: 'happy-right' } };

  assert.equal(
    selectFacingClip(capability, 'happy', { requested: 'camera', crowd: 'left', subjectX: 60 }, warn),
    'happy-left',
  );
  assert.equal(
    selectFacingClip(capability, 'happy', { requested: 'camera', subjectX: 20 }, warn),
    'happy-right',
  );
  assert.equal(
    selectFacingClip(capability, 'happy', { requested: 'camera', subjectX: 50 }, warn),
    'happy-right',
  );
  assert.equal(
    selectFacingClip({ happy: { left: 'happy-left' } }, 'happy', { requested: 'camera', subjectX: 20 }, warn),
    'happy-left',
  );
  assert.equal(
    selectFacingClip({ happy: {} }, 'happy', { requested: 'camera', subjectX: 20 }, warn),
    null,
  );

  assert.deepEqual(warnings, [
    { policy: 'facing-fallback', verb: 'happy', requested: 'camera', selected: 'left' },
    { policy: 'facing-fallback', verb: 'happy', requested: 'camera', selected: 'right' },
    { policy: 'facing-fallback', verb: 'happy', requested: 'camera', selected: 'right' },
    { policy: 'facing-fallback', verb: 'happy', requested: 'camera', selected: 'left' },
    { policy: 'facing-fallback', verb: 'happy', requested: 'camera', selected: null },
  ]);
});

test('selects locomotion families in move-walk-fly order and warns when absent', () => {
  assert.equal(selectLocomotion({ move: { left: 'move-left' }, walk: { left: 'walk-left' } }), 'move');
  assert.equal(selectLocomotion({ walk: { left: 'walk-left' }, fly: { left: 'fly-left' } }), 'walk');
  assert.equal(selectLocomotion({ fly: { left: 'fly-left' } }), 'fly');

  const warnings = [];
  assert.equal(selectLocomotion({}, (detail) => warnings.push(detail)), null);
  assert.equal(warnings.length, 1);
});

test('wraps frame indices at fps and maps arbitrary atlas grids', () => {
  assert.equal(frameIndexAt(0.49, 10, 5), 4);
  assert.equal(frameIndexAt(0.5, 10, 5), 0);
  assert.equal(frameIndexAt(1.2, 4, 5), 4);
  assert.deepEqual(frameCell(7, [5, 5]), [2, 1]);
  assert.deepEqual(frameCell(24, [5, 5]), [4, 4]);
});
