import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadStorageConfig,
  publicObjectUrl,
  storageSummary,
} from '../scripts/storage-config.mjs';

const VALID = Object.freeze({
  S3_URL: 'http://127.0.0.1:9000/',
  STORY_PLAYER_BUCKET: 'story-player',
  S3_ACCESS_KEY: 'publisher-access',
  S3_SECRET_KEY: 'publisher-secret',
});

test('loads one strict storage origin, an allowed bucket, paired credentials, and default region', () => {
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

test('accepts the dev rail as a separate bucket, and keeps the two rails apart', () => {
  const dev = loadStorageConfig({ ...VALID, STORY_PLAYER_BUCKET: 'story-player-dev' });

  assert.equal(dev.bucket, 'story-player-dev');
  // The whole point of the second rail: a dev publish addresses different
  // objects, so it cannot reach `story-player/stable/story-player.js` — the key
  // story-engine-v2 loads at runtime — however wrong the rest of the config is.
  assert.equal(
    publicObjectUrl(dev, 'stable/story-player.js'),
    'http://127.0.0.1:9000/story-player-dev/stable/story-player.js',
  );
  assert.notEqual(
    publicObjectUrl(dev, 'stable/story-player.js'),
    publicObjectUrl(loadStorageConfig(VALID), 'stable/story-player.js'),
  );
  assert.equal(storageSummary(dev).bucket, 'story-player-dev');
});

test('accepts an explicit non-empty region and credential-free anonymous verification', () => {
  assert.equal(loadStorageConfig({ ...VALID, S3_REGION: 'eu-west-2' }).region, 'eu-west-2');
  const config = loadStorageConfig({
    S3_URL: 'https://storage.example',
    STORY_PLAYER_BUCKET: 'story-player',
  }, { requireCredentials: false });
  assert.equal(config.accessKeyId, null);
  assert.equal(config.secretAccessKey, null);
});

test('refuses ambiguous endpoints, alternate buckets, incomplete credentials, and unsafe keys', () => {
  for (const [change, message] of [
    [{ S3_URL: '' }, /S3_URL is required/],
    [{ S3_URL: 'ftp://storage.example' }, /S3_URL must be an HTTP\(S\) origin/],
    [{ S3_URL: 'https://user:pass@storage.example' }, /S3_URL must not contain credentials/],
    [{ S3_URL: 'https://storage.example/api' }, /S3_URL must not contain a path/],
    [{ S3_URL: 'https://storage.example/?x=1' }, /S3_URL must not contain a query or fragment/],
    // An allow-list, not a free-form name: this publisher signs public-read
    // writes against a store that also holds `fairytale-assets` and `jobs`.
    [{ STORY_PLAYER_BUCKET: 'some-player' }, /STORY_PLAYER_BUCKET must be one of/],
    [{ STORY_PLAYER_BUCKET: 'fairytale-assets' }, /STORY_PLAYER_BUCKET must be one of/],
    [{ STORY_PLAYER_BUCKET: 'story-player-staging' }, /STORY_PLAYER_BUCKET must be one of/],
    [{ S3_ACCESS_KEY: '' }, /S3_ACCESS_KEY and S3_SECRET_KEY must be provided together/],
    [{ S3_SECRET_KEY: '' }, /S3_ACCESS_KEY and S3_SECRET_KEY must be provided together/],
    [{ S3_REGION: ' ' }, /S3_REGION must not be blank/],
  ]) {
    assert.throws(() => loadStorageConfig({ ...VALID, ...change }), message);
  }

  assert.throws(
    () => loadStorageConfig({
      S3_URL: 'https://storage.example',
      STORY_PLAYER_BUCKET: 'story-player',
    }),
    /S3_ACCESS_KEY and S3_SECRET_KEY are required/,
  );

  const config = loadStorageConfig(VALID);
  for (const key of ['', '/stable/x', '../x', 'stable//x', 'stable/x?y']) {
    assert.throws(() => publicObjectUrl(config, key), /object key/);
  }
});
