import test from "node:test";
import assert from "node:assert/strict";
import { performanceFixture } from "./_performance.mjs";
import { compileTimeline } from "../browser/v0/core/timeline/compile.mjs";
import { stateAt } from "../browser/v0/core/state/state.mjs";

test("contact masks follow the current frame through flipped scale and camera", () => {
  const s = performanceFixture();
  s.scenes[0].nodes.splice(1);
  const n = s.scenes[0].nodes[0];
  n.scale_x = -1;
  n.mask = {
    type: "contact",
    contact: "hand",
    points: [
      [-10, -20],
      [10, -20],
      [10, 10],
    ],
    start_ms: 0,
    end_ms: 2000,
    min_y: 139,
  };
  let tl = compileTimeline(s);
  const first = stateAt(tl, s, 0).renderNodes[0];
  assert.deepEqual(first.mask, {
    type: "polygon",
    points: [
      [80, 20],
      [60, 20],
      [60, 50],
    ],
  });
  assert.deepEqual(stateAt(tl, s, 500).renderNodes[0].mask.points, [
    [82, 22],
    [62, 22],
    [62, 52],
  ]);
  assert.equal(stateAt(tl, s, 2000).renderNodes.length, 0);
  n.mask.min_y = 141;
  tl = compileTimeline(s);
  assert.equal(stateAt(tl, s, 0).renderNodes.length, 0);
  assert.equal(stateAt(tl, s, 500).renderNodes.length, 1);
  s.assets.hero.contacts.hand[1] = null;
  assert.throws(() => compileTimeline(s), /mask contact/);
});

test("multi-stage camera, bounded scalar wave, and spiral star geometry remain pure", () => {
  const s = performanceFixture();
  s.scenes[0].nodes.splice(1);
  s.scenes[0].camera = {
    from: [500, 281.25, 1],
    to: [500, 281.25, 1],
    start_ms: 0,
    end_ms: 4000,
    tracks: [
      {
        property: "zoom",
        keys: [
          [0, 1],
          [1000, 2],
          [2000, 2],
          [3000, 1],
        ],
        easing: "smoothstep",
      },
      {
        property: "zoom_multiplier",
        keys: [
          [0, 1],
          [4000, 1.014],
        ],
        easing: "smoothstep",
      },
    ],
  };
  const n = s.scenes[0].nodes[0];
  n.tracks = [
    {
      property: "rotation",
      keys: [
        [0, 0],
        [2000, 0],
      ],
      wave: { amplitude: -0.12, cycles: 0.5 },
    },
  ];
  n.particles = {
    count: 2,
    color: "#fff4b0",
    start_ms: 0,
    end_ms: 4000,
    radius: 41,
    period_ms: 1000,
    phase_step: 0.071,
    radial_start: 12,
    vertical_scale: 0.65,
    rise: 12,
    size_from: 4,
    size_to: 2,
    opacity: 0.85,
    points: 5,
    inner: 0.4,
    rotation_speed: 1,
    stroke: "#eaaa4e",
    stroke_width: 0.8,
  };
  const tl = compileTimeline(s);
  const out = stateAt(tl, s, 1000);
  assert.equal(out.camera.scale, 2 * (1 + 0.014 * 0.15625));
  assert.ok(Math.abs(out.renderNodes[0].matrix[1] + Math.sin(0.12)) < 1e-10);
  const star = out.renderNodes[0].particles[0];
  assert.equal(star.points.length, 10);
  assert.equal(star.radius, 4);
  assert.equal(star.x, 62);
  assert.equal(star.y, 50);
  assert.deepEqual(stateAt(tl, s, 1000), out);
  assert.deepEqual(
    stateAt(tl, s, 3000).renderNodes[0].matrix.slice(0, 4),
    [1, 0, -0, 1],
  );
});
