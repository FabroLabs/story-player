#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';
import * as esbuild from 'esbuild';

import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';

/**
 * The counting board, as a contact sheet.
 *
 * The board is the one thing in the player that is a BUILD rather than a
 * picture: counters arrive one by one, the newest wears the ring, the badge
 * climbs, the equation is spelled out a term at a time. A single screenshot
 * says almost nothing about it, and `npm test` — which pins the draw list,
 * rightly — says nothing at all about whether the result is a board a child
 * would understand. So this paints the same build at several instants, side by
 * side, and leaves the judgement to whoever opens the file.
 *
 * It is repository tooling, not a test: dev-only like `test:e2e`, run by hand,
 * asserting nothing. What it prints with `--dump` is the part worth diffing —
 * the draw list is the pure answer, the pixels are only how it looked.
 *
 * The plate never appears here. It is a DOM `<video>` behind the canvas, not
 * something `paintDrawList` draws, so each cell stands on a flat ground in its
 * place. A change that has to be judged against a real plate (the frost, for
 * one) needs a mounted player, not this sheet.
 */

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE_DIRECTORY = path.join(ROOT, 'tests', 'fixtures', 'board');
const DEFAULT_OUT = path.join('ignored', 'board-sheet.png');

// Four instants into the build and then the end of the board's scene. They are
// spaced to straddle the stages rather than to sample evenly: the first lands
// while the opening counter is still growing, the last after everything the
// schedule has to say has been said.
const OFFSETS_MS = [150, 600, 1400, 3200];
// What the last cell of a row is showing, named after whatever ended the board.
const CLOSING_CAPTION = Object.freeze({
  slate: 'the next board replaces it',
  scene: 'the scene cuts',
  end: 'the story ends',
});
// The same three, said as a cause, for a board that never outlived its closer.
const CLOSING_REASON = Object.freeze({
  slate: 'replaced by the next board',
  scene: 'cut by its scene',
  end: 'ended with the story',
});
const STAGE = [1920, 1080];
const DEFAULT_SCALE = 0.35;
// Stands in for the plate, so the frosted panel has something to be frosted
// over. Any flat colour would do; this one is a night sky's worth of dark.
const GROUND_INK = '#14213d';

const ENTRY = `
import { paintDrawList } from './browser/v0/app/stage/canvas-stage.mjs';
import { buildDrawList } from './browser/v0/app/stage/draw-list.mjs';
import { stateAt } from './browser/v0/core/state/state.mjs';

globalThis.renderBoardSheet = (jobs, scale) => jobs.map((job, row) => job.instants.map((tMs, column) => {
  const canvas = document.getElementById('c' + row + '_' + column);
  const picture = stateAt(job.timeline, job.bundle, tMs);
  const list = buildDrawList(picture);
  paintDrawList(canvas.getContext('2d'), list, { scale });
  return {
    commands: list.commands.filter((command) => command.op === 'slate' || command.op === 'ring'),
    // The state core keeps this array precisely so a client cannot quietly
    // believe a picture it had to repair. Carried back rather than dropped.
    warnings: picture.warnings ?? [],
  };
}));
`;

const options = readArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(usage());
} else {
  await writeSheet(options);
}

