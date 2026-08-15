#!/usr/bin/env node

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadStorageConfig, publicObjectUrl } from './storage-config.mjs';

const VERIFICATION_ORIGIN = 'https://story-player-verifier.invalid';

export async function verifyPublicBytes({
  bytes,
  cacheControl,
  config,
  contentType,
  fetchImpl = globalThis.fetch,
  key,
  sha256 = digest(bytes),
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const expected = toBytes(bytes);
  const url = publicObjectUrl(config, key);
  const head = await fetchImpl(url, verificationRequest({ method: 'HEAD' }));
  requireResponse(head, url, 'HEAD');
  verifyHeaders(head.headers, { bytes: expected.length, cacheControl, contentType, key });

  const response = await fetchImpl(url, verificationRequest());
  requireResponse(response, url, 'GET');
  verifyHeaders(response.headers, { bytes: expected.length, cacheControl, contentType, key });
  const actual = new Uint8Array(await response.arrayBuffer());
  if (actual.length !== expected.length) {
    throw new Error(`anonymous byte length mismatch for ${key}: expected ${expected.length}, got ${actual.length}`);
  }
  const actualSha = digest(actual);
  if (actualSha !== sha256) {
    throw new Error(`anonymous SHA-256 mismatch for ${key}: expected ${sha256}, got ${actualSha}`);
  }
  if (!equalBytes(actual, expected)) {
    throw new Error(`anonymous byte mismatch for ${key}`);
  }
  return Object.freeze({ bytes: actual.length, key, sha256, url });
}

export async function fetchPublicBytes({ config, fetchImpl = globalThis.fetch, key }) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const url = publicObjectUrl(config, key);
  const response = await fetchImpl(url, verificationRequest());
  requireResponse(response, url, 'GET');
  requireCors(response.headers, key);
  return Object.freeze({
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentLength: response.headers.get('content-length'),
    cacheControl: response.headers.get('cache-control'),
    contentType: response.headers.get('content-type'),
    url,
  });
}

export async function verifyCdnObject({ config, fetchImpl = globalThis.fetch, key, sha256 }) {
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) throw new Error('sha256 must be 64 lowercase hex characters');
  const expected = expectedHeaders(key);
  const fetched = await fetchPublicBytes({ config, fetchImpl, key });
  if (fetched.cacheControl !== expected.cacheControl) {
    throw new Error(`anonymous Cache-Control mismatch for ${key}`);
  }
  if (fetched.contentType !== expected.contentType) {
    throw new Error(`anonymous Content-Type mismatch for ${key}`);
  }
  if (fetched.contentLength !== String(fetched.bytes.length)) {
    throw new Error(`anonymous Content-Length mismatch for ${key}`);
  }
  const actual = digest(fetched.bytes);
  if (actual !== sha256) {
    throw new Error(`anonymous SHA-256 mismatch for ${key}: expected ${sha256}, got ${actual}`);
  }
  return Object.freeze({ bytes: fetched.bytes.length, key, sha256, url: fetched.url });
}

export function digest(bytes) {
  return crypto.createHash('sha256').update(toBytes(bytes)).digest('hex');
}

function requireResponse(response, url, method) {
  if (!response || response.ok !== true) {
    throw new Error(`anonymous ${method} failed for ${url}: HTTP ${response?.status ?? 'unknown'}`);
  }
}

function verifyHeaders(headers, { bytes, cacheControl, contentType, key }) {
  requireCors(headers, key);
  if (headers.get('cache-control') !== cacheControl) {
    throw new Error(`anonymous Cache-Control mismatch for ${key}`);
  }
  if (headers.get('content-type') !== contentType) {
    throw new Error(`anonymous Content-Type mismatch for ${key}`);
  }
  if (headers.get('content-length') !== String(bytes)) {
    throw new Error(`anonymous Content-Length mismatch for ${key}`);
  }
}

function requireCors(headers, key) {
  if (headers.get('access-control-allow-origin') !== '*') {
    throw new Error(`anonymous CORS mismatch for ${key}`);
  }
}

function verificationRequest(extra = {}) {
  return { cache: 'no-store', headers: { Origin: VERIFICATION_ORIGIN }, ...extra };
}

function expectedHeaders(key) {
  const immutable = /^builds\/[0-9a-f]{40}\/(?:story-player\.js|build\.json)$/.test(key ?? '');
  const stable = /^(?:stable)\/(?:story-player\.js|build\.json)$/.test(key ?? '');
  if (!immutable && !stable) throw new Error('object key must name a stable or immutable CDN object');
  return {
    cacheControl: immutable
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=60, must-revalidate',
    contentType: key.endsWith('.js')
      ? 'text/javascript; charset=utf-8'
      : 'application/json; charset=utf-8',
  };
}

function equalBytes(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('bytes must be a string, ArrayBuffer, or typed array');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const config = loadStorageConfig(process.env, { requireCredentials: false });
    const key = process.argv[2];
    const expectedSha = process.argv[3];
    if (!key || !/^[0-9a-f]{64}$/.test(expectedSha ?? '')) {
      throw new Error('usage: verify-cdn.mjs <object-key> <sha256>');
    }
    const report = await verifyCdnObject({ config, key, sha256: expectedSha });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
