import { PlayerBoard } from '../board.mjs';
import { desiredFacing, selectFacingClip, selectLocomotion } from '../clips.mjs';
import { alongFloor, floorSpan, isSide, sideX, zoneNamed } from '../geometry.mjs';
import { cameraPoint, cameraSpeed, resolveShot } from './camera.mjs';
import { Recorder, stepDetail } from './events.mjs';
import { TimelineStage } from './stage.mjs';
import { Schedule, createGate, runToEnd } from './timing.mjs';
import {
  BESIDE_NUDGE_PCT,
  DEFAULT_EXIT_X_PCT,
  DEPARTURE_DEADLINE_MS,
  MINIMUM_DEPARTURE_SECONDS,
  MINIMUM_MOVE_SECONDS,
  MOVE_X_PCT_PER_SECOND,
} from '../../policy.mjs';

/**
 * A bundle is a SCRIPT, not a schedule.
 *
 * It says a chunk is narrated, then a character crosses the clearing, then a
 * scene ends. What it never says is that the crossing starts at 12,340 ms,
 * takes 1,818, and does not stop the narration behind it. `compileTimeline`
 * answers that — once, purely, synchronously — and every client then plays the
 * same answer instead of rediscovering it, differently, on its own device.
 *
 * Nothing here reads the network, a file or a clock. Same bundle in,
 * byte-identical timeline out.
 */

// Bumped when the shape below changes, so a client can refuse a timeline it
// does not understand instead of misreading one.
const TIMELINE_VERSION = 1;

// The step kinds this compiler performs. Anything else would be logged and
// skipped, which in a live player is a graceful shrug and in a published
// schedule is content that silently does not exist.
const KNOWN_KINDS = new Set(['chunk', 'cmd', 'together']);

// `follow` carries this in place of a character to end the ride. It travels as
// a literal word rather than a null so a released follow can never be mistaken
// for an argument that went missing on the way here.
const RELEASE_FOLLOW = 'off';

export function compileTimeline(bundle) {
  requireCompilableBundle(bundle);

  const schedule = new Schedule();
  const recorder = new Recorder(() => schedule.now());
  const director = new Director(bundle, schedule, recorder);

  runToEnd(schedule, walkStory(director));

  return {
    timeline_version: TIMELINE_VERSION,
    storylang_version: bundle.storylang_version,
    title: bundle.title ?? null,
    duration_ms: schedule.now(),
    events: recorder.events(),
  };
}

/**
 * This must be a v0 bundle, and a whole one.
 *
 * Both halves matter. A file with no scenes at all would compile to a valid,
 * publishable, zero-millisecond timeline; and timing a foreign bundle with
 * these rules and stamping it with its own version number is how a client gets
 * a confidently wrong schedule.
 */
function requireCompilableBundle(bundle) {
  if (bundle?.storylang_version !== 0) {
    throw new Error(
      `storylang_version is ${JSON.stringify(bundle?.storylang_version)}, not 0 — this `
      + 'compiler implements the v0 language, so it can only time a v0 bundle',
    );
  }
  if (!Array.isArray(bundle.scenes) || bundle.scenes.length === 0) {
    throw new Error('no scenes — this is not a built story bundle');
  }

  const unknown = [];
  const walk = (steps, sceneIndex) => {
    for (const step of steps ?? []) {
      if (!KNOWN_KINDS.has(step?.kind)) {
        unknown.push(`scene ${sceneIndex} line ${step?.line ?? '?'}: ${JSON.stringify(step?.kind)}`);
        continue;
      }
      if (step.kind === 'together') walk(step.steps, sceneIndex);
    }
  };
  bundle.scenes.forEach((scene, index) => walk(scene?.steps, index));

  if (unknown.length > 0) {
    throw new Error(
      `${unknown.length} step(s) of a kind this player does not perform:\n    `
      + `${unknown.join('\n    ')}\n  They would vanish from the schedule without `
      + 'shortening it — refusing instead',
    );
  }
}

/**
 * The walk, and the only place time passes.
 *
 * Everything a step does is instantaneous; what makes a story long is narration,
 * a `pause`, and a scene refusing to close while somebody is still walking off
 * it. Those three are the `yield`s below, and they are the whole clock.
 */
function* walkStory(director) {
  for (const [sceneIndex, scene] of director.scenes().entries()) {
    director.beginScene(scene, sceneIndex);
    for (const step of scene.steps ?? []) yield* walkStep(step, director);
    yield* walkSceneEnd(director);
  }
  director.showEnd();
}

