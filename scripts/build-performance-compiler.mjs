/** Bundle the shared compiler for an engine runtime without npm or source imports. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--out-dir') {
  throw new Error('Usage: node scripts/build-performance-compiler.mjs --out-dir DIRECTORY');
}
const directory = path.resolve(args[1]);
const result = await build({
  absWorkingDir: root,
  entryPoints: ['scripts/compile-performance.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  legalComments: 'none',
  write: false,
  metafile: true,
});
const bytes = result.outputFiles[0].contents;
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const filename = `compile-${sha256}.mjs`;
const target = path.join(directory, filename);
fs.mkdirSync(directory, { recursive: true });
try {
  fs.writeFileSync(target, bytes, { flag: 'wx' });
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  if (!fs.readFileSync(target).equals(Buffer.from(bytes))) {
    throw new Error('An existing immutable compiler artifact has different bytes');
  }
}
const sources = Object.keys(result.metafile.inputs).sort().map((name) => ({
  path: name,
  sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
}));
const receipt = { filename, sha256, bytes: bytes.length, sources };
fs.writeFileSync(path.join(directory, filename + '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify({ artifact: target, sha256, bytes: bytes.length }));
