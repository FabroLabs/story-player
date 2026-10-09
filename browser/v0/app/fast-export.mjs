import { NARRATION_GRACE_MS } from '../policy.mjs';
import { looksLikeMp4, readM4a } from './m4a-reader.mjs';
import { createMp4Writer, videoTicks } from './mp4-writer.mjs';
import {
  AUDIO_BITS_PER_SECOND, EXPORT_CHUNK_BYTES, EXPORT_QUEUE_BYTES, VIDEO_BITS_PER_SECOND, VIDEO_FPS, videoBitsFor,
} from './video-export.mjs';

/**
 * A take that does not wait for the story.
 *
 * The ordinary take films the story as it plays, so it lasts as long as the
 * story does. This one steps the story's clock by hand — a frame is drawn,
 * read off the canvas and encoded, and the next is asked for at once — mixes
 * the sound from the story's own schedule instead of listening to it, and
 * writes the mp4 itself. How long it takes is how fast the device can draw and
 * encode, not how long the story is; a device that falls behind is slower, and
 * the file is never choppy for it.
 *
 * It is offered only where every part of it is known to work: a performance
 * (whose sound is one schedule of files), a browser that can encode picture and
 * sound itself, and sound this file can read. Anything else answers `null` or
 * throws before a byte is written, and the take is filmed as it always was.
 */

const FRAME_MS = 1000 / VIDEO_FPS;
// A key frame, and so a new piece of the file, every two seconds.
const KEY_EVERY = VIDEO_FPS * 2;
// A file past this is a bed or a song: decoded whole it is hundreds of
// megabytes, so it is read a moment at a time instead.
const LONG_SOUND_BYTES = 2 * 1024 * 1024;
const FETCHES = 6;
// The story stands still this long with nothing arriving before the take gives up.
const STALL_MS = 30_000;

const VIDEO_CODECS = [
  { codec: 'avc', config: { codec: 'avc1.640028', avc: { format: 'avc' } } },
  { codec: 'avc', config: { codec: 'avc1.42E01F', avc: { format: 'avc' } } },
  { codec: 'vp9', config: { codec: 'vp09.00.31.08' } },
];
const AUDIO_CODECS = [
  { codec: 'aac', config: { codec: 'mp4a.40.2' } },
  { codec: 'opus', config: { codec: 'opus' } },
];

/**
 * Whether this story can be taken fast here, and with which encoders.
 *
 * `null` when it cannot; the answer is asked of the browser, so it is a promise.
 */
export async function planFastTake({ story, size, globalObject = globalThis }) {
  const g = globalObject;
  if (!story?.performance || !Array.isArray(story.audio)) return null;
  if (story.audio.some((cue) => cue.loop)) return null;
  for (const name of ['VideoEncoder', 'VideoFrame', 'AudioEncoder', 'AudioData', 'MessageChannel']) {
    if (typeof g[name] !== 'function') return null;
  }
  if (typeof (g.OfflineAudioContext ?? g.webkitOfflineAudioContext) !== 'function') return null;
  if (typeof g.OffscreenCanvas !== 'function' && !g.document?.createElement) return null;
  const supported = async (Encoder, config) => {
    try { return (await Encoder.isConfigSupported(config)).supported === true; } catch { return false; }
  };
  let video = null;
  for (const option of VIDEO_CODECS) {
    const config = { ...option.config, width: size.width, height: size.height, bitrate: VIDEO_BITS_PER_SECOND, framerate: VIDEO_FPS };
    if (await supported(g.VideoEncoder, config)) { video = option; break; }
  }
  let audio = null;
  for (const option of AUDIO_CODECS) {
    const config = { ...option.config, sampleRate: 48000, numberOfChannels: 2, bitrate: AUDIO_BITS_PER_SECOND };
    if (await supported(g.AudioEncoder, config)) { audio = option; break; }
  }
  return video && audio ? { video, audio } : null;
}

/**
 * One fast take: `timebase` is handed to the runtime in place of the wall
 * clock, and `run` plays the story through it.
 */
