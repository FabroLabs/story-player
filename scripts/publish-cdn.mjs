#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  CreateBucketCommand,
  GetBucketCorsCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { loadStorageConfig, storageSummary } from './storage-config.mjs';
import { digest, verifyPublicBytes } from './verify-cdn.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JS_TYPE = 'text/javascript; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const STABLE_CACHE_CONTROL = 'public, max-age=60, must-revalidate';
export const PUBLIC_READ_POLICY = deepFreeze({
  Version: '2012-10-17',
  Statement: [{
    Sid: 'AnonymousStoryPlayerRead',
    Effect: 'Allow',
    Principal: '*',
    Action: ['s3:GetObject'],
    Resource: ['arn:aws:s3:::story-player/*'],
  }],
});
export const PUBLIC_READ_CORS = deepFreeze([{
  AllowedHeaders: ['*'],
  AllowedMethods: ['GET', 'HEAD'],
  AllowedOrigins: ['*'],
  ExposeHeaders: ['Cache-Control', 'Content-Length', 'Content-Type', 'ETag'],
  MaxAgeSeconds: 3600,
}]);

export async function ensurePublicBucket({ store, config }) {
  if (!await store.bucketExists()) await store.createBucket();
  const policy = await store.getBucketPolicy();
  if (policy === null) await store.putBucketPolicy(PUBLIC_READ_POLICY);
  else if (!isDeepStrictEqual(policy, PUBLIC_READ_POLICY)) {
    throw new Error('refusing conflicting public bucket policy');
  }
  const cors = await store.getBucketCors();
  if (cors === null) await store.putBucketCors(PUBLIC_READ_CORS);
  else if (!isDeepStrictEqual(cors, PUBLIC_READ_CORS)) {
    throw new Error('refusing conflicting public CORS');
  }
  return storageSummary(config);
}

export async function publishCdn({
  artifact,
  commit,
  config,
  fetchImpl = globalThis.fetch,
  log = defaultLog,
  store,
}) {
  requireCommit(commit);
  const script = toBytes(artifact);
  if (!new TextDecoder().decode(script).includes(commit)) {
    throw new Error('artifact does not contain its declared Git commit');
  }
  const sha256 = digest(script);
  const immutablePrefix = `builds/${commit}`;
  const immutableKey = `${immutablePrefix}/story-player.js`;
  const immutableMetadataKey = `${immutablePrefix}/build.json`;
  const stableKey = 'stable/story-player.js';
  const metadata = metadataBytes({ bytes: script.length, commit, key: immutableKey, sha256 });

  await ensurePublicBucket({ store, config });
  log({ event: 'bucket-ready', ...storageSummary(config) });
  await putImmutable(store, {
    body: script,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: JS_TYPE,
    key: immutableKey,
  });
  await putImmutable(store, {
    body: metadata,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: JSON_TYPE,
    key: immutableMetadataKey,
  });
  await verifyPublicBytes({
    bytes: script,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    config,
    contentType: JS_TYPE,
    fetchImpl,
    key: immutableKey,
    sha256,
  });
  await verifyPublicBytes({
    bytes: metadata,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    config,
    contentType: JSON_TYPE,
    fetchImpl,
    key: immutableMetadataKey,
  });
  log({ event: 'immutable-verified', bytes: script.length, commit, key: immutableKey, sha256 });

  await promoteStable({ config, fetchImpl, metadata, script, sha256, store });
  log({ event: 'stable-promoted', bytes: script.length, commit, key: stableKey, sha256 });
  return Object.freeze({
    bucket: config.bucket,
    bytes: script.length,
    commit,
    immutableKey,
    sha256,
    stableKey,
  });
}

