import assert from 'node:assert/strict';
import test from 'node:test';

import { routeWarning } from '../browser/v0/app/warning-router.mjs';

test('routes one warning to the director without falling through on an undefined return', () => {
  const calls = [];
  const director = { warning: (detail) => { calls.push(['director', detail]); } };
  const log = { warning: (detail) => calls.push(['log', detail]) };

  routeWarning({ type: 'media', line: 8 }, director, log);

  assert.deepEqual(calls, [['director', { type: 'media', line: 8 }]]);
});

test('routes an early warning to the log with a nullable top-level line', () => {
  const calls = [];
  const log = { warning: (detail, line, sceneIndex) => calls.push([detail, line, sceneIndex]) };

  routeWarning({ type: 'bundle', message: 'missing story', line: 7, scene_index: 2 }, null, log);

  assert.deepEqual(calls, [[{ type: 'bundle', message: 'missing story' }, 7, 2]]);
});
