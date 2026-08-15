# Fabro Story Player

A self-contained Storylang player delivered as one classic browser script. It
mounts directly into a caller-owned element and renders inside an open Shadow
DOM—no iframe, npm package, standalone page, or player-owned Story JSON fetch.

```html
<script src="https://storage.example/story-player/stable/story-player.js"></script>
<div id="story-player"></div>
<script type="module">
  const story = await fetch('/api/stories/7e07/story.json').then((response) => response.json());
  const player = window.FabroStoryPlayer.createStoryPlayer(
    document.querySelector('#story-player'),
    { story, assetBase: 'https://storage.example/' },
  );
  await player.ready;
</script>
```

See [Embedding and operations](docs/embedding.md) for the plain JavaScript and
React APIs, stable versus immutable URLs, storage/CORS configuration,
publishing, rollback, and GitLab migration.

## Development

Use Node 22 or newer:

```text
npm ci --ignore-scripts
npm test
STORY_PLAYER_COMMIT=<full-git-commit> npm run build:cdn
npm run test:e2e
npm run verify:repository
```

`dist/story-player.js` is generated and never committed. Publishing is owned by
the serialized workflow after green `main` CI; local verification performs no
external storage writes.
