import { CUE } from '../../policy.mjs';
import { toMs } from './timing.mjs';

/**
 * When a cue fires, in milliseconds from the start of its chunk.
 *
 * A cue is a command written under a spoken line to fire when a spoken word is
 * reached. Nothing in the bundle yet says when that word is spoken — the
 * narration is one wav with one measured `duration_s` — so this ESTIMATES it
 * from where the word sits in the text: the character the word begins at, over
 * the characters the line has, is the share of the chunk's clock that has
 * passed when it begins. Then `CUE.leadMs`, for the breath of silence
 * synthesised speech opens on.
 *
 * Measured word times (`chunkStep.words`, a later additive field) drop in HERE
 * and nowhere else: this is the one function the compiler asks, so a chunk
 * that carries them will answer with the measurement while one that does not
 * keeps the estimate.
 *
 * Clamped to the chunk. A cue is a thing that happens while the line is
 * spoken, so it can never land on or after the chunk's own end — the gate
 * resumes the walk there, and a cue firing after it would fire into whatever
 * came next. A chunk with no length at all fires its cues at 0.
 */
export function cueOffsetMs(chunkStep, cue, policy = CUE) {
  const durationMs = toMs(chunkStep?.duration_s);
  const at = cue?.at;
  const positioned = Number.isFinite(at?.char) && Number.isFinite(at?.chars) && at.chars > 0
    ? Math.round((durationMs * at.char) / at.chars)
    : 0;
  return Math.max(0, Math.min(positioned + policy.leadMs, durationMs - 1));
}
