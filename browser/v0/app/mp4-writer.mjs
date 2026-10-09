/**
 * An mp4, written a piece at a time.
 *
 * A fast take encodes the story itself, so there is no browser recorder to
 * write the file: this does. The file is FRAGMENTED — a header that describes
 * the two tracks and then a run of self-contained pieces, each a few seconds of
 * picture and sound — because that is the one shape of mp4 that can be written
 * strictly front to back. A take streams it to a native host a chunk at a time
 * and never goes back to patch a size. It is the shape a browser's own recorder
 * writes, and what a phone's gallery already takes from one.
 *
 * Pure: bytes in, bytes out, no clock and no DOM.
 */

const VIDEO_TIMESCALE = 90_000;
const MOVIE_TIMESCALE = 1_000;
// What a sample says about itself: a key frame depends on nothing, any other
// frame on the one before it and may not be seeked to.
const KEY_FRAME = 0x02000000;
const DELTA_FRAME = 0x01010000;
const IDENTITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

/**
 * `video`: `{ codec: 'avc' | 'vp9', width, height, description }` — the
 * encoder's own configuration record for avc, the codec string for vp9.
 * `audio`: `{ codec: 'aac' | 'opus', sampleRate, channels, description }`.
 * `write` is handed each piece of the file in order.
 *
 * Durations are in each track's own units: `videoTicks(ms)` for a frame, a
 * count of sound samples for an audio packet. That keeps a long file exact —
 * a rounded millisecond per packet would drift the sound off the picture.
 */
export function createMp4Writer({ video, audio, durationMs, write }) {
  const tracks = [
    { id: 1, timescale: VIDEO_TIMESCALE, time: 0, pending: [], flags: true },
    { id: 2, timescale: audio.sampleRate, time: 0, pending: [], flags: false },
  ];
  const index = [];
  let sequence = 0;
  let written = 0;
  let finished = false;
  put(ftyp(video));
  put(moov(video, audio, durationMs));

  return {
    /** One encoded frame: `{ data, duration, key }`. */
    video(sample) { tracks[0].pending.push(sample); },
    /** One encoded packet of sound: `{ data, duration }`. */
    audio(sample) { tracks[1].pending.push(sample); },
    flush,
    /** The last piece and the index a player seeks by. Answers the file's length. */
    finish() {
      if (finished) return written;
      flush();
      finished = true;
      put(mfra(index));
      return written;
    },
    bytes: () => written,
  };

  /** Everything handed over since the last piece, as one piece: picture, then sound. */
  function flush() {
    const filled = tracks.filter((track) => track.pending.length > 0);
    if (finished || filled.length === 0) return;
    // A fragment's samples are found by counting from the start of its own
    // header, so the header's length has to be known before it is written.
    const headerLength = 8 + 16 + filled.reduce((sum, track) => sum + trafLength(track), 0);
    let offset = headerLength + 8;
    const trafs = [];
    const payload = [];
    for (const track of filled) {
      trafs.push(traf(track, offset));
      for (const sample of track.pending) {
        payload.push(sample.data);
        offset += sample.data.length;
        track.time += sample.duration;
      }
    }
    if (tracks[0].pending.length > 0) index.push({ time: tracks[0].time - sum(tracks[0].pending), offset: written });
    for (const track of filled) track.pending = [];
    sequence += 1;
    put(box('moof', full('mfhd', 0, 0, u32(sequence)), ...trafs));
    put(box('mdat', ...payload));
  }

  function put(bytes) {
    written += bytes.length;
    write(bytes);
  }
}

/** A frame's length in the picture track's units. */
export function videoTicks(milliseconds) {
  return Math.round(milliseconds * VIDEO_TIMESCALE / 1000);
}

function sum(samples) {
  return samples.reduce((total, sample) => total + sample.duration, 0);
}

function trafLength(track) {
  return 8 + 16 + 20 + 20 + track.pending.length * (track.flags ? 12 : 8);
}

function traf(track, dataOffset) {
  const samples = track.pending.map((sample) => concat([
    u32(sample.duration), u32(sample.data.length),
    ...(track.flags ? [u32(sample.key ? KEY_FRAME : DELTA_FRAME)] : []),
  ]));
  return box(
    'traf',
    // default-base-is-moof: offsets count from this fragment's own header.
    full('tfhd', 0, 0x020000, u32(track.id)),
    full('tfdt', 1, 0, u64(track.time)),
    // data offset, and per sample a duration and a size (and for the picture, its flags).
    full('trun', 0, track.flags ? 0x000701 : 0x000301, u32(track.pending.length), u32(dataOffset), ...samples),
  );
}

function ftyp(video) {
  const brands = ['isom', 'iso6', 'iso5', 'mp41', ...(video.codec === 'avc' ? ['avc1'] : [])];
  return box('ftyp', ascii('isom'), u32(0x200), ...brands.map(ascii));
}

