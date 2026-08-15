import { createV0Player } from './v0/app/main.mjs';

export const PERFORMERS = new Map([[0, createV0Player]]);

export function performerFor(story) {
  const version = story?.storylang_version;
  const performer = PERFORMERS.get(version);
  if (performer) return performer;
  throw new Error(
    `bundle version ${JSON.stringify(version)} unknown to this player `
    + `(knows: ${[...PERFORMERS.keys()].join(', ')})`,
  );
}
