import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const VERIFIER = fileURLToPath(new URL('../scripts/verify-repository.mjs', import.meta.url));

test('the tracked repository release configuration passes its executable gate', () => {
  const result = verify(ROOT);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /verified repository release configuration/);
});

test('the repository gate locates its own checkout when no root is supplied', () => {
  const result = spawnSync(process.execPath, [VERIFIER], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the repository gate requires registry-free npm configuration', (context) => {
  const fixture = fixtureRoot(context);
  fs.writeFileSync(path.join(fixture, '.npmrc'), '@fabrolabs:registry=https://npm.pkg.github.com\n');

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /repository must not contain \.npmrc/);
});

test('the repository gate rejects credential-like tracked content', (context) => {
  const fixture = fixtureRoot(context);
  for (const credential of [
    ...['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((prefix) => `${prefix}_${'A'.repeat(36)}`),
    'github_pat_' + 'B'.repeat(82),
    'npm_' + 'C'.repeat(36),
    '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nnot-a-real-key\n',
  ]) {
    fs.writeFileSync(path.join(fixture, 'README.md'), `token=${credential}\n`);
    const result = verify(fixture);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /credential-like content in README\.md/);
  }
});

test('the repository gate scans UTF-16LE tracked text', (context) => {
  const fixture = fixtureRoot(context);
  const credential = 'ghp_' + 'D'.repeat(36);
  fs.writeFileSync(path.join(fixture, 'README.md'), Buffer.from(`token=${credential}\n`, 'utf16le'));

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /credential-like content in README\.md/);
});

test('the release gate requires one human-published GitHub Release trigger', (context) => {
  for (const [from, to] of [
    ['types: [published]', 'types: [created]'],
    ['    types: [published]\n', "    types: [published]\n  push:\n    tags: ['v*']\n"],
  ]) {
    const fixture = fixtureRoot(context);
    mutateWorkflow(fixture, 'release.yml', from, to);

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /release workflow must run only for a published GitHub Release/);
  }
});

test('the release gate checks out and validates the event tag exactly once', (context) => {
  for (const [from, to] of [
    ['ref: ${{ github.event.release.tag_name }}', 'ref: main'],
    ['RELEASE_TAG: ${{ github.event.release.tag_name }}', 'RELEASE_TAG: v0.1.1'],
    [
      '      - uses: actions/setup-node@v4\n',
      '      - uses: actions/checkout@v4\n        with:\n          ref: main\n'
        + '      - uses: actions/setup-node@v4\n',
    ],
  ]) {
    const fixture = fixtureRoot(context);
    mutateWorkflow(fixture, 'release.yml', from, to);

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /release workflow must check out and validate the event's exact tag/);
  }
});

test('the release gate requires every proof before the immutable asset upload', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = workflowPath(fixture, 'release.yml');
  const source = fs.readFileSync(workflow, 'utf8');
  const verifier = '      - run: node scripts/verify-install.mjs ./fabrolabs-story-player-*.tgz\n';
  const upload = uploadBlock();
  fs.writeFileSync(workflow, source.replace(verifier + upload, upload + verifier));

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must prove the package before uploading it/);
});

test('the release gate uploads with only the ephemeral Actions token and never clobbers', (context) => {
  for (const [from, to, message] of [
    ['GH_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}', /ephemeral GitHub Actions token/],
    [
      'gh release upload "$RELEASE_TAG" ./fabrolabs-story-player-*.tgz',
      'gh release upload "$RELEASE_TAG" ./fabrolabs-story-player-*.tgz --clobber',
      /must not overwrite an immutable release asset/,
    ],
  ]) {
    const fixture = fixtureRoot(context);
    mutateWorkflow(fixture, 'release.yml', from, to);

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, message);
  }
});

test('the release gate forbids npm registry publication', (context) => {
  const fixture = fixtureRoot(context);
  mutateWorkflow(
    fixture,
    'release.yml',
    uploadBlock(),
    '      - run: npm publish --ignore-scripts\n'
      + '        env:\n'
      + '          NODE_AUTH_TOKEN: ${{ github.token }}\n',
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must upload the public tgz without npm registry publication/);
});

test('the release gate proves the uploaded URL without release credentials', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = workflowPath(fixture, 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - name: Verify anonymous release install\n',
      '      - name: Verify anonymous release install\n'
        + '        env:\n'
        + '          GH_TOKEN: ${{ github.token }}\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /anonymous release verification must not receive credentials/);
});

test('release proof steps fail closed', (context) => {
  for (const [from, to, message] of [
    [
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        continue-on-error: true\n',
      /release proof steps may not continue on error/,
    ],
    [
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        if: always()\n',
      /release steps may not be conditional/,
    ],
    [
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        shell: bash {0} || true\n',
      /release steps may not override their shell/,
    ],
  ]) {
    const fixture = fixtureRoot(context);
    mutateWorkflow(fixture, 'release.yml', from, to);

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, message);
  }
});

test('the release gate grants only top-level contents write permission', (context) => {
  for (const [from, to] of [
    ['contents: write', 'contents: read\n  packages: write'],
    [
      '  release:\n    runs-on: ubuntu-latest\n',
      '  release:\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest\n',
    ],
  ]) {
    const fixture = fixtureRoot(context);
    mutateWorkflow(fixture, 'release.yml', from, to);

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /release workflow permissions must be top-level contents write only/);
  }
});

test('CI stays read-only on Node 22 and proves the installable archive', (context) => {
  for (const [from, to, message] of [
    ['node-version: 22', 'node-version: 20', /CI must pin Node 22/],
    ['contents: read', 'contents: write', /CI workflow permissions must be contents read only/],
    [
      '          cache: npm\n',
      '          cache: npm\n          registry-url: https://npm.pkg.github.com\n',
      /CI must not configure npm registry authentication/,
    ],
    ['      - run: node scripts/verify-install.mjs ./fabrolabs-story-player-*.tgz\n', '', /CI must run the complete package proof in order/],
  ]) {
    const fixture = fixtureRoot(context);
    mutateWorkflow(fixture, 'ci.yml', from, to);

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, message);
  }
});

function uploadBlock() {
  return '      - name: Upload public release artifact\n'
    + '        env:\n'
    + '          GH_TOKEN: ${{ github.token }}\n'
    + '          RELEASE_TAG: ${{ github.event.release.tag_name }}\n'
    + '        run: gh release upload "$RELEASE_TAG" ./fabrolabs-story-player-*.tgz\n';
}

function verify(root) {
  return spawnSync(process.execPath, [VERIFIER, root], { encoding: 'utf8' });
}

function workflowPath(root, name) {
  return path.join(root, '.github', 'workflows', name);
}

function mutateWorkflow(root, name, from, to) {
  const workflow = workflowPath(root, name);
  const source = fs.readFileSync(workflow, 'utf8');
  assert.ok(source.includes(from), `fixture source did not contain ${JSON.stringify(from)}`);
  fs.writeFileSync(workflow, source.replace(from, to));
}

function fixtureRoot(context) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-repository-contract-'));
  context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
  fs.cpSync(path.join(ROOT, '.github'), path.join(fixture, '.github'), { recursive: true });
  return fixture;
}
