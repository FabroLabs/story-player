import assert from 'node:assert/strict';
import test from 'node:test';

import { EventLog } from '../browser/v0/core/event-log.mjs';

test('preserves append order without schema-only sequence keys and does not expose mutable entries', () => {
  let now = 12;
  const log = new EventLog(() => now);
  log.append({ kind: 'cmd', cmd: 'put' });
  now = 15;
  log.warning('clip fallback');

  const entries = log.entries();
  assert.deepEqual(entries, [
    { t_ms: 12, kind: 'cmd', cmd: 'put' },
    { t_ms: 15, scene_index: null, line: null, kind: 'warning', detail: 'clip fallback' },
  ]);
  entries[0].kind = 'changed';
  assert.equal(log.entries()[0].kind, 'cmd');
  assert.equal(JSON.stringify(log.toJSON()), JSON.stringify(log.toJSON()));
});

test('records a warning origin line at top level', () => {
  const log = new EventLog(() => 8);

  log.warning({ type: 'media', message: 'missing' }, 27);

  assert.deepEqual(log.entries(), [{
    t_ms: 8,
    scene_index: null,
    line: 27,
    kind: 'warning',
    detail: { type: 'media', message: 'missing' },
  }]);
});

test('uses an object clock with its receiver intact', () => {
  const clock = {
    time: 42,
    now() { return this.time; },
  };
  const log = new EventLog(clock);

  log.append({ kind: 'cmd', cmd: 'put' });
  assert.equal(log.entries()[0].t_ms, 42);
});
