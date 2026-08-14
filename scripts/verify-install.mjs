#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CREDENTIAL_ENVIRONMENT = new Set([
  'CI_JOB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
]);

export function normalizePackageSource(source, cwd = process.cwd()) {
  assert.ok(source, 'usage: node scripts/verify-install.mjs <package.tgz|https-url>');

  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    const url = new URL(source);
    assert.ok(
      url.protocol === 'https:'
        && !url.username
        && !url.password
        && !url.search
        && !url.hash
        && url.pathname.endsWith('.tgz'),
      'remote package source must be a credential-free public HTTPS .tgz URL',
    );
    return url.href;
  }

  assert.ok(source.endsWith('.tgz'), 'local package source must be a .tgz archive');
  return path.resolve(cwd, source);
}

export function sanitizedInstallEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => {
    if (CREDENTIAL_ENVIRONMENT.has(name.toUpperCase())) return false;
    const normalized = name.toLowerCase();
    return !(normalized.startsWith('npm_config_')
      && (normalized.includes('auth')
        || normalized.includes('token')
        || normalized.endsWith('userconfig')
        || normalized.endsWith('globalconfig')));
  }));
}

export function installEnvironment(temporary, environment = process.env) {
  return {
    ...sanitizedInstallEnvironment(environment),
    NPM_CONFIG_CACHE: path.join(temporary, 'npm-cache'),
    NPM_CONFIG_GLOBALCONFIG: path.join(temporary, 'global.npmrc'),
    NPM_CONFIG_USERCONFIG: path.join(temporary, 'user.npmrc'),
  };
}

export function verifyInstall(sourceArgument) {
  const source = normalizePackageSource(sourceArgument);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-install-'));
  try {
    const consumer = path.join(temporary, 'consumer');
    const installEnv = installEnvironment(temporary);
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    fs.writeFileSync(installEnv.NPM_CONFIG_GLOBALCONFIG, '');
    fs.writeFileSync(installEnv.NPM_CONFIG_USERCONFIG, '');

    run('npm', ['install', '--ignore-scripts', '--no-package-lock', '--no-save', '--', source], {
      cwd: consumer,
      env: installEnv,
    });

    const installed = path.join(consumer, 'node_modules', '@fabrolabs', 'story-player');
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@fabrolabs/story-player');
    for (const required of [
      'browser/index.html',
      'browser/styles.css',
      'browser/host.mjs',
      'tooling/v0.mjs',
    ]) {
      assert.ok(fs.statSync(path.join(installed, required)).isFile(), `installed package omitted ${required}`);
    }

    run(process.execPath, [
      '--input-type=module',
      '--eval',
      "const host = await import('@fabrolabs/story-player/host');"
        + "const tooling = await import('@fabrolabs/story-player/v0/tooling');"
        + "if (typeof host.resolveStoryUrl !== 'function') throw new Error('host export missing');"
        + "if (typeof tooling.PlaybackDirector !== 'function') throw new Error('tooling export missing');"
        + "if (!Object.isFrozen(tooling.V0_POLICY)) throw new Error('V0_POLICY is not frozen');",
    ], { cwd: consumer, env: sanitizedInstallEnvironment() });

    process.stdout.write(`verified install of @fabrolabs/story-player@${manifest.version} from ${source}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    verifyInstall(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
