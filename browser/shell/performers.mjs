/**
 * Which performer plays this bundle — the whole of the version decision, kept
 * pure so it can be tested without a browser.
 *
 * `storylang/__init__.py` has refused an unknown `.story` version since v0
 * shipped, and `tools/mobile/timeline.mjs` refuses a non-v0 bundle before it
 * times one. Development keeps v0 in place, but a version still freezes at its
 * first shipped story — a v1 bundle WILL exist one day, and the v0 performer
 * would play it under v0 rules without complaint. Malformed same-number
 * bundles are gated inside the performer; an unknown numeric version is still
 * refused here.
 */

// A Map, not an object literal, because object keys are strings: PERFORMERS[0]
// and PERFORMERS["0"] would be the same slot, and a bundle whose version is the
// string "0" was not written by our builder. `Map.get` tells them apart.
export const PERFORMERS = new Map([[0, '../v0/app/main.mjs']]);

/**
 * -> the module specifier to import, relative to `player/shell/main.mjs`.
 * Throws by name when nothing here can play the bundle.
 */
export function performerFor(story) {
  const version = story?.storylang_version;
  const performer = PERFORMERS.get(version);
  if (performer) return performer;
  throw new Error(
    `bundle version ${JSON.stringify(version)} unknown to this player `
    + `(knows: ${[...PERFORMERS.keys()].join(', ')})`,
  );
}
