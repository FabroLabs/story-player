#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';

/**
 * What the picture is at one instant, printed.
 *
 * `stateAt` is a pure function, so the only way to disagree with it is to draw
 * it wrong — which is exactly the bug a canvas stage can have and a unit test
 * cannot see. This prints the answer for a bundle and a t so the browser can be
 * held against it: same story, same millisecond, same numbers or a defect.
 *
 *   node scripts/dump-state.mjs tests/fixtures/parity/golden_push_dusk.bundle.json 4700
 *   node scripts/dump-state.mjs tests/fixtures/parity/golden_push_dusk.bundle.json 4.7s
 *
 * Any built `story.json` works the same; the fixtures are what this checkout
 * has without the engine beside it.
 */

const [bundlePath, when] = process.argv.slice(2);
if (!bundlePath || when === undefined) {
  process.stderr.write('usage: node scripts/dump-state.mjs <story.json> <t_ms|t s>\n');
  process.exit(2);
}

const tMs = parseInstant(when);
if (tMs === null) {
  process.stderr.write(`not a time: ${JSON.stringify(when)} — use milliseconds, or seconds with a trailing s\n`);
  process.exit(2);
}

const bundle = JSON.parse(fs.readFileSync(path.resolve(bundlePath), 'utf8'));
const state = stateAt(compileTimeline(bundle), bundle, tMs);
// The plate carries every traced polygon on the scene, which is not what
// anybody diffs a frame against; its name is.
const { plate, ...picture } = state;
process.stdout.write(`${JSON.stringify({ story: bundle.title ?? null, ...picture }, null, 2)}\n`);

function parseInstant(value) {
  // `Number('')` is 0, so an empty argument would silently print the opening
  // frame as though somebody had asked for it.
  if (!value.trim()) return null;
  const seconds = /^(-?[\d.]+)s$/.exec(value);
  const number = Number(seconds ? seconds[1] : value);
  if (!Number.isFinite(number)) return null;
  return seconds ? number * 1000 : number;
}
