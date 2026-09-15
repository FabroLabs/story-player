# WHT player implementation

Completed source is ready for review on `codex/wht-player-integration`, based on
`67e031e2f74dd936b5f9cde1ecbc496ccf2d154c`. Production deployment is pending.
A source-branch push does not publish a CDN artifact, change runtime locks or
admit additional story/avatar combinations.

## Implemented contract

Explicit `performance.kind: "wht"` dispatch precedes legacy StoryLang validation.
The existing compiler validates a complete data-only document and verifies its
embedded instructions. The pure evaluator supplies browser and native draw/audio
adapters. Media remains external and bucket-qualified under the host's trusted
storage root; the player never fetches Story JSON itself.

The contract covers clip ranges/negative clock origins, segments, exact sampled
contacts, attachment/release, future receiver contacts, curved paths, tracks,
layering, camera, travel/parallax, masks, water, glow, particles, lights, geometric
shapes and projected screen children. Missing assets, contacts and unsupported
combinations fail explicitly. [The performance contract](docs/performance.md)
owns field semantics and limitations.

WHT audio keeps authored gain, active intervals, measured duration, loop offsets
and seek/replay state without automatic narration ducking. Engine preparation can
provide a continuous music/ambience/SFX bed plus separate narration. The browser
host observes and controls the existing player clock through the additive handle
API documented in [Embedding](docs/embedding.md#host-controls).

## Validation and repeatable tools

Integration gates use Node22: `npm ci --ignore-scripts`, `npm test`,
`STORY_PLAYER_COMMIT=<full-commit> npm run build:cdn`, `npm run test:e2e` and
`npm run verify:repository`. Real-bucket browser cases are opt-in; a skipped
remote harness is not production storage proof.

The source tests cover unknown/missing data, reachable contact frames, release
and receiver geometry, source rectangles, masks/projection, malformed optional
effect numbers (light phase, particle seed and travel offset/ease durations), deterministic
forward/reverse/replay, audio, host controls and required media failures.
Historical local work also compared all70 default casts against authored source
geometry and sampled actual browser/iOS/Android output. Targeted seven-hero ×
three-Dad belong-01 specimens were checked separately. These are local sampled
proofs, not continuous review of every frame, universal avatar admission or
production deployment. Detailed images, private documents, logs and hash receipts
remain outside this repository.

- `scripts/compile-performance.mjs` compiles/audits complete JSON and evaluates a
  requested state without media I/O.
- `scripts/build-performance-compiler.mjs --out-dir DIRECTORY` creates a
  content-addressed standalone compiler and source receipt for engine consumers.
- `scripts/build-local.mjs OUTPUT.js` creates an explicitly uncommitted debug
  artifact and paired source/byte receipt; it cannot impersonate its base commit.
- `scripts/export-performance-fixture.mjs`, `export-native-coverage.mjs` and
  `compare-native-browser.mjs` reproduce technical fixtures and matching captures.
  Their generated output is operator data and must remain outside source control.

## Remaining limits and release boundary

Projected nodes reject unimplemented glow/water/travel/particles/lights
combinations. Travel rejects masks/glow/water/particles/lights/parents. Alternate
appearances need reviewed fit and semantic pickup/place/throw timing; replacing
an atlas and contacts alone does not establish compatibility. Broad alternate
avatar coverage is deferred.

Visual caches use resolved URLs within a mounted player; different grant prefixes
or new mounts do not share a persistent content-hash visual cache. Browser/native
pixels may differ in filtering while geometry and layer order remain testable.

The engine's existing `67e031e` artifact lock may remain for legacy consumers until
the paired DevOps release. It does not implement WHT. WHT needs the reviewed
compiler and browser artifact with their exact immutable bytes/metadata. Follow
the engine's `wiki/ops/wht-web-release.md` handoff before changing deployed locks.
Publish JavaScript and `build.json` together, verify their bytes and promote
metadata last. No CDN publication or mobile source publication is included here.
