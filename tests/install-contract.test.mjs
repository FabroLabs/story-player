import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  installEnvironment,
  normalizePackageSource,
  sanitizedInstallEnvironment,
} from '../scripts/verify-install.mjs';

test('the install verifier accepts provider-neutral HTTPS release assets', () => {
  for (const source of [
    'https://github.com/FabroLabs/story-player/releases/download/v0.1.1/fabrolabs-story-player-0.1.1.tgz',
    'https://gitlab.example.com/fabrolabs/story-player/-/releases/v0.1.1/downloads/fabrolabs-story-player-0.1.1.tgz',
  ]) {
    assert.equal(normalizePackageSource(source, '/unused'), source);
  }
});

test('the install verifier resolves local archives for clean temporary consumers', () => {
  assert.equal(
    normalizePackageSource('./fabrolabs-story-player-0.1.1.tgz', '/source'),
    path.join('/source', 'fabrolabs-story-player-0.1.1.tgz'),
  );
});

test('the install verifier refuses insecure or credential-bearing remote sources', () => {
  for (const source of [
    'http://downloads.example.com/story-player.tgz',
    'https://token@downloads.example.com/story-player.tgz',
    'https://downloads.example.com/story-player.tgz?private_token=secret',
    'https://downloads.example.com/story-player.tgz#token',
  ]) {
    assert.throws(() => normalizePackageSource(source, '/unused'), /public HTTPS/);
  }
});

test('the install verifier removes registry and hosting credentials from npm', () => {
  const sanitized = sanitizedInstallEnvironment({
    PATH: '/bin',
    NODE_AUTH_TOKEN: 'npm-secret',
    NPM_TOKEN: 'npm-secret',
    GH_TOKEN: 'github-secret',
    GITHUB_TOKEN: 'github-secret',
    CI_JOB_TOKEN: 'gitlab-secret',
    npm_config__authToken: 'npm-secret',
    NPM_CONFIG_USERCONFIG: '/credential-bearing/npmrc',
  });

  assert.deepEqual(sanitized, { PATH: '/bin' });
});

test('the install verifier gives npm distinct empty user and global configurations', () => {
  const environment = installEnvironment('/temporary/install', { PATH: '/bin' });

  assert.equal(environment.PATH, '/bin');
  assert.equal(environment.NPM_CONFIG_USERCONFIG, '/temporary/install/user.npmrc');
  assert.equal(environment.NPM_CONFIG_GLOBALCONFIG, '/temporary/install/global.npmrc');
  assert.notEqual(environment.NPM_CONFIG_USERCONFIG, environment.NPM_CONFIG_GLOBALCONFIG);
  assert.equal(environment.NPM_CONFIG_CACHE, '/temporary/install/npm-cache');
});
