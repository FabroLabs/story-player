import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadStorageConfig,
  publicObjectUrl,
  storageSummary,
} from '../scripts/storage-config.mjs';

const VALID = Object.freeze({
  RUSTFS_URL: 'http://127.0.0.1:9000/',
  STORY_PLAYER_BUCKET: 'story-player',
  RUSTFS_ACCESS_KEY: 'publisher-access',
  RUSTFS_SECRET_KEY: 'publisher-secret',
});

test('loads one strict storage origin, the fixed bucket, paired credentials, and default region', () => {
  const config = loadStorageConfig(VALID);

  assert.deepEqual(config, {
    endpoint: 'http://127.0.0.1:9000',
    publicBase: 'http://127.0.0.1:9000/',
    bucket: 'story-player',
    accessKeyId: 'publisher-access',
    secretAccessKey: 'publisher-secret',
    region: 'us-east-1',
  });
  assert.ok(Object.isFrozen(config));
  assert.equal(
    publicObjectUrl(config, 'builds/abc/story-player.js'),
    'http://127.0.0.1:9000/story-player/builds/abc/story-player.js',
  );
  assert.deepEqual(storageSummary(config), {
    endpoint: 'http://127.0.0.1:9000',
    bucket: 'story-player',
    region: 'us-east-1',
  });
  assert.doesNotMatch(JSON.stringify(storageSummary(config)), /publisher-access|publisher-secret/);
});

test('accepts an explicit non-empty region and credential-free anonymous verification', () => {
  assert.equal(loadStorageConfig({ ...VALID, RUSTFS_REGION: 'eu-west-2' }).region, 'eu-west-2');
  const config = loadStorageConfig({
    RUSTFS_URL: 'https://storage.example',
    STORY_PLAYER_BUCKET: 'story-player',
  }, { requireCredentials: false });
  assert.equal(config.accessKeyId, null);
  assert.equal(config.secretAccessKey, null);
});

test('refuses ambiguous endpoints, alternate buckets, incomplete credentials, and unsafe keys', () => {
  for (const [change, message] of [
    [{ RUSTFS_URL: '' }, /RUSTFS_URL is required/],
    [{ RUSTFS_URL: 'ftp://storage.example' }, /RUSTFS_URL must be an HTTP\(S\) origin/],
    [{ RUSTFS_URL: 'https://user:pass@storage.example' }, /RUSTFS_URL must not contain credentials/],
    [{ RUSTFS_URL: 'https://storage.example/api' }, /RUSTFS_URL must not contain a path/],
    [{ RUSTFS_URL: 'https://storage.example/?x=1' }, /RUSTFS_URL must not contain a query or fragment/],
    [{ STORY_PLAYER_BUCKET: 'some-player' }, /STORY_PLAYER_BUCKET must be exactly story-player/],
    [{ RUSTFS_ACCESS_KEY: '' }, /RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY must be provided together/],
    [{ RUSTFS_SECRET_KEY: '' }, /RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY must be provided together/],
    [{ RUSTFS_REGION: ' ' }, /RUSTFS_REGION must not be blank/],
  ]) {
    assert.throws(() => loadStorageConfig({ ...VALID, ...change }), message);
  }

  assert.throws(
    () => loadStorageConfig({
      RUSTFS_URL: 'https://storage.example',
      STORY_PLAYER_BUCKET: 'story-player',
    }),
    /RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY are required/,
  );

  const config = loadStorageConfig(VALID);
  for (const key of ['', '/stable/x', '../x', 'stable//x', 'stable/x?y']) {
    assert.throws(() => publicObjectUrl(config, key), /object key/);
  }
});
