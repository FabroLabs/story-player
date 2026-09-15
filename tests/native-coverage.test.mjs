import test from "node:test";
import assert from "node:assert/strict";
import { allCapabilitiesFixture } from "./_all-performance.mjs";
import {
  coverageSamples,
  nativeFixture,
} from "../scripts/export-native-coverage.mjs";

test("native coverage includes every scene and critical release boundaries with deterministic fixtures", () => {
  const story = allCapabilitiesFixture();
  const samples = coverageSamples(story);
  for (const scene of story.scenes)
    assert(
      samples.some(
        (s) => s.render && s.ms > scene.start_ms && s.ms < scene.end_ms,
      ),
    );
  for (const scene of story.scenes)
    for (const node of scene.nodes)
      if (node.attach) {
        const end = scene.start_ms + node.attach.end_ms;
        assert(samples.some((s) => Math.abs(s.ms - (end - 0.01)) < 0.000001));
        if (end < scene.end_ms)
          assert(samples.some((s) => Math.abs(s.ms - (end + 0.01)) < 0.000001));
      }
  assert.equal(samples.at(-1).ms, story.scenes.at(-1).end_ms);
  assert(samples.every((s) => s.ms >= 0));
  const bytes = JSON.stringify(story),
    before = structuredClone(story);
  assert.deepEqual(nativeFixture(story, bytes), nativeFixture(story, bytes));
  assert.deepEqual(story, before);
});

test('native coverage preserves exact fractional-millisecond completion time', () => {
  const story = allCapabilitiesFixture();
  story.scenes.at(-1).end_ms += 1 / 24;
  assert.equal(coverageSamples(story).at(-1).ms, story.scenes.at(-1).end_ms);
});
