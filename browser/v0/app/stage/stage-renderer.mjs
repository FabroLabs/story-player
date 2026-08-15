import { frameCell, frameIndexAt } from '../../core/clips.mjs';
import { spreadAlongBand } from '../../core/crowding.mjs';
import { NO_FLOOR_STAND_Y, floorSpan, floorYAtX, zoneDepthOrder, zoneNamed, zoneScale } from '../../core/geometry.mjs';
import { waitForActorAction } from './action-wait.mjs';
import { ActorRegistry } from './actor-registry.mjs';
import { withTimeout } from '../clock.mjs';
import { drawnSpriteHeightPx } from './presentation-policy.mjs';
import { SpriteAssetTracker } from './sprite-assets.mjs';
import {
  CAMERA_DURATIONS_MS,
  DEFAULT_STAGE_RESOLUTION,
  PAN_SCALE_FLOOR,
  PLATE_PARALLAX,
  PUSH_SCALE,
  SHOT_SIZES,
} from '../../policy.mjs';

const VIDEO_READY_TIMEOUT_MS = 6_000;
const SPRITE_READY_TIMEOUT_MS = 5_000;
// Exported so the director can refuse a word the player has no meaning for
// rather than the two of them quietly disagreeing about what the bundle asked
// for. The vocabulary, and the ONE size whose framing is a constant. `medium` and
// `close` are framed by their subject and resolved per shot by the director — the
// half of the player that knows who is being framed and on which band they stand
// — so their entries here are names, not numbers: `null` rather than a value
// nothing reads, because a dead number published as policy is how two
// implementations end up with two answers. Lookups go through `Object.hasOwn`:
// this is a plain object, so `'constructor'` answers with a FUNCTION.
// A camera at 1x cannot pan at all — the offset interval `[100(s-1), 0]` is zero
// wide there — so a pan lifts the scale first, and the lift IS the travel it buys:
// 100(s-1)% of the stage. 1.12 bought 12%, which measured as almost nothing on a
// real story; 1.25 buys 25%. It is not free: a pan holds its scale until something
// re-aims the camera, so this is also how magnified a scene stays after one.
const CAMERA_EASING = 'cubic-bezier(.2,.72,.24,1)';
const CAMERA_ORIGIN = '0 0';
// How much of the camera's move the plate takes. 1 locks the two planes together,
// which is what ships: measured on `golden_push_dusk`, a character is drawn 105.9 px
// wide at the top of a push at EVERY parallax — the near plane never changes — while
// the plate goes 1694 px at 1, 1526 at 0.72, 1153 at 0.1. The cast is about a tenth
// of the frame and the plate is the rest, so the plate is what the eye reads the move
// off: weakening it does not buy depth, it just spends the push. 0.72 costs 28% of
// one and was not visible as depth to anybody who watched it.
//
// The machinery stays because the verdict is about THIS art, not about the idea: a
// plate whose foreground is a real near plane — a trunk, a doorway, something with
// size — has something to move against, and then this becomes one number. Anything
// below 1 also detaches feet from the ground away from the point a push holds,
// because the ground is painted into the plate; that is the bill to re-read first.
export { CAMERA_DURATIONS_MS, PLATE_PARALLAX, SHOT_SIZES } from '../../policy.mjs';
const PLATE_CENTRE = Object.freeze({ x: 50, y: 50 });
const WIDE_FRAMING = Object.freeze({ scale: 1, x: 0, y: 0 });

export class StageRenderer {
  #elements;
  #onWarning;
  #actors = new ActorRegistry();
  #spriteAssets = new SpriteAssetTracker();
  #spriteLoads = new Map();
  #plateWait = null;
  #platePlaybackError = null;
  #scene = null;
  #sceneToken = 0;
  #animationFrame = null;
  #resizeObserver = null;
  #framing = WIDE_FRAMING;
  #followSlug = null;
  #parallax;
  #destroyed = false;

