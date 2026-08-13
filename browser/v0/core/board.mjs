import { desiredFacing } from './clips.mjs';
import { alongFloor, isSide, sideX } from './geometry.mjs';

export class PlayerBoard {
  #characters = new Map();
  #place = null;
  #span = null;
  #arrivalSequence = 0;

  // `span` is the open plate's floor extent; every zone on this board is
  // resolved against it, so all stored x values share one coordinate space.
  beginScene(place, span = null) {
    this.#place = place;
    this.#span = span;
    this.#stageArrivals(place);
    return this.visibleCharacters();
  }

  // A healed travel puts a character in a place the camera has not opened yet
  // (bundle.py emits `place` only then) — that place's own span comes with it.
  // `span` is never inherited across places: naming a foreign place without one
  // means the whole plate, not the open scene's floor, so dropping the argument
  // can never silently stage against the wrong floor.
  // `zone` is the NAME of the band this character stands in — the story's, or
  // the plate's default. It rides on the character rather than on the board
  // because two characters in one scene may now stand in different bands, each
  // with its own span, stand line and drawn size. The span passed in is that
  // zone's, so x stays a plate-wide percentage and every stored x still shares
  // one coordinate space.
  put(subjects, position, facing, place = this.#place, span, zone = null, reference = this) {
    const floor = span === undefined ? (place === this.#place ? this.#span : null) : span;
    // `where` may name a CAST MEMBER, not just a side — the spec says so and
    // the manual teaches it. Only `move` used to resolve that, so `put(rabbit,
    // fox)` fell through to `sideX('fox')` → undefined → `left: NaNpx`, which
    // CSS drops (the sprite renders half off-frame), which crowding then
    // spreads across the whole band, and which the phone's timeline ships as a
    // `place` op with no `x` key at all. Silent at every one of those layers.
    const anchor = typeof position === 'string' && !isSide(position)
      ? reference.positionOf(position)
      : null;
    // an anchor who is not on stage YET is legal for `put` — the validator
    // permits the forward reference because the next line may place them — so
    // it falls back to the default the language already promises, centre,
    // rather than to nothing at all
    const x = anchor && typeof anchor.x === 'number' ? anchor.x : positionX(position, floor)
      ?? positionX('center', floor);
    for (const slug of subjectList(subjects)) {
      this.#characters.set(slug, { slug, x, place, facing, zone: anchor?.zone ?? zone });
    }
  }

  // `zone`/`span` describe the band being moved INTO. Moving to a character
  // takes their band instead: standing beside somebody means standing at their
  // distance, which is why the language refuses `beside=` and `zone=` together.
  move(subjects, target, reference = this, zone = null, span, spanOf = () => undefined) {
    const targetPosition = typeof target === 'string' && !isSide(target)
      ? reference.positionOf(target)
      : null;

    for (const slug of subjectList(subjects)) {
      const character = this.#characters.get(slug);
      if (!character) continue;
      // a move that names no band leaves the character in the one they are in:
      // walking sideways is not walking away from the camera. Resolved PER
      // character, because two characters told to walk left may be standing in
      // different bands, and a side is a fraction of the band you are in (D7)
      // — one shared span would measure one of them against the other's floor.
      const into = targetPosition ? (targetPosition.zone ?? zone) : (zone ?? character.zone ?? null);
      const floor = spanOf(into) ?? (span === undefined ? this.#span : span);
      const targetX = targetPosition ? targetPosition.x : positionX(target, floor);
      const facing = desiredFacing(character.x, targetX);
      character.x = targetX;
      character.facing = facing;
      if (into !== null) character.zone = into;
      delete character.departure;
    }
  }

  travel(subjects, destination, exitAnchorPct) {
    for (const slug of subjectList(subjects)) {
      const character = this.#characters.get(slug);
      if (!character) continue;
      const from = character.place;
      character.place = destination;
      character.departure = { from, to: destination, exitAnchorPct: copyAnchor(exitAnchorPct) };
      character.arrival = { place: destination, sequence: this.#arrivalSequence++ };
    }
  }

  visibleCharacters() {
    return [...this.#characters.values()]
      .filter((character) => character.place === this.#place)
      .map(publicCharacter);
  }

  positionOf(slug) {
    const character = this.#characters.get(slug);
    return character ? positionCharacter(character) : null;
  }

  snapshot() {
    const characters = {};
    for (const [slug, character] of this.#characters) {
      characters[slug] = copyCharacter(character);
    }
    return { place: this.#place, characters };
  }

  reference() {
    const snapshot = this.snapshot();
    return {
      positionOf(slug) {
        const character = snapshot.characters[slug];
        return character ? positionCharacter(character) : null;
      },
      visibleCharacters() {
        return Object.values(snapshot.characters)
          .filter((character) => character.place === snapshot.place)
          .map(publicCharacter);
      },
    };
  }

  #stageArrivals(place) {
    const arrivals = [...this.#characters.values()]
      .filter((character) => character.arrival?.place === place)
      .sort((left, right) => left.arrival.sequence - right.arrival.sequence);
    const positions = stagedPositions(arrivals.length, this.#span);

    arrivals.forEach((character, index) => {
      character.x = positions[index];
      // A zone name belongs to a PLATE, not to the world: `background_road` is
      // a band of forest_path and means nothing at forest_pond. Carried across
      // a travel it resolved to no zone at all on the new plate, so the
      // arrival was drawn at scale 1, on the no-floor stand line, and skipped
      // by crowding — while the story had said nothing at all about a band.
      // Clearing it hands the arrival to the destination's default zone (D6),
      // which is what the engine answers whenever the story does not say.
      character.zone = null;
      delete character.arrival;
      delete character.departure;
    });
  }
}

function subjectList(subjects) {
  return Array.isArray(subjects) ? subjects : String(subjects).trim().split(/\s+/).filter(Boolean);
}

function positionX(position, span) {
  if (typeof position === 'number') return position;
  if (typeof position === 'object' && position !== null) return position.x;
  return sideX(position, span);
}

// Arrival slots are fractions of the floor for the same reason zones are.
function stagedPositions(count, span) {
  const presets = {
    1: [0.5],
    2: [0.3, 0.7],
    3: [0.3, 0.5, 0.7],
    4: [0.1, 0.3, 0.7, 0.9],
    5: [0.1, 0.3, 0.5, 0.7, 0.9],
  };
  const fractions = presets[count]
    ?? Array.from({ length: count }, (_, index) => 0.1 + ((0.8 * index) / (count - 1)));

  return fractions.map((fraction) => alongFloor(fraction, span));
}

function publicCharacter(character) {
  // carries `zone` for the same reason positionCharacter does — and this is the
  // projection the ARRIVAL path reads, so dropping it would have staged every
  // travelled character at full size on the default band
  return {
    slug: character.slug,
    x: character.x,
    place: character.place,
    facing: character.facing,
    zone: character.zone ?? null,
  };
}

function positionCharacter(character) {
  // `zone` belongs here as much as `x` does: it is the other half of where
  // somebody is standing. Leaving it out let every caller read a character as
  // un-banded, so `move(x, bear)` could not join bear's band and the renderer
  // drew everyone at full size in creation order.
  return {
    x: character.x, place: character.place, facing: character.facing, zone: character.zone ?? null,
  };
}

function copyCharacter(character) {
  return JSON.parse(JSON.stringify(character));
}

function copyAnchor(anchor) {
  return Array.isArray(anchor) ? [...anchor] : anchor ?? null;
}