export function createFastTake(plan, {
  story, canvas, durationMs, tailMs, onChunk = null, memoryLimit, signal = null, globalObject = globalThis,
}) {
  const g = globalObject;
  const clock = createTimebase(g);
  const sink = createSink({ onChunk, memoryLimit, globalObject: g });
  const endMs = durationMs + tailMs;
  let videoEncoder = null;
  let audioEncoder = null;
  let closed = false;

  return {
    timebase: { now: clock.now, request: clock.request, cancel: clock.cancel },
    run,
    /** Whether any of the file has left: a take that has written cannot be started over. */
    wrote: () => sink.bytes() > 0,
    bytes: () => sink.bytes(),
    close,
  };

  /**
   * `player` is the runtime, already told to export on this take's timebase.
   * `begin` starts the story; `control` says whether the take was stopped
   * (`failed()` answers the error), is paused, or has reached the story's end.
   */
  async function run({ player, begin, control, onProgress = () => {} }) {
    const sheet = createSheet(canvas, g);
    const sound = await openSound({ story, endMs, plan, signal, globalObject: g });
    let failure = null;
    const fail = (error) => { failure ??= error instanceof Error ? error : new Error(String(error)); };
    const check = () => {
      const stopped = control.failed() ?? failure;
      if (stopped) throw stopped;
    };

    // Both encoders describe themselves with their first packet, and the file's
    // header needs both descriptions: what arrives before then waits here.
    let writer = null;
    const early = [];
    const described = { video: plan.video.codec === 'vp9' ? plan.video.config.codec : null, audio: null, audioSeen: false };
    const deliver = (kind, sample) => {
      if (writer) { writer[kind](sample); return; }
      early.push([kind, sample]);
      if (described.video === null || !described.audioSeen) return;
      writer = createMp4Writer({
        video: { codec: plan.video.codec, width: sheet.width, height: sheet.height, description: described.video },
        audio: { codec: plan.audio.codec, sampleRate: sound.rate, channels: 2,
          description: described.audio ?? (plan.audio.codec === 'aac' ? aacDescription(sound.rate, 2) : null) },
        durationMs: endMs,
        write: sink.write,
      });
      for (const [type, held] of early.splice(0)) writer[type](held);
    };

    // A frame's length is the gap to the next one, so the newest frame waits
    // for its successor before it can be written.
    let heldFrame = null;
    const frameOut = (frame) => {
      if (heldFrame) {
        if (frame.timestamp <= heldFrame.timestamp) return fail(new Error('the encoder returned frames out of order'));
        deliver('video', { data: heldFrame.data, key: heldFrame.key, duration: videoTicks((frame.timestamp - heldFrame.timestamp) / 1000) });
      }
      heldFrame = frame;
    };

    videoEncoder = new g.VideoEncoder({
      output(chunk, metadata) {
        // Inside the encoder's own callback a throw is nobody's to catch.
        try {
          const description = metadata?.decoderConfig?.description;
          if (description && described.video === null) described.video = copyBytes(description);
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          frameOut({ data, key: chunk.type === 'key', timestamp: chunk.timestamp });
        } catch (error) { fail(error); }
      },
      error: fail,
    });
    videoEncoder.configure({
      ...plan.video.config, width: sheet.width, height: sheet.height, framerate: VIDEO_FPS,
      bitrate: videoBitsFor(endMs, onChunk ? 0 : memoryLimit), latencyMode: 'quality',
    });
    audioEncoder = new g.AudioEncoder({
      output(chunk, metadata) {
        try {
          const description = metadata?.decoderConfig?.description;
          if (description && described.audio === null) described.audio = copyBytes(description);
          described.audioSeen = true;
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          deliver('audio', { data, duration: Math.max(1, Math.round((chunk.duration ?? 0) * sound.rate / 1e6)) });
        } catch (error) { fail(error); }
      },
      error: fail,
    });
    audioEncoder.configure({ ...plan.audio.config, sampleRate: sound.rate, numberOfChannels: 2, bitrate: AUDIO_BITS_PER_SECOND });

    let frames = 0;
    let soundAt = 0;
    const encodeFrame = (tMs) => {
      sheet.draw();
      const frame = new g.VideoFrame(sheet.canvas, { timestamp: Math.round(tMs * 1000), duration: Math.round(FRAME_MS * 1000) });
      videoEncoder.encode(frame, { keyFrame: frames % KEY_EVERY === 0 });
      frame.close();
      frames += 1;
    };
    /** The sound up to `tMs`, mixed and handed to its encoder, and the piece of file that completes. */
    const catchUp = async (tMs) => {
      const to = Math.min(sound.frameOf(endMs), sound.frameOf(tMs));
      while (soundAt < to) {
        const count = Math.min(sound.rate, to - soundAt);
        const mixed = await sound.mix(soundAt, count);
        const data = new Float32Array(count * 2);
        data.set(mixed[0], 0);
        data.set(mixed[1], count);
        audioEncoder.encode(new g.AudioData({
          format: 'f32-planar', sampleRate: sound.rate, numberOfFrames: count, numberOfChannels: 2,
          timestamp: Math.round(soundAt / sound.rate * 1e6), data,
        }));
        soundAt += count;
        check();
      }
      writer?.flush();
      await sink.drain();
      onProgress();
    };

    begin();
    // Starting the story draws its first instant; time has not moved yet.
    encodeFrame(0);
    let last = 0;
    let stalledSince = null;
    while (true) {
      check();
      if (control.paused()) { await wait(g, 100); continue; }
      clock.step(FRAME_MS);
      const state = player.getState();
      const tMs = Math.min(state?.tMs ?? 0, durationMs);
      const ended = control.ending() || state?.ended === true;
      const next = afterStep({ tMs, last, durationMs, ended });
      if (next === 'end') break;
      if (next === 'frame') {
        last = tMs;
        stalledSince = null;
        encodeFrame(tMs);
        if (frames % KEY_EVERY === 0) await catchUp(tMs);
        while (videoEncoder.encodeQueueSize > 4) { await turn(g); check(); }
        // Downloads and decodes that landed are noticed between frames.
        if (frames % 3 === 0) await turn(g);
        if (ended && tMs >= durationMs) break;
        continue;
      }
      // The story is holding for a picture that has not landed. Every pass
      // through here yields: what it waits for arrives on the event loop.
      stalledSince ??= clock.wall();
      if (clock.wall() - stalledSince > STALL_MS) throw new Error('the story stopped arriving while it was being saved');
      await idle(g, clock.wall, 4);
    }
    // The last picture, held while the last word finishes.
    for (let tMs = last + FRAME_MS; tMs < endMs; tMs += FRAME_MS) {
      check();
      encodeFrame(tMs);
      while (videoEncoder.encodeQueueSize > 4) await turn(g);
    }
    await catchUp(endMs);
    await videoEncoder.flush();
    await audioEncoder.flush();
    check();
    if (heldFrame) deliver('video', { data: heldFrame.data, key: heldFrame.key, duration: videoTicks(Math.max(1, endMs - heldFrame.timestamp / 1000)) });
    if (!writer) throw new Error('the encoders produced nothing');
    writer.finish();
    await sink.drain(true);
    sound.close();
    return sink.result();
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const encoder of [videoEncoder, audioEncoder]) {
      try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch { /* already gone */ }
    }
    sink.discard();
  }
}

