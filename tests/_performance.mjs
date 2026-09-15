export function performanceFixture() {
  return {
    title: 'A shared performance',
    performance: {
      kind: 'wht',
      resolution: [1000, 562.5],
      required_capabilities: [
        'transform',
        'clip',
        'attachment',
        'path',
        'glow',
      ],
    },
    assets: {
      hero: {
        type: 'sprite',
        media: 'fairytale-assets/hero.webp',
        width: 200,
        height: 100,
        frames: [
          [0, 0, 100, 100],
          [100, 0, 100, 100],
        ],
        registration: [0, 0, 100, 100],
        contacts: {
          hand: [
            [70, 40],
            [72, 42],
          ],
        },
      },
      prop: {
        type: 'image',
        media: 'fairytale-assets/apple.png',
        width: 20,
        height: 20,
      },
    },
    scenes: [
      {
        id: 'one',
        setting_id: 'kitchen',
        start_ms: 0,
        end_ms: 4000,
        nodes: [
          {
            id: 'hero',
            asset: 'hero',
            x: 100,
            y: 200,
            height: 100,
            clip: { fps: 2, frames: [0, 1], loop: true },
          },
          {
            id: 'apple',
            asset: 'prop',
            x: 120,
            y: 140,
            width: 20,
            depth: 300,
            attach: {
              node: 'hero',
              contact: 'hand',
              start_ms: 0,
              end_ms: 1000,
              offset: [0, 0],
            },
            path: {
              start_ms: 1000,
              end_ms: 2000,
              from: 'attachment',
              to: [300, 200],
              arc: 50,
              easing: 'linear',
            },
            glow: {
              start_ms: 2000,
              end_ms: 3000,
              color: '#ffe18a',
              blur: 12,
              pulse: 0.04,
              period_ms: 1000,
            },
          },
        ],
      },
    ],
    audio: [
      {
        id: 'line',
        kind: 'narration',
        media: 'fabro-packs/test/line.m4a',
        start_ms: 0,
        duration_ms: 3000,
        text: 'Hi Sam',
        volume: 1,
      },
    ],
  };
}
