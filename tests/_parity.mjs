import fs from 'node:fs';

// The engine's parity corpus, copied in verbatim. Every `.timeline.json` here
// was produced by the machinery the compiler replaced, so these are the goldens
// both the compiler and the state core are held against.
//
// `golden_board` and `golden_slate` are the exceptions, and they have to be:
// they are the lesson stories, written after that machinery was gone, and the
// build the engine has locked answers their ops with `unknown-command`. Their
// timelines were therefore written by THIS compiler, and the engine regenerates
// its own copies to match once the lock moves to a build that knows them.
export const STEMS = [
  'golden_board',
  'golden_camera_moves',
  'golden_heal_travel',
  'golden_push_dusk',
  'golden_slate',
  'golden_together_audio',
  'ruby_and_the_gentle_dark',
  'the_owls_quiet_friend',
  'thud_in_the_forest_scene1',
];

const FIXTURES = new URL('fixtures/parity/', import.meta.url);

export function slurp(stem, kind) {
  return fs.readFileSync(new URL(`${stem}.${kind}.json`, FIXTURES), 'utf8');
}

export function read(stem, kind) {
  return JSON.parse(slurp(stem, kind));
}

// The engine's manifest block, rebuilt from the same scenes it is derived from
// (`_plates_by_place`): sorted at both levels, so a place staged at two times
// resolves in the same order here as it arrives over the wire.
export function platesOf(bundle) {
  const staged = bundle.scenes.map((scene) => [scene.place, scene.time, scene.plate]);
  staged.sort(([placeA, timeA], [placeB, timeB]) => (
    compare(placeA, placeB) || compare(timeA, timeB)
  ));
  const block = {};
  for (const [place, time, plate] of staged) (block[place] ??= {})[time] = plate;
  return block;
}

const compare = (left, right) => (left < right ? -1 : Number(left > right));
