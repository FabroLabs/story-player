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

test('the classic script installs the deeply frozen five-member build and the registry of builds', async (t) => {
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
    Object.keys(context).filter((name) => !before.has(name)).sort(),
    ['FabroStoryPlayer', 'FabroStoryPlayers'],
  );
  for (const name of ['FabroStoryPlayer', 'FabroStoryPlayers']) {
    const { configurable, enumerable, writable } = Object.getOwnPropertyDescriptor(context, name);
    assert.deepEqual({ configurable, enumerable, writable }, { configurable: false, enumerable: true, writable: false });
  }
  assert.deepEqual(Object.keys(context.FabroStoryPlayers), [FIRST]);
  assert.equal(context.FabroStoryPlayers[FIRST], api);
  assertDeeplyFrozen(api);
});

test('a mutable lookalike of either global is refused, not adopted', async (t) => {
  const { source } = await artifact(t, FIRST);
  assert.throws(
    () => vm.runInContext(source, vm.createContext({ console, FabroStoryPlayer: { build: { commit: FIRST } } })),
    /FabroStoryPlayer existing global is not a protected build/,
  );
  assert.throws(
    () => vm.runInContext(source, vm.createContext({ console, FabroStoryPlayers: {} })),
    /FabroStoryPlayers existing global is not the protected registry/,
  );
  const planted = vm.createContext({ console });
  vm.runInContext(`Object.defineProperty(globalThis, 'FabroStoryPlayers', { value: {}, enumerable: true });
    Object.defineProperty(FabroStoryPlayers, '${FIRST}', { value: { build: { commit: '${FIRST}' } }, enumerable: true });`, planted);
  assert.throws(
    () => vm.runInContext(source, planted),
    /FabroStoryPlayers\[1111111\] existing entry is not the protected 1111111 build/,
  );
});

test('an identical reload is idempotent, and a second build installs beside the first', async (t) => {
  const first = await artifact(t, FIRST);
  const second = await artifact(t, SECOND);
  const context = vm.createContext({ console });

  vm.runInContext(first.source, context);
  const installed = context.FabroStoryPlayer;
  vm.runInContext(first.source, context);
  assert.equal(context.FabroStoryPlayer, installed);
  vm.runInContext(second.source, context);
  assert.equal(context.FabroStoryPlayer, installed, 'the page\'s first build was replaced');
  assert.deepEqual(Object.keys(context.FabroStoryPlayers).sort(), [FIRST, SECOND]);
  assert.equal(context.FabroStoryPlayers[SECOND].build.commit, SECOND);
  assert.notEqual(context.FabroStoryPlayers[SECOND].createStoryPlayer, installed.createStoryPlayer);
});

test('a build loaded after one that predates the registry keeps the older global and registers itself', async (t) => {
  const { source } = await artifact(t, SECOND);
  const context = vm.createContext({ console });
  vm.runInContext(`Object.defineProperty(globalThis, 'FabroStoryPlayer', {
    value: Object.freeze({ build: Object.freeze({ commit: '${FIRST}' }) }), enumerable: true });`, context);
  vm.runInContext(source, context);
  assert.equal(context.FabroStoryPlayer.build.commit, FIRST);
  assert.equal(context.FabroStoryPlayers[SECOND].build.commit, SECOND);
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

test('local uncommitted source identity is explicit and cannot collide with the production base', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-local-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, 'story-player.js');
  const sourceSha256 = 'a'.repeat(64);
  await buildCdn({ commit: FIRST, sourceSha256, outfile });
  const local = fs.readFileSync(outfile, 'utf8');
  const context = vm.createContext({ console });
  vm.runInContext(local, context);
  assert.equal(context.FabroStoryPlayer.build.uncommitted, true);
  assert.equal(context.FabroStoryPlayer.build.source_sha256, sourceSha256);
  vm.runInContext(local, context);
  const production = await artifact(t, FIRST);
  assert.throws(() => vm.runInContext(production.source, context), /build collision/);
});
