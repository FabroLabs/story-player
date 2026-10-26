import { readFarmJourney } from '../core/farm-journey.mjs';
import { cuesBetween } from '../core/state/cues.mjs';
import { DUCKED_MUSIC_VOLUME, DUCK_FADE_MS, MUSIC_FADE_MS, MUSIC_VOLUME, NARRATION_GRACE_MS } from '../policy.mjs';

/** The export's sound schedule. The visual runtime keeps its original bundle. */
export function soundCuesFor({ story, timeline = null, board = null }) {
  if (story?.performance) return Array.isArray(story.audio) ? story.audio : null;
  // Canvas worlds and farm journeys have scheduled sound. Farm plates are
  // paused and sought to each output instant by the export runtime. Other
  // legacy stories keep their existing filmed fallback.
  if (!timeline || (!board?.world && !timeline.events?.some(event =>
    event.source === 'stage' && event.op === 'slate' && readFarmJourney(event)?.kind === 'journey'))) return null;
  const events = cuesBetween(timeline, story, 0, Infinity);
  if (events.some(cue => cue.missing)) return null;
  const endMs = timeline.duration_ms;
  const cues = [];
  let music = null;
  for (const [order, event] of events.entries()) {
    if (event.kind !== 'music') {
      cues.push({ kind: event.kind, media: event.media, start_ms: event.tMs, export_order: order,
        ...(event.kind === 'narration' ? { duration_ms: event.durationMs } : { end_ms: endMs }) });
      continue;
    }
    if (music?.name === event.name) continue;
    if (music) {
      music.stop_ms = event.tMs;
      music.end_ms = Math.min(endMs, event.tMs + MUSIC_FADE_MS);
    }
    music = null;
    if (event.name === 'off') continue;
    music = { kind: 'music', name: event.name, media: event.media, start_ms: event.tMs,
      end_ms: endMs, loop: true, volume: 0, gain_ramps: [], legacy_music: true, export_order: order };
    cues.push(music);
  }
  updateMusicRamps(cues);
  return cues;
}

/** Recompute ducks once the current mix window knows the decoded voice lengths. */
export function updateMusicRamps(cues) {
  const tracks = cues.filter(cue => cue.legacy_music);
  if (!tracks.length) return;
  const changes = [];
  for (const cue of cues) {
    if (cue.kind === 'narration') {
      changes.push({ kind: 'voice', at: cue.start_ms, delta: 1, order: cue.export_order });
      const end = cue.source_end_ms === undefined ? cue.start_ms + cue.duration_ms : windowEnd(cue);
      changes.push({ kind: 'voice', at: end, delta: -1, order: cue.export_order });
    }
  }
  for (const cue of tracks) {
    cue.gain_ramps = [];
    changes.push({ kind: 'music', at: cue.start_ms, cue, order: cue.export_order });
    if (cue.stop_ms !== undefined) changes.push({ kind: 'stop', at: cue.stop_ms, cue, order: -1 });
  }
  changes.sort((a, b) => a.at - b.at || a.order - b.order);
  let music = null, voices = 0;
  const fade = (cue, to, at, duration) => {
    cue.gain_ramps.push({ start_ms: at, end_ms: at + duration, from: volumeAt(cue, at), to });
  };
  for (const change of changes) {
    if (change.kind === 'voice') {
      const before = voices;
      voices += change.delta;
      if (music && Boolean(before) !== Boolean(voices)) {
        fade(music, voices ? DUCKED_MUSIC_VOLUME : MUSIC_VOLUME, change.at, DUCK_FADE_MS);
      }
    } else if (change.kind === 'stop') {
      fade(change.cue, 0, change.at, MUSIC_FADE_MS);
      if (music === change.cue) music = null;
    } else {
      music = change.cue;
      fade(music, voices ? DUCKED_MUSIC_VOLUME : MUSIC_VOLUME, change.at, MUSIC_FADE_MS);
    }
  }
}

/** The same authored window used for mixing and releasing decoded sounds. */
export function windowEnd(cue) {
  const end = cue.end_ms ?? cue.start_ms + cue.duration_ms;
  return Math.min(cue.source_end_ms ?? Infinity, cue.kind === 'narration' ? end + NARRATION_GRACE_MS : end);
}