async function writeSheet({ bundles, out, scale, dump }) {
  const skipped = [];
  const jobs = bundles.flatMap((file) => jobsFor(file, skipped));
  if (jobs.length === 0) throw new Error(nothingToDraw(bundles, skipped));

  const [width, height] = [Math.round(STAGE[0] * scale), Math.round(STAGE[1] * scale)];
  const { outputFiles } = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: 'board-sheet-entry.mjs', loader: 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: pageWidth(width, jobs), height: 900 } });
  // Anything the page says went wrong is a FAILURE, not a note beside a
  // success line. The sheet's whole worth is that somebody looks at it and
  // believes it, and a broken renderer draws a perfectly plausible empty board.
  const broke = [];
  page.on('pageerror', (error) => broke.push(`page threw: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') broke.push(`page logged an error: ${message.text()}`);
    else process.stderr.write(`page: ${message.text()}\n`);
  });

  await page.setContent(sheetHtml(jobs, width, height, outputFiles[0].text));
  const painted = await page.evaluate(
    ([handed, factor]) => globalThis.renderBoardSheet(handed, factor),
    [jobs.map(({ timeline, bundle, instants }) => ({ timeline, bundle, instants })), scale],
  );

  // Judged BEFORE the screenshot, so a run that would have lied leaves no
  // picture behind to be found and believed later.
  broke.push(...unusable(jobs, painted));
  if (broke.length > 0) {
    await browser.close();
    throw new Error(`the sheet would have lied — ${broke.length} problem(s):\n  ${broke.join('\n  ')}`);
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await page.screenshot({ path: path.resolve(out), fullPage: true });
  await browser.close();

  if (dump) dumpCommands(jobs, painted);
  for (const reason of skipped) process.stderr.write(`not on the sheet — ${reason}\n`);
  // Progress goes to stderr so `--dump` leaves a clean JSON-lines stream on
  // stdout for `jq` and for diffing two runs.
  process.stderr.write(`${jobs.length} board(s), ${jobs[0].instants.length} instants each → ${out}\n`);
}

/**
 * The checks that stand between a broken renderer and a signed-off phase.
 *
 * This has happened: a policy key the draw list still asked for was renamed, so
 * every number in the board's geometry came back `NaN`, `paintSlate` skipped
 * each zero-width card, and the tool wrote a captioned sheet of empty stages and
 * exited 0. Nothing but the human eye caught it, and only because the emptiness
 * was total. These raise it as the failure it is.
 */
function unusable(jobs, painted) {
  const problems = [];
  for (const [row, job] of jobs.entries()) {
    for (const [column, cell] of painted[row].entries()) {
      const where = `${job.stem} slate@${job.op.t_ms} cell ${job.captions[column]}`;
      for (const warning of cell.warnings) {
        problems.push(`${where}: the state core warns ${JSON.stringify(warning)}`);
      }
      for (const command of cell.commands) {
        const broken = notFinite(command);
        if (broken.length > 0) {
          problems.push(`${where}: ${command.op} carries unusable ${broken.join(', ')} — the`
            + ' renderer skips what it cannot size, so this cell is blank rather than wrong-looking');
        }
      }
    }
    // The build cells are the row; the last one is the closing and is meant to
    // be empty. A row that drew no board at all in ANY of them is not a board.
    const build = painted[row].slice(0, -1);
    if (!build.some((cell) => cell.commands.some((command) => command.op === 'slate'))) {
      problems.push(`${job.stem} slate@${job.op.t_ms} (${payloadOf(job.op)}): no board in any `
        + 'build cell — this row would be five empty stages under a board\'s caption');
    }
  }
  return problems;
}

// `null` is what a NaN becomes on the way back from the page, so both count —
// except where the contract SAYS null: a board draws no running total until its
// first counter is half there, and no equation at all until the counters have
// finished, and both say so with `null`. Those two are the whole early half of
// every build, so reading them as broken numbers condemns the cells that show
// the board arriving — which is what this sheet exists to show.
function notFinite(command) {
  // Declared here rather than beside the module's other constants: the script
  // does its work at the top, before a `const` further down has been initialised.
  const nullable = new Set(['badge', 'equation']);
  const bad = [];
  const walk = (value, trail, key) => {
    if (value === null) {
      if (!nullable.has(key)) bad.push(trail);
    } else if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${trail}[${index}]`, key));
    else if (typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) walk(item, trail ? `${trail}.${name}` : name, name);
    } else if (typeof value === 'number' && !Number.isFinite(value)) bad.push(trail);
  };
  walk(command, '', '');
  return bad;
}

