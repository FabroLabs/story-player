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

Publisher configuration:

```dotenv
RUSTFS_URL=https://storage.example
STORY_PLAYER_BUCKET=story-player
RUSTFS_ACCESS_KEY=provided-by-secret-store
RUSTFS_SECRET_KEY=provided-by-secret-store
RUSTFS_REGION=us-east-1
```

`RUSTFS_URL` is one HTTP(S) origin with no bucket, path, credentials, query, or
fragment. The credentials are paired and are never part of browser URLs or
logs.

## Promotion and rollback

Pull-request and `main` CI run unit tests, a deterministic build, and real
Chromium plain-JavaScript/React tests. A separate serialized workflow publishes
only after green `main` CI:

1. create/configure the public bucket without overwriting conflicting policy;
2. create immutable script and metadata with `If-None-Match: *`;
3. accept a repeat only when existing bytes and headers are identical;
4. verify immutable bytes through anonymous HTTP;
5. write and anonymously verify stable script;
6. write and anonymously verify stable metadata last.

Configure `RUSTFS_URL` and optional `RUSTFS_REGION` as variables, and the access
and secret keys as secrets in the protected `cdn-production` GitHub
environment. `STORY_PLAYER_BUCKET` is fixed by the workflow.

To roll back, run the **Publish CDN** workflow manually with a full commit. The
rollback reads that immutable metadata and script anonymously, verifies their
headers, byte length, SHA-256, and embedded commit, then promotes those exact
bytes. It never rebuilds or edits an immutable object.

## GitLab migration

The output and storage layout do not depend on GitHub. A protected GitLab runner
can run the same Node 22 commands, provide the same five environment variables,
and serialize `npm run publish:cdn` after green default-branch CI. Copy the
workflow gates—not credentials—into GitLab CI. Existing stable and immutable
browser URLs remain unchanged as long as the RustFS endpoint and bucket remain
the same.
