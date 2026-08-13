import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { PERFORMERS, performerFor } from '../browser/shell/performers.mjs';

const read = (path) => fs.readFileSync(new URL(`../browser/${path}`, import.meta.url), 'utf8');
const exists = (path) => fs.existsSync(new URL(`../browser/${path}`, import.meta.url));
const bare = (specifier) => specifier.replace(/^\.\//, '');
// performer specifiers are written for the importing module, which lives in shell/
const fromShell = (specifier) => new URL(specifier, new URL('../browser/shell/', import.meta.url));
const SHELL = ['shell/main.mjs', 'shell/performers.mjs', 'shell/urls.mjs'];

test('a v0 bundle is handed to the v0 performer', () => {
  assert.equal(performerFor({ storylang_version: 0, title: 'ruby' }), '../v0/app/main.mjs');
});

test('a version this player does not know is refused by name, never guessed', () => {
  // The three shapes a bundle arrives in when it was not written for us: a
  // later language, a version that is a string (so not written by our builder,
  // and the case a plain object table would have accepted), and a file that
  // never carried one. Playing a story under the wrong rules is worse than not
  // playing it, so all three refuse — and the message names the version, which
  // is the whole of what the viewer is told.
  for (const [version, message] of [
    [99, 'bundle version 99 unknown to this player (knows: 0)'],
    ['0', 'bundle version "0" unknown to this player (knows: 0)'],
    [undefined, 'bundle version undefined unknown to this player (knows: 0)'],
  ]) {
    assert.throws(() => performerFor({ storylang_version: version }), { message });
  }

  assert.throws(() => performerFor({}), { message: /unknown to this player/ });
});

test('every performer in the table is a module that exports the entry the shell destructures', () => {
  // A dispatch path is only walked by a browser, so both halves of a wrong
  // table — a path that is not there, and a module that no longer exports
  // `performStory` — would otherwise ship with both suites green.
  for (const [version, specifier] of PERFORMERS) {
    assert.ok(fs.existsSync(fromShell(specifier)), `performer for version ${version} is missing: ${specifier}`);
    assert.match(
      fs.readFileSync(fromShell(specifier), 'utf8'),
      /export (?:async )?function performStory\(/,
      `performer for version ${version} no longer exports performStory`,
    );
  }
});

test('the shell chooses the performer through the gate, and stays version-free', () => {
  // The regression this whole feature exists to prevent: drop `performerFor`
  // from the import and every test above still passes while a v1 bundle plays
  // under v0 rules. Nothing in node can import `main.mjs` (window, document,
  // fetch at module scope), so the wiring is pinned at the source, the way
  // policy-pins.test.mjs pins the renderer's fallback — if the shape changes,
  // this stops matching and says so instead of going quiet.
  const shell = read('shell/main.mjs');

  assert.match(shell, /const performer = performerFor\(story\)/, 'main.mjs no longer asks the gate which performer plays this bundle');
  assert.match(shell, /await import\(performer\)/, 'main.mjs no longer imports the performer the gate chose');
  assert.doesNotMatch(shell, /import\(['"]/, 'main.mjs dynamic-imports a literal path, which bypasses the gate');

  for (const file of SHELL) {
    // both spellings a version import could take from shell/: './v0' before the
    // move, '../v0' after it — pinning only one would blind the guard
    assert.doesNotMatch(read(file), /from '\.\.?\/v0/, `${file} imports a version directly — the shell must stay version-free`);
  }
});

test('the shell resolves the story path before fetching it', () => {
  // `?story=` is repository-root-relative, not player-relative — that is the
  // whole reason resolveStoryUrl exists and moved up here with the shell.
  // `fetch(storyPath)` instead would resolve against `player/` and 404 every
  // story ever built, with both suites green.
  const shell = read('shell/main.mjs');

  assert.match(shell, /resolveStoryUrl\(storyPath, window\.location\.href\)/, 'main.mjs no longer resolves ?story= against the page');
  assert.match(shell, /fetch\(storyUrl\)/, 'main.mjs fetches something other than the resolved url');
  assert.match(
    shell,
    /performStory\(story, \{ storyUrl, assetBase \}\)/,
    'main.mjs no longer hands the trusted asset base to the selected performer',
  );
  assert.doesNotMatch(
    shell,
    /params\.get\(['"]asset_base['"]\)/,
    'main.mjs reads asset_base from the attacker-controlled query string',
  );
});

test('the two sides of a failure keep their own surfaces', () => {
  // The rule this feature is built on has two halves, and only one of them is
  // visible from either file alone: before handover there is no drawer, so the
  // log button is withdrawn; after handover the drawer is live, so the performer
  // writes the failure into it and the button stays. Delete either line and a
  // bedtime story fails with its only inspection tool either dead or missing —
  // silently, since no browser runs in this suite.
  const shell = read('shell/main.mjs');
  const performer = read('v0/app/main.mjs');

  assert.match(shell, /handedOver = true;\s+await performStory\(/, 'main.mjs no longer marks the handover immediately before it happens — a performer that throws in setup would lose the drawer holding its own trace');
  assert.match(shell, /if \(!handedOver\) document\.getElementById\('debug-toggle'\)\.hidden = true;/, 'main.mjs no longer withdraws the log button from a bundle that never opened');
  assert.match(performer, /catch \(error\)[\s\S]*log\.warning\(\{ type: 'bundle'/, 'the v0 performer no longer leaves a structured trace of a setup failure');
  const projection = performer.indexOf('resolveStoryAssets(story, assetBase)');
  assert.ok(projection !== -1, 'the performer no longer makes the whole-story asset projection');
  for (const consumer of ['new StageRenderer', 'new AudioDirector', 'new PlaybackDirector']) {
    assert.ok(
      projection < performer.indexOf(consumer),
      `${consumer} is constructed before hostile keys are refused`,
    );
  }

  // `hidden` is a weak UA rule: any `display` on .quiet-button beats it, which
  // is why .end-overlay needed its own. Without this line the withdrawal above
  // is one stylesheet edit from being a no-op.
  assert.match(read('styles.css'), /\.quiet-button\[hidden\]\s*\{[^}]*display:\s*none/, 'styles.css no longer forces the hidden log button to actually disappear');
});

test('index.html loads the dispatcher and carries every id the player looks up', () => {
  // The entry line no suite could reach: get it wrong and the page is blank
  // with both suites green. The ids are the same class of failure one layer
  // down — every one of them is fetched by hand, and a missing one throws
  // inside the code that was supposed to report the problem. Collected from
  // the sources rather than listed here, so this cannot go stale.
  const page = read('index.html');
  const script = page.match(/<script type="module" src="([^"]+)"/);
  const styles = page.match(/<link rel="stylesheet" href="([^"]+)"/);

  assert.ok(script, 'index.html has no module script tag — re-read it by hand');
  assert.ok(styles, 'index.html has no stylesheet link — re-read it by hand');
  assert.equal(script[1], './shell/main.mjs', 'index.html no longer boots the version dispatcher');
  assert.match(
    page,
    /<meta name="storytime-asset-base" content="__STORYTIME_ASSET_BASE__">/,
    'index.html no longer carries the server-injected asset-base slot',
  );
  for (const href of [script[1], styles[1]]) {
    assert.ok(exists(bare(href)), `index.html names a file that is not there: ${href}`);
  }

  const ids = new Set();
  for (const source of ['shell/main.mjs', 'v0/app/main.mjs']) {
    for (const [, id] of read(source).matchAll(/(?:getElementById|byId)\('([^']+)'\)/g)) ids.add(id);
  }
  assert.ok(ids.size > 10, 'found almost no element ids in the player sources — this reader is stale');
  for (const id of [...ids].sort()) {
    assert.ok(page.includes(`id="${id}"`), `index.html no longer carries #${id}, which the player fetches by hand`);
  }
});
