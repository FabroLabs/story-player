import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  IMMUTABLE_CACHE_CONTROL,
  PUBLIC_READ_CORS,
  PUBLIC_READ_POLICY,
  STABLE_CACHE_CONTROL,
  ensurePublicBucket,
  publishCdn,
} from '../scripts/publish-cdn.mjs';
import { loadStorageConfig } from '../scripts/storage-config.mjs';
import { verifyCdnObject, verifyPublicBytes } from '../scripts/verify-cdn.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SCRIPT = new TextEncoder().encode(`window.FabroStoryPlayer = "${COMMIT}";\n`);
const CONFIG = loadStorageConfig({
  RUSTFS_URL: 'https://storage.example',
  STORY_PLAYER_BUCKET: 'story-player',
  RUSTFS_ACCESS_KEY: 'access-do-not-log',
  RUSTFS_SECRET_KEY: 'secret-do-not-log',
});
const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('creates and configures the one public bucket idempotently without weakening conflicts', async () => {
  assert.equal(IMMUTABLE_CACHE_CONTROL, 'public, max-age=31536000, immutable');
  assert.equal(STABLE_CACHE_CONTROL, 'public, max-age=60, must-revalidate');
  assert.deepEqual(PUBLIC_READ_POLICY, {
    Version: '2012-10-17',
    Statement: [{
      Sid: 'AnonymousStoryPlayerRead',
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::story-player/*'],
    }],
  });
  assert.deepEqual(PUBLIC_READ_CORS, [{
    AllowedHeaders: ['*'],
    AllowedMethods: ['GET', 'HEAD'],
    AllowedOrigins: ['*'],
    ExposeHeaders: ['Cache-Control', 'Content-Length', 'Content-Type', 'ETag'],
    MaxAgeSeconds: 3600,
  }]);
  const fresh = fakeStore();
  await ensurePublicBucket({ store: fresh, config: CONFIG });
  assert.deepEqual(fresh.calls.slice(0, 6).map(([name]) => name), [
    'bucketExists', 'createBucket', 'getBucketPolicy', 'putBucketPolicy',
    'getBucketCors', 'putBucketCors',
  ]);
  assert.deepEqual(fresh.policy, PUBLIC_READ_POLICY);
  assert.deepEqual(fresh.cors, PUBLIC_READ_CORS);

  fresh.calls.length = 0;
  await ensurePublicBucket({ store: fresh, config: CONFIG });
  assert.deepEqual(fresh.calls.map(([name]) => name), [
    'bucketExists', 'getBucketPolicy', 'getBucketCors',
  ]);

  for (const change of [
    (store) => { store.policy.Statement[0].Action = ['s3:GetObject', 's3:PutObject']; },
    (store) => { store.cors[0].AllowedOrigins = ['https://app.example']; },
  ]) {
    const conflict = fakeStore({ exists: true, configured: true });
    change(conflict);
    await assert.rejects(
      ensurePublicBucket({ store: conflict, config: CONFIG }),
      /conflicting public (?:bucket policy|CORS)/,
    );
    assert.equal(conflict.calls.some(([name]) => name.startsWith('putBucket')), false);
  }
});

test('publishes immutable objects create-only, verifies anonymously, and promotes metadata last', async () => {
  const store = fakeStore({ exists: true, configured: true });
  const logs = [];
  const report = await publishCdn({
    artifact: SCRIPT,
    commit: COMMIT,
    config: CONFIG,
    fetchImpl: store.fetch,
    log: (entry) => logs.push(entry),
    store,
  });

  const digest = sha256(SCRIPT);
  assert.deepEqual(report, {
    bucket: 'story-player',
    bytes: SCRIPT.length,
    commit: COMMIT,
    immutableKey: `builds/${COMMIT}/story-player.js`,
    sha256: digest,
    stableKey: 'stable/story-player.js',
  });
  assert.ok(Object.isFrozen(report));
  assert.deepEqual(store.calls.filter(([name]) => name === 'putObject').map(([, input]) => ({
    cacheControl: input.cacheControl,
    contentType: input.contentType,
    createOnly: input.createOnly,
    key: input.key,
  })), [
    {
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: 'text/javascript; charset=utf-8',
      createOnly: true,
      key: `builds/${COMMIT}/story-player.js`,
    },
    {
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: 'application/json; charset=utf-8',
      createOnly: true,
      key: `builds/${COMMIT}/build.json`,
    },
    {
      cacheControl: STABLE_CACHE_CONTROL,
      contentType: 'text/javascript; charset=utf-8',
      createOnly: false,
      key: 'stable/story-player.js',
    },
    {
      cacheControl: STABLE_CACHE_CONTROL,
      contentType: 'application/json; charset=utf-8',
      createOnly: false,
      key: 'stable/build.json',
    },
  ]);
  assert.equal(store.calls.at(-1)[0], 'fetch');
  assert.match(store.calls.at(-1)[1], /stable\/build\.json$/);
  const immutableMetadataVerifiedAt = store.calls.findIndex(
    ([name, url, init]) => name === 'fetch'
      && url.endsWith(`/builds/${COMMIT}/build.json`)
      && init.method !== 'HEAD',
  );
  const stableScriptWrittenAt = store.calls.findIndex(
    ([name, input]) => name === 'putObject' && input.key === 'stable/story-player.js',
  );
  const stableScriptVerifiedAt = store.calls.findIndex(
    ([name, url, init]) => name === 'fetch'
      && url.endsWith('/stable/story-player.js')
      && init.method !== 'HEAD',
  );
  const stableMetadataWrittenAt = store.calls.findIndex(
    ([name, input]) => name === 'putObject' && input.key === 'stable/build.json',
  );
  assert.ok(immutableMetadataVerifiedAt > 0);
  assert.ok(immutableMetadataVerifiedAt < stableScriptWrittenAt);
  assert.ok(stableScriptWrittenAt < stableScriptVerifiedAt);
  assert.ok(stableScriptVerifiedAt < stableMetadataWrittenAt);
  const publicCalls = store.calls.filter(([name]) => name === 'fetch');
  assert.equal(publicCalls.length, 8);
  for (let index = 0; index < publicCalls.length; index += 2) {
    assert.equal(publicCalls[index][2]?.method, 'HEAD');
    assert.equal(publicCalls[index + 1][2]?.method, undefined);
    for (const [, , options] of [publicCalls[index], publicCalls[index + 1]]) {
      assert.deepEqual(options.headers, { Origin: 'https://story-player-verifier.invalid' });
      assert.equal(Object.hasOwn(options.headers, 'Authorization'), false);
    }
  }

  const metadata = JSON.parse(new TextDecoder().decode(store.objects.get(`builds/${COMMIT}/build.json`).body));
  assert.deepEqual(metadata, {
    schema: 1,
    commit: COMMIT,
    script: {
      key: `builds/${COMMIT}/story-player.js`,
      bytes: SCRIPT.length,
      sha256: digest,
    },
  });
  assert.deepEqual(
    store.objects.get('stable/build.json').body,
    store.objects.get(`builds/${COMMIT}/build.json`).body,
  );
  assert.doesNotMatch(JSON.stringify(logs), /access-do-not-log|secret-do-not-log/);
});

test('an exact immutable rerun is idempotent while a mismatch or anonymous verification failure never promotes', async () => {
  const exact = fakeStore({ exists: true, configured: true });
  await publishCdn({ artifact: SCRIPT, commit: COMMIT, config: CONFIG, fetchImpl: exact.fetch, store: exact });
  exact.calls.length = 0;
  await publishCdn({ artifact: SCRIPT, commit: COMMIT, config: CONFIG, fetchImpl: exact.fetch, store: exact });
  assert.equal(exact.calls.filter(([name]) => name === 'putObject').length, 4);
  assert.equal(exact.calls.filter(([name]) => name === 'getObject').length, 2);

  const mismatch = fakeStore({ exists: true, configured: true });
  mismatch.objects.set(`builds/${COMMIT}/story-player.js`, object('different', {
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: 'text/javascript; charset=utf-8',
  }));
  await assert.rejects(
    publishCdn({ artifact: SCRIPT, commit: COMMIT, config: CONFIG, fetchImpl: mismatch.fetch, store: mismatch }),
    /immutable object conflict.*story-player\.js/,
  );
  assert.equal(mismatch.objects.has('stable/story-player.js'), false);

  const corrupt = fakeStore({ exists: true, configured: true, corruptAnonymous: true });
  await assert.rejects(
    publishCdn({ artifact: SCRIPT, commit: COMMIT, config: CONFIG, fetchImpl: corrupt.fetch, store: corrupt }),
    /anonymous SHA-256 mismatch/,
  );
  assert.equal(corrupt.objects.has('stable/story-player.js'), false);

  for (const existing of [
    object(SCRIPT, { cacheControl: 'public, max-age=1', contentType: 'text/javascript; charset=utf-8' }),
    object(SCRIPT, { cacheControl: IMMUTABLE_CACHE_CONTROL, contentType: 'application/octet-stream' }),
  ]) {
    const wrongHeaders = fakeStore({ exists: true, configured: true });
    wrongHeaders.objects.set(`builds/${COMMIT}/story-player.js`, existing);
    await assert.rejects(
      publishCdn({ artifact: SCRIPT, commit: COMMIT, config: CONFIG, fetchImpl: wrongHeaders.fetch, store: wrongHeaders }),
      /immutable object conflict.*story-player\.js/,
    );
    assert.equal(wrongHeaders.objects.has('stable/story-player.js'), false);
  }

  const metadataConflict = fakeStore({ exists: true, configured: true });
  metadataConflict.objects.set(`builds/${COMMIT}/build.json`, object('{}\n', {
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: 'application/json; charset=utf-8',
  }));
  await assert.rejects(
    publishCdn({ artifact: SCRIPT, commit: COMMIT, config: CONFIG, fetchImpl: metadataConflict.fetch, store: metadataConflict }),
    /immutable object conflict.*build\.json/,
  );
  assert.equal(metadataConflict.objects.has('stable/story-player.js'), false);
});

test('anonymous verification requires credential-free HEAD and GET with exact public headers', async () => {
  for (const headerOverrides of [
    { 'cache-control': 'private' },
    { 'content-type': 'application/octet-stream' },
    { 'content-length': '999' },
    { 'access-control-allow-origin': 'https://wrong.example' },
  ]) {
    const store = fakeStore({ exists: true, configured: true, headerOverrides });
    store.objects.set('stable/story-player.js', object(SCRIPT, {
      cacheControl: STABLE_CACHE_CONTROL,
      contentType: 'text/javascript; charset=utf-8',
    }));
    await assert.rejects(verifyPublicBytes({
      bytes: SCRIPT,
      cacheControl: STABLE_CACHE_CONTROL,
      config: CONFIG,
      contentType: 'text/javascript; charset=utf-8',
      fetchImpl: store.fetch,
      key: 'stable/story-player.js',
    }), /anonymous (?:Cache-Control|Content-Type|Content-Length|CORS) mismatch/);
    const calls = store.calls.filter(([name]) => name === 'fetch');
    assert.equal(calls[0][2].method, 'HEAD');
    assert.deepEqual(calls[0][2].headers, { Origin: 'https://story-player-verifier.invalid' });
    assert.equal(Object.hasOwn(calls[0][2].headers, 'Authorization'), false);
  }

  const getOnlyFailure = fakeStore({
    exists: true,
    configured: true,
    headerOverrides: (init) => (init.method === 'HEAD'
      ? {}
      : { 'access-control-allow-origin': 'https://wrong.example' }),
  });
  getOnlyFailure.objects.set('stable/story-player.js', object(SCRIPT, {
    cacheControl: STABLE_CACHE_CONTROL,
    contentType: 'text/javascript; charset=utf-8',
  }));
  await assert.rejects(verifyPublicBytes({
    bytes: SCRIPT,
    cacheControl: STABLE_CACHE_CONTROL,
    config: CONFIG,
    contentType: 'text/javascript; charset=utf-8',
    fetchImpl: getOnlyFailure.fetch,
    key: 'stable/story-player.js',
  }), /anonymous CORS mismatch/);
  const getOnlyCalls = getOnlyFailure.calls.filter(([name]) => name === 'fetch');
  assert.equal(getOnlyCalls.length, 2);
  assert.equal(getOnlyCalls[1][2].method, undefined);
  assert.deepEqual(getOnlyCalls[1][2].headers, { Origin: 'https://story-player-verifier.invalid' });
  assert.equal(Object.hasOwn(getOnlyCalls[1][2].headers, 'Authorization'), false);
});

test('the standalone verifier refuses correct bytes with the wrong CDN headers', async () => {
  for (const headerOverrides of [
    { 'cache-control': 'private' },
    { 'content-type': 'application/octet-stream' },
    { 'access-control-allow-origin': 'https://wrong.example' },
  ]) {
    const store = fakeStore({ exists: true, configured: true, headerOverrides });
    store.objects.set('stable/story-player.js', object(SCRIPT, {
      cacheControl: STABLE_CACHE_CONTROL,
      contentType: 'text/javascript; charset=utf-8',
    }));
    await assert.rejects(verifyCdnObject({
      config: CONFIG,
      fetchImpl: store.fetch,
      key: 'stable/story-player.js',
      sha256: sha256(SCRIPT),
    }), /anonymous (?:Cache-Control|Content-Type|CORS) mismatch/);
    const request = store.calls.find(([name]) => name === 'fetch');
    assert.equal(request[2].method, undefined);
    assert.deepEqual(request[2].headers, { Origin: 'https://story-player-verifier.invalid' });
    assert.equal(Object.hasOwn(request[2].headers, 'Authorization'), false);
  }
});

test('repository commands, protected workflows, and public examples describe only the CDN product', () => {
  const manifest = JSON.parse(read('package.json'));
  assert.deepEqual(manifest.scripts, {
    test: 'node --test "tests/*.test.mjs"',
    'build:cdn': 'node scripts/build-cdn.mjs',
    'publish:cdn': 'node scripts/publish-cdn.mjs',
    'rollback:cdn': 'node scripts/rollback-cdn.mjs',
    'test:e2e': 'playwright test',
    'verify:cdn': 'node scripts/verify-cdn.mjs',
    'verify:repository': 'node scripts/verify-repository.mjs',
  });
  assert.equal(manifest.devDependencies['@aws-sdk/client-s3'], '3.1111.0');
  assert.equal(manifest.devDependencies['@playwright/test'], '1.62.1');
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'release.yml')), false);

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /branches: \[main\]/);
  assert.match(ci, /playwright install --with-deps chromium/);
  assert.match(ci, /npm run test:e2e/);
  assert.doesNotMatch(ci, /npm pack|verify-package|verify-install/);
  // The RustFS push workflow is gone: the store this player is consumed from is
  // ClusterIP-only, so CI publishes a release and the cluster pulls. Asserted
  // ABSENT rather than merely unmentioned, so it cannot quietly come back and
  // give the repository two answers to "which bytes are live".
  assert.equal(
    fs.existsSync(path.join(ROOT, '.github', 'workflows', 'publish-cdn.yml')),
    false,
  );

  const deploy = read('.github/workflows/deploy-player.yml');
  // `production` is the deploy branch, and the trigger must stay `push`: a
  // `workflow_run` trigger only fires for the copy of a workflow on the DEFAULT
  // branch, so this file — which exists to live on `production` and react to
  // `production` — would silently never run.
  assert.match(deploy, /on:[\s\S]*?push:[\s\S]*?branches: \[production\]/);
  assert.doesNotMatch(deploy, /workflow_run:/);
  // The release must not be reachable without the full suite passing first.
  assert.match(deploy, /jobs:[\s\S]*verify:[\s\S]*release:/);
  assert.match(deploy, /needs: verify/);
  for (const gate of ['npm test', 'npm run test:e2e', 'npm run verify:repository']) {
    assert.ok(deploy.includes(gate), `deploy must gate on ${gate}`);
  }
  // A queued run from three merges ago must not overwrite `latest` with an
  // older player than the one already published.
  assert.match(deploy, /git fetch origin production --depth=1/);
  assert.match(deploy, /git rev-parse origin\/production/);
  // Two publishes racing would leave `latest` on a build nobody chose.
  assert.match(deploy, /cancel-in-progress: false/);
  assert.match(deploy, /permissions:[\s\S]*contents: write/);
  // Immutable first: `latest` must never name a build with no permanent copy.
  const immutableAt = deploy.indexOf('gh release create "build-$SHA"');
  const latestAt = deploy.indexOf('gh release upload latest');
  assert.ok(immutableAt > 0 && latestAt > 0 && immutableAt < latestAt,
    'the immutable release must be published before `latest` moves');
  // Both files, always together — `build.json` is what the consumer verifies the
  // script against, so a release carrying only one of them is unusable.
  assert.match(deploy, /gh release upload latest dist\/story-player\.js dist\/build\.json --clobber/);
  assert.match(deploy, /gh release create "build-\$SHA" dist\/story-player\.js dist\/build\.json/);
  // No store credential reaches this workflow.
  assert.doesNotMatch(deploy, /RUSTFS_|ACCESS_KEY|SECRET_KEY/);

  for (const document of [read('README.md'), read('docs/embedding.md')]) {
    assert.match(document, /createStoryPlayer/);
    assert.match(document, /assetBase/);
    assert.match(document, /<script type="module">/);
    assert.doesNotMatch(document, /<iframe\b|\.tgz|npm install/i);
  }
  assert.match(
    read('AGENTS.md'),
    /`STORY_PLAYER_COMMIT=<full-git-commit> npm run build:cdn`/,
  );
});

function fakeStore({
  configured = false, corruptAnonymous = false, exists = false, headerOverrides = {},
} = {}) {
  const store = {
    calls: [],
    cors: configured ? structuredClone(PUBLIC_READ_CORS) : null,
    exists,
    objects: new Map(),
    policy: configured ? structuredClone(PUBLIC_READ_POLICY) : null,
    async bucketExists() { this.calls.push(['bucketExists']); return this.exists; },
    async createBucket() { this.calls.push(['createBucket']); this.exists = true; },
    async getBucketPolicy() { this.calls.push(['getBucketPolicy']); return structuredClone(this.policy); },
    async putBucketPolicy(value) { this.calls.push(['putBucketPolicy', value]); this.policy = structuredClone(value); },
    async getBucketCors() { this.calls.push(['getBucketCors']); return structuredClone(this.cors); },
    async putBucketCors(value) { this.calls.push(['putBucketCors', value]); this.cors = structuredClone(value); },
    async putObject(input) {
      this.calls.push(['putObject', input]);
      if (input.createOnly && this.objects.has(input.key)) {
        const error = new Error('already exists');
        error.code = 'PreconditionFailed';
        throw error;
      }
      this.objects.set(input.key, object(input.body, input));
    },
    async getObject(key) { this.calls.push(['getObject', key]); return this.objects.get(key) ?? null; },
  };
  store.fetch = async (url, init = {}) => {
    store.calls.push(['fetch', String(url), init]);
    const marker = '/story-player/';
    const key = decodeURIComponent(String(url).split(marker)[1] ?? '');
    const value = store.objects.get(key);
    if (!value) return new Response('missing', { status: 404 });
    const body = corruptAnonymous && key.includes('/story-player.js')
      ? Uint8Array.from(value.body, (byte) => byte ^ 1)
      : value.body;
    const overrides = typeof headerOverrides === 'function'
      ? headerOverrides(init)
      : headerOverrides;
    const headers = {
      'access-control-allow-origin': '*',
      'cache-control': value.cacheControl,
      'content-length': String(body.length),
      'content-type': value.contentType,
      ...overrides,
    };
    return new Response(init.method === 'HEAD' ? null : body, {
      headers,
    });
  };
  return store;
}

function object(body, { cacheControl, contentType } = {}) {
  return {
    body: typeof body === 'string' ? new TextEncoder().encode(body) : Uint8Array.from(body),
    cacheControl,
    contentType,
  };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}