/**
 * What a step of the clock produced: a `frame` to write, the `end` of the
 * story, or nothing yet (`wait`).
 *
 * A story that held for a picture stands a few milliseconds past the last
 * frame, and comes back from the hold there: that sliver is the same frame, not
 * one of its own. It is a `wait`, never a reason to step again at once — a
 * story standing on a sliver would be stepped for ever without the loop ever
 * yielding to the download it is waiting for.
 */
export function afterStep({ tMs, last, durationMs, ended }) {
  const atEnd = tMs >= durationMs;
  if (tMs - last >= FRAME_MS / 2 || (atEnd && tMs > last)) return 'frame';
  return ended ? 'end' : 'wait';
}

/**
 * Story time, moved by hand.
 *
 * The runtime reads `now` where it read the wall clock and asks `request`
 * where it asked for an animation frame; `step` moves time on and gives every
 * frame asked for its turn.
 */
function createTimebase(g) {
  const wall = () => g.performance?.now?.() ?? Date.now();
  let now = wall();
  let id = 0;
  const asked = new Map();
  return {
    now: () => now,
    wall,
    request(callback) { asked.set(++id, callback); return id; },
    cancel(handle) { asked.delete(handle); },
    step(milliseconds) {
      now += milliseconds;
      const due = [...asked.values()];
      asked.clear();
      for (const callback of due) callback(now);
    },
  };
}

