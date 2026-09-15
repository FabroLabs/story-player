import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('local build rejects a non-JavaScript output before overwriting its bytes with the receipt', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'player-local-output-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const outfile = path.join(directory, 'existing-artifact');
  fs.writeFileSync(outfile, 'preserve existing bytes');
  const result = spawnSync(process.execPath, ['scripts/build-local.mjs', outfile], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output must end in \.js/);
  assert.equal(fs.readFileSync(outfile, 'utf8'), 'preserve existing bytes');
  assert.deepEqual(fs.readdirSync(directory), ['existing-artifact']);
});
