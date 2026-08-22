# AGENTS.md — story-player

- Browser delivery is one deterministic classic IIFE built from maintainable
  ESM. It has zero runtime dependencies, embeds its CSS, and installs only the
  deeply frozen `window.FabroStoryPlayer` global.
- The supported browser API is exactly `build`, `createStoryPlayer`,
  `resolveMediaUrl`, `createReactStoryPlayer`, and `tooling`. React is always
  supplied by the caller; never bundle a React copy.
- The player accepts parsed Story JSON plus one trusted storage-root
  `assetBase`. Never add player-owned Story JSON fetching, a `storyUrl`, iframe,
  query-string, standalone HTML, or npm/tarball product.
- Every media value is `<bucket>/<object-key>`. Preserve strict path validation
  before resolving it under `assetBase`.
- `browser/v0/core/**` is pure logic, the timeline compiler and `stateAt`
  included: no fetch, no clock, no DOM, and the same arguments always compile
  to the same bytes. `compileTimeline` takes a second, optional one — the
  manifest's `plates` block, which lets a host compile a story still being
  written; it may only answer for a place no scene stands in, so a finished
  story compiles the same with it or without. Only
  `browser/v0/app/stage/canvas-stage.mjs` (which measures stage DOM and owns
  the 2D context) and `browser/v0/app/stage/video-plate.mjs` (which owns the
  plate `<video>`) touch stage DOM or canvas;
  `browser/v0/app/stage/draw-list.mjs` between them is pure. Preserve
  deterministic behavior; policy changes require contract tests and downstream
  mobile parity regeneration.
- The timeline op schema is the contract between the compiler and every
  interpreter — this player's `stateAt`, the engine's tools, the phone client.
  `tooling.v0` publishes exactly `compileTimeline`, `TIMELINE_OPS`, `stateAt`,
  the pure render rules, and `V0_POLICY`; the seven parity timelines are its
  goldens and stay byte-identical unless a rule change is documented.
- Keep package metadata private at `0.0.0-development`. `dist/` is generated,
  ignored, and never committed.
- Never commit credentials, `.npmrc`, registry configuration, or a
  credential-bearing URL. The publisher uses `RUSTFS_URL`, the exact public
  `story-player` bucket, shared credentials, and an optional region.
- Immutable commit objects are create-only and must be anonymously verified
  before stable promotion. Promote stable metadata last. Rollback only from a
  verified immutable full-commit object. Never upload from a developer shell
  without explicit authorization.
- Run Node 22 `npm ci --ignore-scripts`, `npm test`,
  `STORY_PLAYER_COMMIT=<full-git-commit> npm run build:cdn`,
  `npm run test:e2e`, and `npm run verify:repository` before integration.
- GitHub Actions hosts the current workflow, but the artifact, object layout,
  commands, and storage contract remain provider-neutral for GitLab migration.
