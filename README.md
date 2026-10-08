# Fabro Story Player

A self-contained story player delivered as one classic browser script. It
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
controls; sprite sheets load as display-sized webp renditions, a few frames at a
time, instead of the originals; a weak device is put on a cheaper tier rather
than into a slideshow. A performance holds on its last frame, rather than cutting a
word or showing a scene with parts missing, until what it reaches has landed.
`tooling.v0` exports the same `compileTimeline`, `stateAt`, render rules and
`V0_POLICY` that the engine's tools and the phone client run, so every client
plays one schedule.

Lessons can also put one to four catalog picture or glyph cards on that same
glass board, with a focused slot and a short prompt. Their images must decode
before the lesson can play; a missing teaching image stops it visibly. A host
can opt into `board: {layout: 'lesson-guide', guide: '<cast-slug>'}` to reserve
a named guide in a slightly larger corner cell while preserving the board layout.
Native captions stay beside that guide in a bottom-left area with native CC behavior;
players up to 400px wide use 13px captions to keep longer lines below the cards.
Optional `board.choreography` supplies seekable guide and card-image skits;
the fixed teaching tiles stay in place. Its `caption: 'top'` lane leaves room
for comic movement below them. See the embedding contract for its
normalized keyframes and finite story-time windows.
An optional `board.ledge` supplies a fixed canvas shelf beneath the guide;
guide lessons end with “Great exploring!” and “See you next time!”.
`board.world` gives a guide lesson an illustrated world with timed outdoor and
teaching phases. Outdoor phases show the guide and props; teaching phases reveal
a freestanding themed board with fixed answer slots. World images preload through
the same trusted storage paths as story objects, and all motion follows story time.
Optional board artwork, content fades and exact object-to-card docking let that
board stay present through play and teaching. Separate content bands can enlarge
cards and prompts; authored thinking and answer-reveal cues add neutral pause
indicators and a finite celebration of the shown answer, without scoring a child.
Reveal cues can opt into `presentation: 'spotlight'` for a neutral card lift and
soft shadow, with stationary emphasis for reduced-motion viewers.

A story does not have to be finished to be watched: a host that has published
one scene mounts it and hands over the rest as they land, and the timeline only
ever grows — an appended scene never moves an event already played. With an
intro card to open on, it does not have to be started either: the player mounts
on the manifest alone and the first scene is published while the card plays.

A story may open on its world's intro film and close on its end card, each with
its own music and a skip that is always there. Neither is in the compiled
timeline — they are phases either side of it — so the clock, the scrub bar and
every `t_ms` still cover the story alone.

Stories can be saved as branded 720p MP4 files with narration and the selected
captions. The exporter also composites legacy video backgrounds. Saving runs
in the foreground, pauses when hidden, and resumes only after a press. It
omits intro/end cards and the bedtime wind-down and restores the viewer's
playback position afterward. Hosts put Save video beside their story actions
with `videoControls: 'host'`; the additive export API provides progress,
cancellation and bounded, acknowledged chunks for native file storage.

See [Embedding and operations](docs/embedding.md) for the plain JavaScript and
React APIs, how it plays, following a story still being written, the cards
either side of it, controls, saving a story as a video, renditions and device tiers, stable versus
immutable URLs, storage/CORS configuration, publishing, rollback, and GitLab
migration.

The same compiler and state evaluator accept complete declarative performance
JSON (`performance.kind` `wht` or `bedtime`) without a StoryLang marker. See [the performance contract](docs/performance.md)
and [current integration evidence](WHT_IMPLEMENTATION_STATUS.md). The WHT source
is ready for review; production deployment and paired runtime-lock changes remain
pending. Pushing this feature branch does not publish a CDN artifact.

## Development

Use Node 22 or newer:

```text
npm ci --ignore-scripts
npm test
STORY_PLAYER_COMMIT=<full-git-commit> npm run build:cdn
npm run test:e2e
npm run verify:repository
```

`dist/story-player.js` is generated and never committed. Local verification
performs no external storage writes.

Two branches, and one of them is deployed:

| Branch | Runs | Result |
| --- | --- | --- |
| `dev` | `deploy-dev.yml` | builds and uploads to the `story-player-dev` bucket. No tests — it is a preview rail |
| `main` | `deploy-player.yml` | the full suite, then publishes the release the cluster mirrors |

See [Embedding and operations](docs/embedding.md#branches-and-deployment) for
what each rail writes and why the two delivery shapes differ.
