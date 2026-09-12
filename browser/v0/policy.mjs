export const DEFAULT_STAGE_RESOLUTION = Object.freeze([1920, 1080]);
export const PUSH_SCALE = 1.55;
export const PAN_SCALE_FLOOR = 1.25;
export const SHOT_SIZES = Object.freeze({ wide: 1, medium: null, close: null });
export const CAMERA_DURATIONS_MS = Object.freeze({ slow: 2_400, medium: 1_400 });
export const PLATE_PARALLAX = 1;

export const BESIDE_NUDGE_PCT = 0.01;
export const MOVE_X_PCT_PER_SECOND = 22;
export const MINIMUM_MOVE_SECONDS = 0.25;
export const MINIMUM_DEPARTURE_SECONDS = 0.35;
export const DEFAULT_EXIT_X_PCT = Object.freeze({ left: -8, right: 108 });
export const DEPARTURE_DEADLINE_MS = 5_000;

// The counting board a lesson draws, and the ring that names a thing.
//
// Both are HUD, and they are HUD in two different senses. The board is painted
// in plate space with the camera left out, so a push-in magnifies the actors
// underneath while the arithmetic keeps its size and its place; the ring rides
// its actor, under the framing, because it is a mark on that actor.
//
// Every number here is published for the same reason the movement numbers are:
// a client drawing its own board has to land it where this one does. They are
// the ratios of the teaching surface the lessons were designed against
// (`procgraphics/math_board.py`), which measured everything against the panel
// it draws rather than against the frame — so the board keeps its proportions
// on a stage of any aspect. The COLOURS are deliberately not here: they are the
// painter's, and a client with its own palette is still drawing this board.
//
// The milliseconds are the one thing the old renderer did not have. There, the
// reveal was paced by the narration's own beats; here a board is raised at an
// instant and builds from it, so the pacing is fixed and published: a counter
// every `staggerMs`, each popping over `popMs`, then the taken ones crossed out
// over `takeMs` apiece, then the equation a token every `tokenMs`.
export const SLATE = Object.freeze({
  // The most counters a board keeps in ONE row. Past it the board splits into
  // two BALANCED rows rather than wrapping — eleven lands as six and five,
  // twenty as ten and ten — so a row may hold more than this; what this number
  // decides is whether there is a second row at all. A client that wraps every
  // five draws four rows where this board draws two.
  perRow: 5,
  // The frosted panel, as percentages of the plate's own width and height.
  panelPct: Object.freeze({ left: 4.5, top: 8.5, right: 95.5, bottom: 93 }),
  radiusPct: 5,
  // The bright sheen along the panel's top, as a fraction of the panel's HEIGHT.
  sheenPct: 16,
  // The band the counters live in, between these two fractions of the panel's
  // height; the equation gets what is left below them.
  countersTopPct: 11,
  countersBottomPct: 62,
  // A counter's cell is the smallest of: its share of the panel's width, the
  // height the rows have to share, and this fraction of the plate's height —
  // which is what keeps three counters from growing into three balloons.
  cellShare: 0.84,
  cellMaxPct: 27,
  // The counter itself, and the gold ring around the newest one, as fractions
  // of that cell and of the counter's own radius.
  counterRadius: 0.34,
  ringGap: 0.22,
  ringWidth: 0.16,
  // The red X over a counter being taken away.
  crossWidth: 0.18,
  // The running-count badge: a square of the plate's height, its centre offset
  // in from the panel's top-right corner by these fractions of its own side.
  badgePct: 11,
  badgeOffset: Object.freeze([0.78, 0.62]),
  badgeRadius: 0.3,
  badgeFont: 0.6,
  // The gap above the equation band, and the one below it.
  bandGapPct: 5,
  // The equation's numerals: the smaller of this fraction of the band's height
  // and this fraction of the plate's width, spaced by a fraction of that size.
  equationFont: Object.freeze([0.84, 0.1]),
  tokenGap: 0.28,
  popMs: 350,
  staggerMs: 250,
  takeMs: 450,
  takeStaggerMs: 250,
  tokenMs: 300,
  // The peak the newest counter overshoots to on its way in. It is the peak of
  // the standard back-out curve rather than a second free number, and a test
  // holds the curve to it.
  overshoot: 1.1,
  max: 20,
  // What happens BEHIND the board while it is up: the plate is blurred so the
  // scene reads as a backdrop rather than as something still worth watching,
  // by this fraction of the plate's own height (the old renderer's 16px at
  // 720), eased over this many milliseconds. The blur is CSS on the plate
  // layer, not a draw-list number - the plate is a `<video>` and never enters
  // the canvas - so `ms` reaches the stylesheet as a custom property.
  frost: Object.freeze({ pct: 2.2, ms: 250 }),
  // Where the one character left visible stands while the board is up: small,
  // in the corner, over the panel. Percentages of the plate, feet on the line
  // rather than centred, because a companion is stood on the floor.
  companion: Object.freeze({ heightPct: 27, centreXPct: 90, feetPct: 99 }),
});

// `pulses` is how many times the ring brightens across `durationMs`, and
// `ringPct` is how far outside the subject's own box it is drawn.
export const HIGHLIGHT = Object.freeze({ durationMs: 1_500, pulses: 2, ringPct: 12 });

export const MUSIC_VOLUME = 0.38;
export const DUCKED_MUSIC_VOLUME = 0.14;
export const MUSIC_FADE_MS = 850;
export const DUCK_FADE_MS = 220;
// How far past its scheduled end a narration line may still be sounding.
//
// A line's file is only opened as its cue comes, so it begins as late as the
// fetch takes, and its end used to be fixed to the clock — the difference came
// out of the last words. This is the bound on giving that difference back: the
// line runs on until it has played what it is owed, and the next line's opening
// overlaps it by at most this. Measured on the qa host over 60 chunks of two
// real stories (2026-08-24): start lag p50 246/270 ms, p95 330/408 ms; the tail
// lost p50 295/316 ms, p95 421/447 ms, worst 869 ms on a line that also stalled
// mid-file. A second covers the worst of those and bounds the overlap.
export const NARRATION_GRACE_MS = 1_000;