/**
 * The frame the encoder reads: the stage, with both sides even.
 *
 * The stage is fitted to the story's shape and may be an odd number of pixels
 * tall; a hardware encoder takes even sides only, so at most one row or column
 * is left off.
 */
function createSheet(canvas, g) {
  const width = canvas.width - (canvas.width % 2);
  const height = canvas.height - (canvas.height % 2);
  const sheet = typeof g.OffscreenCanvas === 'function'
    ? new g.OffscreenCanvas(width, height)
    : Object.assign(g.document.createElement('canvas'), { width, height });
  const context = sheet.getContext('2d', { alpha: false });
  return { canvas: sheet, width, height, draw: () => context.drawImage(canvas, 0, 0) };
}

/**
 * Where the file goes: to the host a piece at a time, or kept here whole.
 *
 * Pieces handed to a host are acknowledged in order. The take does not stand
 * still for each one — a host writing to disk answers slower than a device
 * encodes — but it does once too much is waiting (`drain`), so a slow writer
 * slows the take instead of filling memory.
 */
function createSink({ onChunk, memoryLimit, globalObject: g }) {
  const parts = [];
  let bytes = 0;
  let index = 0;
  let waiting = 0;
  let writes = Promise.resolve();
  let failure = null;
  let discarded = false;
  return {
    write(piece) {
      if (discarded) return;
      bytes += piece.length;
      if (!onChunk) {
        if (memoryLimit > 0 && bytes > memoryLimit) throw new Error('this video exceeds the browser’s memory limit');
        // A Blob is the browser's to keep, and it may keep it out of memory.
        parts.push(new g.Blob([piece]));
        return;
      }
      for (let offset = 0; offset < piece.length; offset += EXPORT_CHUNK_BYTES) {
        const slice = new g.Blob([piece.subarray(offset, offset + EXPORT_CHUNK_BYTES)]);
        const at = index++;
        waiting += slice.size;
        writes = writes
          .then(() => (failure || discarded ? null : onChunk(slice, at)))
          .catch((error) => { failure ??= error; })
          .finally(() => { waiting -= slice.size; });
      }
    },
    /** Waits for the host when too much is unacknowledged; with `all`, for every piece. */
    async drain(all = false) {
      if (all || waiting > EXPORT_QUEUE_BYTES / 2) await writes;
      if (failure) throw failure;
    },
    result() { return onChunk ? { size: bytes, type: 'video/mp4' } : new g.Blob(parts, { type: 'video/mp4' }); },
    bytes: () => bytes,
    discard() { discarded = true; parts.length = 0; },
  };
}

/**
 * The story's sound, mixed from its schedule.
 *
 * Every cue is a file, an instant it starts and a volume that may step. Short
 * files — a line of narration, an effect — are decoded whole when the mix
 * reaches them and let go once it has passed. A long one is read through its
 * own table of contents, a second at a time.
 */
