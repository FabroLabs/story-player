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
the `stream` object that says the story is still being written, the `cards`
either side of the story, the `kicker` line the ceremony opens with, and two
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
  `story.json` has nothing to pass and says so with nothing. `{}` is that same
  nothing — a block with no places in it answers no question — so it does not
  satisfy a streaming mount's requirement for one.
- `stream` says the writer has not finished yet, and is refused without
  `plates`. See [a story that is still being
  written](#a-story-that-is-still-being-written).
- `cards` are the manifest's `intro` and `end_card` blocks, passed under those
  two names. See [the cards either side of the
  story](#the-cards-either-side-of-the-story).
- `kicker` is the line over the story's name on the opening screen, for a host
  mounting something that is not a bedtime story—`kicker: 'a counting lesson'`.
  Anything that is not a string with words in it leaves the default,
  `a bedtime story`, rather than an empty line where it would have been.
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
frame cells, the camera framing, the subtitle showing, the counting board
(`slate: {count, mode, groups, sinceMs, from, standing}`, and `highlightMs` on each
actor—see below), and the warnings crossed on the way. It interprets the timeline and never re-decides it.

The picture is a single canvas 2D stage drawn over the hardware-decoded
`<video>` plate, both inside the player's open Shadow DOM. Camera framing is a
CSS transform on the plate and the matching `ctx.setTransform` on the canvas,
written only when the framing moves. Subtitles, the media note and the controls
stay ordinary DOM.

A lesson draws two things a bedtime story never asks for, and both come through
the same path. `slate` is the counting board: a translucent panel over the
scene carrying one counter per thing counted, a running-count badge, and the
equation written under them. It is the whole claim rather than a total—`mode`
is `count`, `add` or `subtract`, `groups` is what it was reached from (`[n]`,
`[a, b]` addends, or `[start, taken]`), and `count` is the answer—so a client
can draw two addends in two colours and cross out what a take-away took. How
many counters that is follows the mode: a count or a join draws `count` of
them, and a SUBTRACTION draws `groups[0]`—everything it started with—then takes
`groups[1]` away. A step that names only a count is normalised into the
plain-count shape, so a bundle built before modes existed draws the same board.
`count: 0` with `mode` `count` and nothing in `groups` is the EMPTY board: the compiler raises one
at the opening of the scene that first counts—right after that scene's `scene`
op, once per story—so a lesson begins on its panel rather than on the floor the
panel is about to cover, and `stateAt` answers it with `standing: true` and
nothing to draw on it. A client folding the stream stands the panel there,
frost and all, and draws the first count onto it. An AUTHORED count of
nothing—what v1's `slate(off)` compiled to—is still refused with
`slate-count-unusable`, and so is an empty board over a standing one: nothing
lowers a board, and a board comes down only with the story.
`V0_POLICY.slate.max` is the largest count there is,
and a claim whose own groups do not make its count—or that runs past the
ceiling—is refused with `slate-count-unusable` rather than mended, at the
compiler and again at `stateAt`, so no client is left drawing a board the story
did not ask for without being told. A board the story TAKES AWAY before it has
finished arriving—the ending, or a DIFFERENT board raised over it less than a
build later—is said too, as `slate-cut-short` carrying the milliseconds it
needed and the milliseconds it got: a board wiped before its equation shows a
child the counters and never the sentence they were for, and nothing else about
the bundle looks wrong. A scene cut is NOT one of them: the board outlives the
seam, so a board raised a second before a cut goes on counting itself over the
next scene. A board replaced by one counted on from it is not cut short either;
that is the lesson working. The whole build is a function of the
instant the board was raised (`sinceMs`) and of `from`: a counter every
`staggerMs`, each popping over `popMs`, then a take-away crossing out one
counter every `takeStaggerMs`, each cross taking `takeMs`, then the equation a
token every `tokenMs`. `from` is how many counters were ALREADY standing—a
plain count raised over a smaller plain count in the same scene carries the
previous count, and those counters are drawn settled while the build starts at
the first new one, so a lesson counting on to four does not re-pop the three
that never left. A cut does not interrupt that either: the three are still
standing after it, so a four raised in the next scene still counts on from them. A client folding the stream itself has to work `from` out the
same way, or its board breathes on every number. It is a HUD—painted in plate
coordinates with the camera left out, so a push-in moves the scene behind the
glass while the arithmetic keeps its size and its place; any command the
list marks `hud` is drawn that way, not the board alone. While a board is up it
IS the picture: nothing standing on the floor is drawn—not the pile being
counted, not the numeral card, not the shadow under either, because the panel
covers 91 x 84.5% of the stage and a sprite under it is a sliver sticking out
past the glass—and the plate behind it is blurred by
`V0_POLICY.slate.frost.pct` of the plate's own height, eased over `frost.ms`.
That blur is a CSS filter on the plate layer rather than a command in the list:
the plate is a `<video>` on its own compositor layer that the list never
reaches, so a client folding the stream itself has to apply it to whatever its
background is. The one thing kept over the board is the companion, redrawn as a
`hud` figure `V0_POLICY.slate.companion.heightPct` of the plate tall, centred at
`centreXPct` with its feet at `feetPct`—the first character on stage, never a
prop, and nobody who has already faded out. `highlight` is a gold ring around
one subject, pulsing twice over `V0_POLICY.highlight.durationMs` and riding its
actor under the camera—unless a board has hidden that subject, and then the same
pulse is drawn `hud` just clear of the gold mark on the counter the count has
reached. A highlight of the companion stays on the companion, up in the corner;
two hidden subjects ringed in one instant leave only the one named last, since
they would both land on the same counter. A scene cut clears the ring, and so does the ending. NOTHING
clears the board—a lesson is one uninterrupted surface, and the board its first
count raises is the board the end card is drawn over. Watch where that happens:
the subtitle is reset by an event of its own, while the ring is cleared by the
`scene` and `end` ops themselves, so a client folding the stream must clear the
ring at both ops rather than wait for a reset that never arrives, and must
never clear the board at either. Every rectangle, counter and band either one draws is measured
from `V0_POLICY.slate` and `V0_POLICY.highlight`; the COLOURS are the painter's
own—a client with its own palette is still drawing this board—and the numerals
are set in the platform's rounded font, deliberately not part of that contract.

The story clock is pausable and seekable, and audio follows it: each cue starts
at its own `t_ms` and is aligned by `currentTime`, so blocked or late audio
never holds up the picture. The loop redraws only when the frame changed—and a
board still popping or a ring still pulsing IS the frame changing, so a counting
scene where nobody moves still repaints until its overlay has landed—and never
faster than 24 Hz. A story that is paused, hidden, ended or destroyed
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
- An `appendScene` that ends a wait decodes the scene before the spinner comes
  down, and only then resolves. It is the one scene nothing could warm ahead of
  time, and the wait is the one moment the picture is already stopped, so the
  decode is spent where nobody sees it rather than on the cut. A host feeding
  scenes faster than they are played is unaffected: outside a wait the append
  returns as soon as the timeline has been swapped.

Liveness is the host's, exactly as fetching is. The player has no timeout of its
own: it waits in that spinner until `appendScene`, `finishStory` or `destroy`
arrives. A host whose writer stalls is the one that decides how long to be
patient, and then calls `finishStory('failed')`.

## The cards either side of the story

A story may open on its world's intro film and close on its end card, each with
the music its writer chose. Both come off the manifest and are passed under one
option:

```js
const player = createStoryPlayer(element, {
  story,
  assetBase: 'https://storage.example/',
  plates: manifest.plates,
  cards: { intro: manifest.intro, end_card: manifest.end_card },
});
```

Every value inside is bucket-qualified media, resolved under the same
`assetBase` as the rest, and every one of them is checked at the mount: a card
is reached after the viewer has pressed begin, and a bad path found there would
be a black rectangle where the opening was. Only the two slot names are fixed —
a block that grows a field this build does not read is played rather than
refused, so a newer manifest never costs an older player the story.

Either slot may be left out, and a mount with neither is the player as it was
before cards existed. Within a slot, `video` is required; `music` is optional
and a card without it plays silent; `intro.narration` is `{text, audio}`, the
story's own title, and its `audio` is optional too — the words are shown on the
card either way, because a name only a listener gets is a name half the audience
never hears.

`intro.lead` is the cast slug of the character the story is about, and it is
what turns the opening's ending into a title card — see the intro below. It is
optional, and its absence is not a lesser card: a manifest written before this
key existed opens exactly the way it was built to. It is read together with
`intro.narration`, which carries the words: a card that names a lead but has no
narration has no name to raise, and plays the ordinary short ending instead.

The slug is looked up in the cast the player was mounted with — `story.cast`
for a joined story, `story.cast_bundle` for a host that mounts the manifest
itself (the no-scenes case below), which is where a manifest keeps that block.
A slug neither carries, a character with no clip to stand in, or a sheet that
has not decoded by the time the film ends costs the card its sprite and writes
one line in the log. None of them costs the story anything.

Neither card is in the compiled timeline, and that is the point: `duration_ms`,
the scrub bar and every `t_ms` cover the story alone, so seeking cannot land
inside a title sequence and the timeline a phone client is handed is the same
one this player compiles. What the cards are instead is a phase either side of
it:

- The intro plays between the begin click and the story. The film is warmed
  while the opening scene is decoded, its own `<video>` is the clock, and the
  music starts inside the click. It arrives through black rather than in front
  of what was on screen, and it ENDS as a beat rather than a cut: the film's
  last frame is held with the music still playing, then a curtain takes the card
  away with the music falling inside it, and the story is begun only once that
  curtain is over. The curtain is the arrival run backwards and takes the same
  half-second: the film goes under the layer's own black first, then the black
  goes out onto the story. A card that simply dissolved into scene one would not
  read as an ending at all — two lit forests crossing over each other is a blur,
  not a curtain — and a black that outstayed the arrival that made it would read
  as a wait.
- What happens on that held frame is what `intro.lead` decides. **Without a
  lead**, the story's name is written and spoken a second into the film, with
  the music ducked under it, and the held frame is a short beat — budget about a
  second and three quarters between the film's last frame and the story's first. **With one**,
  nothing is written over the moving picture at all: the name waits for the held
  frame and fades in there, spoken at the same moment, with the lead standing
  beside it in its idle loop. The name and the sprite are drawn on a layer of
  their own ABOVE the card, so the curtain can take the film out from under them
  and leave them standing on the black — and then they go WITH that black, on
  the curtain's second half. What the story opens on is the story.
- That beat is at least three seconds and no more than six: it asks the spoken
  title's own file how long it is and waits for it, because a title sequence
  that clips the title is the thing this beat exists to fix. A narration with no
  audio, or one that never reports a duration, gets the three. So budget between
  three and a half and six and a half seconds between the film's last frame and
  the story's first.
- The lead's sprite is drawn from the same bundle and the same decoded-sheet
  cache the scenes are, at the smallest rendition the ladder carries: it is a
  decoration on a three-second beat, not a subject. It is asked for while the
  film is still playing and never waited on — a sheet that has not decoded by
  the time the film ends leaves the name alone on the card, on schedule.
- The end card plays after the story has stopped — the clock paused, the plate
  stopped, the last line left to finish — and before the end screen, which waits
  behind it. Its film is warmed as the last scene opens. It ends differently
  from the intro: there is no curtain, because there is nothing left to hand the
  stage back to. The closing film holds its last frame and KEEPS it — the layer
  drops under the end screen and the transport and becomes the ground "the end"
  is written on, rather than fading out to show the scene the story stopped on.
  The music still goes, over the length the curtain would have taken. Scrubbing
  back into the story, or replaying it, takes that backdrop away with it.
- A dedicated skip sits on the card, visible the whole time either one is up,
  and it is the only control there: the transport is withdrawn for as long as a
  card is playing and comes back when it is over. Covered is not enough — its
  keys are live wherever the focus is, and a space bar under an opaque film
  would steer a story nobody can see.
- A replay is the whole performance again — intro, story, end card — with the
  story standing at zero behind the opening film.
- A card is not on the story's clock, so a tab that goes away stops it here: the
  film, its music and the lead's idle loop pause together and resume together. A
  film that has already ended is not started again — the beat its last frame is
  held for begins over, so a viewer who looked away gets the whole of it rather
  than its stub.
- Nothing here can hold the story up. A card whose file fails, is refused by the
  device, never puts a frame on screen, or stops moving part-way through ends
  its phase and writes one named line into the log. So does a spoken title: if
  it cannot be heard the music stops making room for it. And so does the lead —
  a slug this story never cast, a character with no clip to stand in, a sheet
  that was still fetching when the film ended: one line each, and a title beat
  with the name on it and nothing beside it.

`cards.intro` is also what allows a mount with **no scenes at all**, alongside
`stream` and `plates`:

```js
const player = createStoryPlayer(element, {
  story: { ...manifest, scenes: [] },
  assetBase, plates: manifest.plates, stream: { scenes: manifest.scenes },
  cards: { intro: manifest.intro, end_card: manifest.end_card },
});
await player.ready;
await player.appendScene(await scene(1));
```

The player mounts on the manifest, before the writer has published anything, and
the intro is what the first scene is published during. Nothing is resolved or
compiled until that scene arrives — an empty story is not the opening of
anything — so the begin button is armed by the card alone, and the story is
entered when the curtain falls. If the scene is not there yet the waiting
spinner says so, exactly as it does mid-story, and the story starts the moment it
lands and decodes. A writer who publishes nothing at all and then calls
`finishStory` ends the performance rather than leaving a viewer in the spinner.

A build too old to know the option ignores it and plays the story alone, which
is what makes it safe to pass unconditionally — but an old build also ignores
`scenes: []` only as far as refusing the mount, so a host that mounts with no
scenes must be the one that already feature-detected `appendScene`.

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

Changing `story`, `assetBase`, `plates`, `cards`, `kicker`, `debug`, or `perf`
destroys the previous instance before mounting the replacement — the eyebrow is
written once, when the ceremony is built, so a `kicker` that changes mid-story
sends the viewer back to the opening screen. Hold it still, as you would a
story. Unmounting destroys the
instance. React StrictMode is supported.

`plates` and `cards` are props here for the same reason they are options there:
a component that mounted a finished story without them would stage that story
differently, and open it without its title card. Hold the `cards` object still
between renders — a fresh object literal on every render is a new identity, and
a new identity remounts the player. `stream` is not a prop—it throws. The component keeps no
handle to call `appendScene` on, and it remounts whenever `story` changes
identity, which for a growing story is every scene; accepting the option would
put it on the host `div` as an attribute and mount a player that shows the end
at the end of the prefix. A React host following a writer calls
`createStoryPlayer` on its own element instead.

## Controls

The player owns its transport, inside the Shadow DOM. It appears when the story
begins, not while the opening ceremony is still up, and it withdraws again for
as long as a card is playing — each card has a skip of its own: play/pause, skip back and
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

Narration keeps the end of itself. A line's schedule is decided before anything
has been heard, and its file costs a fetch to open, so a line that arrived late
used to be cut short of its last words when the clock reached the end the
schedule had guessed. The player now opens the next line's file while the
current one is still playing, and a line that is sounding runs on until it has
played what is left of it—while the story's clock is running, by at most
`V0_POLICY.audio.narrationGraceMs`, which also bounds how far a line may overlap
the opening of the one after it. Subtitles and the clock are untouched: only the
audio runs on. The two instants the story stops at on its own—the end, and
catching up with a writer who has not published the next scene yet—let the
sentence being read finish rather than freezing it mid-word. The clock has
stopped at both, so nothing is counting there: what ends the line is the file
itself, or the next pause, seek or `destroy`.

## Sheets, renditions and device tiers

Every clip in a current bundle carries `renditions`—the content-addressed webp
ladder at 200, 320, 384 and 512 px, the same one the phone client reads. The
player asks for the smallest step that covers the sprite's drawn height times
the stage's fit scale, the capped device pixel ratio, and the largest camera
magnification that scene reaches; when a ladder exists the original sheet is
never requested. Renditions are re-gridded during the encode—a one-row strip
becomes near-square—and the player derives that grid rather than reading the
bundle's, which describes the original.

Beside that ladder a current bundle also carries `rendition_chunks`: the same
four steps cut into short runs of frames, each step a `{frames_per_chunk, keys}`
block whose `keys` are in frame order. Where they exist the player draws from
one chunk at a time and holds only the chunk under a character's playhead plus
the next, so a scene costs a few megabytes of decoded bitmap per character
instead of a whole clip—one 81-frame clip at 512 px is 4608×4608, which is 81 MB
of RAM on its own and more than a small device's entire budget. The chunk
holding frame `f` is `floor(f / frames_per_chunk)`, its cell inside that chunk is
`f % frames_per_chunk` counted row-major, and every
chunk of a clip—including a short last one, which the encode pads—is laid out on
`nearSquare(min(frames_per_chunk, clip.frames))`. The scene's opening chunks are
part of the gate; the rest are fetched as the story reaches them.

A bundle built before renditions existed still plays. It falls back to the
original sheets and says so once per sheet in the log. A bundle with renditions
but no chunks plays from the whole sheets, exactly as before they existed; a
chunk block whose key list does not match the clip's frame count is refused the
same way, with one line in the log, because reading it would draw the wrong
frames rather than fail.

The device tier is probed once, before the first frame, from `deviceMemory`,
`hardwareConcurrency` and 2D-canvas support:

| tier | what changes |
|---|---|
| `high` | full budget: 96 MB of decoded sheets, DPR capped at 2, 24 Hz |
| `mid` | the decoded-sheet budget halves to 48 MB; the picture is identical |
| `low` | DPR capped at 1.5, 12 Hz draw cadence, 48 MB |

The ground shadow under each character is currently off on every tier: it is
drawn at the stand line, and a sprite's cell carries transparent rows under the
feet, so it sat visibly below the character. It comes back when the contact line
is measured from the artwork.

With `perf: true`, frames that stay slow for five seconds demote the tier while
the story runs; the tier never climbs back inside one session. A browser that
gives no 2D context at all is not a failure to mount: the canvas draws nothing,
one warning names the reason, and the poster, subtitles and audio still play.

## The counting board, as a contact sheet

`npm run sheet:board` paints a lesson's board at five instants of each build
into a single PNG. It is dev tooling, not a test: it asserts nothing, it is
never run by CI, and it exists because the board ARRIVES rather than appears,
and no one screenshot shows that.

A row is the life of ONE board, and its instants are clamped to that life rather
than simply offset from it. A counting lesson raises `slate 1`, `slate 2` and
`slate 3` about half a second apart, so a blind `+3.2 s` would paint the third
board under the first one's caption; instead the row holds at its own last
moment, its header says how long the board was held, and its final cell is
whatever ended it — the next board, or the story. A scene cut ends nothing: the
board outlives it.

`--bundle <path>` (repeatable) takes real built bundles instead of the fixtures
in `tests/fixtures/board/`; `--out` moves the PNG and `--scale` resizes it.
`--dump` writes each instant's `slate` and `ring` draw-list commands to stdout
as JSON lines — the pure answer, and the part worth diffing; progress and page
errors go to stderr, so the stream pipes clean into `jq` or a differ.

The plate is a DOM `<video>`, so it is never in these pixels: a flat ground
stands in for it, and anything to be judged against a real plate — the frost,
above all — needs a mounted player.

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
story plays with placeholder silhouettes and one warning per object—which on a
chunked bundle is one per chunk, so a single 81-frame clip at 512 px is twenty-one
lines. Poster and plate video are plain elements and would still load, which is
why the symptom looks like missing characters rather than a missing background.

## Branches and deployment

Three branches, and only one of them reaches a child's bedtime. `dev` is where
work is tried, `main` is where work lands and means "ready for production", and
**`production` is what is deployed** — merging into it is the deliberate act
that publishes a player, and nothing else in this repository moves what the
cluster serves.

A merge into `production` runs **Deploy player**
(`.github/workflows/deploy-player.yml`):

1. `verify` — unit tests, a deterministic build, real Chromium
   plain-JavaScript/React tests, and the repository contract;
2. `release` — rebuilds, writes `build.json` (commit, byte count, SHA-256),
   creates the immutable `build-<commit>` release, then moves the rolling
   `latest` tag onto those bytes, and finally re-downloads both published assets
   and byte-compares them against what it just built.

The `release` job cannot start unless `verify` passes.

## The dev rail

A push to `dev` runs **Deploy dev** (`.github/workflows/deploy-dev.yml`), which
builds the player and writes it straight into the **`story-player-dev`** S3
bucket — same layout as production, so an integration can point at

```text
${S3_URL}/story-player-dev/stable/story-player.js
```

or pin `story-player-dev/builds/<commit>/story-player.js` for an exact build.

It is a separate bucket and not a prefix, because the production bucket is read
at runtime: story-engine-v2 loads `story-player/stable/story-player.js` and pins
`story-player/builds/<commit>/` in its `story-player.lock.json`. A dev build
promoted into that bucket would be served to whoever is using that engine. A
second bucket lets the credential itself be scoped, so a wrong key here cannot
reach production even in principle — `scripts/storage-config.mjs` enforces the
two names as an allow-list, and the workflow contract test asserts each rail
never names the other's bucket or environment.

Dev publishes no GitHub release. `production` does that because the cluster
mirrors releases over a pull-shaped path it cannot invert; the dev store answers
directly, so the build is written where it is read and `latest` keeps meaning
exactly one thing — the newest production player.

**Dev runs no tests, on purpose.** Five steps: checkout, Node, `npm ci`,
`build:cdn`, `publish:cdn`. `dev` is where work is tried, and a preview rail
that refuses to publish a broken build cannot show you the break — a dev page
rendering wrong is faster feedback than a red tick. The consequence is worth
holding onto: a commit pushed straight to `dev` is tested nowhere, because CI
runs on pull requests and on `main`. The pull request into `main` is the first
gate, and `production` reruns the whole suite before it publishes anything.

There is no `workflow_dispatch` either — the trigger is a push to `dev` and
nothing else. To republish without a new commit (after creating the bucket, or
rotating a key), rerun the last run: `gh run rerun <id>`.

### Naming, and why the two halves differ

The `cdn-dev` environment holds these, named for the **rail**:

| Name | Kind | Example |
| --- | --- | --- |
| `S3_DEV_URL` | variable | `http://<host>:9002` |
| `S3_DEV_REGION` | variable | `us-east-1` (default if unset) |
| `S3_DEV_ACCESS_KEY` | secret | — |
| `S3_DEV_SECRET_KEY` | secret | — |

The workflow maps them onto `S3_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` and
`S3_REGION`, which is what `scripts/storage-config.mjs` reads. The script side is
named for the **protocol**, because it is not the script's business which rail
called it — it is given an endpoint, a bucket and a key pair, and it validates
them the same way either time. The GitHub side is named for the rail because a
repository setting called `S3_ACCESS_KEY` gives a reader no clue which store it
opens, and the one it used to open was production's. The workflow contract test
asserts the dev workflow reads only `S3_DEV_*`.

Neither side is named for a vendor. The store is RustFS today and MinIO in the
cluster; the publisher only needs it to speak S3.

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

There was previously a second workflow that wrote straight into the
**production** bucket over S3, on every green `main`. It has been removed: two
writers of one `stable/` key meant two answers to "which bytes are live", and
the answer that mattered was the cluster's.

The S3 publisher scripts (`scripts/publish-cdn.mjs`, `scripts/storage-config.mjs`,
`scripts/verify-cdn.mjs`) are not vestigial — the dev rail above calls them. What
changed is which bucket a runner may address: `story-player-dev` from `dev`, and
nothing from `main`.

`scripts/rollback-cdn.mjs` went with that change — see **Rollback** below for
what replaced it. A script with no caller is a claim about how the system works,
and that one had stopped being true.

## Rollback

Production: pick the immutable `build-<commit>` release and pin the consumer to
it. In the moonykids cluster that is `infra/scripts/17-player-rollback.sh
<full-commit>`, which writes `stable/pinned.json`; the mirror keeps ingesting
new builds but will not promote over the pin until it is removed. Nothing is
rebuilt and no immutable release is ever edited.

Dev: push again. If a specific older build is wanted meanwhile, point the dev
server at its immutable object —
`${S3_URL}/story-player-dev/builds/<commit>/story-player.js` — which is still
there, because `builds/` writes are create-only and nothing prunes them.

There is no rollback script. There used to be one that moved an S3 `stable/` key
back to an earlier build; it described neither of these paths and had no caller,
so it was removed rather than left as a claim about a mechanism that no longer
existed.

## GitLab migration

The output and release layout do not depend on GitHub beyond the release API. A
protected GitLab runner can run the same Node 22 commands and publish the same
two files — `story-player.js` and `build.json` — anywhere a consumer can fetch
over HTTPS. What must not change is the contract: the consumer verifies commit,
byte count and SHA-256 before promoting, so any host works as long as both files
are served together and `build.json` describes the bytes beside it.
