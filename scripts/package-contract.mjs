import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export function assertManifestContract(manifest, expectedVersion) {
  assert.equal(manifest.name, '@fabrolabs/story-player');
  assert.equal(manifest.version, expectedVersion);
  assert.equal(manifest.license, 'UNLICENSED');
  assert.equal(Object.hasOwn(manifest, 'private'), false, 'package must not set private');
  assert.equal(
    Object.hasOwn(manifest, 'dependencies'),
    false,
    'package must not declare runtime dependencies',
  );
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/FabroLabs/story-player.git',
  });
  assert.deepEqual(manifest.files, ['browser/', 'tooling/']);
  assert.deepEqual(manifest.exports, {
    './host': './browser/host.mjs',
    './v0/tooling': './tooling/v0.mjs',
  });
  assert.deepEqual(
    manifest.publishConfig,
    { registry: 'https://npm.pkg.github.com', access: 'restricted' },
    'package publishConfig must remain private GitHub Packages',
  );
}

export function assertUnpackedContents(unpacked, source, expectedFiles) {
  const actualFiles = walkFiles(unpacked)
    .map((target) => normalize(path.relative(unpacked, target)))
    .sort();
  assert.deepEqual(
    actualFiles,
    [...expectedFiles].sort(),
    'tarball file list differs from npm pack report',
  );

  for (const relative of actualFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(unpacked, relative)),
      fs.readFileSync(path.join(source, relative)),
      `tarball content differs from source: ${relative}`,
    );
  }
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(target) : [target];
    });
}

function normalize(value) {
  return value.replaceAll('\\', '/');
}
