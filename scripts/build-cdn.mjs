#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENTRY = path.join(ROOT, 'browser', 'cdn-entry.mjs');
const TEMPLATE = path.join(ROOT, 'browser', 'template.mjs');
const STYLES = path.join(ROOT, 'browser', 'styles.css');
const TEMPLATE_STYLESHEET = "const STYLESHEET = new URL('./styles.css', import.meta.url).href;";

export async function buildCdn({ commit, outfile = path.join(ROOT, 'dist', 'story-player.js') } = {}) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error('STORY_PLAYER_COMMIT must be a 40-character lowercase Git commit');
  }
  const target = path.resolve(outfile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = await build({
    absWorkingDir: ROOT,
    bundle: true,
    charset: 'utf8',
    define: { __STORY_PLAYER_COMMIT__: JSON.stringify(commit) },
    entryPoints: [ENTRY],
    format: 'iife',
    legalComments: 'none',
    metafile: true,
    minify: false,
    outfile: target,
    platform: 'browser',
    sourcemap: false,
    target: ['es2022'],
    plugins: [embeddedStylesheet()],
  });
  const bytes = fs.readFileSync(target);
  return Object.freeze({
    commit,
    outfile: target,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    inputs: Object.freeze(Object.keys(result.metafile.inputs).sort()),
  });
}

function embeddedStylesheet() {
  return {
    name: 'embedded-story-player-stylesheet',
    setup(esbuild) {
      esbuild.onLoad({ filter: /browser[/\\]template\.mjs$/ }, async ({ path: target }) => {
        if (path.resolve(target) !== TEMPLATE) return null;
        const [template, css] = await Promise.all([
          fs.promises.readFile(TEMPLATE, 'utf8'),
          fs.promises.readFile(STYLES, 'utf8'),
        ]);
        if (!template.includes(TEMPLATE_STYLESHEET)) {
          throw new Error('browser/template.mjs no longer exposes the stylesheet seam');
        }
        const dataUrl = `data:text/css;charset=utf-8,${encodeURIComponent(css)}`;
        return {
          contents: template.replace(TEMPLATE_STYLESHEET, `const STYLESHEET = ${JSON.stringify(dataUrl)};`),
          loader: 'js',
        };
      });
    },
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const report = await buildCdn({ commit: process.env.STORY_PLAYER_COMMIT });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
