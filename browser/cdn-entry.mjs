import { createStoryPlayer, resolveMediaUrl } from './embed.mjs';
import { createReactStoryPlayer } from './react.mjs';
import * as v0 from '../tooling/v0.mjs';

// Every build on the page, by commit: a story plays the build it was made with, and a page can hold
// stories made with different builds. `FabroStoryPlayer` is the first build the page loaded, for
// hosts that load exactly one.
const NAME = 'FabroStoryPlayer';
const REGISTRY = 'FabroStoryPlayers';
const build = __STORY_PLAYER_LOCAL_SOURCE__ === null
  ? { commit: __STORY_PLAYER_COMMIT__ }
  : { commit: __STORY_PLAYER_COMMIT__, uncommitted: true, source_sha256: __STORY_PLAYER_LOCAL_SOURCE__ };
const api = deepFreeze({
  build,
  createStoryPlayer,
  resolveMediaUrl,
  createReactStoryPlayer,
  tooling: { v0: { ...v0 } },
});

const first = Object.getOwnPropertyDescriptor(globalThis, NAME);
if (first !== undefined && !isProtected(first)) throw new Error(`${NAME} existing global is not a protected build`);
const registry = installRegistry();
const held = Object.getOwnPropertyDescriptor(registry, build.commit);
if (held === undefined) define(registry, build.commit, api);
else assertSameBuild(`${REGISTRY}[${build.commit.slice(0, 7)}]`, held);
if (first === undefined) define(globalThis, NAME, registry[build.commit]);

/** The registry, created by the first build's load; anything else in its place is refused. */
function installRegistry() {
  const existing = Object.getOwnPropertyDescriptor(globalThis, REGISTRY);
  if (existing === undefined) {
    define(globalThis, REGISTRY, Object.create(null));
    return globalThis[REGISTRY];
  }
  const { value } = existing;
  const entriesProtected = value !== null && typeof value === 'object'
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(isProtected);
  if (!isProtected(existing) || !entriesProtected) {
    throw new Error(`${REGISTRY} existing global is not the protected registry`);
  }
  return value;
}

/** The same commit loaded twice is the same build, or a collision. */
function assertSameBuild(where, descriptor) {
  const existing = Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  if (existing?.build?.commit !== build.commit || existing?.build?.source_sha256 !== build.source_sha256) {
    throw new Error(
      `${where} build collision: page has ${String(existing?.build?.commit ?? 'unknown')}, `
      + `script is ${build.commit}`,
    );
  }
  if (!isProtectedInstallation(existing, descriptor)) {
    throw new Error(`${where} existing entry is not the protected ${build.commit.slice(0, 7)} build`);
  }
}

function define(target, key, value) {
  Object.defineProperty(target, key, { configurable: false, enumerable: true, writable: false, value });
}

function isProtected(descriptor) {
  return descriptor.configurable === false && descriptor.enumerable === true && descriptor.writable === false;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || !['object', 'function'].includes(typeof value) || seen.has(value)) return value;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (Object.hasOwn(descriptor, 'value')) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function isProtectedInstallation(value, descriptor) {
  try {
    return isProtected(descriptor)
      && descriptor.value === value
      && hasExactKeys(value, Object.keys(api))
      && hasExactKeys(value.build, Object.keys(build))
      && value.build.commit === build.commit
      && value.build.source_sha256 === build.source_sha256
      && typeof value.createStoryPlayer === 'function'
      && typeof value.resolveMediaUrl === 'function'
      && typeof value.createReactStoryPlayer === 'function'
      && hasExactKeys(value.tooling, ['v0'])
      && hasExactKeys(value.tooling.v0, Object.keys(api.tooling.v0))
      && isDeeplyFrozen(value);
  } catch {
    return false;
  }
}

function hasExactKeys(value, expected) {
  if (value === null || typeof value !== 'object') return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index]);
}

function isDeeplyFrozen(value, seen = new WeakSet()) {
  if (value === null || !['object', 'function'].includes(typeof value) || seen.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  seen.add(value);
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => (
    !Object.hasOwn(descriptor, 'value') || isDeeplyFrozen(descriptor.value, seen)
  ));
}