function* walkStep(step, director) {
  // A `together` block fires its children and does NOT wait: the block's own
  // pacing is whatever its children happen to cost the story, which for
  // everything but a chunk is nothing at all.
  if (step.kind === 'together') {
    director.logStep(step);
    for (const child of step.steps ?? []) director.logStep(child, step);
    director.performTogether(step.steps ?? []);
    return;
  }

  director.logStep(step);

  if (step.kind === 'chunk') {
    yield director.narrate(step);
    return;
  }
  if (step.kind === 'cmd' && step.cmd === 'pause') {
    yield director.wait(step.seconds * 1000);
    return;
  }
  if (step.kind === 'cmd') director.performCommand(step);
}

function* walkSceneEnd(director) {
  if (director.pendingDepartures() > 0) yield director.departureGate();
  director.closeScene();
}

/**
 * Every decision a performance makes, with nothing to draw on.
 *
 * This is the same reasoning a live player runs — who stands where, which way
 * they face, which clip loops, how far the camera magnifies — with the stage
 * calls written down instead of rendered. The pure core underneath (`board`,
 * `clips`, `geometry`, `presentation-policy`) is shared with the renderer, so
 * the two cannot answer the same question differently.
 */
class Director {
  #story;
  #schedule;
  #recorder;
  #stage;
  #board = new PlayerBoard();
  #scene = null;
  #sceneIndex = null;
  #currentLine = null;

  constructor(story, schedule, recorder) {
    this.#story = story;
    this.#schedule = schedule;
    this.#recorder = recorder;
    this.#stage = new TimelineStage(schedule, recorder);
  }

  scenes() {
    return this.#story.scenes ?? [];
  }

  beginScene(scene, sceneIndex) {
    this.#scene = scene;
    this.#sceneIndex = sceneIndex;
    this.#currentLine = scene.line ?? null;
    const origin = this.#origin(scene.line);
    this.#stage.showScene(scene, origin);
    const arrivals = this.#board.beginScene(scene.place, this.#floorSpanFor(scene.place));

    // Arrivals are staged before the scene's first authored step.
    for (const character of arrivals) {
      this.#placeVisibleCharacter(character.slug, character.x, null, this.#board, origin);
    }
  }

  closeScene() {
    this.#stage.setSubtitle('');
    this.#stage.resetCamera();
  }

  showEnd() {
    this.#stage.showEnd();
  }

  pendingDepartures() {
    return this.#stage.pendingDepartures();
  }

