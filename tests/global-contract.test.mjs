import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { buildCdn } from '../scripts/build-cdn.mjs';

const FIRST = '1111111111111111111111111111111111111111';
const SECOND = '2222222222222222222222222222222222222222';
const V0_TOOLING = [
  'MINIMUM_SPRITE_HEIGHT_PX', 'NO_FLOOR_STAND_Y', 'SIDE_FRACTION',
  'SPRITE_PX_PER_CM', 'STAND_FRACTION', 'TIMELINE_OPS', 'V0_POLICY',
  'compileTimeline', 'desiredFacing', 'floorSpan', 'floorYAtX', 'frameCell',
  'frameIndexAt', 'selectFacingClip', 'selectLocomotion', 'sideX',
  'spriteHeightForCm', 'stateAt', 'zoneNamed',
];

test('the classic script installs only the deeply frozen five-member global', async (t) => {
  const { source } = await artifact(t, FIRST);
  const context = vm.createContext({ console, Element: class {} });
  const before = new Set(Object.keys(context));
  vm.runInContext(source, context);
  const api = context.FabroStoryPlayer;

  assert.deepEqual(
    Object.keys(api).sort(),
    ['build', 'createReactStoryPlayer', 'createStoryPlayer', 'resolveMediaUrl', 'tooling'],
  );
  assert.equal(api.build.commit, FIRST);
  assert.equal(typeof api.createStoryPlayer, 'function');
  assert.equal(typeof api.resolveMediaUrl, 'function');
  assert.equal(typeof api.createReactStoryPlayer, 'function');
  assert.equal(api.tooling.v0.V0_POLICY.version, 0);
  assert.deepEqual(Object.keys(api.tooling.v0).sort(), V0_TOOLING.sort());
  assert.throws(
    () => api.createStoryPlayer(new context.Element(), {
      story: { storylang_version: 17 }, assetBase: 'https://storage.example/',
    }),
    /bundle version 17 unknown to this player \(knows: 0\)/,
  );
  assert.deepEqual(
    Object.keys(context).filter((name) => !before.has(name)),
    ['FabroStoryPlayer'],
  );
  assert.deepEqual(Object.getOwnPropertyDescriptor(context, 'FabroStoryPlayer'), {
    configurable: false,
    enumerable: true,
    writable: false,
    value: api,
  });
  assertDeeplyFrozen(api);
});

test('a mutable same-commit lookalike is a collision, not an idempotent reload', async (t) => {
  const { source } = await artifact(t, FIRST);
  const context = vm.createContext({
    console,
    FabroStoryPlayer: { build: { commit: FIRST } },
  });

  assert.throws(
    () => vm.runInContext(source, context),
    /FabroStoryPlayer existing global is not the protected 1111111 build/,
  );
});

test('identical reload is idempotent and a different build collision fails closed', async (t) => {
  const first = await artifact(t, FIRST);
  const second = await artifact(t, SECOND);
  const context = vm.createContext({ console });

  vm.runInContext(first.source, context);
  const installed = context.FabroStoryPlayer;
  vm.runInContext(first.source, context);
  assert.equal(context.FabroStoryPlayer, installed);
  assert.throws(
    () => vm.runInContext(second.source, context),
    /FabroStoryPlayer build collision.*1111111.*2222222/,
  );
  assert.equal(context.FabroStoryPlayer, installed);
});

async function artifact(t, commit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-global-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, 'story-player.js');
  await buildCdn({ commit, outfile });
  return { source: fs.readFileSync(outfile, 'utf8') };
}

function assertDeeplyFrozen(value, seen = new Set()) {
  if ((value === null || !['object', 'function'].includes(typeof value)) || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value));
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) assertDeeplyFrozen(descriptor.value, seen);
  }
}
