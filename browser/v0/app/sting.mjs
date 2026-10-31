import { readMp4Video } from './m4a-reader.mjs';

/**
 * The Moony Kids sting a saved video opens with and closes on.
 *
 * Only a downloaded video carries it: a story played in the app starts at its
 * own first scene. Each film is a silent mp4 in the frame's shape (H.264,
 * 60 fps, frames stored in the order they are shown) with its sound in an m4a
 * beside it, kept in the shared story bucket so every story's asset base
 * reaches them. A stepped take opens them as it starts (`fast-export.mjs`); a
 * filmed take goes without, and so does any take whose sting cannot be
 * fetched or decoded here.
 */

export const STING_ROOT = 'fairytale-assets/brand/sting/v1';
// A decoder this far ahead of the frame being drawn keeps the take moving
// without holding more than a few full frames.
const DECODE_AHEAD = 3;

/** The bucket paths of both films and their sound, for a frame of this shape. */
export function stingMedia(shape) {
  const frame = shape === '9:16' ? '9x16' : '16x9';
  const part = (name) => ({ picture: `${STING_ROOT}/${name}-${frame}.mp4`, sound: `${STING_ROOT}/${name}.m4a` });
  return { intro: part('intro'), outro: part('outro') };
}

/**
 * Both films, `{ intro, outro }`, each `{ frames, picture(), sound }`:
 * `picture()` hands out its frames in order, `sound` is `{ length, mix }` at
 * `rate`, cut to the picture's length. `resolve` turns a bucket path into a
 * URL as the story's own media are.
 */
export async function openSting(shape, { resolve, rate, frameMs, signal = null, globalObject: g = globalThis }) {
  if (typeof g.VideoDecoder !== 'function' || typeof g.EncodedVideoChunk !== 'function') {
    throw new Error('this browser cannot decode the sting');
  }
  const bytesOf = async (path) => {
    const answer = await g.fetch(resolve(path), signal ? { signal } : undefined);
    if (!answer.ok) throw new Error(`the sting could not be fetched (${answer.status})`);
    return answer.arrayBuffer();
  };
  const Offline = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  // Decoding resamples to the context it is asked of: one at the mix's rate.
  const decoding = new Offline(2, 1, rate);
  const film = async ({ picture, sound }) => {
    const [pictureBytes, soundBytes] = await Promise.all([bytesOf(picture), bytesOf(sound)]);
    const info = readMp4Video(pictureBytes);
    const config = { codec: info.codec, description: info.description, codedWidth: info.width, codedHeight: info.height, optimizeForLatency: true };
    const answer = await Promise.resolve(g.VideoDecoder.isConfigSupported(config)).catch(() => null);
    if (answer?.supported !== true) throw new Error('this browser cannot decode the sting');
    const buffer = await decoding.decodeAudioData(soundBytes);
    const frames = info.frames.length;
    return {
      frames,
      picture: () => decodeInOrder(info, new Uint8Array(pictureBytes), config, g),
      sound: soundOf(buffer, Math.min(buffer.length, Math.round(frames * frameMs * rate / 1000))),
    };
  };
  const [intro, outro] = await Promise.all([film(stingMedia(shape).intro), film(stingMedia(shape).outro)]);
  return { intro, outro };
}

/** A decoded sound as `{ length, mix(from, count) }`, both sides; one channel is heard on both. */
function soundOf(buffer, length) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  const [left, right = left] = channels;
  return {
    length,
    async mix(from, count) {
      const out = [new Float32Array(count), new Float32Array(count)];
      const end = Math.min(length, from + count);
      if (end > from) {
        out[0].set(left.subarray(from, end));
        out[1].set(right.subarray(from, end));
      }
      return out;
    },
  };
}

/**
 * A film's frames, one `next()` at a time and in order; `null` after the last.
 * Each frame is the caller's to close. The decoder is fed a few packets ahead
 * and woken by every frame it gives back and every packet it takes.
 */
export function decodeInOrder(info, bytes, config, g) {
  const ready = [];
  let fed = 0;
  let flushed = false;
  let failure = null;
  let wake = null;
  const nudge = () => { const resolve = wake; wake = null; resolve?.(); };
  const decoder = new g.VideoDecoder({
    output(frame) { ready.push(frame); nudge(); },
    error(error) { failure = error; nudge(); },
  });
  decoder.addEventListener?.('dequeue', nudge);
  decoder.configure(config);
  const feed = () => {
    const frame = info.frames[fed++];
    decoder.decode(new g.EncodedVideoChunk({
      type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, duration: frame.duration,
      data: bytes.subarray(frame.offset, frame.offset + frame.size),
    }));
  };
  return {
    async next() {
      while (ready.length === 0) {
        if (failure) throw failure;
        if (fed < info.frames.length && decoder.decodeQueueSize < DECODE_AHEAD) { feed(); continue; }
        if (fed === info.frames.length) {
          if (flushed) return null;
          flushed = true;
          await decoder.flush();
          continue;
        }
        await new Promise((resolve) => { wake = resolve; });
      }
      return ready.shift();
    },
    close() {
      for (const frame of ready.splice(0)) frame.close();
      try { if (decoder.state !== 'closed') decoder.close(); } catch { /* already gone */ }
    },
  };
}
