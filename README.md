# @fabrolabs/story-player

Private, dependency-free browser performer for validated Storylang bundles.
The package ships the complete static player under `browser/`; hosts serve that
directory without bundling so its relative module paths remain intact.

The supported Node entry points are deliberately narrow:

- `@fabrolabs/story-player/host` exports `resolveStoryUrl`,
  `normalizeAssetBase`, and `resolveAssetKey` for host integration.
- `@fabrolabs/story-player/v0/tooling` exports the v0 playback semantics used
  by non-browser renderers. The `v0` segment is the Storylang contract version,
  independent of this package's semantic version.

All other files below `browser/v0/` are browser-delivered implementation
details. Consumers pin an exact package version and upgrade by rebuilding and
rerunning their integration suite.

## Development

Use Node 22 or newer:

```text
npm ci --ignore-scripts
node --test "tests/*.test.mjs"
node scripts/verify-repository.mjs
npm pack --dry-run --json
npm pack
node scripts/verify-package.mjs fabrolabs-story-player-0.1.0.tgz
```

The package has no runtime dependencies and no browser build step. Publishing
is restricted to the release workflow for a matching immutable `v<version>`
GitHub Release.
