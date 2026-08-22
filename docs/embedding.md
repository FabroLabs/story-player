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

Beside `story` and `assetBase`, `options` accepts the manifest's `plates` block,
the `stream` object that says the story is still being written, and two
booleans, both off by default:

- `plates` is the manifest block of the same name, `{place: {time: plate}}`,
  and each leaf is a whole plate—one carrying at least a non-empty `zones`
  array, since the traced zones are the only field read off it. A leaf trimmed
  down to its `poster` and `video` answers nothing, so it is refused by name
  rather than accepted and quietly ignored. The compiler reaches the block only
  for a place none of the story's own scenes opens—where the scenes answer, they
  do—so it adds a staging where there was none and never moves one the story
  already decided. Pass it whenever the
  manifest carries it, finished story or not: a host that omits it stages a
  healed step into an unopened place differently from a host that passes it, and
  one story staged two ways is the thing the block exists to prevent. It is a
  manifest block and the join drops it, so the host that has it is the one
  joining the manifest and its scenes itself; a host handed an already-joined
  `story.json` has nothing to pass and says so with nothing.
- `stream` says the writer has not finished yet, and is refused without
  `plates`. See [a story that is still being
  written](#a-story-that-is-still-being-written).
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

## A story that is still being written

Playback does not have to wait for the writer. A host that has published one
scene mounts it with `stream`, then hands over the rest as they land:

```html
<script type="module">
  const url = '/api/stories/7e07/manifest.json';
  const manifest = await fetch(url).then((response) => response.json());
  const player = window.FabroStoryPlayer.createStoryPlayer(
    document.querySelector('#performance'),
    {
      story: join(manifest, [await scene(1)]),
      assetBase: 'https://storage.example/',
      plates: manifest.plates,
      stream: { scenes: manifest.scenes },
    },
  );
  await player.ready;

  for (let index = 2; index <= manifest.scenes; index += 1) {
    await player.appendScene(await scene(index));
  }
  await player.finishStory('done');
</script>
```

The host still owns every fetch, as it always has. The handle carries two more
methods beside `ready` and `destroy`, and `stream` is what makes them mean
something rather than refuse:

- `appendScene(scene)` takes one parsed scene, in publication order. The grown
  story is resolved and compiled whole before anything on screen moves, so a
  scene naming a character the story never carried throws to the host with the
  published prefix still playing—what to tell the viewer is the host's call. It
  is refused after `finishStory`.
- `finishStory(status)` takes `'done'` or `'failed'`, and the timeline treats
  them alike: what has been published is the whole story, so the next end
  reached is the real one. A story that stopped after two of six scenes ends
  after two; the words about the missing ending belong beside the player rather
  than inside it.

Feature-detect the build. Host and player never update together—stable
revalidates after 60 seconds and an open page keeps the build it loaded—so a
host that can stream must keep the path it had before. There is no capability
flag on the global to read first: the handle is the only place the answer shows,
so the test is made on a mounted player, and both methods sit on every handle
this build returns whether or not `stream` was passed. Read it before the viewer
starts the story, and back out by destroying:

```js
const player = createStoryPlayer(element, {
  story: prefix, assetBase, plates, stream,
});
if (typeof player.appendScene === 'function') {
  // grow the mounted story, scene by scene
} else {
  // too old to follow a writer: throw this mount away and take the old path
  player.destroy();
  // wait for the writer to finish, then mount the whole story
}
```

Do not skip the `destroy()`. A build too old to follow a growing story does not
reject `stream`—it does not read the option at all, and the player left behind
is one that will play the published prefix and then show the end, because as far
as it knows the prefix is the story.

What this build does read, it either honours or names. `stream` without
`plates`, a `stream` carrying any key but `scenes`, and a `plates` block whose
leaves are not plates are all refused at mount; `appendScene` and `finishStory`
on a player mounted without `stream` are refused when called. A mount refusal
does not throw out of `createStoryPlayer`, though: the player paints the reason
onto its own surface and the handle comes back with a rejected `ready`, so a
host that only wraps the call in `try` and never awaits `ready` learns nothing.
Only a container that is not an `Element`, a `story` that is not a parsed
object, and a Storylang version this build does not know throw synchronously.

While the story grows:

- The badge reads `scene 1 of N` from the first frame when `stream.scenes` says
  how long the story will be. Pass it: it is the manifest's count, and without
  it a viewer watches `scene 1 of 1` become `scene 2 of 2`, a story that never
  seems to get anywhere. It is a floor rather than a promise—publish more scenes
  than you declared and the badge counts what is really there—and `finishStory`
  drops it to what actually arrived, so a story that ended early is never left
  counting up to a total nobody wrote.
- The remaining time on the bar grows with each append. An append never moves an
  event the viewer has already crossed, so seeking back over a scene boundary
  lands on the frame it landed on before.
- When playback catches up with the writer the picture holds its last frame, the
  stage dims, and a spinner says *the storyteller is still writing…* through a
  `role="status"` node. The clock, the plate and the audio stop with it. The
  transport does not: play and pause still work under the spinner, where they
  mean "carry on when the scene lands" and "stay here", and the next
  `appendScene` obeys whichever the viewer chose last. A story that was rolling
  when it caught up rolls on by itself. Scrubbing back out of the wait also
  leaves it, and nothing about the wait can be reached by a viewer who paused
  earlier—a paused story never plays out its prefix to arrive there.

Liveness is the host's, exactly as fetching is. The player has no timeout of its
own: it waits in that spinner until `appendScene`, `finishStory` or `destroy`
arrives. A host whose writer stalls is the one that decides how long to be
patient, and then calls `finishStory('failed')`.

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

Changing `story`, `assetBase`, `plates`, `debug`, or `perf` destroys the
previous instance before mounting the replacement. Unmounting destroys the
instance. React StrictMode is supported.

`plates` is a prop here for the same reason it is an option there: a component
that mounted a finished story without it would stage that story differently from
a host that passed it. `stream` is not a prop—it throws. The component keeps no
handle to call `appendScene` on, and it remounts whenever `story` changes
identity, which for a growing story is every scene; accepting the option would
put it on the host `div` as an attribute and mount a player that shows the end
at the end of the prefix. A React host following a writer calls
`createStoryPlayer` on its own element instead.

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
