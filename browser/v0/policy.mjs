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
