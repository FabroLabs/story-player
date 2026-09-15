#!/usr/bin/env node
// Operator specimens for the existing native JS bridge and painter; no renderer.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { compileTimeline } from "../browser/v0/core/timeline/compile.mjs";
import { stateAt } from "../browser/v0/core/state/state.mjs";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function coverageSamples(story) {
  const samples = new Map();
  function add(ms, label, render = false) {
    if (!Number.isFinite(ms) || ms < 0 || ms > story.scenes.at(-1).end_ms)
      return;
    const key = ms;
    const sample = samples.get(key) ?? { ms: key, labels: [], render: false };
    if (!sample.labels.includes(label)) sample.labels.push(label);
    sample.render ||= render;
    samples.set(key, sample);
  }
  const rendered = new Set();
  for (const scene of story.scenes) {
    const start = scene.start_ms,
      end = scene.end_ms,
      length = end - start;
    const local = (time, label, render = false) => {
      if (time >= 0 && time < length)
        add(start + time, `${scene.id}:${label}`, render);
    };
    local(0.01, "scene-start");
    local(length / 2, "scene-middle", true);
    local(length - 0.01, "scene-end");
    const interval = (value, kind, id) => {
      const from = value.start_ms ?? 0,
        to = Math.min(value.end_ms ?? length, length);
      for (const time of [
        from - 0.01,
        from,
        from + 0.01,
        (from + to) / 2,
        to - 0.01,
        to,
        to + 0.01,
      ])
        local(time, `${id}:${kind}`);
      if (!rendered.has(kind) && to > from) {
        local((from + to) / 2, `${id}:${kind}-render`, true);
        if (kind === "attach" || kind === "path") {
          local(to - 0.01, `${id}:${kind}-before-end`, true);
          local(to + 0.01, `${id}:${kind}-after-end`, true);
        }
        rendered.add(kind);
      }
    };
    if (scene.camera) {
      interval(scene.camera, "camera", "camera");
      for (const track of scene.camera.tracks ?? []) for (const [ms] of track.keys) {
        local(ms - .01, "camera-track"); local(ms + .01, "camera-track");
      }
    }
    for (const node of scene.nodes) {
      for (const kind of [
        "attach",
        "path",
        "glow",
        "mask",
        "particles",
        "travel",
      ])
        if (node[kind]) interval(node[kind], kind, node.id);
      for (const kind of ["projection", "water", "lights"])
        if (node[kind] && !rendered.has(kind)) {
          const from = node.visible?.[0] ?? 0,
            to = node.visible?.[1] ?? length;
          local((from + to) / 2, `${node.id}:${kind}-render`, true);
          rendered.add(kind);
        }
      for (const segment of node.segments ?? [])
        interval(segment, "segment", node.id);
      for (const track of node.tracks ?? [])
        for (const [ms] of track.keys) {
          local(ms - 0.01, `${node.id}:track`);
          local(ms + 0.01, `${node.id}:track`);
        }
    }
  }
  add(story.scenes.at(-1).end_ms, "complete");
  return [...samples.values()].sort((a, b) => a.ms - b.ms);
}

export function nativeFixture(story, sourceBytes) {
  const timeline = compileTimeline(story);
  const states = coverageSamples(story).map(sample => {
    const state = stateAt(timeline, story, sample.ms);
    const features = [...new Set(state.renderNodes.flatMap(node => {
      const effects = ["glow", "mask", "water", "projection", "travel", "particles", "lights"]
        .filter(key => Array.isArray(node[key]) ? node[key].length : node[key]);
      if (node.shape) effects.push("shape:" + node.shape.kind);
      return effects.length ? [effects.sort().join("+")] : [];
    }))].sort();
    return {...sample, state, features};
  });
  const renderedFeatures = new Set(states.filter(s => s.render).flatMap(s => s.features));
  for (const sample of states) for (const feature of sample.features) if (!renderedFeatures.has(feature)) {
    sample.render = true; sample.labels.push("active-effects:" + feature); renderedFeatures.add(feature);
  }
  return {
    id: story.template_id,
    source_sha256: digest(sourceBytes),
    story,
    timeline: JSON.stringify(canonical(timeline), null, 2) + "\n",
    states,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: options } = parseArgs({
    options: {
      stories: { type: "string" },
      out: { type: "string" },
      "asset-base": { type: "string" },
      story: { type: "string" },
      "expected-count": { type: "string" },
    },
  });
  for (const key of ["stories", "out", "asset-base"])
    if (!options[key]) throw new Error(`Missing --${key}`);
  const origin = new URL(options["asset-base"]);
  if (!["http:", "https:"].includes(origin.protocol))
    throw new Error("HTTP asset base required");
  const files = fs
    .readdirSync(options.stories)
    .filter(
      (f) =>
        /^wht-[a-z]+-\d{2}\.json$/.test(f) &&
        (!options.story || f.includes(options.story)),
    )
    .sort();
  if (
    options["expected-count"] &&
    files.length !== Number(options["expected-count"])
  )
    throw new Error(
      `Expected ${options["expected-count"]} stories, found ${files.length}`,
    );
  fs.mkdirSync(options.out, { recursive: true });
  const stories = [];
  for (const file of files) {
    const bytes = fs.readFileSync(path.join(options.stories, file));
    const fixture = nativeFixture(JSON.parse(bytes), bytes);
    const data = JSON.stringify(fixture) + "\n";
    fs.writeFileSync(path.join(options.out, file), data);
    stories.push({
      id: file.slice(0, -5),
      url: file,
      sha256: digest(data),
      source_sha256: fixture.source_sha256,
      samples: fixture.states.length,
      renders: fixture.states.filter((s) => s.render).length,
    });
  }
  const manifest = {
    kind: "wht-native-coverage",
    asset_base: origin.href.replace(/\/$/, ""),
    stories,
  };
  fs.writeFileSync(
    path.join(options.out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      stories: stories.length,
      samples: stories.reduce((a, s) => a + s.samples, 0),
      renders: stories.reduce((a, s) => a + s.renders, 0),
    }) + "\n",
  );
}
