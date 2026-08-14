#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  process.argv[2] ?? path.dirname(path.dirname(fileURLToPath(import.meta.url))),
);
const SECRET_CONTENT = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bnpm_[A-Za-z0-9]{20,}\b/,
  /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/,
];

try {
  assert.equal(
    fs.existsSync(path.join(ROOT, '.npmrc')),
    false,
    'repository must not contain .npmrc',
  );
  const release = read('.github/workflows/release.yml');
  assert.match(
    release,
    /^on:\n  release:\n    types: \[published\]\n\npermissions:/m,
    'release workflow must run only for a published GitHub Release',
  );
  assert.match(
    release,
    /^permissions:\n  contents: write\n$/m,
    'release workflow permissions must be top-level contents write only',
  );
  assert.equal(
    [...release.matchAll(/^\s*permissions:$/gm)].length,
    1,
    'release workflow permissions must be top-level contents write only',
  );
  assert.match(release, /^          node-version: 22$/m, 'release workflow must pin Node 22');
  assert.ok(
    release.includes(
      'run: node -e "if (process.env.RELEASE_TAG !== \'v\' + require(\'./package.json\').version) process.exit(1)"',
    ),
    'release workflow must refuse a tag that differs from the package version',
  );
  assert.match(
    release,
    /- uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github\.event\.release\.tag_name \}\}/,
    "release workflow must check out and validate the event's exact tag",
  );
  requireUsesSteps(
    release,
    ['actions/checkout@v4', 'actions/setup-node@v4'],
    "release workflow must check out and validate the event's exact tag",
  );
  assert.match(
    release,
    /- name: Verify release tag\n        env:\n          RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}\n        run:/,
    "release workflow must check out and validate the event's exact tag",
  );
  assert.doesNotMatch(
    release,
    /npm publish|npm\.pkg\.github|NODE_AUTH_TOKEN|registry-url:|scope:/,
    'release workflow must upload the public tgz without npm registry publication',
  );
  assert.ok(
    release.includes(
      '- name: Upload public release artifact\n'
        + '        env:\n'
        + '          GH_TOKEN: ${{ github.token }}\n'
        + '          RELEASE_TAG: ${{ github.event.release.tag_name }}\n'
        + '        run: gh release upload "$RELEASE_TAG" ./fabrolabs-story-player-*.tgz',
    ),
    'release upload must use only the ephemeral GitHub Actions token',
  );
  assert.doesNotMatch(
    release,
    /gh release upload[^\n]*--clobber/,
    'release workflow must not overwrite an immutable release asset',
  );
  assert.match(
    release,
    /- name: Verify anonymous release install\n        env:\n          RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}\n        run: node scripts\/verify-install\.mjs "https:\/\/github\.com\/\$\{\{ github\.repository \}\}\/releases\/download\/\$\{RELEASE_TAG\}\/fabrolabs-story-player-\$\{RELEASE_TAG#v\}\.tgz"/,
    'anonymous release verification must not receive credentials',
  );
  requireRunSteps(release, [
    'node -e "if (process.env.RELEASE_TAG !== \'v\' + require(\'./package.json\').version) process.exit(1)"',
    'npm ci --ignore-scripts',
    'node --test "tests/*.test.mjs"',
    'npm pack --dry-run --json',
    'npm pack --json',
    'node scripts/verify-package.mjs',
    'node scripts/verify-install.mjs ./fabrolabs-story-player-*.tgz',
    'gh release upload "$RELEASE_TAG" ./fabrolabs-story-player-*.tgz',
    'node scripts/verify-install.mjs "https://github.com/${{ github.repository }}/releases/download/${RELEASE_TAG}/fabrolabs-story-player-${RELEASE_TAG#v}.tgz"',
  ], 'release workflow must prove the package before uploading it');
  assert.doesNotMatch(
    release,
    /^\s*continue-on-error:/m,
    'release proof steps may not continue on error',
  );
  assert.doesNotMatch(release, /^\s*if:/m, 'release steps may not be conditional');
  assert.doesNotMatch(release, /^\s*shell:/m, 'release steps may not override their shell');
  const ci = read('.github/workflows/ci.yml');
  assert.match(
    ci,
    /^permissions:\n  contents: read\n$/m,
    'CI workflow permissions must be contents read only',
  );
  assert.equal(
    [...ci.matchAll(/^\s*permissions:$/gm)].length,
    1,
    'CI workflow permissions must be contents read only',
  );
  requireUsesSteps(
    ci,
    ['actions/checkout@v4', 'actions/setup-node@v4'],
    'CI must use one checkout followed by one Node setup',
  );
  assert.match(ci, /^          node-version: 22$/m, 'CI must pin Node 22');
  assert.doesNotMatch(
    ci,
    /npm\.pkg\.github|NODE_AUTH_TOKEN|registry-url:|scope:/,
    'CI must not configure npm registry authentication',
  );
  requireRunSteps(ci, [
    'npm ci --ignore-scripts',
    'node --test "tests/*.test.mjs"',
    'npm pack --dry-run --json',
    'npm pack --json',
    'node scripts/verify-package.mjs',
    'node scripts/verify-install.mjs ./fabrolabs-story-player-*.tgz',
  ], 'CI must run the complete package proof in order');
  assert.doesNotMatch(ci, /^\s*continue-on-error:/m, 'CI proof steps may not continue on error');
  assert.doesNotMatch(ci, /^\s*if:/m, 'CI steps may not be conditional');
  assert.doesNotMatch(ci, /^\s*shell:/m, 'CI steps may not override their shell');
  scanForSecrets();
  process.stdout.write('verified repository release configuration\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replaceAll('\r\n', '\n');
}

function requireRunSteps(source, expected, message) {
  const actual = [...source.matchAll(/^\s+(?:-\s+)?run: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(actual, expected, message);
}

function requireUsesSteps(source, expected, message) {
  const actual = [...source.matchAll(/^\s+- uses: (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(actual, expected, message);
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
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'coverage') return [];
      if (entry.isFile() && entry.name.endsWith('.tgz')) return [];
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(target) : [target];
    });
}
