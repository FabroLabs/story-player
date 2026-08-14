# @fabrolabs/story-player

MIT-licensed, dependency-free browser performer for validated Storylang bundles.
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

## Install

Each GitHub Release carries an npm-compatible `.tgz`. The public asset needs no
registry configuration or download token:

```text
npm install --save-exact https://github.com/FabroLabs/story-player/releases/download/v0.1.1/fabrolabs-story-player-0.1.1.tgz
```

The resulting dependency still imports by package name:

```js
import { resolveStoryUrl } from '@fabrolabs/story-player/host';
import { V0_POLICY } from '@fabrolabs/story-player/v0/tooling';
```

The player is not a React component. Browser hosts copy the installed
`node_modules/@fabrolabs/story-player/browser/` tree intact into their static
output and may embed its `index.html` in an iframe. The package has no runtime
dependencies and no browser build step.

The archive contract is hosting-provider neutral: a future GitLab or object
storage release can serve the same versioned `.tgz`. Consumers then change only
the dependency URL and lockfile; package imports and browser hosting stay the
same. Private artifact hosting necessarily requires build-time authentication.

## Development

Use Node 22 or newer:

```text
npm ci --ignore-scripts
node --test "tests/*.test.mjs"
node scripts/verify-repository.mjs
npm pack --dry-run --json
npm pack
node scripts/verify-package.mjs fabrolabs-story-player-0.1.1.tgz
node scripts/verify-install.mjs fabrolabs-story-player-0.1.1.tgz
```

The package has no runtime dependencies and no browser build step. Publishing
is restricted to the release workflow for a matching immutable `v<version>`
GitHub Release. The workflow uploads the verified `.tgz` without overwriting an
existing asset, then installs its public HTTPS URL without credentials. A bad
release is superseded by a higher version.
