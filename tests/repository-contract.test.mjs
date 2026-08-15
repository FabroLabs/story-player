import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERIFIER = fileURLToPath(new URL('../scripts/verify-repository.mjs', import.meta.url));

test('the development-only CDN repository passes its executable gate', () => {
  const result = verify(ROOT);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /verified CDN source repository/);
});

test('the repository gate refuses npm-product metadata and a tracked build directory', (t) => {
  for (const mutate of [
    (root) => mutateManifest(root, (manifest) => { manifest.private = false; }),
    (root) => mutateManifest(root, (manifest) => { manifest.version = '9.9.9'; }),
    (root) => mutateManifest(root, (manifest) => { manifest.exports = { '.': './browser/embed.mjs' }; }),
    (root) => fs.writeFileSync(path.join(root, 'scripts', 'verify-package.mjs'), 'export {};\n'),
    (root) => fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n'),
    trackGeneratedBuild,
  ]) {
    const fixture = fixtureRoot(t);
    mutate(fixture);
    const result = verify(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

test('the repository gate still rejects registry credentials and credential-like content', (t) => {
  for (const mutate of [
    (root) => fs.writeFileSync(
      path.join(root, '.npmrc'),
      `//registry/:${['_auth', 'Token=secret'].join('')}\n`,
    ),
    (root) => fs.writeFileSync(path.join(root, 'README.md'), `token=ghp_${'A'.repeat(36)}\n`),
  ]) {
    const fixture = fixtureRoot(t);
    mutate(fixture);
    const result = verify(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
  }
});

function verify(root) {
  return spawnSync(process.execPath, [VERIFIER, root], { encoding: 'utf8' });
}

function trackGeneratedBuild(root) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dist', 'story-player.js'), 'stale build\n');
  for (const args of [['init', '--quiet'], ['add', '-f', 'dist/story-player.js']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
}

function mutateManifest(root, change) {
  const target = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
  change(manifest);
  fs.writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
}

function fixtureRoot(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-repository-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.cpSync(ROOT, fixture, {
    recursive: true,
    filter: (source) => !['.git', 'node_modules', 'dist'].includes(path.basename(source)),
  });
  return fixture;
}