/**
 * One job per board, not per bundle: a lesson raises the board several times,
 * and each of those builds is its own thing to look at.
 *
 * A row is the life of ONE board, which is why its instants are clamped rather
 * than simply offset. A real counting lesson raises `slate 1`, `slate 2` and
 * `slate 3` about half a second apart; offsetting blindly paints the second and
 * third board under the first one's caption, and the sheet a reader trusts most
 * is then the one telling them the loudest lie.
 *
 * Whatever this declines to draw it says out loud through `skipped`. A board
 * dropped in silence is the same lie one step further back: the reader counts
 * the rows, finds the number they expected, and never learns that one of them
 * belongs to a different story than they think.
 */
function jobsFor(file, skipped) {
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  const timeline = compileTimeline(bundle);
  const stem = path.basename(file).replace(/\.bundle\.json$/, '');
  const jobs = [];

  for (const [index, event] of timeline.events.entries()) {
    if (event.source !== 'stage' || event.op !== 'slate') continue;
    const closing = closingAfter(timeline, index);
    // Replaced or cut on its own millisecond. `stateAt` has already folded
    // whatever took its place by then, so every instant this row could ask for
    // answers with somebody else's board — and there is no instant at which a
    // viewer saw this one. Nothing to paint, and saying so is the only honest
    // thing left.
    if (closing.tMs <= event.t_ms) {
      skipped.push(`${stem} slate@${event.t_ms} ${payloadOf(event)}: ${CLOSING_REASON[closing.op]}`
        + ' on its own millisecond — never visible, so there is no instant to paint');
      continue;
    }

    const held = closing.tMs - 1;
    const instants = [...OFFSETS_MS.map((offset) => Math.min(event.t_ms + offset, held)), closing.tMs];

    jobs.push({
      stem,
      bundle,
      timeline,
      op: event,
      heldMs: closing.tMs - event.t_ms,
      instants,
      captions: [
        // Labelled from the instant actually painted, never from the offset
        // asked for: a clamped cell must not claim to be 3.2 s into a board
        // that only lasted half of one.
        ...instants.slice(0, -1).map((tMs) => `+${tMs - event.t_ms} ms`),
        CLOSING_CAPTION[closing.op],
      ],
    });
  }

  if (!timeline.events.some((event) => event.source === 'stage' && event.op === 'slate')) {
    skipped.push(`${stem}: no board — ${refusals(timeline) ?? 'this bundle raises no slate'}`);
  }
  return jobs;
}

/**
 * Why the compiler threw a `slate` away, in its own words.
 *
 * Without this the tool says "no slate in 1 bundle(s)" over a story that plainly
 * has one, and sends the reader hunting through a `.story` file for a line that
 * is right there — while the real answer, `slate-count-unusable`, sits unread in
 * the timeline it just compiled.
 */
function refusals(timeline) {
  const said = timeline.events
    .filter((event) => event.kind === 'warning' && String(event.detail?.policy ?? '').startsWith('slate'))
    .map((event) => `line ${event.line} ${JSON.stringify(event.detail)}`);
  return said.length > 0 ? `the compiler refused it — ${said.join('; ')}` : null;
}

function nothingToDraw(bundles, skipped) {
  return [
    `no board to draw in ${bundles.length} bundle(s):`,
    ...skipped.map((reason) => `  ${reason}`),
  ].join('\n');
}

/**
 * What ends this board, and when.
 *
 * Positional, not a time comparison: a scene cut costs no time, so a board
 * raised as the last step of its scene is cleared on its own millisecond, and
 * `t_ms > slate` would skip that cut and describe the NEXT scene under this
 * board's caption. The event stream is ordered, so the index answers it.
 */
function closingAfter(timeline, index) {
  for (const event of timeline.events.slice(index + 1)) {
    if (event.source !== 'stage') continue;
    if (event.op === 'slate' || event.op === 'scene' || event.op === 'end') {
      return { tMs: event.t_ms, op: event.op };
    }
  }
  return { tMs: timeline.duration_ms, op: 'end' };
}