async function openSound({ story, endMs, plan, signal, globalObject: g }) {
  // A resolved story names each file by `url`; `media` is its place in the store.
  const cues = story.audio
    .map((cue) => ({ ...cue, media: cue.url ?? cue.media }))
    .filter((cue) => typeof cue.media === 'string' && cue.start_ms < endMs && audible(cue, endMs));
  const files = new Map();
  const urls = [...new Set(cues.map((cue) => cue.media))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(FETCHES, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const answer = await g.fetch(url, signal ? { signal } : undefined);
      if (!answer.ok) throw new Error(`story sound could not be fetched (${answer.status})`);
      files.set(url, await answer.arrayBuffer());
    }
  }));

  // A long file sets the rate everything is mixed at, so it is never resampled
  // a window at a time; opus is 48 kHz and nothing else.
  const long = new Map();
  for (const [url, bytes] of files) {
    if (bytes.byteLength <= LONG_SOUND_BYTES) continue;
    if (!looksLikeMp4(bytes) || typeof g.AudioDecoder !== 'function') throw new Error('a long story sound cannot be read a piece at a time here');
    long.set(url, readM4a(bytes));
  }
  const first = long.values().next().value;
  const rate = plan.audio.codec === 'aac' && (first?.sampleRate === 44100 || first?.sampleRate === 48000) ? first.sampleRate : 48000;
  for (const info of long.values()) {
    if (info.sampleRate !== rate) throw new Error('the story’s long sounds are at different rates');
    const supported = await g.AudioDecoder.isConfigSupported({ codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels, description: info.description })
      .then((answer) => answer.supported === true, () => false);
    if (!supported) throw new Error('a long story sound cannot be decoded here');
  }

  const Offline = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  // Decoding resamples to the context it is asked of: one at the mix's rate.
  const decoding = new Offline(1, 1, rate);
  const frameOf = (ms) => Math.round(ms * rate / 1000);
  const sources = new Map();
  const readers = new Map();
  /** A cue's sound at the mix's rate: `{ length, read(from, count) }`. */
  const sourceOf = (cue) => {
    if (!sources.has(cue.media)) {
      const bytes = files.get(cue.media);
      sources.set(cue.media, long.has(cue.media)
        ? Promise.resolve(streamed(long.get(cue.media), bytes))
        : decoding.decodeAudioData(bytes.slice(0)).then(whole));
    }
    return sources.get(cue.media);
  };
  const whole = (buffer) => {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
    return { length: buffer.length, read: async (from, count) => channels.map((data) => data.subarray(from, from + count)) };
  };
  const streamed = (info, bytes) => {
    const reader = createPacketReader(info, bytes, g);
    readers.set(info, reader);
    return { length: info.samples.length * info.frames - info.skip, read: reader.read };
  };

  /** A short file every one of whose cues has passed is let go, decoded and undecoded. */
  const release = (cue, from) => {
    if (long.has(cue.media) || !files.has(cue.media)) return;
    if (cues.some((other) => other.media === cue.media && frameOf(windowEnd(other)) > from)) return;
    sources.delete(cue.media);
    files.delete(cue.media);
  };

  return {
    rate,
    frameOf,
    /** `count` frames from `from`, as left and right. */
    async mix(from, count) {
      const left = new Float32Array(count);
      const right = new Float32Array(count);
      const to = from + count;
      for (const cue of cues) {
        const start = frameOf(cue.start_ms);
        const end = frameOf(windowEnd(cue));
        if (start >= to) continue;
        if (end <= from) { release(cue, from); continue; }
        const source = await sourceOf(cue);
        const a = Math.max(from, start);
        const b = Math.min(to, start + source.length, end);
        if (b <= a) continue;
        const pcm = await source.read(a - start, b - a);
        const second = pcm[1] ?? pcm[0];
        // The volume steps at its keys: each stretch between two is one gain.
        const steps = [a, ...(cue.gain_keys ?? []).map(([ms]) => frameOf(ms)).filter((frame) => frame > a && frame < b), b];
        for (let i = 0; i + 1 < steps.length; i += 1) {
          const gain = volumeAt(cue, steps[i] * 1000 / rate);
          if (gain === 0) continue;
          for (let frame = steps[i]; frame < steps[i + 1]; frame += 1) {
            left[frame - from] += pcm[0][frame - a] * gain;
            right[frame - from] += second[frame - a] * gain;
          }
        }
      }
      return [left, right];
    },
    close() {
      for (const reader of readers.values()) reader.close();
      sources.clear();
      files.clear();
    },
  };
}

/** When a cue stops sounding: a line of narration may finish its last word. */
function windowEnd(cue) {
  const end = cue.end_ms ?? cue.start_ms + cue.duration_ms;
  return cue.kind === 'narration' ? end + NARRATION_GRACE_MS : end;
}

