import test from "node:test";
import assert from "node:assert/strict";
import { performanceFixture } from "./_performance.mjs";
import { compileTimeline } from "../browser/v0/core/timeline/compile.mjs";
import { stateAt } from "../browser/v0/core/state/state.mjs";

test("negative clip clock origins preserve phase through scene and segment cuts", () => {
  const story = performanceFixture();
  story.audio = [];
  story.scenes[0].nodes.splice(1);
  const hero = story.scenes[0].nodes[0];
  hero.clip.start_ms = -250;
  story.scenes[0].end_ms = 1750;
  const next = structuredClone(story.scenes[0]);
  next.id = "two";
  next.start_ms = 1750;
  next.end_ms = 4000;
  next.nodes[0].clip.start_ms = -2000;
  next.nodes[0].segments = [
    {
      start_ms: 500,
      end_ms: 1500,
      asset: "hero",
      clip: { ...hero.clip, start_ms: -2500 },
    },
  ];
  story.scenes.push(next);
  const continuous = performanceFixture();
  continuous.audio = [];
  continuous.scenes[0].nodes.splice(1);
  continuous.scenes[0].nodes[0].clip.start_ms = -250;
  const timeline = compileTimeline(story);
  const reference = compileTimeline(continuous);
  for (const ms of [
    0, 249, 250, 1749, 1750, 1751, 2249, 2250, 2749, 2750, 3249, 3250, 3999,
  ]) {
    assert.deepEqual(
      stateAt(timeline, story, ms).renderNodes[0].source,
      stateAt(reference, continuous, ms).renderNodes[0].source,
      `phase at ${ms}`,
    );
  }
  story.scenes[1].start_ms = -1;
  assert.throws(() => compileTimeline(story), /start_ms/);
});
