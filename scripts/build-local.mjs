#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCdn } from './build-cdn.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
function files(dir) {
  return fs
    .readdirSync(path.join(root, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const rel = path.posix.join(dir, entry.name);
      return entry.isDirectory() ? files(rel) : [rel];
    })
    .sort();
}
const inputs = [
  ...files('browser'),
  ...files('tooling'),
  'package.json',
  'package-lock.json',
  'scripts/build-cdn.mjs',
  'scripts/build-local.mjs',
].sort();
const source = createHash('sha256');
for (const name of inputs) {
  source.update(name);
  source.update('\0');
  source.update(fs.readFileSync(path.join(root, name)));
  source.update('\0');
}
const source_sha256 = source.digest('hex');
const output = path.resolve(
  process.argv[2] ?? path.join(root, 'dist', 'wht-player.local.js'),
);
if (!output.endsWith('.js')) throw new Error('Local build output must end in .js');
const report = await buildCdn({
  commit,
  sourceSha256: source_sha256,
  outfile: output,
});
const receipt = {
  kind: 'local-uncommitted',
  contract: 'v0',
  commit,
  uncommitted: true,
  source_sha256,
  sha256: report.sha256,
  bytes: report.bytes,
  inputs,
};
fs.writeFileSync(
  output.replace(/\.js$/, '.json'),
  JSON.stringify(receipt, null, 2) + '\n',
);
process.stdout.write(JSON.stringify(receipt) + '\n');
