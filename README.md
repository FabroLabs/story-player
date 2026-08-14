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

## Use from an application

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

The player is a static browser application, not a React component. A host copies
the installed `browser/` tree intact, injects its trusted asset base into
`index.html`, and embeds that page in an iframe. The package has no runtime
dependencies and no browser build step.

### 1. Copy the browser application

This provider-neutral Node script resolves the installed package instead of
assuming where a package manager placed `node_modules`:

```js
// scripts/copy-story-player.mjs
import { cpSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostEntry = fileURLToPath(import.meta.resolve('@fabrolabs/story-player/host'));
const browserDirectory = dirname(hostEntry);
const outputDirectory = resolve('public/story-player');

rmSync(outputDirectory, { force: true, recursive: true });
cpSync(browserDirectory, outputDirectory, { recursive: true });
```

Run it after `npm install`, or from the application's build command. Always copy
the complete directory: the HTML loads shell and versioned modules by relative
path.

### 2. Supply the trusted asset base

The copied `index.html` contains this deployment slot:

```html
<meta name="storytime-asset-base" content="__STORYTIME_ASSET_BASE__">
```

Replace `__STORYTIME_ASSET_BASE__` with the trusted HTTP(S) base for catalog
media when serving the file or while producing the deployment output. The host
owns this value; never take it from the iframe query string or another
untrusted request value. Narration paths are resolved beside `story.json`, not
under this base.

### 3. Expose stories on the application's origin

The `story` query accepts a path on the player's own origin. Provide a route
such as `/stories/<id>/story.json`; it may serve the bundle itself, proxy S3, or
redirect to a signed/public S3 URL. When it redirects across origins, the
storage response must allow the application's origin through CORS.

Direct absolute URLs such as `?story=https://storage.example/story.json` are
intentionally refused. The same-origin entry route is what prevents a link from
making your application perform an arbitrary third-party bundle.

### 4. Embed it

For example, a React application can render the shipped page as an iframe:

```jsx
export function StoryPlayer({ storyId }) {
  const storyPath = `/stories/${encodeURIComponent(storyId)}/story.json`;
  const src = `/story-player/index.html?story=${encodeURIComponent(storyPath)}`;

  return (
    <iframe
      title="Story player"
      src={src}
      allow="autoplay"
      style={{ border: 0, height: '100%', width: '100%' }}
    />
  );
}
```

Each iframe owns one story and a fresh playback clock. There is currently no
supported programmatic mount API; `@fabrolabs/story-player/host` contains URL
utilities, not a React or DOM player component.

### Upgrading

Create or select a higher immutable GitHub Release, replace the exact `.tgz`
URL in the consuming application's `package.json`, run
`npm install --ignore-scripts`, and commit both manifests. Rebuild the
application and run its player integration tests before deployment. Do not add
an npm token, `.npmrc`, or GitHub credentials for this public artifact.

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
