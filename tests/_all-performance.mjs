import { performanceFixture } from "./_performance.mjs";
export function allCapabilitiesFixture() {
  const story = performanceFixture();
  story.performance.required_capabilities = [
    "transform",
    "clip",
    "attachment",
    "path",
    "glow",
    "mask",
    "water",
    "projection",
    "lights",
    "particles",
    "travel",
    "camera",
    "layers",
    "audio",
    "segments",
    "transition",
    "shapes",
  ];
  const scene = story.scenes[0];
  scene.camera = {
    from: [500, 281.25, 1],
    to: [600, 320, 1.5],
    start_ms: 0,
    end_ms: 4000,
    easing: "smoothstep",
  };
  scene.transition = { kind: "fade", duration_ms: 200, color: "#142333" };
  scene.nodes[0].segments = [
    { start_ms: 2500, end_ms: 4000, asset: "hero", clip: { hold: 1 } },
  ];
  scene.nodes[0].water = {
    line_from_feet: 0.2,
    fade: 0.23,
    color: "#26a8e8",
    opacity: 0.25,
  };
  scene.nodes[1].mask = {
    type: "polygon",
    points: [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
    ],
  };
  scene.nodes[1].tracks = [
    {
      property: "depth",
      keys: [
        [999, 300],
        [1000, 20],
      ],
      easing: "hold",
    },
    {
      property: "rotation",
      keys: [
        [1000, 0],
        [2000, 0.8],
      ],
    },
    {
      property: "scale_x",
      keys: [
        [1000, 1],
        [2000, 0.4],
      ],
    },
  ];
  scene.nodes[1].particles = {
    count: 12,
    colors: ["#ffd279", "#fff4b1"],
    seed: 3,
    start_ms: 1500,
    end_ms: 3000,
    radius: 20,
  };
  scene.nodes.push({
    id: "tablet",
    asset: "prop",
    x: 400,
    y: 200,
    width: 80,
    rotation: 0.15,
    depth: 400,
  });
  scene.nodes.push({
    id: "remote",
    asset: "hero",
    parent: "tablet",
    x: 0,
    y: 0,
    width: 10,
    depth: 401,
    clip: { fps: 2 },
    projection: {
      corners: [
        [2, 2],
        [18, 3],
        [17, 16],
        [3, 17],
      ],
    },
  });
  scene.nodes.push({
    id: "car",
    asset: "prop",
    x: 600,
    y: 450,
    width: 100,
    depth: 200,
    lights: [
      { x: 4, y: 8, radius: 4, color: "#ffd733", phase: 0.5, period_ms: 400 },
    ],
  });
  scene.nodes.push({
    id: "badge",
    asset: "prop",
    x: 950,
    y: 45,
    width: 40,
    space: "screen",
    depth: 999,
  });
  scene.nodes.push({
    id: "background",
    asset: "prop",
    x: 500,
    y: 281.25,
    width: 1000,
    height: 562.5,
    depth: -100,
    travel: {
      start_ms: 0,
      end_ms: 4000,
      speed: 50,
      scale: 1.2,
      repeat: true,
      ease_in_ms: 500,
      ease_out_ms: 500,
    },
  });
  story.audio.push({
    id: "music",
    kind: "music",
    media: "fairytale-assets/music.m4a",
    start_ms: 0,
    end_ms: 4000,
    duration_ms: 1000,
    loop: true,
    volume: 0.2,
    gain_keys: [
      [0, 0.2],
      [2000, 0.1],
    ],
  });
  story.assets.shadow = {
    type: "shape",
    width: 100,
    height: 30,
    shape: { kind: "ellipse", bounds: [5, 5, 90, 20], fill: "#16253f33" },
  };
  story.assets.ripple = {
    type: "shape",
    width: 100,
    height: 40,
    shape: {
      kind: "arc",
      bounds: [4, 4, 92, 32],
      stroke: "#9cdeee",
      stroke_width: 2,
      start_angle: 0,
      end_angle: Math.PI,
    },
  };
  story.assets.card = {
    type: "shape",
    width: 100,
    height: 100,
    shape: {
      kind: "roundrect",
      bounds: [5, 5, 90, 90],
      fill: "#fff0d6",
      radius: 8,
      shadow: { color: "#10243b33", blur: 4, offset: [0, 2] },
    },
  };
  scene.nodes.push({
    id: "ground",
    asset: "shadow",
    x: 100,
    y: 200,
    width: 100,
    depth: 90,
  });
  scene.nodes.push({
    id: "ripple",
    asset: "ripple",
    x: 100,
    y: 190,
    width: 100,
    depth: 205,
  });
  scene.nodes.push({
    id: "screen",
    asset: "card",
    x: 0,
    y: 0,
    width: 100,
    depth: 402,
    projection: {
      corners: [
        [400, 200],
        [500, 205],
        [490, 300],
        [410, 290],
      ],
    },
  });
  scene.nodes.push({
    id: "self_view",
    asset: "hero",
    parent: "screen",
    x: 75,
    y: 85,
    width: 22,
    depth: 403,
    clip: { fps: 2 },
  });
  scene.nodes.push({
    id: "receiver",
    asset: "hero",
    x: 550,
    y: 300,
    height: 100,
    scale_x: -1,
    clip: { fps: 2 },
    tracks: [
      {
        property: "x",
        keys: [
          [0, 550],
          [2000, 600],
        ],
      },
    ],
  });
  scene.nodes[1].path.to = {
    node: "receiver",
    contact: "hand",
    at_ms: 2000,
    offset: [0, 0],
  };
  scene.camera.tracks = [
    {
      property: "zoom_multiplier",
      keys: [
        [0, 1],
        [4000, 1.014],
      ],
      easing: "smoothstep",
    },
  ];
  scene.nodes.push({
    id: "hand_overlay",
    asset: "hero",
    x: 700,
    y: 350,
    height: 100,
    scale_x: -1,
    clip: { fps: 2, start_ms: -250 },
    depth: 800,
    mask: {
      type: "contact",
      contact: "hand",
      points: [
        [-14, -27],
        [0, -27],
        [12, 3],
        [9, 11],
        [-3, 8],
        [-6, -6],
      ],
      start_ms: 0,
      end_ms: 3000,
      min_y: 200,
    },
    tracks: [
      {
        property: "rotation",
        keys: [
          [0, 0],
          [2000, 0],
        ],
        wave: { amplitude: 0.12, cycles: 0.5 },
      },
    ],
  });
  scene.nodes[1].glow.blur_pulse = 6;
  scene.nodes[1].glow.pulse_cycles = 2;
  Object.assign(scene.nodes[1].particles, {
    points: 5,
    inner: 0.4,
    period_ms: 1000,
    phase_step: 0.071,
    radial_start: 12,
    vertical_scale: 0.65,
    rise: 12,
    size_from: 4,
    size_to: 2,
    opacity: 0.85,
    rotation_speed: 1,
    stroke: "#eaaa4e",
    stroke_width: 0.8,
    clock_start_ms: 0,
  });
  return story;
}
