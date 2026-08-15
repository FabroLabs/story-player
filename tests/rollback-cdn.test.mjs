import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { IMMUTABLE_CACHE_CONTROL, STABLE_CACHE_CONTROL } from '../scripts/publish-cdn.mjs';
import { rollbackCdn } from '../scripts/rollback-cdn.mjs';
import { loadStorageConfig } from '../scripts/storage-config.mjs';

const COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';
const SCRIPT_KEY = `builds/${COMMIT}/story-player.js`;
const METADATA_KEY = `builds/${COMMIT}/build.json`;
const SCRIPT = new TextEncoder().encode(`window.FabroStoryPlayer = "${COMMIT}";\n`);
const SHA256 = crypto.createHash('sha256').update(SCRIPT).digest('hex');
const METADATA = metadataBytes();
const CONFIG = loadStorageConfig({
  RUSTFS_URL: 'https://storage.example',
  STORY_PLAYER_BUCKET: 'story-player',
  RUSTFS_ACCESS_KEY: 'rollback-access',
  RUSTFS_SECRET_KEY: 'rollback-secret',
});

test('rolls stable back from verified immutable bytes and writes metadata last', async () => {
  const store = rollbackStore();
  const logs = [];
  const report = await rollbackCdn({
    commit: COMMIT,
    config: CONFIG,
    fetchImpl: store.fetch,
    log: (entry) => logs.push(entry),
    store,
  });

  assert.deepEqual(report, {
    bucket: 'story-player',
    bytes: SCRIPT.length,
    commit: COMMIT,
    sha256: SHA256,
    stableKey: 'stable/story-player.js',
  });
  assert.deepEqual(store.objects.get('stable/story-player.js').body, SCRIPT);
  assert.deepEqual(store.objects.get('stable/build.json').body, METADATA);
  assert.equal(store.writes.at(-1).key, 'stable/build.json');
  assert.equal(store.writes.at(-1).cacheControl, STABLE_CACHE_CONTROL);
  const immutableGets = store.fetches.filter(({ path }) => path.startsWith('/builds/'));
  assert.equal(immutableGets.length, 2);
  for (const request of immutableGets) {
    assert.equal(request.options.method, undefined);
    assert.deepEqual(request.options.headers, { Origin: 'https://story-player-verifier.invalid' });
    assert.equal(Object.hasOwn(request.options.headers, 'Authorization'), false);
  }
  assert.doesNotMatch(JSON.stringify(logs), /rollback-access|rollback-secret/);
});

test('refuses a missing, malformed, mismatched, or corrupt immutable build before stable changes', async () => {
  for (const mutate of [
    (store) => store.objects.delete(METADATA_KEY),
    (store) => store.objects.set(METADATA_KEY, object(new TextEncoder().encode('{bad json\n'), 'application/json; charset=utf-8')),
    (store) => store.objects.set(METADATA_KEY, object(new TextEncoder().encode(JSON.stringify({
      schema: 1,
      commit: '0'.repeat(40),
      script: { key: SCRIPT_KEY, bytes: SCRIPT.length, sha256: SHA256 },
    })), 'application/json; charset=utf-8')),
    (store) => store.objects.set(METADATA_KEY, object(
      METADATA,
      'application/json; charset=utf-8',
      STABLE_CACHE_CONTROL,
    )),
    (store) => store.objects.set(SCRIPT_KEY, object(
      SCRIPT,
      'application/octet-stream',
    )),
    (store) => store.objects.set(METADATA_KEY, object(metadataBytes({ key: 'builds/other/story-player.js' }), 'application/json; charset=utf-8')),
    (store) => store.objects.set(METADATA_KEY, object(metadataBytes({ bytes: SCRIPT.length + 1 }), 'application/json; charset=utf-8')),
    (store) => store.objects.set(METADATA_KEY, object(metadataBytes({ sha256: '0'.repeat(64) }), 'application/json; charset=utf-8')),
    (store) => store.objects.set(SCRIPT_KEY, object(Uint8Array.from(SCRIPT, (byte) => byte ^ 1), 'text/javascript; charset=utf-8')),
  ]) {
    const store = rollbackStore();
    mutate(store);
    await assert.rejects(
      rollbackCdn({ commit: COMMIT, config: CONFIG, fetchImpl: store.fetch, store }),
      /immutable (?:metadata|build)|anonymous SHA-256 mismatch|byte length mismatch|HTTP 404/,
    );
    assert.equal(store.writes.length, 0);
    assert.equal(store.objects.has('stable/story-player.js'), false);
  }
});

test('requires a full immutable commit key', async () => {
  await assert.rejects(
    rollbackCdn({ commit: 'stable', config: CONFIG, fetchImpl: async () => {}, store: {} }),
    /40-character lowercase Git commit/,
  );
});

function rollbackStore() {
  const objects = new Map([
    [SCRIPT_KEY, object(SCRIPT, 'text/javascript; charset=utf-8')],
    [METADATA_KEY, object(METADATA, 'application/json; charset=utf-8')],
  ]);
  const store = {
    fetches: [],
    objects,
    writes: [],
    async putObject(input) {
      this.writes.push(input);
      this.objects.set(input.key, object(input.body, input.contentType, input.cacheControl));
    },
  };
  store.fetch = async (url, init = {}) => {
    const key = decodeURIComponent(String(url).split('/story-player/')[1] ?? '');
    store.fetches.push({ options: init, path: `/${key}` });
    const value = store.objects.get(key);
    if (!value) return new Response('missing', { status: 404 });
    return new Response(init.method === 'HEAD' ? null : value.body, {
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': value.cacheControl,
        'content-length': String(value.body.length),
        'content-type': value.contentType,
      },
    });
  };
  return store;
}

function object(body, contentType, cacheControl = IMMUTABLE_CACHE_CONTROL) {
  return { body: Uint8Array.from(body), cacheControl, contentType };
}

function metadataBytes({ key = SCRIPT_KEY, bytes = SCRIPT.length, sha256 = SHA256 } = {}) {
  return new TextEncoder().encode(`${JSON.stringify({
    schema: 1,
    commit: COMMIT,
    script: { key, bytes, sha256 },
  }, null, 2)}\n`);
}