  // `parallax` is an argument and not just the constant so that the far plane can
  // be switched on for the plates that earn it and stay off for the rest — the
  // shape a per-scene decision would take. Nothing passes it today: `main.mjs`
  // builds the renderer with the constant, which is 1.
  constructor(elements, onWarning = () => {}, { parallax = PLATE_PARALLAX } = {}) {
    this.#elements = elements;
    this.#onWarning = onWarning;
    this.#parallax = parallax;
    // Off is UNTOUCHED, not "moved by zero". A `will-change: transform` left
    // standing hands the plate its own compositor layer for the whole session for
    // a transform that never comes, so the hint is a class the renderer only adds
    // when there is going to be something to hint about.
    if (parallax !== 1) elements.plate.classList.add('is-parallaxed');
    this.#resizeObserver = new ResizeObserver(() => this.#fitStage());
    this.#resizeObserver.observe(elements.frame);
  }

  startAnimation() {
    if (this.#destroyed || this.#animationFrame !== null) return;
    const animate = (timeMs) => {
      if (this.#destroyed) return;
      this.#drawFrames(timeMs);
      this.#animationFrame = requestAnimationFrame(animate);
    };
    this.#animationFrame = requestAnimationFrame(animate);
  }

  showScene(scene, origin = { line: scene.line ?? null }) {
    if (this.#destroyed) return;
    this.#scene = scene;
    this.#sceneToken += 1;
    this.#clearActors();
    this.resetCamera();
    this.setSubtitle('');
    this.#elements.end.hidden = true;

    const [width = DEFAULT_STAGE_RESOLUTION[0], height = DEFAULT_STAGE_RESOLUTION[1]] = scene.plate?.resolution ?? [];
    const safeWidth = positiveNumber(width, 1920);
    const safeHeight = positiveNumber(height, DEFAULT_STAGE_RESOLUTION[1]);
    this.#elements.stage.style.width = `${safeWidth}px`;
    this.#elements.stage.style.height = `${safeHeight}px`;
    this.#fitStage();
    this.#loadPlate(scene.plate, this.#sceneToken, origin);
  }

  placeCharacter(slug, definition, x, clipKey, origin = null, zoneName = null) {
    let actor = this.#actors.get(slug);
    if (!actor) {
      const element = document.createElement('div');
      element.className = 'sprite';
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', definition.display_name ?? slug);
      this.#elements.sprites.append(element);
      actor = { slug, element, definition, clip: null, clipStartedAt: performance.now() };
      this.#actors.attach(slug, actor);
    } else {
      this.#actors.supersede(slug);
    }

    actor.element.style.opacity = '1';
    actor.element.style.transition = 'none';
    // the band the character stands in decides three things at once: how big
    // they are drawn, which polygon gives their stand line, and what they are
    // painted in front of. Held on the actor so a later resize or move can ask.
    actor.zone = zoneName;
    this.#sizeActor(actor);
    this.#positionActor(actor, x, this.floorY(x, zoneName));
    this.#applyCharacterClip(slug, actor, clipKey, origin);
    this.#applyDepthOrder();
    this.#relieveCrowding(zoneName, origin);
  }

  // A prop is drawn once and never animated (D17): a flat SVG in a plain
  // element, no clips, no atlas, no facing ladder, no locomotion. Everything
  // else it shares with a character — the zone gives its size, its stand line
  // and its paint depth, and it takes room when the band is crowded.
  placeObject(slug, definition, x, zoneName = null, origin = null) {
    let actor = this.#actors.get(slug);
    if (!actor) {
      const element = document.createElement('div');
      element.className = 'sprite is-object';
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', definition.description ?? slug);
      this.#elements.sprites.append(element);
      actor = { slug, element, definition, kind: 'object', clip: null };
      this.#actors.attach(slug, actor);
    }
    actor.kind = 'object';
    actor.zone = zoneName;
    actor.element.style.opacity = '1';
    actor.element.style.backgroundImage = `url("${cssUrl(definition.svg)}")`;
    // contain, not the spritesheet's cover: an SVG prop is one whole picture,
    // not a cell of a grid, so nothing about it may be cropped
    actor.element.style.backgroundSize = 'contain';
    actor.element.style.backgroundRepeat = 'no-repeat';
    this.#sizeActor(actor);
    this.#positionActor(actor, x, this.floorY(x, zoneName));
    this.#applyDepthOrder();
    this.#relieveCrowding(zoneName, origin);
  }

  setCharacterClip(slug, clipKey, origin = null) {
    const actor = this.#actors.supersede(slug);
    if (!actor) return;
    this.#applyCharacterClip(slug, actor, clipKey, origin);
  }

  #applyCharacterClip(slug, actor, clipKey, origin) {
    if (!clipKey || actor.clip?.key === clipKey) return;
    const clip = actor.definition.clips?.[clipKey];
    if (!clip) {
      this.#warn({ type: 'media', asset: 'sprite-clip', slug, clip: clipKey, message: 'clip absent from bundle' }, origin);
      actor.element.classList.add('is-missing');
      return;
    }

    actor.clip = { key: clipKey, ...clip };
    actor.clipStartedAt = performance.now();
    actor.element.classList.remove('is-missing');
    actor.element.style.backgroundImage = `url("${cssUrl(clip.spritesheet)}")`;
    const [columns = 1, rows = 1] = clip.grid ?? [];
    actor.element.style.backgroundSize = `${positiveNumber(columns, 1) * 100}% ${positiveNumber(rows, 1) * 100}%`;
    this.#verifySprite(clip.spritesheet, slug, clipKey, origin);
  }

  // A walk between bands is a walk in DEPTH as well as across: the destination
  // band decides the size, the stand line, the paint order and the crowding,
  // exactly as it does for `placeCharacter`. This used to move `left`/`top`
  // and nothing else, so a character walked to the far band's x still drawn at
  // the near band's size, standing on the near band's floor, painted at the
  // near band's depth — while the manual taught that they shrink as they go.
  //
  // Size and stand line TWEEN with the walk: both are transitioned, and since
  // `top` is `y - height`, two linear interpolations leave the feet tracking a
  // straight line between the two stand lines. Paint order cannot tween, so it
  // switches at whichever end of the walk keeps the character right for longer
  // — on departure when coming toward the camera, on arrival when going away.
  // The unavoidable pop then happens where the sprite is smallest and farthest.
  async moveCharacter(slug, { x, clipKey, settleClipKey, durationSeconds, zoneName = null, line = null, scene_index = undefined }) {
    const actor = this.#actors.get(slug);
    if (!actor) return;
    const action = this.#actors.begin(slug);
    const origin = { line, ...(scene_index === undefined ? {} : { scene_index }) };
    // naming no band means staying in the one you are standing in — walking
    // sideways is not walking away from the camera
    const destination = zoneName ?? actor.zone ?? null;
    const approaching =
      zoneDepthOrder(zoneNamed(this.#scene?.plate, destination)) < zoneDepthOrder(this.#zoneOf(actor));

    this.#applyCharacterClip(slug, actor, clipKey, origin);
    actor.element.getBoundingClientRect();
    actor.element.style.transition = motionTransition(durationSeconds);
    actor.zone = destination;
    this.#sizeActor(actor);
    this.#positionActor(actor, x, this.floorY(x, destination));
    this.#rideCamera(slug, x, durationSeconds);
    if (approaching) this.#applyDepthOrder();

    await this.#waitForMotion(actor.element, durationSeconds, slug, 'move', origin, action);
    if (!this.#actors.isCurrent(action)) return;
    this.#actors.complete(action);
    actor.element.style.transition = 'none';
    this.#applyCharacterClip(slug, actor, settleClipKey, origin);
    if (!approaching) this.#applyDepthOrder();
    this.#relieveCrowding(destination, origin);
  }

  async departCharacter(slug, { x, y, clipKey, durationSeconds, line = null, scene_index = undefined }) {
    const actor = this.#actors.get(slug);
    if (!actor) return;
    const action = this.#actors.begin(slug);
    const origin = { line, ...(scene_index === undefined ? {} : { scene_index }) };
    this.#applyCharacterClip(slug, actor, clipKey, origin);
    actor.element.getBoundingClientRect();
    actor.element.style.transition = `${motionTransition(durationSeconds)}, opacity ${durationSeconds}s ease-in`;
    this.#positionActor(actor, x, y ?? this.floorY(x));
    // The camera watches them all the way out, then lets go — a ride is a
    // subscription to somebody who is on the stage, and they no longer are.
    this.#rideCamera(slug, x, durationSeconds);
    if (this.#followSlug === slug) this.#followSlug = null;
    actor.element.style.opacity = '0';

    await this.#waitForMotion(actor.element, durationSeconds, slug, 'travel', origin, action);
    if (!this.#actors.remove(action)) return;
    actor.element.remove();
  }

  removeCharacter(slug) {
    this.#actors.removeCurrent(slug)?.element.remove();
  }

  // The stand line of the character's OWN band. Each zone brings its own
  // polygon, so a character on the back road stands on the back road's front
  // rim, not on the whole floor's. Falls back to the plate's default zone, and
  // then to the bridge polygon, so an un-banded plate reads exactly as before.
  floorY(x, zoneName = null) {
    const zone = zoneNamed(this.#scene?.plate, zoneName);
    const polygon = zone?.polygon;
    return floorYAtX(polygon, x) ?? NO_FLOOR_STAND_Y;
  }

  #zoneOf(actor) {
    return zoneNamed(this.#scene?.plate, actor?.zone ?? null);
  }

  // Paint order: farthest first, so depth 1 lands on top (D4). There was no
  // per-actor order at all before this — every sprite went into one layer with
  // one z-index, and who covered whom was the order they were created in.
  // Equal depth keeps that creation order, which is a tie-break, not a policy.
  #applyDepthOrder() {
    // `values()`, not `entries()` — ActorRegistry is not a Map and exposes no
    // pair iterator; assuming it did threw inside the director's put and paused
    // the story, which the event log named and no test did.
    const ordered = [...this.#actors.values()].map((actor, seq) => (
      { actor, depth: zoneDepthOrder(this.#zoneOf(actor)), seq }
    ));
    ordered.sort((a, b) => (b.depth - a.depth) || (a.seq - b.seq));
    ordered.forEach(({ actor }, order) => {
      actor.element.style.zIndex = String(order + 1);
    });
  }

  // A push holds the point it names still and grows the world around it. It never
  // shrinks: `shot(close, who)` now lands wherever that character has to be framed
  // — 2.048x for a rabbit, 3.41x for a hedgehog — and an absolute 1.55x after one
  // is a push that visibly pulls BACK, which the corpus already asks for
  // (`golden_camera_moves`: a close on the rabbit, then a push at the right edge).
  // Already closer than the push scale means the push re-aims at the closeness it
  // is in, rather than undoing it.
  pushIn(point, speed = 'slow') {
    this.#reframe(framingHolding(point, Math.max(this.#framing.scale, PUSH_SCALE)), cameraDuration(speed));
  }

  // Back to 1x, where there is only one framing to be in.
  pullOut(speed = 'slow') {
    this.#reframe(WIDE_FRAMING, cameraDuration(speed));
  }

  // A shot is a cut, not a move: no easing, no duration. `wide` frames nobody,
  // so it has no point to hold and simply opens on the whole plate.
  // `Object.hasOwn`, not `?? wide`: a plain object answers `'constructor'` with a
  // FUNCTION and `??` never fires. Refused rather than widened, and said out loud,
  // because the size IS what the shot means — the director refuses one first, so
  // this is the second lock on the same door rather than a duplicate warning.
  setShot(size, point = null, scale = null) {
    if (!Object.hasOwn(SHOT_SIZES, size)) {
      this.#warn({ type: 'policy', policy: 'camera-shot-size-unknown', size });
      return;
    }
    // No fallback: every size's scale is resolved by the director, and a missing
    // one is a defect rather than a size to guess at — `#reframe` refuses a
    // framing that is not three finite numbers and says so.
    this.#reframe(framingHolding(point ?? PLATE_CENTRE, scale), 0);
  }

  // A pan asks for plate x in the middle of the frame and is granted as much of
  // that as the frame allows — see `clampOffset`. It lifts the scale to the pan
  // floor first, because at 1x there is nowhere to move to.
  panTo(x, speed = 'slow') {
    this.#panFramed(x, cameraDuration(speed));
  }

  // A ride is a pan on somebody else's clock: it lasts exactly as long as the
  // walk it is following, so the camera and the character arrive together.
  follow(slug) {
    this.#followSlug = slug;
  }

  followOff() {
    this.#followSlug = null;
  }

  resetCamera() {
    this.#followSlug = null;
    // Pinned once per scene, and never moved again: every aim the camera takes
    // is expressed in `transform` alone. `transform-origin` is not transitioned,
    // so moving it while magnified would snap the picture mid-move. The plate
    // composes against the camera, so it has to measure from the same corner —
    // when it is carrying anything at all.
    this.#elements.camera.style.transformOrigin = CAMERA_ORIGIN;
    if (this.#parallax !== 1) this.#elements.plate.style.transformOrigin = CAMERA_ORIGIN;
    this.#reframe(WIDE_FRAMING, 0);
  }

  #panFramed(x, durationMs) {
    const scale = Math.max(this.#framing.scale, PAN_SCALE_FLOOR);
    this.#reframe(framingPanned(x, scale, this.#framing), durationMs);
  }

  // Called from the walk itself, so the ride cannot drift out of step with it.
  #rideCamera(slug, x, durationSeconds) {
    if (this.#followSlug !== slug) return;
    this.#panFramed(x, Math.round(Math.max(0, durationSeconds) * 1000));
  }

  #reframe(framing, durationMs) {
    // The last gate before a number becomes a transform, and the only one that
    // covers every way in. The director checks the aim it resolves itself, but a
    // ride is aimed by the WALK — `board.move` leaves `x` undefined for a target
    // it cannot place, and `exit_anchor_pct` is raw catalog copied straight
    // through — so an unaimed ride used to write `translate(NaN%, …)`. The
    // browser drops the whole declaration, which hard-cuts the camera out of a
    // push mid-move, and `#framing` kept the NaN for every later pan to read.
    if (!isFramingFinite(framing)) {
      this.#warn({ type: 'policy', policy: 'camera-framing-unusable', framing: { ...framing } });
      return;
    }
    this.#framing = framing;
    this.#aim(this.#elements.camera, framing, durationMs);
    if (this.#parallax === 1) return;
    // Written in the same breath as the camera's, on the same clock: two
    // transitions started apart would arrive apart, and the gap between the
    // planes IS the effect.
    this.#aim(this.#elements.plate, plateFraming(framing, this.#parallax), durationMs);
  }

  // A scale multiplies every coordinate under it, so it is written finer than an
  // offset is: the camera's own scales are exact, but the plate's is a ratio, and
  // rounding it as coarsely as a percentage would move a far corner by more than
  // the rounding itself.
  #aim(element, framing, durationMs) {
    element.style.transition = durationMs > 0 ? `transform ${durationMs}ms ${CAMERA_EASING}` : 'none';
    element.style.transform = `translate(${round4(framing.x)}%, ${round4(framing.y)}%) scale(${round(framing.scale, 6)})`;
  }

  setSubtitle(text, note = '') {
    this.#elements.subtitle.textContent = text ?? '';
    this.#elements.mediaNote.textContent = note;
  }

  showEnd() {
    this.setSubtitle('');
    this.#elements.end.hidden = false;
  }

  #positionActor(actor, xPct, yPct) {
    const [width = DEFAULT_STAGE_RESOLUTION[0], height = DEFAULT_STAGE_RESOLUTION[1]] = this.#scene?.plate?.resolution ?? [];
    actor.x = xPct; // remembered so crowding can reason about the whole band
    actor.element.style.left = `${(xPct / 100) * positiveNumber(width, 1920)}px`;
    actor.element.style.top = `${(yPct / 100) * positiveNumber(height, DEFAULT_STAGE_RESOLUTION[1]) - actor.height}px`;
  }

  // The footprint of one actor as a percentage of the plate. Sprites are drawn
  // in a square cell, so a sprite is as wide as it is tall — that is the whole
  // reason this arithmetic lives in the player: it comes out of
  // spriteHeightForCm, which is presentation policy, so nothing upstream could
  // compute it and nothing upstream should try (D13).
  #widthPct(actor) {
    const [width = DEFAULT_STAGE_RESOLUTION[0]] = this.#scene?.plate?.resolution ?? [];
    return (actor.height / positiveNumber(width, 1920)) * 100;
  }

  // Nobody is drawn on top of anybody else in the same band. Runs after every
  // placement, over that band's occupants only: characters at other depths are
  // at other distances and cannot collide by construction.
  #relieveCrowding(zoneName, origin) {
    const zone = zoneNamed(this.#scene?.plate, zoneName);
    if (!zone) return;
    const band = this.#actorsInBand(zoneName);
    if (band.length < 2) return;
    const occupants = band.map((actor) => ({
      slug: actor.slug, x: actor.x, widthPct: this.#widthPct(actor), kind: actor.kind ?? 'character',
    }));

    const { x, overflow } = spreadAlongBand(occupants, floorSpan(zone.polygon));
    for (const actor of band) {
      const moved = x[actor.slug];
      if (typeof moved === 'number' && moved !== actor.x) {
        this.#positionActor(actor, moved, this.floorY(moved, zoneName));
      }
    }
    if (overflow > 0) {
      // said out loud rather than absorbed: a band too narrow for its cast is a
      // fact about the plate, and the picture is crowded whatever we do
      this.#warn({
        type: 'policy',
        policy: 'band-overcrowded',
        zone: zone.name,
        occupants: occupants.length,
        short_pct: Math.round(overflow * 10) / 10,
      }, origin);
    }
  }

  // `values()` is the registry's whole iteration API — it is not a Map, and
  // assuming otherwise has now cost two bugs. The slug rides on the actor.
  #actorsInBand(zoneName) {
    return [...this.#actors.values()].filter(
      (actor) => (actor.zone ?? null) === (zoneName ?? null),
    );
  }

  #sizeActor(actor) {
    // farther is smaller. The zone's scale multiplies the height its real-world
    // centimetres earn, so the same character drawn on depth 3 at scale 0.3 is
    // a third the size they are at the front — which is the whole point of a
    // band, and the only part of it an audience can actually see.
    actor.height = drawnSpriteHeightPx(actor.definition.height_cm, this.#zoneOf(actor));
    actor.element.style.width = `${actor.height}px`;
    actor.element.style.height = `${actor.height}px`;
  }

  #drawFrames(timeMs) {
    for (const actor of this.#actors.values()) {
      if (!actor.clip) continue;
      const frame = frameIndexAt((timeMs - actor.clipStartedAt) / 1000, actor.clip.fps, actor.clip.frames);
      const [column, row] = frameCell(frame, actor.clip.grid ?? [actor.clip.frames, 1]);
      const [columns = 1, rows = 1] = actor.clip.grid ?? [];
      actor.element.style.backgroundPosition = `${cellPosition(column, columns)}% ${cellPosition(row, rows)}%`;
    }
  }

  async #waitForMotion(element, durationSeconds, slug, kind, origin, action) {
    let onTransitionEnd;
    const transition = new Promise((resolve) => {
      onTransitionEnd = resolve;
      element.addEventListener('transitionend', onTransitionEnd, { once: true });
    });
    try {
      await waitForActorAction(action, transition, (durationSeconds * 1000) + 650, {
        onTimeout: () => this.#warn({ type: 'media', asset: 'motion', slug, kind, message: 'motion deadline reached' }, origin),
      });
    } finally {
      element.removeEventListener('transitionend', onTransitionEnd);
    }
  }

  async #loadPlate(plate = {}, token, origin) {
    const { video, poster } = this.#elements;
    this.#cancelPlateReadiness();
    this.#removePlatePlaybackError();
    video.pause();
    video.classList.remove('is-ready');
    poster.classList.remove('is-ready');
    poster.style.backgroundImage = plate.poster ? `url("${cssUrl(plate.poster)}")` : 'none';
    video.poster = plate.poster ?? '';
    video.src = plate.video ?? '';
    const controller = new AbortController();
    let onCanPlay;
    let onError;
    const ready = new Promise((resolve, reject) => {
      onCanPlay = resolve;
      onError = () => reject(new Error('video failed to load'));
      video.addEventListener('canplay', onCanPlay, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
    const cleanup = () => {
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('error', onError);
    };
    const wait = { controller, cleanup };
    this.#plateWait = wait;
    video.load();

    try {
      const result = await withTimeout(ready, VIDEO_READY_TIMEOUT_MS, {
        onTimeout: () => this.#warn({ type: 'media', asset: 'plate-video', url: plate.video, message: 'video load timed out; poster retained' }, origin),
        signal: controller.signal,
      });
      if (result.timedOut || token !== this.#sceneToken) return;
      await video.play();
      if (token !== this.#sceneToken) return;
      const playbackError = () => {
        if (token !== this.#sceneToken) return;
        this.#warn({ type: 'media', asset: 'plate-video', url: plate.video, message: 'video playback failed; poster restored' }, origin);
        video.classList.remove('is-ready');
        poster.classList.remove('is-ready');
        this.#platePlaybackError = null;
      };
      this.#platePlaybackError = playbackError;
      video.addEventListener('error', playbackError, { once: true });
      video.classList.add('is-ready');
      poster.classList.add('is-ready');
    } catch (error) {
      if (error?.name === 'AbortError' || token !== this.#sceneToken) return;
      this.#warn({ type: 'media', asset: 'plate-video', url: plate.video, message: error.message }, origin);
      video.classList.remove('is-ready');
      poster.classList.remove('is-ready');
    } finally {
      cleanup();
      if (this.#plateWait === wait) this.#plateWait = null;
    }
  }

  #cancelPlateReadiness() {
    const wait = this.#plateWait;
    if (!wait) return;
    this.#plateWait = null;
    wait.cleanup();
    wait.controller.abort();
  }

  #removePlatePlaybackError() {
    if (!this.#platePlaybackError) return;
    this.#elements.video.removeEventListener('error', this.#platePlaybackError);
    this.#platePlaybackError = null;
  }

  #verifySprite(url, slug, clipKey, origin) {
    if (!url || this.#destroyed) return;
    const status = this.#spriteAssets.start(url);
    this.#applySpriteStatus(url, status);
    if (status.state !== 'loading' || this.#spriteLoads.has(url)) return;

    const image = new Image();
    const timer = setTimeout(() => {
      const slow = this.#spriteAssets.markSlow(url);
      this.#applySpriteStatus(url, slow);
      if (slow.warn) {
        this.#warn({ type: 'media', asset: 'spritesheet', slug, clip: clipKey, url, message: 'spritesheet load timed out; waiting in background' }, origin);
      }
    }, SPRITE_READY_TIMEOUT_MS);
    this.#spriteLoads.set(url, { image, timer });

    image.addEventListener('load', () => {
      clearTimeout(timer);
      this.#spriteLoads.delete(url);
      if (this.#destroyed) return;
      this.#applySpriteStatus(url, this.#spriteAssets.markReady(url));
    }, { once: true });
    image.addEventListener('error', () => {
      clearTimeout(timer);
      this.#spriteLoads.delete(url);
      if (this.#destroyed) return;
      const failed = this.#spriteAssets.markFailed(url);
      this.#applySpriteStatus(url, failed);
      if (failed.warn) {
        this.#warn({ type: 'media', asset: 'spritesheet', slug, clip: clipKey, url, message: 'spritesheet failed to load' }, origin);
      }
    }, { once: true });
    image.src = url;
  }

  #applySpriteStatus(url, status) {
    for (const actor of this.#actors.values()) {
      if (actor.clip?.spritesheet !== url) continue;
      actor.element.classList.toggle('is-missing', status.placeholder);
    }
  }

  #warn(detail, origin) {
    if (this.#destroyed) return;
    this.#onWarning({ ...detail, ...normalizeOrigin(origin) });
  }

  #fitStage() {
    if (this.#destroyed) return;
    const box = this.#elements.frame.getBoundingClientRect();
    const width = this.#elements.stage.offsetWidth || 1920;
    const height = this.#elements.stage.offsetHeight || DEFAULT_STAGE_RESOLUTION[1];
    this.#elements.stage.style.setProperty('--fit-scale', Math.min(box.width / width, box.height / height));
  }

  #clearActors() {
    for (const actor of this.#actors.values()) actor.element.remove();
    this.#actors.clear();
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#sceneToken += 1;
    if (this.#animationFrame !== null) cancelAnimationFrame(this.#animationFrame);
    this.#animationFrame = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#cancelPlateReadiness();
    this.#removePlatePlaybackError();
    for (const { image, timer } of this.#spriteLoads.values()) {
      clearTimeout(timer);
      image.removeAttribute?.('src');
    }
    this.#spriteLoads.clear();
    const video = this.#elements.video;
    video.pause();
    video.removeAttribute?.('src');
    video.load?.();
    this.#clearActors();
  }
}

function cellPosition(cell, cells) {
  return cells <= 1 ? 0 : (cell / (cells - 1)) * 100;
}

function motionTransition(seconds) {
  // width/height ride along so a walk between bands shrinks or grows the
  // sprite over the walk rather than popping on arrival. `top` is computed
  // from the height, so all three interpolating together is what keeps the
  // feet on a straight line between the two stand lines.
  return `left ${seconds}s linear, top ${seconds}s linear, width ${seconds}s linear, height ${seconds}s linear`;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isFramingFinite({ scale, x, y }) {
  return Number.isFinite(scale) && Number.isFinite(x) && Number.isFinite(y);
}

// An omitted speed is a slow move — the language's own default. An unknown word
// is the director's to refuse; if one reaches here anyway it is still slow, never
// a duration of `undefined`.
function cameraDuration(speed) {
  return Object.hasOwn(CAMERA_DURATIONS_MS, speed ?? 'slow') ? CAMERA_DURATIONS_MS[speed ?? 'slow'] : CAMERA_DURATIONS_MS.slow;
}

// The camera is a scale and an offset, both written into one `transform`: a
// plate point `p` lands at `scale * p + offset`, in percent of the layer. That
// is the whole model — a push, a shot, a pan and a ride differ only in which
// offset they ask for.
//
// A magnified layer keeps covering the frame only while its offset stays
// between `100 * (1 - scale)` and 0: past the top end the near edge pulls in,
// past the bottom end the far one does, and either way the stage background
// shows through. The interval is exactly zero wide at 1x, which is the reason a
// pan has to magnify before it can move at all rather than a rule anyone chose.
function clampOffset(offset, scale) {
  return Math.min(0, Math.max(100 * (1 - scale), offset));
}

// Hold `point` exactly where it already is and grow the world around it.
function framingHolding(point, scale) {
  return { scale, x: clampOffset(point.x * (1 - scale), scale), y: clampOffset(point.y * (1 - scale), scale) };
}

// Bring plate x to the middle of the frame, as far as the clamp allows, and
// leave the height alone — a pan is a horizontal move, and the vertical one is
// a different word. Aiming both axes at a character would point the camera at
// their FEET, which is what a stand line is: on a wide open that drove the frame
// straight down into the floor and pinned it there against the clamp.
//
// "Leave it alone" is not "keep the number": lifting the scale re-scales the
// axis under it, so what is preserved is the plate point already in the middle.
function framingPanned(x, scale, held) {
  const middleY = (50 - held.y) / held.scale;
  return { scale, x: clampOffset(50 - (scale * x), scale), y: clampOffset(50 - (scale * middleY), scale) };
}

// The far plane takes the same move at `PLATE_PARALLAX` of its magnitude — a
// scale of `1 + k(scale - 1)` and an offset of `k * offset`. At the shipped k of
// 1 that is the whole move and the two planes are locked; see the constant for
// why, and for what a plate would have to look like to earn a smaller one.
//
// What gets written here is not that weakened move but the DIFFERENCE, because
// the plate hangs inside the camera layer and is already carrying the full one:
// `camera⁻¹ ∘ weakened`, which the browser composes back into the weakened move.
//
// Two things fall out of the arithmetic rather than out of taste. The point a
// push holds still is held by both planes — both mappings fix it — so a push
// onto a character never slides the ground under them. And `k * offset` sits
// inside the weakened clamp exactly (`100(1 - scale')` is `k * 100(1 - scale)`),
// so the far plane can no more uncover the stage than the near one can.
//
// One approximation, deliberate: the drift layer animates between the camera and
// the plate, and it does not commute with either, so what lands is off from the
// exact weakened pair by `(drift - 1)(offset' - offset) + driftOffset(scale -
// scale')` — 0.17% of the stage at the deepest push, 3.3 px of 1920, breathing on
// the drift's 26 s cycle. `driftOffset` there is the drift's own affine offset,
// NOT the translate its keyframes name: the drift layer pins no transform origin,
// so it works about its centre and carries `50(1 - drift) + drift * translate`,
// about -0.68% — three times the keyframe number and the other way round, which
// is why the two terms partly cancel instead of adding. Cancelling the rest would
// mean reading a running animation's matrix every frame, which is the per-frame
// camera this renderer is built not to have.
// Exported for its own test: at the shipped 1 this function is the identity, so a
// test that could only reach it through the renderer would pass over a deleted
// body. The algebra is pinned here across parallaxes instead, and stays pinned
// while the plate is switched off.
export function plateFraming({ scale, x, y }, parallax = PLATE_PARALLAX) {
  const weakened = 1 + (parallax * (scale - 1));
  const share = (parallax - 1) / scale;
  return { scale: weakened / scale, x: x * share, y: y * share };
}

function round(value, places) {
  const step = 10 ** places;
  return Math.round(value * step) / step;
}

function round4(value) {
  return round(value, 4);
}

function cssUrl(value) {
  return String(value ?? '').replace(/["\\\n\r]/g, (character) => `\\${character}`);
}

function normalizeOrigin(origin) {
  if (typeof origin === 'number') return { line: origin };
  if (origin && typeof origin === 'object') return origin;
  return { line: null };
}