  logStep(step, together = null) {
    this.#recorder.step({
      scene_index: this.#sceneIndex,
      line: step.line,
      kind: step.kind,
      ...(step.cmd === undefined ? {} : { cmd: step.cmd }),
      detail: stepDetail(step, together),
    });
  }

  /** Time passes here and nowhere else. */
  wait(milliseconds) {
    const gate = createGate();
    this.#schedule.at(milliseconds, () => gate.pass());
    return gate;
  }

  /**
   * The subtitle goes up, then the story waits out the narration.
   *
   * Its length is the chunk's own `duration_s` — the measured length of the wav
   * it stands for. A text-only chunk waits the same number, which is then the
   * language's estimate rather than a measurement; refusing that is the
   * publishing tool's job, not this one's, because a browser playing a
   * preview should still get a schedule.
   */
  narrate(step) {
    this.#currentLine = step.line ?? this.#scene.line ?? null;
    this.#stage.setSubtitle(step.text);
    return this.wait(Math.max(0, Number(step.duration_s) * 1000 || 0));
  }

  /**
   * A scene cannot close while somebody is still walking off it — but it will
   * not hold the whole story on one, either. Whichever lands first cancels the
   * other, so the deadline can never fire into a scene that already moved on.
   */
  departureGate() {
    const gate = createGate();
    const deadline = this.#schedule.at(DEPARTURE_DEADLINE_MS, () => {
      this.#stage.whenDeparturesDrain(null);
      const origin = this.#origin(this.#scene.line);
      this.warning(
        { type: 'media', asset: 'travel', message: 'scene departure deadline reached' },
        origin.line,
        origin.scene_index,
      );
      gate.pass();
    });
    this.#stage.whenDeparturesDrain(() => {
      this.#schedule.cancel(deadline);
      gate.pass();
    });
    return gate;
  }

  /**
   * Every refusal in this compiler comes through here, so a step that was not
   * performed is never merely absent from the schedule.
   *
   * `line` and `sceneIndex` are for a warning that outlives the step which
   * armed it — the scene-end departure deadline is the only one — and otherwise
   * default to wherever the walk has got to.
   */
  warning(detail, line = this.#currentLine ?? this.#scene?.line ?? null, sceneIndex = this.#sceneIndex) {
    this.#recorder.step({ scene_index: sceneIndex, line, kind: 'warning', detail });
  }

  performTogether(steps) {
    const reference = this.#board.reference();
    for (const step of [...steps].sort(compareTogetherSteps)) {
      this.performCommand(step, reference);
    }
  }

  performCommand(step, reference = this.#board) {
    this.#currentLine = step.line ?? this.#scene.line ?? null;
    const origin = this.#origin(step.line);
    switch (step.cmd) {
      case 'put': this.#put(step, reference, origin); break;
      case 'emote': this.#emote(step, reference, origin); break;
      case 'move': this.#move(step, reference, origin); break;
      case 'travel': this.#travel(step, reference, origin); break;
      // Sound and music cost the schedule nothing: the step entry already
      // carries the name at the right instant, and a timeline that says a thing
      // twice is a timeline that can disagree with itself.
      case 'sound': break;
      case 'music': break;
      case 'push_in': this.#pushIn(step, reference); break;
      case 'pull_out': this.#stage.pullOut(this.#speed(step)); break;
      case 'shot': this.#shot(step); break;
      case 'pan_to': this.#panTo(step, reference); break;
      case 'follow': this.#follow(step, reference); break;
      default: this.warning({ type: 'policy', policy: 'unknown-command', cmd: step.cmd });
    }
  }

  // A healed travel can put a character in a place no scene ever opens, and a
  // place could one day carry a plate per time of day — this takes the first
  // scene standing there, which is the whole story's answer only while every
  // place has exactly one plate. Falls back to the whole plate, never throws.
  #floorSpanFor(place) {
    // the default zone's span, which is what `floor_polygon` was a copy of
    // before it was deleted. One geometry, named once.
    return floorSpan(zoneNamed(this.#plateFor(place), null)?.polygon);
  }

  // The plate a place is shown on, wherever the camera happens to be. A healed
  // put names a place the camera has not opened yet, and that place's bands are
  // the ones its own scene will show.
  #plateFor(place) {
    const open = this.#scene;
    if (open && place === open.place) return open.plate;
    return this.#story.scenes?.find((candidate) => candidate.place === place)?.plate;
  }

  // Which band a step lands in, and how wide it is. A story that named no zone
  // gets the plate's default, so a character is never unplaced — the engine
  // guarantees that even when the text does not say it.
  #bandFor(place, zoneName) {
    const zone = zoneNamed(this.#plateFor(place), zoneName);
    if (!zone) return { zone: null, span: this.#floorSpanFor(place) };
    return { zone, span: floorSpan(zone.polygon) ?? this.#floorSpanFor(place) };
  }

  // `beside=left|right` of a character. The nudge only has to establish which
  // SIDE of them you are on — crowding then pushes the two apart to exactly
  // touching, using footprints only a renderer knows. Computing a real offset
  // here would need sprite widths this layer does not have, and would duplicate
  // the spacing rule that already exists one layer down.
  #besideX(step, reference) {
    if (!step.beside) return null;
    const anchor = reference.positionOf(step.position ?? step.target);
    if (!anchor || typeof anchor.x !== 'number') return null;
    return anchor.x + (step.beside === 'left' ? -BESIDE_NUDGE_PCT : BESIDE_NUDGE_PCT);
  }

  #put(step, reference, origin) {
    const place = step.place ?? this.#scene.place;
    const beside = this.#besideX(step, reference);
    // beside joins the reference's band, so their zone wins over any default
    const anchorZone = beside === null
      ? undefined
      : reference.positionOf(step.position)?.zone ?? null;
    const band = this.#bandFor(place, anchorZone === undefined ? step.zone : anchorZone);
    // Props are scenery, not somebody standing somewhere, so they must not
    // reach the board: `beginScene` re-stages EVERYONE at a place, not only the
    // arrivals, so a prop on the board comes back as a character on the second
    // scene at that place and warns `cast-missing`.
    const props = new Set(step.objects ?? []);
    const cast = (step.subjects ?? []).filter((slug) => !props.has(slug));
    if (cast.length) {
      this.#board.put(
        cast,
        beside ?? step.position,
        step.facing,
        place,
        band.span,
        band.zone?.name ?? null,
        reference,
      );
    }
    for (const slug of props) this.#placeObject(slug, step, band, beside, reference, origin);
    for (const slug of cast) {
      const position = this.#board.positionOf(slug);
      if (position?.place === this.#scene.place) {
        this.#placeVisibleCharacter(slug, position.x, step.facing, reference, origin);
      }
    }
  }

  #placeObject(slug, step, band, beside, reference, origin) {
    if (!this.#story.objects?.[slug]) {
      this.warning({ type: 'policy', policy: 'object-missing', slug });
      return;
    }
    // A prop's band is the compiler's answer, not the step's: a kite rests on
    // `sky` and the step's band is the nearest one a CHARACTER could stand on,
    // so taking the step's would lay the kite on the grass. `rest_surface` is
    // world knowledge and lives upstream — nothing here reads it.
    const named = step.object_zones?.[slug] ?? band.zone?.name ?? null;
    const own = named === (band.zone?.name ?? null) ? band : this.#bandFor(this.#scene.place, named);
    // `where` may be a side, a `beside=` nudge off a character, or a character
    // named outright — a prop set down beside somebody is the whole point of
    // `put(lantern, grandpa)`.
    const anchor = typeof step.position === 'string' && !isSide(step.position)
      ? reference.positionOf(step.position)
      : null;
    const x = beside
      ?? (typeof anchor?.x === 'number' ? anchor.x : undefined)
      ?? sideX(step.position, own.span)
      ?? alongFloor(0.5, own.span);
    this.#stage.placeObject(slug, x, own.zone?.name ?? null, origin);
  }

  #emote(step, reference, origin) {
    for (const slug of step.subjects ?? []) {
      const clipKey = this.#selectClip(slug, step.emotion, step.facing, reference);
      this.#stage.setCharacterClip(slug, clipKey, origin);
    }
  }

  #move(step, reference, origin) {
    const starts = new Map((step.subjects ?? []).map((slug) => [slug, reference.positionOf(slug)]));
    const beside = this.#besideX(step, reference);
    // NOT `#bandFor`, which resolves the plate default: that default is right
    // for a `put` (the story has said nothing, so the engine answers) and wrong
    // for a `move` (the story has said nothing, so the character stays where
    // they are).
    const anchorZone = beside === null
      ? undefined
      : reference.positionOf(step.position ?? step.target)?.zone ?? null;
    const named = anchorZone === undefined ? (step.zone ?? null) : anchorZone;
    this.#board.move(
      step.subjects,
      beside ?? step.target,
      reference,
      named,
      this.#floorSpanFor(this.#scene.place),
      (zoneName) => (zoneName === null ? undefined : this.#bandFor(this.#scene.place, zoneName).span),
    );

    for (const slug of step.subjects ?? []) {
      const start = starts.get(slug);
      const end = this.#board.positionOf(slug);
      if (!start || !end) continue;
      const facing = desiredFacing(start.x, end.x);
      const locomotion = this.#locomotion(slug, step.line);
      const movingClip = this.#selectClipForFacing(slug, locomotion ?? 'idle', facing);
      const settleClip = this.#selectClipForFacing(slug, 'idle', facing);
      this.#stage.moveCharacter(slug, {
        x: end.x,
        // the band comes off the board rather than off the step: the board is
        // where "stay in the one you are in" was already decided, per character
        clipKey: movingClip,
        settleClipKey: settleClip,
        durationSeconds: Math.max(
          MINIMUM_MOVE_SECONDS,
          Math.abs(end.x - start.x) / MOVE_X_PCT_PER_SECOND,
        ),
        ...origin,
      });
    }
  }

  #travel(step, reference, origin) {
    const visible = new Map(reference.visibleCharacters().map((character) => [character.slug, character]));
    this.#board.travel(step.subjects, step.destination, step.exit_anchor_pct);

    for (const slug of step.subjects ?? []) {
      const start = visible.get(slug);
      if (!start) continue;
      const anchor = Array.isArray(step.exit_anchor_pct)
        ? { x: step.exit_anchor_pct[0], y: step.exit_anchor_pct[1] }
        : {
          x: start.x <= 50 ? DEFAULT_EXIT_X_PCT.left : DEFAULT_EXIT_X_PCT.right,
          y: this.#stage.floorY(start.x <= 50 ? 0 : 100),
        };
      const facing = desiredFacing(start.x, anchor.x);
      const locomotion = this.#locomotion(slug, step.line);
      this.#stage.departCharacter(slug, {
        ...anchor,
        clipKey: this.#selectClipForFacing(slug, locomotion ?? 'idle', facing),
        durationSeconds: Math.max(
          MINIMUM_DEPARTURE_SECONDS,
          Math.abs(anchor.x - start.x) / MOVE_X_PCT_PER_SECOND,
        ),
        ...origin,
      });
    }
  }

  #pushIn(step, reference) {
    const point = this.#aim(step, reference);
    if (point) this.#stage.pushIn(point, this.#speed(step));
  }

  #shot(step) {
    const shot = resolveShot(step, this.#board, this.#scene.plate, this.#story.cast, (detail) => this.warning(detail));
    if (shot) this.#stage.setShot(shot.size, shot.point, shot.scale);
  }

  // Only the x reaches the stage: a pan is horizontal. The point is still
  // resolved whole so an aim at nobody warns here exactly as it does everywhere.
  #panTo(step, reference) {
    const point = this.#aim(step, reference);
    if (point) this.#stage.panTo(point.x, this.#speed(step));
  }

  #follow(step, reference) {
    if (step.target === RELEASE_FOLLOW) {
      this.#stage.followOff();
      return;
    }
    if (!reference.positionOf?.(step.target)) {
      this.warning({ type: 'policy', policy: 'camera-target-unresolved', cmd: step.cmd, target: step.target });
      return;
    }
    this.#stage.follow(step.target);
  }

  #aim(step, reference) {
    return cameraPoint(step, reference, this.#scene.plate, (detail) => this.warning(detail));
  }

  #speed(step) {
    return cameraSpeed(step, (detail) => this.warning(detail));
  }

  #locomotion(slug, line) {
    return selectLocomotion(
      this.#story.cast[slug]?.capability,
      (detail) => this.warning({ ...detail, slug }, line),
    );
  }

  #placeVisibleCharacter(slug, x, facingTarget, reference, origin) {
    if (!this.#story.cast[slug]) {
      this.warning({ type: 'policy', policy: 'cast-missing', slug });
      return;
    }
    const clipKey = this.#selectClip(slug, 'idle', facingTarget, reference, x);
    // No band travels with a `place`: the op table carries `slug`, `x` and
    // `clip` and nothing else, and a client resolves the band from the step
    // stream's three rules. The renderer needs one to group crowding by and
    // resolves its own; a schedule has nobody to crowd against.
    this.#stage.placeCharacter(slug, x, clipKey, origin);
  }

  #selectClip(slug, verb, target, reference = this.#board, subjectX = undefined) {
    const referencePosition = reference.positionOf(slug);
    const livePosition = this.#board.positionOf(slug);
    const resolvedSubjectX = subjectX ?? referencePosition?.x ?? livePosition?.x ?? 50;
    const request = this.#facingRequest(slug, resolvedSubjectX, target, reference);
    return this.#selectClipForFacing(slug, verb, request);
  }

  #selectClipForFacing(slug, verb, facing) {
    const definition = this.#story.cast[slug];
    const variants = definition?.capability?.[verb] ?? {};
    const requested = typeof facing === 'string' ? facing : facing.requested;
    let clipKey;
    if (requested === 'camera' && variants.camera) {
      clipKey = variants.camera;
    } else {
      clipKey = selectFacingClip(definition?.capability, verb, facing, (detail) => this.warning({ ...detail, slug }));
    }
    if (clipKey) return clipKey;

    const fallback = Object.keys(definition?.clips ?? {}).sort()[0] ?? null;
    this.warning({ type: 'policy', policy: 'clip-missing', slug, verb, selected: fallback });
    return fallback;
  }

  #facingRequest(slug, subjectX, target, reference) {
    const span = this.#floorSpanFor(this.#scene?.place);
    if (target) {
      const targetX = sideX(target, span) ?? reference.positionOf(target)?.x;
      if (Number.isFinite(targetX)) return desiredFacing(subjectX, targetX);
    }

    const others = reference.visibleCharacters().filter((character) => character.slug !== slug);
    const left = others.filter((character) => character.x < subjectX).length;
    const right = others.filter((character) => character.x > subjectX).length;
    const crowd = left === right ? null : left > right ? 'left' : 'right';
    return { requested: 'camera', crowd, subjectX, centerX: alongFloor(0.5, span) };
  }

  #origin(line) {
    return { scene_index: this.#sceneIndex, line: line ?? this.#scene?.line ?? null };
  }
}

function compareTogetherSteps(left, right) {
  const leftKey = togetherStepKey(left);
  const rightKey = togetherStepKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function togetherStepKey(step) {
  // Position/camera/audio effects begin before expression writes so a valid
  // simultaneous move+emote keeps the authored emotion while still moving.
  const phase = step.cmd === 'emote' ? 1 : 0;
  const subjects = [...(step.subjects ?? [])].sort().join(',');
  const target = step.target ?? step.destination ?? step.position ?? step.name ?? '';
  return `${phase}|${step.cmd}|${subjects}|${target}`;
}