function dumpCommands(jobs, painted) {
  for (const [row, job] of jobs.entries()) {
    for (const [column, tMs] of job.instants.entries()) {
      process.stdout.write(`${JSON.stringify({
        bundle: job.stem, slate_ms: job.op.t_ms, t_ms: tMs, commands: painted[row][column],
      })}\n`);
    }
  }
}

function pageWidth(cellWidth, jobs) {
  const columns = Math.max(...jobs.map((job) => job.instants.length));
  return (columns * cellWidth) + ((columns - 1) * 12) + 48;
}

function sheetHtml(jobs, width, height, script) {
  const rows = jobs.map((job, row) => `
    <section>
      <h2>${escapeHtml(job.stem)} — slate at ${job.op.t_ms} ms, held ${job.heldMs} ms — ${escapeHtml(payloadOf(job.op))}</h2>
      <div class="row">
        ${job.instants.map((tMs, column) => `
          <figure>
            <canvas id="c${row}_${column}" width="${width}" height="${height}"></canvas>
            <figcaption>${job.captions[column]} <span>${tMs} ms</span></figcaption>
          </figure>
        `).join('')}
      </div>
    </section>
  `).join('');

  return `
<style>
  body { margin: 0; padding: 24px; background: #f6f4ee; color: #1b1f43;
         font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 17px; font-weight: 500; margin: 0 0 4px; }
  p.note { margin: 0 0 20px; color: #5b6070; }
  h2 { font-size: 14px; font-weight: 500; margin: 0 0 8px; font-family: ui-monospace, monospace; }
  section { margin-bottom: 24px; }
  .row { display: flex; gap: 12px; }
  figure { margin: 0; }
  canvas { display: block; border-radius: 6px; background: ${GROUND_INK}; }
  figcaption { padding: 6px 2px 0; }
  figcaption span { color: #5b6070; }
</style>
<h1>the counting board, painted at five instants of each build</h1>
<p class="note">The flat ground stands in for the plate — it is a DOM video behind the
canvas, never drawn into it. Actors with no sheet in reach are placeholders.</p>
${rows}
<script>${script}</script>
`;
}

function payloadOf(event) {
  const { t_ms: _t, source: _s, op: _o, scene_index: _i, line: _l, ...payload } = event;
  return JSON.stringify(payload);
}

function escapeHtml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function readArguments(argv) {
  const bundles = [];
  const options = { out: DEFAULT_OUT, scale: DEFAULT_SCALE, dump: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} wants a value`);
      index += 1;
      return next;
    };
    if (flag === '--bundle') bundles.push(path.resolve(value()));
    else if (flag === '--out') options.out = value();
    else if (flag === '--scale') options.scale = Number(value());
    else if (flag === '--dump') options.dump = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(flag)}\n${usage()}`);
  }

  if (!(options.scale > 0 && options.scale <= 1)) {
    throw new Error(`--scale must be between 0 and 1, not ${JSON.stringify(options.scale)}`);
  }
  options.bundles = bundles.length > 0 ? bundles : everyFixture();
  return options;
}

// Sorted, so two runs of the whole set produce the same sheet in the same order.
function everyFixture() {
  return fs.readdirSync(FIXTURE_DIRECTORY)
    .filter((name) => name.endsWith('.bundle.json'))
    .sort()
    .map((name) => path.join(FIXTURE_DIRECTORY, name));
}

function usage() {
  return [
    'usage: npm run sheet:board -- [--bundle <path>]... [--out <path>] [--scale <0..1>] [--dump]',
    '',
    `  --bundle  a built story bundle; repeatable. Default: every ${path.relative(ROOT, FIXTURE_DIRECTORY)}/*.bundle.json`,
    `  --out     where the PNG goes. Default: ${DEFAULT_OUT}`,
    `  --scale   stage 1920x1080 painted at this factor. Default: ${DEFAULT_SCALE}`,
    '  --dump    print each instant\'s slate and ring draw-list commands as JSON lines',
    '',
  ].join('\n');
}
