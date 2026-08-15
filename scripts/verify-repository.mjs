#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  process.argv[2] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const REMOVED_NPM_PRODUCT = [
  'scripts/package-contract.mjs',
  'scripts/verify-package.mjs',
  'scripts/verify-install.mjs',
  'tests/package-contract.test.mjs',
  'tests/install-contract.test.mjs',
];
const SECRET_CONTENT = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /_authToken\s*=\s*(?!\$\{)[^\s]+/i,
  /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/,
];

try {
  assert.equal(fs.existsSync(path.join(ROOT, '.npmrc')), false, 'repository must not contain .npmrc');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(
    manifest.version,
    '0.0.0-development',
    'package version must remain fixed development metadata',
  );
  assert.equal(manifest.private, true, 'package must remain private development metadata');
  for (const field of ['files', 'exports', 'publishConfig', 'dependencies']) {
    assert.equal(Object.hasOwn(manifest, field), false, `package must not declare ${field}`);
  }
  assert.equal(manifest.scripts?.test, 'node --test "tests/*.test.mjs"');
  assert.equal(manifest.scripts?.['build:cdn'], 'node scripts/build-cdn.mjs');
  assert.equal(manifest.scripts?.['verify:repository'], 'node scripts/verify-repository.mjs');
  for (const name of ['esbuild', 'jsdom', 'react', 'react-dom']) {
    assert.equal(typeof manifest.devDependencies?.[name], 'string', `missing development dependency ${name}`);
  }
  for (const relative of REMOVED_NPM_PRODUCT) {
    assert.equal(fs.existsSync(path.join(ROOT, relative)), false, `removed npm product file returned: ${relative}`);
  }
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignored.includes('dist/'), 'dist/ must stay untracked');
  assertNoTrackedBuild();
  scanForSecrets();
  process.stdout.write('verified CDN source repository\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function assertNoTrackedBuild() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) return;
  const result = spawnSync('git', ['-C', ROOT, 'ls-files', '--', 'dist'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'could not inspect tracked build output');
  assert.equal(result.stdout.trim(), '', 'dist/ must not contain tracked build output');
}

function scanForSecrets() {
  for (const target of walkFiles(ROOT)) {
    const contents = fs.readFileSync(target);
    const relative = path.relative(ROOT, target).replaceAll('\\', '/');
    const sources = [contents.toString('utf8')];
    if (contents.includes(0)) sources.push(contents.toString('utf16le'));
    for (const source of sources) {
      for (const pattern of SECRET_CONTENT) {
        assert.doesNotMatch(source, pattern, `credential-like content in ${relative}`);
      }
    }
  }
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) => {
      if (['.git', 'node_modules', 'coverage', 'dist'].includes(entry.name)) return [];
      if (entry.isFile() && entry.name.endsWith('.tgz')) return [];
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(target) : [target];
    });
}
