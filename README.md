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

It is a timeline player. The bundle is compiled to a schedule, every frame is a
pure function of that schedule, and the picture is one canvas 2D stage over the
hardware-decoded video plate:

```text
story.json → compileTimeline(bundle) → stateAt(timeline, bundle, t) → canvas
```

The story clock is pausable and seekable behind play/pause, skip and progress
controls; sprite sheets load as display-sized webp renditions instead of the
originals; a weak device is put on a cheaper tier rather than into a slideshow.
`tooling.v0` exports the same `compileTimeline`, `stateAt`, render rules and
`V0_POLICY` that the engine's tools and the phone client run, so every client
plays one schedule.

A story does not have to be finished to be watched: a host that has published
one scene mounts it and hands over the rest as they land, and the timeline only
ever grows — an appended scene never moves an event already played.

See [Embedding and operations](docs/embedding.md) for the plain JavaScript and
React APIs, how it plays, following a story still being written, controls,
renditions and device tiers, stable versus immutable URLs, storage/CORS
configuration, publishing, rollback, and GitLab migration.

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
