import { PlayerBoard } from '../../core/board.mjs';
import { desiredFacing, selectFacingClip, selectLocomotion } from '../../core/clips.mjs';
import { alongFloor, floorSpan, isSide, resolvePoint, sideX, zoneNamed } from '../../core/geometry.mjs';
import { runStory } from '../../core/scheduler.mjs';
import { withTimeout } from '../clock.mjs';
import { drawnSpriteHeightPx, subjectFramedScale } from '../stage/presentation-policy.mjs';
import { CAMERA_DURATIONS_MS, SHOT_SIZES } from '../stage/stage-renderer.mjs';
import { resolveNarrationUrl } from '../urls.mjs';
import {
  BESIDE_NUDGE_PCT,
  DEFAULT_EXIT_X_PCT,
  DEPARTURE_DEADLINE_MS,
  MINIMUM_DEPARTURE_SECONDS,
  MINIMUM_MOVE_SECONDS,
  MOVE_X_PCT_PER_SECOND,
} from '../../policy.mjs';

// `follow` carries this in place of a character to end the ride. It travels as a
// literal word rather than a null so a released follow can never be mistaken for
// an argument that went missing on the way here.
const RELEASE_FOLLOW = 'off';

// How far `beside=` offsets from the character it names. Deliberately tiny: it
// only has to decide which SIDE of them you are on. Crowding then separates the
// two by their real footprints, which live in the renderer — so this number is
// never the spacing anyone sees, and making it bigger would not widen the gap.
export class PlaybackDirector {
  #story;
  #storyUrl;
  #stage;
  #audio;
  #clock;
  #log;
  #board = new PlayerBoard();
  #scene = null;
  #sceneIndex = null;
  #currentLine = null;
  #departures = new Set();

  constructor({ story, storyUrl, stage, audio, clock, log }) {
    this.#story = story;
    this.#storyUrl = storyUrl;
    this.#stage = stage;
    this.#audio = audio;
    this.#clock = clock;
    this.#log = log;
  }

