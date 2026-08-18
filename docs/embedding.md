# Embedding and operations

## Browser contract

Load one classic script. It installs a deeply frozen
`window.FabroStoryPlayer` with exactly five members:

- `build.commit`
- `createStoryPlayer(container, options)`
- `resolveMediaUrl(path, assetBase)`
- `createReactStoryPlayer(React)`
- `tooling`, including the deterministic `tooling.v0` surface

The host fetches and parses `story.json`. The player receives only that object
and a trusted storage-root `assetBase`; it never accepts or fetches a story URL.
Every media value inside the bundle must already be bucket-qualified, such as
`fairytale-assets/plates/forest/poster.webp` or
`jobs/<story-id>/audio/<digest>.wav`. The player resolves both against the same
base, for example `https://storage.example/`.

## Plain JavaScript

```html
<script src="https://storage.example/story-player/stable/story-player.js"></script>
<div id="performance"></div>
<script type="module">
  const response = await fetch('/api/stories/7e07/story.json');
  if (!response.ok) throw new Error(`story fetch failed: ${response.status}`);
  const story = await response.json();

  const player = window.FabroStoryPlayer.createStoryPlayer(
    document.querySelector('#performance'),
    { story, assetBase: 'https://storage.example/' },
  );
  await player.ready;

  // Call when the route/component is removed. It is safe to call repeatedly.
  player.destroy();
</script>
```

Multiple elements may own independent players. A single element may own only
one live instance; destroy it before remounting.

## React

The artifact does not bundle React. Pass the application’s own React object to
the factory once, then render the returned component normally:

```jsx
const StoryPlayer = window.FabroStoryPlayer.createReactStoryPlayer(React);

export function Performance({ story }) {
  return (
    <StoryPlayer
      story={story}
      assetBase="https://storage.example/"
      className="performance"
      aria-label={story.title}
    />
  );
}
```

Changing `story`, `assetBase`, or `debug` destroys the previous instance before
mounting the replacement. Unmounting destroys the instance. React StrictMode is
supported.

## Stable and immutable URLs

Use stable when applications should receive a repaired player after reloading:

```text
https://storage.example/story-player/stable/story-player.js
```

Stable responses revalidate after 60 seconds. An already open page keeps the
build it loaded; refresh or navigation observes a later promotion.

Use the immutable URL when a consumer must lock exact renderer semantics:

```text
https://storage.example/story-player/builds/<full-commit>/story-player.js
https://storage.example/story-player/builds/<full-commit>/build.json
```

Immutable responses cache for one year and include the full Git commit,
byte count, and SHA-256 in `build.json`. There are no semantic-version aliases.

## Storage and CORS

The dedicated public bucket name is exactly `story-player`. Its policy permits
anonymous `s3:GetObject`, which covers browser GET and HEAD, and its CORS rule
permits cross-origin GET/HEAD. No write operation is public. The player script,
Story JSON, and media may share one storage origin while remaining in separate
buckets.

## Branches and deployment

`main` is where work lands. **`production` is what is deployed** — merging into
it is the deliberate act that publishes a player, and nothing else in this
repository moves what the cluster serves.

A merge into `production` runs **Deploy player**
(`.github/workflows/deploy-player.yml`):

1. `verify` — unit tests, a deterministic build, real Chromium
   plain-JavaScript/React tests, and the repository contract;
2. `release` — rebuilds, writes `build.json` (commit, byte count, SHA-256),
   creates the immutable `build-<commit>` release, then moves the rolling
   `latest` tag onto those bytes, and finally re-downloads both published assets
   and byte-compares them against what it just built.

The `release` job cannot start unless `verify` passes.

## How the bytes reach the store

Delivery is **pull, not push.** The store this player is consumed from — MinIO
in the moonykids cluster — is a ClusterIP service with no Ingress, so GitHub's
runners cannot write to it, and exposing an object store's write API to the
internet to ship a 141 KB file would be a far larger change than the thing it
delivers.

So a CronJob inside the cluster
(`infra/manifests/47-player-updater.yaml`, every 10 minutes) watches `latest`,
verifies all three fields in `build.json` before it trusts a byte, mirrors into
`story-player/builds/<commit>/` and promotes `stable/`. Nothing inbound is
opened and the store credential never leaves the cluster. Expect the site to be
serving a new player within about ten minutes of a green deploy.

There was previously a second workflow that wrote straight into a RustFS bucket
over S3 from the runner. It has been removed: it delivered to a store nothing
now reads from, and two publish paths meant two answers to "which bytes are
live". The S3 publisher scripts (`scripts/publish-cdn.mjs`,
`scripts/rollback-cdn.mjs`, `scripts/storage-config.mjs`) and their tests remain
for any deployment whose store IS reachable — nothing in CI calls them.

## Rollback

Pick the immutable `build-<commit>` release and pin the consumer to it. In the
moonykids cluster that is `infra/scripts/17-player-rollback.sh <full-commit>`,
which writes `stable/pinned.json`; the mirror keeps ingesting new builds but
will not promote over the pin until it is removed. Nothing is rebuilt and no
immutable release is ever edited.

## GitLab migration

The output and release layout do not depend on GitHub beyond the release API. A
protected GitLab runner can run the same Node 22 commands and publish the same
two files — `story-player.js` and `build.json` — anywhere a consumer can fetch
over HTTPS. What must not change is the contract: the consumer verifies commit,
byte count and SHA-256 before promoting, so any host works as long as both files
are served together and `build.json` describes the bytes beside it.
