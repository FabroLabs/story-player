#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertManifestContract,
  assertUnpackedContents,
} from './package-contract.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SECRET_PATH = /(^|\/)(?:\.env(?:\.|$)|\.npmrc$|npmrc$|\.git(?:\/|$)|id_rsa$|id_ed25519$)/i;
const SECRET_CONTENT = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /_authToken\s*=\s*(?!\$\{)[^\s]+/i,
  /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/,
];

const tarballArgument = process.argv[2] ?? singleTarball();
const tarball = path.resolve(ROOT, tarballArgument);
assert.ok(fs.existsSync(tarball), `tarball does not exist: ${tarball}`);

const [npmExecutable, npmArguments] = npmInvocation(['pack', '--dry-run', '--json']);
const dryRun = run(npmExecutable, npmArguments, {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_AUTH_TOKEN: process.env.NODE_AUTH_TOKEN ?? 'verification-placeholder',
  },
});
const packReport = parsePackReport(dryRun.stdout);
const packedFiles = packReport.files.map(({ path: packedPath }) => normalize(packedPath)).sort();

assert.equal(new Set(packedFiles).size, packedFiles.length, 'npm pack reported duplicate paths');
for (const packedPath of packedFiles) {
  assert.ok(isAllowlisted(packedPath), `npm pack included unallowlisted file: ${packedPath}`);
  assert.doesNotMatch(packedPath, SECRET_PATH, `npm pack included a secret-bearing path: ${packedPath}`);
}

const browserFiles = walkFiles(path.join(ROOT, 'browser'))
  .map((sourcePath) => normalize(path.relative(ROOT, sourcePath)))
  .sort();
assert.deepEqual(
  packedFiles.filter((packedPath) => packedPath.startsWith('browser/')),
  browserFiles,
  'packed browser tree differs from the complete source browser tree',
);

for (const required of [
  'browser/index.html',
  'browser/styles.css',
  'browser/host.mjs',
  'browser/shell/main.mjs',
  'browser/shell/performers.mjs',
  'browser/shell/urls.mjs',
  'browser/v0/app/main.mjs',
  'browser/v0/policy.mjs',
  'tooling/v0.mjs',
  'package.json',
  'README.md',
]) {
  assert.ok(packedFiles.includes(required), `npm pack omitted required file: ${required}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-verify-'));
try {
  run('tar', ['-xzf', tarball, '-C', temporary]);
  const unpacked = path.join(temporary, 'package');
  assert.ok(fs.statSync(unpacked).isDirectory(), 'tarball did not unpack to package/');
  assertUnpackedContents(unpacked, ROOT, packedFiles);

  const manifest = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8'));
  assertManifestContract(manifest, sourceManifest.version);

  scanForSecrets(unpacked);

  const consumer = path.join(temporary, 'consumer');
  const installed = path.join(consumer, 'node_modules', '@fabrolabs', 'story-player');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.renameSync(unpacked, installed);

  run(process.execPath, [
    '--input-type=module',
    '--eval',
    "const host = await import('@fabrolabs/story-player/host');"
      + "const tooling = await import('@fabrolabs/story-player/v0/tooling');"
      + "if (typeof host.resolveStoryUrl !== 'function') throw new Error('host export missing');"
      + "if (typeof tooling.PlaybackDirector !== 'function') throw new Error('tooling export missing');"
      + "if (!Object.isFrozen(tooling.V0_POLICY)) throw new Error('V0_POLICY is not frozen');",
  ], { cwd: consumer });
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write(`verified ${path.basename(tarball)} (${packedFiles.length} files)\n`);

function npmInvocation(args) {
  if (process.platform !== 'win32') return ['npm', args];

  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.ok(fs.existsSync(npmCli), `cannot locate npm CLI beside Node: ${npmCli}`);
  return [process.execPath, [npmCli, ...args]];
}

function singleTarball() {
  const tarballs = fs.readdirSync(ROOT).filter((name) => name.endsWith('.tgz')).sort();
  assert.equal(
    tarballs.length,
    1,
    `usage: node scripts/verify-package.mjs <tarball> (found ${tarballs.length} tarballs)`,
  );
  return tarballs[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function parsePackReport(output) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`npm pack --dry-run did not return JSON: ${error.message}\n${output}`);
  }
  assert.equal(parsed.length, 1, 'npm pack must report exactly one package');
  assert.ok(Array.isArray(parsed[0].files), 'npm pack report omitted its file list');
  return parsed[0];
}

function normalize(value) {
  return value.replaceAll('\\', '/').replace(/^package\//, '');
}

function isAllowlisted(packedPath) {
  return packedPath === 'package.json'
    || packedPath === 'README.md'
    || packedPath.startsWith('browser/')
    || packedPath.startsWith('tooling/');
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(target) : [target];
    });
}

function scanForSecrets(directory) {
  for (const target of walkFiles(directory)) {
    const relative = normalize(path.relative(directory, target));
    assert.doesNotMatch(relative, SECRET_PATH, `tarball contains secret-bearing path: ${relative}`);
    const contents = fs.readFileSync(target);
    if (contents.includes(0)) continue;
    const text = contents.toString('utf8');
    for (const pattern of SECRET_CONTENT) {
      assert.doesNotMatch(text, pattern, `tarball contains credential-like content in ${relative}`);
    }
  }
}
