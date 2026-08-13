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

test('the repository gate rejects a literal npm credential', (context) => {
  const fixture = fixtureRoot(context);
  fs.writeFileSync(
    path.join(fixture, '.npmrc'),
    '@fabrolabs:registry=https://npm.pkg.github.com\n'
      + '//npm.pkg.github.com/:_authToken=literal-credential\n',
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /\.npmrc must reference NODE_AUTH_TOKEN without containing a credential/);
});

test('the repository gate rejects credential-like content outside npm configuration', (context) => {
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

test('the repository gate scans UTF-16LE tracked text instead of treating it as binary', (context) => {
  const fixture = fixtureRoot(context);
  const credential = 'ghp_' + 'D'.repeat(36);
  fs.writeFileSync(path.join(fixture, 'README.md'), Buffer.from(`token=${credential}\n`, 'utf16le'));

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /credential-like content in README\.md/);
});

test('the repository gate requires a human-published GitHub Release event', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('types: [published]', 'types: [created]'),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must run only for a published GitHub Release/);
});

test('the repository gate rejects an additional release workflow trigger', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '    types: [published]\n',
      "    types: [published]\n  push:\n    tags: ['v*']\n",
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must run only for a published GitHub Release/);
});

test('the repository gate requires the release tag to match the package version', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      'run: node -e "if (process.env.RELEASE_TAG !== \'v\' + require(\'./package.json\').version) process.exit(1)"',
      'run: node -e "process.exit(0)"',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must refuse a tag that differs from the package version/);
});

test('the repository gate checks out and validates the human Release tag', (context) => {
  for (const [from, to] of [
    ['ref: ${{ github.event.release.tag_name }}', 'ref: main'],
    ['RELEASE_TAG: ${{ github.event.release.tag_name }}', 'RELEASE_TAG: v0.1.0'],
  ]) {
    const fixture = fixtureRoot(context);
    const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
    fs.writeFileSync(workflow, fs.readFileSync(workflow, 'utf8').replace(from, to));

    const result = verify(fixture);

    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /release workflow must check out and validate the event's exact tag/);
  }
});

test('the repository gate rejects a second checkout that can replace tagged source', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - uses: actions/setup-node@v4\n',
      '      - uses: actions/checkout@v4\n        with:\n          ref: main\n'
        + '      - uses: actions/setup-node@v4\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must use one checkout followed by one Node setup/);
});

test('the repository gate requires every release proof before npm publish', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  const source = fs.readFileSync(workflow, 'utf8');
  const verifier = '      - run: node scripts/verify-package.mjs\n';
  const publish = '      - run: npm publish --ignore-scripts\n'
    + '        env:\n'
    + '          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n';
  fs.writeFileSync(workflow, source.replace(verifier + publish, publish + verifier));

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must run every package proof before npm publish/);
});

test('the repository gate forbids release proofs from continuing after failure', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        continue-on-error: true\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release proof steps may not continue on error/);
});

test('the repository gate forbids conditional release execution', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
      '          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        if: always()\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release steps may not be conditional/);
});

test('the repository gate rejects a custom release shell that masks failures', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        shell: bash {0} || true\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release steps may not override their shell/);
});

test('the repository gate rejects shell-masked release proof failures', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs || true\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must run every package proof before npm publish/);
});

test('the repository gate limits release permissions to package publication', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('packages: write', 'packages: read'),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow permissions must be contents read and packages write/);
});

test('the repository gate rejects job-level release permission overrides', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '  publish:\n    runs-on: ubuntu-latest\n',
      '  publish:\n    permissions:\n      contents: write\n      packages: write\n    runs-on: ubuntu-latest\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow may define permissions only once at top level/);
});

test('the repository gate binds publish authentication to the ephemeral Actions token', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('secrets.GITHUB_TOKEN', 'secrets.NPM_TOKEN'),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /npm publish must use only the ephemeral GitHub Actions token/);
});

test('the repository gate pins CI to Node 22', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('node-version: 22', 'node-version: 20'),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI must pin Node 22/);
});

test('the repository gate keeps CI read-only', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('contents: read', 'contents: write'),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI workflow permissions must be contents read only/);
});

test('the repository gate pins release execution to Node 22', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'release.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('node-version: 22', 'node-version: 20'),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /release workflow must pin Node 22/);
});

test('the repository gate requires the complete CI package proof', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace('      - run: node scripts/verify-package.mjs\n', ''),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI must run the complete package proof in order/);
});

test('the repository gate rejects a second CI checkout that can replace PR source', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - uses: actions/setup-node@v4\n',
      '      - uses: actions/checkout@v4\n        with:\n          ref: main\n'
        + '      - uses: actions/setup-node@v4\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI must use one checkout followed by one Node setup/);
});

test('the repository gate forbids CI proofs from continuing after failure', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        continue-on-error: true\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI proof steps may not continue on error/);
});

test('the repository gate forbids conditional CI proof execution', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        if: always()\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI steps may not be conditional/);
});

test('the repository gate rejects a custom CI shell that masks failures', (context) => {
  const fixture = fixtureRoot(context);
  const workflow = path.join(fixture, '.github', 'workflows', 'ci.yml');
  fs.writeFileSync(
    workflow,
    fs.readFileSync(workflow, 'utf8').replace(
      '      - run: node scripts/verify-package.mjs\n',
      '      - run: node scripts/verify-package.mjs\n        shell: bash {0} || true\n',
    ),
  );

  const result = verify(fixture);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /CI steps may not override their shell/);
});

function verify(root) {
  return spawnSync(process.execPath, [VERIFIER, root], { encoding: 'utf8' });
}

function fixtureRoot(context) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-repository-contract-'));
  context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.copyFileSync(path.join(ROOT, '.npmrc'), path.join(fixture, '.npmrc'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(fixture, 'package.json'));
  fs.cpSync(path.join(ROOT, '.github'), path.join(fixture, '.github'), { recursive: true });
  return fixture;
}