function moov(video, audio, durationMs) {
  return box(
    'moov',
    full('mvhd', 0, 0, u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(0), u32(0x00010000), u16(0x0100),
      zeros(10), ...IDENTITY.map(u32), zeros(24), u32(3)),
    trak(1, VIDEO_TIMESCALE, 'vide', 'VideoHandler', video.width, video.height,
      full('vmhd', 0, 1, zeros(8)), videoEntry(video)),
    trak(2, audio.sampleRate, 'soun', 'SoundHandler', 0, 0,
      full('smhd', 0, 0, zeros(4)), audioEntry(audio)),
    box(
      'mvex',
      // The story's length is known before its first frame is drawn, which
      // is what lets a player show it for a file with no sample tables.
      full('mehd', 0, 0, u32(Math.round(durationMs))),
      ...[1, 2].map((id) => full('trex', 0, 0, u32(id), u32(1), u32(0), u32(0), u32(0))),
    ),
  );
}

function trak(id, timescale, handler, name, width, height, mediaHeader, entry) {
  const sound = handler === 'soun';
  return box(
    'trak',
    full('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(0), zeros(8), u16(0), u16(0),
      u16(sound ? 0x0100 : 0), u16(0), ...IDENTITY.map(u32), u32(width << 16), u32(height << 16)),
    box(
      'mdia',
      // 0x55c4: the language "und", three letters packed five bits each.
      full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0)),
      full('hdlr', 0, 0, u32(0), ascii(handler), zeros(12), ascii(`${name}\0`)),
      box(
        'minf',
        mediaHeader,
        box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
        box(
          'stbl',
          full('stsd', 0, 0, u32(1), entry),
          // Empty on purpose: every sample is described by its own fragment.
          full('stts', 0, 0, u32(0)),
          full('stsc', 0, 0, u32(0)),
          full('stsz', 0, 0, u32(0), u32(0)),
          full('stco', 0, 0, u32(0)),
        ),
      ),
    ),
  );
}

function videoEntry({ codec, width, height, description }) {
  const head = concat([
    zeros(6), u16(1), zeros(16), u16(width), u16(height), u32(0x00480000), u32(0x00480000),
    u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff),
  ]);
  if (codec === 'avc') return box('avc1', head, box('avcC', bytesOf(description)));
  if (codec === 'vp9') {
    // `vp09.PP.LL.DD`: profile, level and bit depth. 4:2:0, limited range, BT.709.
    const [profile = 0, level = 31, depth = 8] = String(description).split('.').slice(1).map(Number);
    return box('vp09', head, full('vpcC', 1, 0, u8(profile), u8(level), u8((depth << 4) | (1 << 1)), u8(1), u8(1), u8(1), u16(0)));
  }
  throw new TypeError(`an mp4 cannot be written for ${codec} video`);
}

function audioEntry({ codec, sampleRate, channels, description }) {
  const head = concat([zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate << 16 >>> 0)]);
  if (codec === 'aac') return box('mp4a', head, esds(bytesOf(description)));
  if (codec === 'opus') return box('Opus', head, dOps(description, channels, sampleRate));
  throw new TypeError(`an mp4 cannot be written for ${codec} sound`);
}

/** The elementary-stream descriptor: three nested tags around the encoder's own two bytes. */
function esds(specific) {
  const tag = (id, ...parts) => { const body = concat(parts); return concat([u8(id), u8(body.length), body]); };
  return full('esds', 0, 0, tag(0x03, u16(0), u8(0),
    // 0x40: MPEG-4 audio. 0x15: an audio stream.
    tag(0x04, u8(0x40), u8(0x15), zeros(3), u32(0), u32(0), tag(0x05, specific)),
    tag(0x06, u8(2))));
}

/** Opus's own header, re-laid in the byte order an mp4 keeps it in. */
function dOps(description, channels, sampleRate) {
  const head = description ? bytesOf(description) : null;
  const view = head && head.length >= 19 ? new DataView(head.buffer, head.byteOffset, head.byteLength) : null;
  const preSkip = view ? view.getUint16(10, true) : 312;
  const gain = view ? view.getInt16(16, true) : 0;
  return box('dOps', u8(0), u8(channels), u16(preSkip), u32(sampleRate), u16(gain & 0xffff), u8(0));
}

/** Where each piece starts, so a player can jump to an instant without reading the file to it. */
function mfra(entries) {
  const rows = entries.map((entry) => concat([u64(entry.time), u64(entry.offset), u8(1), u8(1), u8(1)]));
  const tfra = full('tfra', 1, 0, u32(1), u32(0), u32(entries.length), ...rows);
  // The box ends by stating its own length, which is how it is found from the end of the file.
  return box('mfra', tfra, full('mfro', 0, 0, u32(8 + tfra.length + 16)));
}

function box(type, ...parts) {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(ascii(type), 4);
  out.set(body, 8);
  return out;
}

function full(type, version, flags, ...parts) {
  return box(type, u8(version), u8(flags >>> 16), u8((flags >>> 8) & 0xff), u8(flags & 0xff), ...parts);
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return new Uint8Array(value);
}

function ascii(text) { return Uint8Array.from(text, (letter) => letter.charCodeAt(0)); }
function zeros(count) { return new Uint8Array(count); }
function u8(value) { return Uint8Array.of(value & 0xff); }
function u16(value) { return Uint8Array.of((value >>> 8) & 0xff, value & 0xff); }
function u32(value) { return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff); }
function u64(value) { return concat([u32(Math.floor(value / 2 ** 32)), u32(value >>> 0)]); }
