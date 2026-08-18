/**
 * Everything you hear, and when.
 *
 * No stage op carries an audio path: a client built from the stage stream alone
 * plays a correct, perfectly timed, completely silent story. The sound is all
 * in the step stream — `kind: "chunk"` is the narration, `cmd: "sound"` and
 * `cmd: "music"` are the rest — and the media itself is in the bundle, which is
 * why both are arguments here.
 *
 * Two questions, because a player asks two. Playing forward asks what STARTS in
 * the slice of time just crossed; seeking asks what should be SOUNDING at the
 * instant landed on, and how far into it. Answering the second with the first
 * would replay every sound effect of the last ten minutes at once.
 */

export function cuesBetween(timeline, bundle, fromMs, toMs) {
  const cues = [];
  for (const event of timeline?.events ?? []) {
    if (event.t_ms >= toMs) break;
    if (event.t_ms < fromMs) continue;
    const cue = cueFor(event, bundle);
    if (cue) cues.push(cue);
  }
  return cues;
}

export function soundingAt(timeline, bundle, tMs) {
  let narration = null;
  let music = null;
  for (const event of timeline?.events ?? []) {
    if (event.t_ms > tMs) break;
    const cue = cueFor(event, bundle);
    if (!cue) continue;
    // A sound effect is a moment, not a state — landing after one means having
    // missed it, and firing it late is worse than not firing it at all.
    if (cue.kind === 'sound') continue;
    if (cue.kind === 'music') {
      // Only `off` stops the music. A track the bundle does not carry is a
      // failure, not an instruction, and the live audio director answered it by
      // leaving whatever was playing alone — silencing the story because one
      // name was misspelled is the louder mistake.
      if (cue.name === 'off') music = null;
      else if (cue.media) music = cue;
      continue;
    }
    narration = cue.tMs + cue.durationMs > tMs ? { ...cue, offsetMs: tMs - cue.tMs } : null;
  }
  return { narration, music };
}

function cueFor(event, bundle) {
  if (event.source !== 'step') return null;
  if (event.kind === 'chunk') return narrationCue(event);
  if (event.kind !== 'cmd') return null;
  if (event.cmd === 'sound') return effectCue(event, bundle?.audio?.sfx, 'sound');
  if (event.cmd === 'music') return effectCue(event, bundle?.audio?.bgm, 'music');
  return null;
}

function narrationCue(event) {
  const media = event.detail?.audio;
  // A chunk inside a `together` is logged but never performed — no subtitle, no
  // wait — so it is not something anybody hears either. And a text-only chunk
  // has no wav: it still shows its subtitle, through the `subtitle` op, and
  // still costs the schedule its duration.
  if (typeof media !== 'string' || event.detail?.together_line !== undefined) return null;
  return {
    kind: 'narration',
    tMs: event.t_ms,
    media,
    durationMs: Math.max(0, (Number(event.detail.duration_s) * 1000) || 0),
    text: event.detail.text ?? '',
    sceneIndex: event.scene_index ?? null,
    line: event.line ?? null,
  };
}

function effectCue(event, library, kind) {
  const name = event.detail?.name;
  if (typeof name !== 'string') return null;
  // `music(off)` is a cue with nothing to play: it means stop the one running.
  // A name the bundle does not carry has nothing to play either, and the two
  // are not the same thing at all — `missing` is what tells them apart, so a
  // player can report the one and obey the other.
  const stop = name === 'off';
  const media = stop ? null : library?.[name] ?? null;
  return {
    kind,
    tMs: event.t_ms,
    name,
    media,
    missing: !stop && media === null,
    sceneIndex: event.scene_index ?? null,
    line: event.line ?? null,
  };
}
