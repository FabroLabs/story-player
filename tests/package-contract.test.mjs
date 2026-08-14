import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertManifestContract,
  assertUnpackedContents,
} from '../scripts/package-contract.mjs';

test('the tarball verifier rejects an archive missing a file from the pack report', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-contract-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-source-'));
  try {
    fs.mkdirSync(path.join(temporary, 'browser'), { recursive: true });
    fs.mkdirSync(path.join(source, 'browser'), { recursive: true });
    fs.writeFileSync(path.join(temporary, 'package.json'), '{}');
    fs.writeFileSync(path.join(temporary, 'browser', 'host.mjs'), 'export {};');
    fs.writeFileSync(path.join(source, 'package.json'), '{}');
    fs.writeFileSync(path.join(source, 'browser', 'host.mjs'), 'export {};');
    fs.writeFileSync(path.join(source, 'browser', 'index.html'), '<!doctype html>');

    assert.throws(
      () => assertUnpackedContents(temporary, source, [
        'browser/host.mjs',
        'browser/index.html',
        'package.json',
      ]),
      /tarball file list differs from npm pack report/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('the tarball verifier rejects an archive whose file bytes differ from source', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-contract-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-source-'));
  try {
    fs.writeFileSync(path.join(temporary, 'package.json'), '{"name":"wrong"}');
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"right"}');

    assert.throws(
      () => assertUnpackedContents(temporary, source, ['package.json']),
      /tarball content differs from source: package\.json/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('the manifest contract refuses release-blocking or misrouted metadata', () => {
  const valid = {
    name: '@fabrolabs/story-player',
    version: '0.1.1',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/FabroLabs/story-player.git' },
    files: ['browser/', 'tooling/'],
    exports: {
      './host': './browser/host.mjs',
      './v0/tooling': './tooling/v0.mjs',
    },
  };

  assert.doesNotThrow(() => assertManifestContract(valid, '0.1.1'));
  assert.throws(
    () => assertManifestContract({ ...valid, private: true }, '0.1.1'),
    /must not set private/,
  );
  assert.throws(
    () => assertManifestContract({ ...valid, dependencies: { leftpad: '1.0.0' } }, '0.1.1'),
    /must not declare runtime dependencies/,
  );
  assert.throws(
    () => assertManifestContract({ ...valid, license: 'UNLICENSED' }, '0.1.1'),
    /MIT/,
  );
  assert.throws(
    () => assertManifestContract({
      ...valid,
      publishConfig: { registry: 'https://npm.pkg.github.com', access: 'restricted' },
    }, '0.1.1'),
    /must not set publishConfig/,
  );
});
