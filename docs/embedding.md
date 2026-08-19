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

Beside `story` and `assetBase`, `options` accepts two booleans, both off by
default:

- `debug: true` shows the log button and its drawer, and the log downloaded from
  that drawer carries the compiled timeline.
- `perf: true` measures the running player—frame times per scene, long frames,
  event-loop lag, dropped video frames—into the same log, after one `capability`
  entry naming the device tier and the signals that chose it. It is also what
  allows a sustained run of slow frames to demote the tier mid-story.

`tooling.v0` is the deterministic surface other clients share: `compileTimeline`,
`TIMELINE_OPS`, `stateAt`, the pure render rules (`frameIndexAt`, `frameCell`,
`spriteHeightForCm`, `floorYAtX`, `zoneNamed`, `selectFacingClip`,
`selectLocomotion`), and the frozen `V0_POLICY`.

## How it plays

One pure path, and every client runs the same one:

```text
story.json → compileTimeline(bundle) → stateAt(timeline, bundle, t) → canvas
```

`compileTimeline` is pure and synchronous: the parsed bundle in, the whole
schedule out—`{timeline_version, storylang_version, title, duration_ms, events}`
with every event stamped `t_ms`. It fetches nothing and reads no clock, and the
same bundle always compiles to the same bytes. The engine's timeline tool calls
this exact function out of the published artifact, so the browser and the phone
play one schedule rather than two implementations of it.

`stateAt` is one frame: a pure function of that timeline, the bundle and an
instant in milliseconds, answering with the actors on stage, their clips and
frame cells, the camera framing, the subtitle showing, and the warnings crossed
on the way. It interprets the timeline and never re-decides it.

The picture is a single canvas 2D stage drawn over the hardware-decoded
`<video>` plate, both inside the player's open Shadow DOM. Camera framing is a
CSS transform on the plate and the matching `ctx.setTransform` on the canvas,
written only when the framing moves. Subtitles, the media note and the controls
stay ordinary DOM.

The story clock is pausable and seekable, and audio follows it: each cue starts
at its own `t_ms` and is aligned by `currentTime`, so blocked or late audio
never holds up the picture. The loop redraws only when the frame changed, and
never faster than 24 Hz. A story that is paused, hidden, ended or destroyed
schedules nothing.

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

Changing `story`, `assetBase`, `debug`, or `perf` destroys the previous instance
before mounting the replacement. Unmounting destroys the instance. React
StrictMode is supported.

## Controls

The player owns its transport, inside the Shadow DOM. It appears when the story
begins, not while the opening ceremony is still up: play/pause, skip back and
forward ten seconds, and a draggable progress bar with the elapsed time and the
minutes left, below the stage; the subtitle toggle sits over the picture at the
top right, with the story's name opposite it. A host that draws its own chrome
up there — close, cast, parental, overflow — owns that row; the player never
adds to it.

The picture itself is the play/pause switch, and a click on it leaves the round
mark every video player draws. The overlay follows the pointer: it comes back
whenever the pointer moves over the player, and withdraws after about two and a
half seconds of stillness or as soon as the pointer leaves. A story that is
paused or over keeps its transport while the pointer is on it, and so does a bar
being dragged or a control holding focus. Touch is exempt from the leave rule,
because a device with no hover reports one after every tap.

Keyboard, while the stage frame has focus: space or `k` toggles play, the arrow
keys skip ten seconds, `Home` and `End` seek to the start and the end. Any key
brings the overlay back first. Keys are ignored while a text field has focus,
and space and enter are left to whichever button has focus so the drawer and
toggle stay reachable.

Seeking is a seek of the story, not of a video: the clock moves, the next frame
is `stateAt` at the new instant, and the narration and music the instant lands
inside restart from the right offset through `currentTime`. A sound effect the
seek landed in the middle of stays silent until the story crosses its next cue.
While the bar is being dragged the picture follows the pointer and the sound is
held; it is placed once, where the pointer is let go.

## Sheets, renditions and device tiers

Every clip in a current bundle carries `renditions`—the content-addressed webp
ladder at 200, 320, 384 and 512 px, the same one the phone client reads. The
player asks for the smallest step that covers the sprite's drawn height times
the stage's fit scale, the capped device pixel ratio, and the largest camera
magnification that scene reaches; when a ladder exists the original sheet is
never requested. Renditions are re-gridded during the encode—a one-row strip
becomes near-square—and the player derives that grid rather than reading the
bundle's, which describes the original.

A bundle built before renditions existed still plays. It falls back to the
original sheets and says so once per sheet in the log.

The device tier is probed once, before the first frame, from `deviceMemory`,
`hardwareConcurrency` and 2D-canvas support:

| tier | what changes |
|---|---|
| `high` | full budget: 96 MB of decoded sheets, DPR capped at 2, 24 Hz, ground shadows |
| `mid` | the decoded-sheet budget halves to 48 MB; the picture is identical |
| `low` | DPR capped at 1.5, 12 Hz draw cadence, 48 MB, no ground shadows |

With `perf: true`, frames that stay slow for five seconds demote the tier while
the story runs; the tier never climbs back inside one session. A browser that
gives no 2D context at all is not a failure to mount: the canvas draws nothing,
one warning names the reason, and the poster, subtitles and audio still play.

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

The media buckets need that same cross-origin GET/HEAD rule. Sprite sheets are
no longer CSS backgrounds: they are fetched with `mode: 'cors'` and
`credentials: 'omit'`, then decoded with `createImageBitmap` (falling back to
`Image.decode`) before they can be drawn into the canvas. A media bucket without
a CORS rule fails every sheet request from a host on another origin, and the
story plays with placeholder silhouettes and one warning per sheet. Poster and
plate video are plain elements and would still load, which is why the symptom
looks like missing characters rather than a missing background.

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
