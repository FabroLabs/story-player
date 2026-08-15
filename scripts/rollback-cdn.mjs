#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMMUTABLE_CACHE_CONTROL,
  createS3Store,
  promoteStable,
} from './publish-cdn.mjs';
import { loadStorageConfig, storageSummary } from './storage-config.mjs';
import { digest, fetchPublicBytes } from './verify-cdn.mjs';

const JS_TYPE = 'text/javascript; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

export async function rollbackCdn({
  commit,
  config,
  fetchImpl = globalThis.fetch,
  log = defaultLog,
  store,
}) {
  requireCommit(commit);
  const scriptKey = `builds/${commit}/story-player.js`;
  const metadataKey = `builds/${commit}/build.json`;
  const metadataObject = await fetchPublicBytes({ config, fetchImpl, key: metadataKey });
  requireImmutableHeaders(metadataObject, metadataKey, JSON_TYPE);
  const metadata = parseMetadata(metadataObject.bytes, { commit, scriptKey });
  const scriptObject = await fetchPublicBytes({ config, fetchImpl, key: scriptKey });
  requireImmutableHeaders(scriptObject, scriptKey, JS_TYPE);
  if (scriptObject.bytes.length !== metadata.script.bytes) {
    throw new Error(`immutable build byte length mismatch for ${scriptKey}`);
  }
  const sha256 = digest(scriptObject.bytes);
  if (sha256 !== metadata.script.sha256) {
    throw new Error(`anonymous SHA-256 mismatch for immutable build ${scriptKey}`);
  }
  if (!new TextDecoder().decode(scriptObject.bytes).includes(commit)) {
    throw new Error(`immutable build ${scriptKey} does not contain its declared Git commit`);
  }

  log({ event: 'rollback-source-verified', ...storageSummary(config), bytes: scriptObject.bytes.length, commit, sha256 });
  await promoteStable({
    config,
    fetchImpl,
    metadata: metadataObject.bytes,
    script: scriptObject.bytes,
    sha256,
    store,
  });
  log({ event: 'rollback-promoted', bytes: scriptObject.bytes.length, commit, key: 'stable/story-player.js', sha256 });
  return Object.freeze({
    bucket: config.bucket,
    bytes: scriptObject.bytes.length,
    commit,
    sha256,
    stableKey: 'stable/story-player.js',
  });
}

function parseMetadata(bytes, { commit, scriptKey }) {
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('immutable metadata is not valid JSON');
  }
  if (!hasExactKeys(value, ['schema', 'commit', 'script'])
      || value.schema !== 1
      || value.commit !== commit
      || !hasExactKeys(value.script, ['key', 'bytes', 'sha256'])
      || value.script.key !== scriptKey
      || !Number.isSafeInteger(value.script.bytes)
      || value.script.bytes < 1
      || !/^[0-9a-f]{64}$/.test(value.script.sha256 ?? '')) {
    throw new Error(`immutable metadata does not describe ${commit}`);
  }
  return value;
}

function requireImmutableHeaders(value, key, contentType) {
  if (value.cacheControl !== IMMUTABLE_CACHE_CONTROL || value.contentType !== contentType) {
    throw new Error(`immutable metadata or build headers are invalid for ${key}`);
  }
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function requireCommit(commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error('rollback commit must be a 40-character lowercase Git commit');
  }
}

function defaultLog(entry) {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const config = loadStorageConfig();
    const commit = process.argv[2];
    const report = await rollbackCdn({
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
