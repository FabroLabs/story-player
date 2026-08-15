import { createStoryPlayer, resolveMediaUrl } from './embed.mjs';
import { createReactStoryPlayer } from './react.mjs';
import * as v0 from '../tooling/v0.mjs';

const NAME = 'FabroStoryPlayer';
const build = { commit: __STORY_PLAYER_COMMIT__ };
const api = deepFreeze({
  build,
  createStoryPlayer,
  resolveMediaUrl,
  createReactStoryPlayer,
  tooling: { v0: { ...v0 } },
});
const existingDescriptor = Object.getOwnPropertyDescriptor(globalThis, NAME);

if (existingDescriptor === undefined) {
  Object.defineProperty(globalThis, NAME, {
    configurable: false,
    enumerable: true,
    writable: false,
    value: api,
  });
} else {
  const existing = Object.hasOwn(existingDescriptor, 'value')
    ? existingDescriptor.value
    : undefined;
  if (existing?.build?.commit !== build.commit) {
    throw new Error(
      `${NAME} build collision: page has ${String(existing?.build?.commit ?? 'unknown')}, `
      + `script is ${build.commit}`,
    );
  }
  if (!isProtectedInstallation(existing, existingDescriptor)) {
    throw new Error(
      `${NAME} existing global is not the protected ${build.commit.slice(0, 7)} build`,
    );
  }
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
    return descriptor.configurable === false
      && descriptor.enumerable === true
      && descriptor.writable === false
      && descriptor.value === value
      && hasExactKeys(value, Object.keys(api))
      && hasExactKeys(value.build, ['commit'])
      && value.build.commit === build.commit
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