/** A cue's volume at an instant: its own, or the last key at or before it. */
function volumeAt(cue, tMs) {
  let volume = cue.volume ?? 1;
  for (const [at, value] of cue.gain_keys ?? []) {
    // Half a frame of leeway: a step found by its frame is a hair before its key.
    if (at > tMs + 0.5) break;
    volume = value;
  }
  return Math.max(0, Math.min(1, volume));
}

/** Whether a cue is ever heard before `endMs`: a bed that is silent throughout is not fetched. */
function audible(cue, endMs) {
  if (!cue.gain_keys?.length) return (cue.volume ?? 1) > 0;
  const before = cue.gain_keys.filter(([at]) => at < endMs);
  const startsHeard = (cue.gain_keys[0][0] > cue.start_ms ? (cue.volume ?? 1) : 0) > 0;
  return startsHeard || before.some(([, value]) => value > 0);
}

/**
 * A long m4a, read a stretch at a time.
 *
 * Each read decodes only the packets under it, plus two before: an AAC packet
 * leans on its predecessor, and a decoder that was just emptied has none.
 * Decoded sound is placed by its own timestamp, so a decoder that swallows its
 * first packet shifts nothing.
 */
function createPacketReader(info, bytes, g) {
  const view = new Uint8Array(bytes);
  let failure = null;
  let target = null;
  const decoder = new g.AudioDecoder({
    output(data) {
      try {
        if (!target) return;
        const first = Math.round(data.timestamp * info.sampleRate / 1e6) - info.skip;
        const from = Math.max(first, target.from);
        const to = Math.min(first + data.numberOfFrames, target.from + target.count);
        for (let channel = 0; channel < target.out.length && to > from; channel += 1) {
          data.copyTo(target.out[channel].subarray(from - target.from, to - target.from), {
            planeIndex: Math.min(channel, data.numberOfChannels - 1), frameOffset: from - first, frameCount: to - from, format: 'f32-planar',
          });
        }
      } catch (error) { failure ??= error; } finally { data.close(); }
    },
    error(error) { failure ??= error; },
  });
  decoder.configure({ codec: info.codec, sampleRate: info.sampleRate, numberOfChannels: info.channels, description: info.description });
  const micros = (packet) => Math.round(packet * info.frames * 1e6 / info.sampleRate);
  return {
    async read(from, count) {
      const out = Array.from({ length: info.channels }, () => new Float32Array(count));
      const firstPacket = Math.max(0, Math.floor((from + info.skip) / info.frames) - 2);
      const lastPacket = Math.min(info.samples.length, Math.ceil((from + count + info.skip) / info.frames));
      target = { from, count, out };
      for (let packet = firstPacket; packet < lastPacket; packet += 1) {
        const { offset, size } = info.samples[packet];
        decoder.decode(new g.EncodedAudioChunk({
          type: 'key', timestamp: micros(packet), duration: micros(1), data: view.subarray(offset, offset + size),
        }));
      }
      await decoder.flush();
      target = null;
      if (failure) throw failure;
      return out;
    },
    close() { try { if (decoder.state !== 'closed') decoder.close(); } catch { /* already gone */ } },
  };
}

/** Plain AAC at this rate and channel count, as the two bytes a decoder is configured with. */
function aacDescription(sampleRate, channels) {
  const index = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(sampleRate);
  return Uint8Array.of((2 << 3) | (index >> 1), ((index & 1) << 7) | (channels << 3));
}

function copyBytes(source) {
  const view = ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  return view.slice();
}

/** A turn of the event loop that a hidden tab does not stretch to a second. */
function turn(g) {
  return new Promise((resolve) => {
    const channel = new g.MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(0);
  });
}

function wait(g, milliseconds) {
  return new Promise((resolve) => { g.setTimeout(resolve, milliseconds); });
}

/**
 * A few milliseconds of letting the event loop run, by turns rather than by a
 * timer: a hidden tab stretches a four-millisecond timer to a second, and a
 * story holds for a picture dozens of times.
 */
async function idle(g, wall, milliseconds) {
  const until = wall() + milliseconds;
  do { await turn(g); } while (wall() < until);
}
