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

The player owns its transport, inside the Shadow DOM and below the stage. It
appears when the story begins, not while the opening ceremony is still up:
play/pause, skip back and forward ten seconds, a draggable progress bar with the
elapsed time and the minutes left, and the subtitle toggle.

Keyboard, while the stage frame has focus: space or `k` toggles play, the arrow
keys skip ten seconds, `Home` and `End` seek to the start and the end. Keys are
ignored while a text field has focus, and space and enter are left to whichever
button has focus so the drawer and toggle stay reachable.

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
