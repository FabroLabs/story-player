import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCdn } from '../scripts/build-cdn.mjs';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

test('the classic build is deterministic, self-contained, and dependency-free at runtime', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-cdn-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = path.join(directory, 'first.js');
  const second = path.join(directory, 'second.js');

  const firstReport = await buildCdn({ commit: COMMIT, outfile: first });
  const secondReport = await buildCdn({ commit: COMMIT, outfile: second });
  const bytes = fs.readFileSync(first);
  assert.deepEqual(bytes, fs.readFileSync(second));
  assert.equal(firstReport.commit, COMMIT);
  assert.equal(firstReport.sha256, secondReport.sha256);
  assert.equal(firstReport.bytes, bytes.length);
  assert.equal(firstReport.inputs.some((input) => input.includes('node_modules')), false);

  const source = bytes.toString('utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|[{'"*])/);
  assert.doesNotMatch(source, /storyUrl|<iframe|browser\/index\.html/);
  assert.match(source, /\.player-shell/);
  assert.doesNotMatch(source, /styles\.css/);
  const embedded = source.match(/data:text\/css;charset=utf-8,([^"]+)/)?.[1];
  assert.ok(embedded, 'classic artifact omitted its CSS data URL');
  assert.equal(
    decodeURIComponent(embedded),
    fs.readFileSync(new URL('../browser/styles.css', import.meta.url), 'utf8'),
    'classic artifact embedded stale or incomplete CSS',
  );
  for (const required of ['browser/performers.mjs', 'browser/v0/app/main.mjs', 'tooling/v0.mjs']) {
    assert.ok(firstReport.inputs.includes(required), `classic artifact omitted ${required}`);
  }
});

test('the build refuses anything except a full lowercase Git commit', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'story-player-cdn-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const commit of ['', 'abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(41)]) {
    await assert.rejects(
      buildCdn({ commit, outfile: path.join(directory, 'story-player.js') }),
      /40-character lowercase Git commit/,
    );
  }
});
