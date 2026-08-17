import { isSide, zoneNamed } from '../geometry.mjs';

/**
 * Which band everybody is standing in.
 *
 * The stage stream names a band only on `place_object`: `place` carries
 * `slug`, `x`, `clip` and `move` adds `duration_ms`, and neither says where in
 * depth that x is. The band is not decoration — it decides how big a character
 * draws, which polygon their feet land on, what they are painted in front of,
 * and who they have to make room for — so it has to be recovered before
 * anything else can be computed.
 *
 * It is recovered from the STEP stream, by the three rules the engine
 * documents (`wiki/clients/mobile.md`, "Which band a character is in"): a `put`
 * that names no band gets the plate's default; a `move` that names none keeps
 * the band the character is already in; an arrival — a character walked in by
 * `travel`, which is where most `place` ops come from — gets the destination's
 * default. Standing at, or beside, somebody else means standing at their
 * distance, so an anchor's band wins over all three.
 *
 * Every character is held under TWO keys, and the difference matters:
 *
 *   raw    what `core/board.mjs` would be holding — `null` where the story said
 *          nothing, which is what an arrival leaves behind. Anchors are read
 *          off this, because the board reads its own answers: `move(rabbit,
 *          robin)` where robin arrived takes `robin.zone ?? null`, which is
 *          null, which means rabbit does not change band at all.
 *   name   the same ground, named. `null` and the default band's NAME are one
 *          physical band, and the DOM stage grouped crowding by the raw key, so
 *          an arrival and somebody put on that band never made room for each
 *          other — in Ruby's forest_glow the two landed on one x and were drawn
 *          on one pixel. Everything geometric reads this one.
 *
 * Collapsing the two is what made that bug; collapsing them the other way makes
 * a different one, where a walk toward an arrival changes the walker's band.
 */
export class BandBook {
  #plate = null;
  #bands = new Map();
  #instant = null;
  #steps = [];
  #snapshot = null;

  /** A cut empties the stage, so nobody's band survives it. */
  openScene(plate) {
    this.#plate = plate ?? null;
    this.#bands.clear();
    this.#instant = null;
    this.#steps = [];
    this.#snapshot = null;
  }

  /** Every `source: "step"` entry, in the order the stream carries them. */
  observeStep(event) {
    if (event.t_ms !== this.#instant) {
      this.#instant = event.t_ms;
      this.#steps = [];
      this.#snapshot = null;
    }
    // A `together` resolves its anchors against the board as the block FOUND
    // it, so two children that both name the same character agree about where
    // that character was — even if one of them is what moves them.
    if (event.kind === 'together') this.#snapshot = new Map(this.#bands);
    if (event.kind === 'cmd') this.#steps.push(event);
  }

  forget(slug) {
    this.#bands.delete(slug);
  }

  /**
   * A `place`. Its `put` is whichever command at this instant claims the slug;
   * no claim means an arrival, which the destination's default band answers.
   */
  place(slug) {
    const detail = this.#claim(slug, 'put');
    // An arrival keeps the board's own answer, which is nothing at all: a band
    // name belongs to the plate it was traced on and means nothing on the next
    // one, so travelling clears it. It resolves to the destination's default
    // for everything geometric, and stays `null` for anybody who walks to them.
    if (!detail) return this.#record(slug, null);
    const anchor = this.#anchorBand(detail, detail.position);
    // `beside=` and `zone=` cannot both be authored, so a beside that resolves
    // to nobody falls to the plate default rather than to the step's band.
    const named = detail.beside ? null : detail.zone ?? null;
    return this.#record(slug, anchor ?? this.#bandName(named));
  }

  /**
   * A `move`. Naming a character to walk to means joining their band; naming a
   * band means that one; naming neither means staying where you are, which is
   * why walking sideways is not walking away from the camera.
   */
  move(slug) {
    const detail = this.#claim(slug, 'move');
    const held = this.#bands.get(slug)?.raw ?? null;
    if (!detail) return this.#record(slug, held);

    // A `beside=` walks to a NUMBER, so the board never resolves a target
    // character for it — only the anchor's band reaches the walk.
    if (detail.beside) {
      const anchor = this.#anchorBand(detail, detail.position ?? detail.target);
      return this.#record(slug, (anchor ?? null) ?? held);
    }
    const target = this.#anchorBand(detail, detail.target);
    const named = detail.zone ?? null;
    const into = target === undefined ? named ?? held : target ?? named;
    return this.#record(slug, into ?? held);
  }

  /** A prop's band is on its own op — the compiler resolved it there. */
  object(slug, zoneName) {
    return this.#record(slug, zoneName ?? null);
  }

  #record(slug, raw) {
    const zone = zoneNamed(this.#plate, raw ?? null);
    // A name the plate does not know is kept as it is: it resolves to no band
    // at all, which is what an un-traced plate has always looked like.
    const name = zone ? zone.name : raw ?? null;
    this.#bands.set(slug, { raw: raw ?? null, name });
    return name;
  }

  // What a `put`'s own `zone=` resolves to before the board sees it: the named
  // band, the plate's default when it named none, and `null` when the plate
  // knows neither.
  #bandName(named) {
    return zoneNamed(this.#plate, named)?.name ?? null;
  }

  // Standing AT somebody — `put(rabbit, fox)` — takes their band as surely as
  // `beside=` does, so the anchor is read off the position either way. A side
  // word is a place on the floor and names nobody. `undefined` back means there
  // was no anchor at all, which is a different answer from an anchor standing
  // on no particular band.
  #anchorBand(detail, target) {
    if (!detail || typeof target !== 'string' || isSide(target)) return undefined;
    const source = this.#snapshotFor(detail) ?? this.#bands;
    const entry = source.get(target);
    return entry ? entry.raw : undefined;
  }

  #snapshotFor(detail) {
    return detail.together_line === undefined ? null : this.#snapshot;
  }

  #claim(slug, cmd) {
    for (let index = this.#steps.length - 1; index >= 0; index -= 1) {
      const step = this.#steps[index];
      if (step.cmd !== cmd) continue;
      if ((step.detail?.subjects ?? []).includes(slug)) return step.detail;
    }
    return null;
  }
}
