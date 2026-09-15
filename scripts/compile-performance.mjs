import fs from 'node:fs';
import { auditPerformance } from '../browser/v0/core/performance/audit.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
const args = process.argv.slice(2);
try {
  const filename = args.find((a) => !a.startsWith('--'));
  const story = JSON.parse(fs.readFileSync(filename ?? 0, 'utf8'));
  if (story.performance?.kind !== 'wht')
    throw new Error('expected WHT performance JSON');
  const timeline = compileTimeline(story);
  const at = args.find((a) => a.startsWith('--state='));
  const output = args.includes('--audit')
    ? auditPerformance(story)
    : at
      ? stateAt(timeline, story, Number(at.slice(8)))
      : timeline;
  const sort = (value) =>
    Array.isArray(value)
      ? value.map(sort)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, sort(value[k])]),
          )
        : value;
  process.stdout.write(JSON.stringify(sort(output), null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