  async play() {
    await runStory(this.#story, {
      clock: this.#clock,
      log: this.#log,
      beginScene: (scene, context) => this.#beginScene(scene, context),
      endScene: (scene, context) => this.#endScene(scene, context),
      playChunk: (step) => this.#playChunk(step),
      performCommand: (step) => this.#performCommand(step),
      performTogether: (steps) => this.#performTogether(steps),
    });
    this.#stage.showEnd();
  }

  warning(detail, line = undefined, sceneIndex = undefined) {
    const isStructured = detail && typeof detail === 'object';
    const hasCarriedLine = isStructured && Object.hasOwn(detail, 'line');
    const hasCarriedScene = isStructured && Object.hasOwn(detail, 'scene_index');
    const payload = detail && typeof detail === 'object'
      ? Object.fromEntries(Object.entries(detail).filter(([key]) => key !== 'line' && key !== 'scene_index'))
      : detail;
    return this.#log.append({
      scene_index: sceneIndex !== undefined
        ? sceneIndex
        : hasCarriedScene ? detail.scene_index : this.#sceneIndex,
      line: line !== undefined
        ? line
        : hasCarriedLine ? detail.line : this.#currentLine ?? this.#scene?.line ?? null,
      kind: 'warning',
      detail: payload,
    });
  }

  async #beginScene(scene, context) {
    this.#scene = scene;
    this.#sceneIndex = context.sceneIndex;
    this.#currentLine = scene.line ?? null;
    const origin = this.#origin(scene.line);
    this.#stage.showScene(scene, origin);
    const arrivals = this.#board.beginScene(scene.place, this.#floorSpanFor(scene.place));

    // Arrivals are staged before the scene's first authored step.
    for (const character of arrivals) {
      this.#placeVisibleCharacter(character.slug, character.x, null, this.#board, origin);
    }
  }

  async #endScene() {
    const pending = [...this.#departures];
    if (pending.length > 0) {
      await withTimeout(Promise.allSettled(pending), DEPARTURE_DEADLINE_MS, {
        onTimeout: () => {
          const origin = this.#origin(this.#scene.line);
          this.warning({ type: 'media', asset: 'travel', message: 'scene departure deadline reached' }, origin.line, origin.scene_index);
        },
      });
    }
    this.#stage.setSubtitle('');
    this.#stage.resetCamera();
  }

  async #playChunk(step) {
    this.#currentLine = step.line ?? this.#scene.line ?? null;
    const estimatedMs = Math.max(0, Number(step.duration_s) * 1000 || 0);
    this.#stage.setSubtitle(step.text);

    if (!step.audio) {
      await this.#clock.wait(estimatedMs);
      return;
    }

    const audioUrl = resolveNarrationUrl(step.audio, this.#storyUrl);
    const result = await this.#audio.playNarration(audioUrl, estimatedMs, this.#origin(step.line));
    if (result.ok) return;

    const remainingMs = Math.max(0, estimatedMs - result.elapsedMs);
    this.#stage.setSubtitle(step.text, 'narration unavailable · read along');
    await this.#clock.wait(remainingMs);
  }

  #performTogether(steps) {
    const reference = this.#board.reference();
    for (const step of [...steps].sort(compareTogetherSteps)) {
      this.#performCommand(step, reference);
    }
  }

  #performCommand(step, reference = this.#board) {
    this.#currentLine = step.line ?? this.#scene.line ?? null;
    const origin = this.#origin(step.line);
    switch (step.cmd) {
      case 'put': this.#put(step, reference, origin); break;
      case 'emote': this.#emote(step, reference, origin); break;
      case 'move': this.#move(step, reference, origin); break;
      case 'travel': this.#travel(step, reference, origin); break;
      case 'sound': this.#audio.playSound(step.name, origin); break;
      case 'music': this.#audio.setMusic(step.name, origin); break;
      case 'push_in': this.#pushIn(step, reference); break;
      case 'pull_out': this.#stage.pullOut(this.#cameraSpeed(step)); break;
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
  // touching, using footprints only the renderer knows. Computing a real
  // offset here would need sprite widths the director does not have, and would
  // duplicate the spacing rule that already exists one layer down.
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
    // reach the board: `beginScene` re-stages EVERYONE at a place, not only
    // the arrivals, so a prop on the board came back as a character on the
    // second scene at that place, missed `story.cast`, and warned
    // `cast-missing`. The comment here used to claim they never joined it —
    // they did, because `step.subjects` still carries them.
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
    const definition = this.#story.objects?.[slug];
    if (!definition) {
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
    // `put(lantern, grandpa)`. All three were dropped and every prop landed at
    // the middle of its band.
    const anchor = typeof step.position === 'string' && !isSide(step.position)
      ? reference.positionOf(step.position)
      : null;
    const x = beside
      ?? (typeof anchor?.x === 'number' ? anchor.x : undefined)
      ?? sideX(step.position, own.span)
      ?? alongFloor(0.5, own.span);
    this.#stage.placeObject(slug, definition, x, own.zone?.name ?? null, origin);
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
    // they are). Resolving it here made the board's own "leaves them in the
    // band they are in" rule unreachable, and walked them to the default
    // band's side instead of their own.
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
      const locomotion = selectLocomotion(this.#story.cast[slug]?.capability, (detail) => this.warning({ ...detail, slug }, step.line));
      const movingClip = locomotion
        ? this.#selectClipForFacing(slug, locomotion, facing)
        : this.#selectClipForFacing(slug, 'idle', facing);
      const settleClip = this.#selectClipForFacing(slug, 'idle', facing);
      const durationSeconds = Math.max(
        MINIMUM_MOVE_SECONDS,
        Math.abs(end.x - start.x) / MOVE_X_PCT_PER_SECOND,
      );
      const motion = this.#stage.moveCharacter(slug, {
        x: end.x,
        // the band comes off the board rather than off the step: the board is
        // where "stay in the one you are in" was already decided, per character
        zoneName: end.zone ?? null,
        clipKey: movingClip,
        settleClipKey: settleClip,
        durationSeconds,
        ...origin,
      });
      motion.catch((error) => this.warning(
        { type: 'media', asset: 'motion', slug, message: error.message },
        origin.line,
        origin.scene_index,
      ));
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
      const locomotion = selectLocomotion(this.#story.cast[slug]?.capability, (detail) => this.warning({ ...detail, slug }, step.line));
      const clipKey = locomotion
        ? this.#selectClipForFacing(slug, locomotion, facing)
        : this.#selectClipForFacing(slug, 'idle', facing);
      const durationSeconds = Math.max(
        MINIMUM_DEPARTURE_SECONDS,
        Math.abs(anchor.x - start.x) / MOVE_X_PCT_PER_SECOND,
      );
      const departure = this.#stage.departCharacter(slug, { ...anchor, clipKey, durationSeconds, ...origin });
      this.#trackDeparture(departure, origin);
    }
  }

  // Where a camera command is looking, or null with the warning already sent.
  // `target_pct` is a portal the compiler resolved for us. A side word is
  // measured across the plate's default band — that is what `left_edge` means to
  // a camera, whoever else is standing elsewhere — while a character is read on
  // the band they are actually on, which is the only way the height comes out
  // right for anyone off the near floor.
  // The finiteness check guards BOTH ways in, portal included: `target_pct` is
  // copied out of the catalog unchecked, and one non-number in it used to cost a
  // dropped `transform-origin`. It now costs the whole `transform`, and the bad
  // number latches into the framing every later pan reads.
  #cameraPoint(step, reference) {
    const point = Array.isArray(step.target_pct)
      ? { x: step.target_pct[0], y: step.target_pct[1] }
      : this.#pointOnBand(step, reference);
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return point;
    this.warning({ type: 'policy', policy: 'camera-target-unresolved', cmd: step.cmd, target: step.target });
    return null;
  }

  #pointOnBand(step, reference) {
    const floor = zoneNamed(this.#scene.plate, null)?.polygon;
    const band = isSide(step.target) ? null : reference.positionOf?.(step.target)?.zone ?? null;
    return resolvePoint(step.target, reference, floor, zoneNamed(this.#scene.plate, band)?.polygon ?? floor);
  }

  // An absent speed means slow — the language's own default, resolved here so the
  // three implementations of it cannot drift. A word neither the language nor the
  // player has is a malformed bundle: this repo cannot mint one (`fast` was taken
  // out of `SPEEDS`, and `build` refuses a story with errors), so the point is
  // that a hand-made one is SAID rather than absorbed. The move still happens, at
  // the default — only its pacing was unreadable.
  #cameraSpeed(step) {
    const speed = step.speed ?? 'slow';
    if (Object.hasOwn(CAMERA_DURATIONS_MS, speed)) return speed;
    this.warning({ type: 'policy', policy: 'camera-speed-unknown', cmd: step.cmd, speed });
    return 'slow';
  }

  #pushIn(step, reference) {
    const point = this.#cameraPoint(step, reference);
    if (point) this.#stage.pushIn(point, this.#cameraSpeed(step));
  }

  // A wide frames nobody, so it is the one camera command with nothing to aim at.
  // An unknown SIZE is refused rather than defaulted, unlike an unknown speed: the
  // size is what the command means, and `SHOT_SCALES[size] ?? wide` used to answer
  // a close-up with an unchanged wide and no warning at all.
  // A shot is the one camera command that FRAMES A PERSON, so it reads the LIVE
  // board rather than the `together` snapshot every other aim uses. Inside a block
  // the children are sorted `move` before `shot`, and the renderer resizes the
  // sprite to its destination band synchronously — so measuring against the
  // snapshot framed a deer at the 194 px of the band it was leaving while it was
  // drawn at 486 px, i.e. 1280 px of deer in a 1080 px frame, head and feet cut
  // off. Outside a block the two are the same object, so this changes nothing
  // anybody has written yet.
  #shot(step) {
    if (!Object.hasOwn(SHOT_SIZES, step.size)) {
      this.warning({ type: 'policy', policy: 'camera-shot-size-unknown', cmd: step.cmd, size: step.size });
      return;
    }
    if (step.size === 'wide') {
      this.#stage.setShot('wide', null, SHOT_SIZES.wide);
      return;
    }
    // the aim first, so a target that is nobody is answered by the name every
    // other camera command answers it with, not by a question about its height
    const point = this.#cameraPoint(step, this.#board);
    if (!point) return;
    const scale = this.#shotScale(step);
    if (scale !== null) this.#stage.setShot(step.size, point, scale);
  }

  // `medium` and `close` are framed by their subject, so neither scale is a
  // constant anybody can look up — each is how far this character, on this band,
  // has to be magnified to be drawn at the height that size asks for. Resolved
  // here because the renderer draws and the projection records, and both must be
  // handed the SAME number or the phone and the browser disagree about the shot.
  #shotScale(step) {
    const heightCm = this.#story.cast[step.target]?.height_cm;
    // A subject nobody measured is refused rather than framed at a guess: without
    // a height, `spriteHeightForCm` falls to its 72 px legibility floor and the
    // frame that comes back is the CEILING — maximum magnification on a character
    // whose size is simply unknown. Every sibling here refuses and says so.
    if (!Number.isFinite(heightCm) || heightCm <= 0) {
      this.warning({ type: 'policy', policy: 'camera-subject-unmeasured', cmd: step.cmd, target: step.target });
      return null;
    }
    const band = this.#board.positionOf?.(step.target)?.zone ?? null;
    return subjectFramedScale(drawnSpriteHeightPx(heightCm, zoneNamed(this.#scene.plate, band)), step.size);
  }

  // Only the x reaches the stage: a pan is horizontal. The point is still
  // resolved whole so an aim at nobody warns here exactly as it does everywhere.
  #panTo(step, reference) {
    const point = this.#cameraPoint(step, reference);
    if (point) this.#stage.panTo(point.x, this.#cameraSpeed(step));
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

  #placeVisibleCharacter(slug, x, facingTarget, reference, origin) {
    const definition = this.#story.cast[slug];
    if (!definition) {
      this.warning({ type: 'policy', policy: 'cast-missing', slug });
      return;
    }
    const clipKey = this.#selectClip(slug, 'idle', facingTarget, reference, x);
    // The band comes off the board, not off the step: an arrival stages nobody
    // through a put, and a character who never moved keeps the one they have.
    // RESOLVED through `#bandFor`, because the board holds `null` for "the
    // engine's answer" while a `put` holds the default zone's NAME — the same
    // physical band under two keys. The renderer groups crowding by that key,
    // so the pair never met: in Ruby's forest_glow the arriving hedgehog and
    // the put owl both land on x 61.505 and were drawn on the same pixel.
    const held = this.#board.positionOf(slug)?.zone ?? null;
    const zone = this.#bandFor(this.#scene.place, held).zone?.name ?? null;
    this.#stage.placeCharacter(slug, definition, x, clipKey, origin, zone);
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

  #trackDeparture(promise, origin) {
    const tracked = Promise.resolve(promise)
      .catch((error) => this.warning(
        { type: 'media', asset: 'travel', message: error.message },
        origin.line,
        origin.scene_index,
      ))
      .finally(() => this.#departures.delete(tracked));
    this.#departures.add(tracked);
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