export async function promoteStable({ config, fetchImpl = globalThis.fetch, metadata, script, sha256, store }) {
  const scriptBytes = toBytes(script);
  const metadataValue = toBytes(metadata);
  await store.putObject({
    body: scriptBytes,
    cacheControl: STABLE_CACHE_CONTROL,
    contentType: JS_TYPE,
    createOnly: false,
    key: 'stable/story-player.js',
  });
  await verifyPublicBytes({
    bytes: scriptBytes,
    cacheControl: STABLE_CACHE_CONTROL,
    config,
    contentType: JS_TYPE,
    fetchImpl,
    key: 'stable/story-player.js',
    sha256,
  });
  await store.putObject({
    body: metadataValue,
    cacheControl: STABLE_CACHE_CONTROL,
    contentType: JSON_TYPE,
    createOnly: false,
    key: 'stable/build.json',
  });
  await verifyPublicBytes({
    bytes: metadataValue,
    cacheControl: STABLE_CACHE_CONTROL,
    config,
    contentType: JSON_TYPE,
    fetchImpl,
    key: 'stable/build.json',
  });
}

export function createS3Store(config) {
  const client = new S3Client({
    endpoint: config.endpoint,
    forcePathStyle: true,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const bucket = config.bucket;
  return Object.freeze({
    async bucketExists() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async createBucket() {
      const input = { Bucket: bucket };
      if (config.region !== 'us-east-1') {
        input.CreateBucketConfiguration = { LocationConstraint: config.region };
      }
      await client.send(new CreateBucketCommand(input));
    },
    async getBucketPolicy() {
      try {
        const result = await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        return JSON.parse(result.Policy);
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async putBucketPolicy(policy) {
      await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
    },
    async getBucketCors() {
      try {
        const result = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
        return result.CORSRules ?? [];
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async putBucketCors(cors) {
      await client.send(new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: { CORSRules: cors },
      }));
    },
    async putObject({ body, cacheControl, contentType, createOnly, key }) {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        CacheControl: cacheControl,
        ContentType: contentType,
        ...(createOnly ? { IfNoneMatch: '*' } : {}),
      }));
    },
    async getObject(key) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return {
          body: new Uint8Array(await result.Body.transformToByteArray()),
          cacheControl: result.CacheControl,
          contentType: result.ContentType,
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
  });
}

async function putImmutable(store, input) {
  try {
    await store.putObject({ ...input, createOnly: true });
  } catch (error) {
    if (!isPrecondition(error)) throw error;
    const existing = await store.getObject(input.key);
    if (existing && equalBytes(existing.body, input.body)
        && existing.cacheControl === input.cacheControl
        && existing.contentType === input.contentType) return;
    throw new Error(`immutable object conflict at ${input.key}`);
  }
}

function metadataBytes({ bytes, commit, key, sha256 }) {
  return new TextEncoder().encode(`${JSON.stringify({
    schema: 1,
    commit,
    script: { key, bytes, sha256 },
  }, null, 2)}\n`);
}

function requireCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error('STORY_PLAYER_COMMIT must be a 40-character lowercase Git commit');
  }
}

function isMissing(error) {
  return error?.$metadata?.httpStatusCode === 404
    || ['NoSuchBucket', 'NoSuchCORSConfiguration', 'NoSuchKey', 'NoSuchBucketPolicy', 'NotFound']
      .some((code) => code === error?.name || code === error?.code);
}

function isPrecondition(error) {
  return error?.$metadata?.httpStatusCode === 412
    || ['PreconditionFailed', 'ConditionalRequestConflict']
      .some((code) => code === error?.name || code === error?.code);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('artifact must be a string, ArrayBuffer, or typed array');
}

function equalBytes(left, right) {
  const actual = toBytes(left);
  const expected = toBytes(right);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function defaultLog(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const config = loadStorageConfig();
    const commit = process.env.STORY_PLAYER_COMMIT;
    const artifact = fs.readFileSync(path.join(ROOT, 'dist', 'story-player.js'));
    const report = await publishCdn({
      artifact,
      commit,
      config,
      store: createS3Store(config),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