/** Performance keys remain steps; export-only legacy music ramps are linear. */
export function volumeAt(cue, tMs) {
  let volume = cue.volume ?? 1;
  for (const [at, value] of cue.gain_keys ?? []) {
    if (at > tMs + 0.5) break;
    volume = value;
  }
  for (const ramp of cue.gain_ramps ?? []) {
    if (ramp.start_ms > tMs) break;
    const progress = Math.min(1, Math.max(0, (tMs - ramp.start_ms) / (ramp.end_ms - ramp.start_ms)));
    volume = ramp.from + (ramp.to - ramp.from) * progress;
  }
  return Math.max(0, Math.min(1, volume));
}

/** Mix one bounded window, reading again at loop boundaries without retaining copies. */
export async function mixCue(cue, source, from, left, right, rate) {
  if (!(source.length > 0)) return;
  const frameOf = ms => Math.round(ms * rate / 1000);
  const start = frameOf(cue.start_ms);
  const end = Math.min(from + left.length, frameOf(windowEnd(cue)), cue.loop ? Infinity : start + source.length);
  const keys = [...(cue.gain_keys ?? []).map(([ms]) => ms),
    ...(cue.gain_ramps ?? []).flatMap(ramp => [ramp.start_ms, ramp.end_ms])].map(frameOf);
  let at = Math.max(from, start);
  while (at < end) {
    const offset = (at - start) % source.length;
    const until = Math.min(end, at + source.length - offset);
    const pcm = await source.read(offset, until - at);
    const second = pcm[1] ?? pcm[0];
    const steps = [at, ...new Set(keys.filter(frame => frame > at && frame < until).sort((a, b) => a - b)), until];
    for (let i = 0; i + 1 < steps.length; i++) {
      const a = steps[i], b = steps[i + 1];
      const gain = volumeAt(cue, a * 1000 / rate);
      const last = cue.gain_ramps?.length ? volumeAt(cue, (b - 1) * 1000 / rate) : gain;
      const slope = b - a > 1 ? (last - gain) / (b - a - 1) : 0;
      for (let frame = a; frame < b; frame++) {
        const volume = gain + slope * (frame - a);
        left[frame - from] += pcm[0][frame - at] * volume;
        right[frame - from] += second[frame - at] * volume;
      }
    }
    at = until;
  }
}

/** Read a long sound at the mix rate without decoding or retaining the whole track.
 * Absolute sample positions preserve phase across read windows and loop restarts.
 * A windowed sinc filter also removes frequencies that would alias when reducing rate.
 */
export function resampleSource(source, inputRate, outputRate) {
  if (inputRate === outputRate || source.length === 0) return source;
  const cutoff = Math.min(1, outputRate / inputRate) * 0.94;
  const radius = Math.ceil(16 / cutoff);
  const kernels = new Map();
  function kernel(phase) {
    if (kernels.has(phase)) return kernels.get(phase);
    const fraction = phase / outputRate;
    const weights = new Float64Array(radius * 2 + 1);
    let sum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const distance = offset - fraction;
      if (Math.abs(distance) >= radius) continue;
      const x = Math.PI * cutoff * distance;
      const weight = cutoff * (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x)
        * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      weights[offset + radius] = weight;
      sum += weight;
    }
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    // Standard 44.1 -> 48 kHz needs 160 phases; unusual rates stay bounded too.
    if (kernels.size < 256) kernels.set(phase, weights);
    return weights;
  }
  return {
    length: Math.round(source.length * outputRate / inputRate),
    async read(from, count) {
      if (count === 0) return source.read(0, 0);
      const first = Math.max(0, Math.floor(from * inputRate / outputRate) - radius);
      const until = Math.min(source.length, Math.floor((from + count - 1) * inputRate / outputRate) + radius + 1);
      const input = await source.read(first, until - first);
      const output = input.map(() => new Float32Array(count));
      for (let frame = 0; frame < count; frame++) {
        const position = (from + frame) * inputRate;
        const center = Math.floor(position / outputRate);
        const weights = kernel(position % outputRate);
        for (let channel = 0; channel < input.length; channel++) {
          let value = 0;
          for (let tap = 0; tap < weights.length; tap++) {
            const at = Math.max(0, Math.min(source.length - 1, center + tap - radius));
            value += input[channel][at - first] * weights[tap];
          }
          output[channel][frame] = value;
        }
      }
      return output;
    },
  };
}
