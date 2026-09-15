import fs from 'node:fs';
import { allCapabilitiesFixture } from '../tests/_all-performance.mjs';
import { compileTimeline } from '../browser/v0/core/timeline/compile.mjs';
import { stateAt } from '../browser/v0/core/state/state.mjs';
const story = allCapabilitiesFixture();
story.instructions = compileTimeline(story);
const times = [
  0, 1, 199, 200, 499, 999, 1000, 1001, 1499, 1500, 1999, 2000, 2499, 2500,
  2999, 3000, 3999, 4000,
];
const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const fixture = {
  story,
  timeline: JSON.stringify(canonical(story.instructions), null, 2) + '\n',
  states: times.map((ms) => ({
    ms,
    state: stateAt(story.instructions, story, ms),
  })),
};
fs.writeFileSync(process.argv[2], JSON.stringify(fixture) + '\n');
