/**
 * Where the sound — or a short film's picture — is inside an mp4.
 *
 * A fast take mixes the story's sound itself, and a bed can be twenty minutes
 * of which the story hears eighteen seconds. Decoding the whole file to find
 * them costs hundreds of megabytes; this reads the file's own table of
 * contents instead, so only the packets a moment needs are decoded. The same
 * table gives a downloaded video's sting its frames one at a time.
 *
 * It reads the shapes we write — AAC, or H.264 without reordered frames, in an
 * ordinary, unfragmented mp4 — and refuses anything else by throwing, which
 * sends the take back to the recording it was before. Pure: bytes in, a
 * description out.
 */

/**
 * `{ codec, sampleRate, channels, description, skip, length, samples }`.
 *
 * `samples` is every packet as `{ offset, size }` into the same bytes, each
 * `frames` sound samples long. `skip` is how many samples the file's own edit
 * list drops from the start: an AAC encoder's lead-in, which is not the sound.
 * `length` is the playable sample count; the last packet can contain padding.
 */
export function readM4a(input) {
  const mp4 = openMp4(input);
  const { view } = mp4;
  const { trak, inMedia } = mp4.track('soun') ?? fail('no sound track in this mp4');
  const timescale = mp4.timescale(inMedia);
  const tables = mp4.tables(inMedia);
  const entry = mp4.entry(tables);
  if (entry?.type !== 'mp4a') throw new Error(`the sound is ${entry?.type ?? 'nothing'}, not AAC`);
  // A sound entry is 28 bytes of fields before its own boxes; QuickTime's
  // older second version of it keeps sixteen more.
  const version = view.getUint16(entry.body + 8);
  const esds = mp4.need(mp4.children(entry.body + 28 + (version === 1 ? 16 : 0), entry.end), 'esds');
  const description = specific(mp4, esds);
  const config = audioConfig(description);
  const timing = packetTiming(mp4, mp4.need(tables, 'stts'), timescale, config.sampleRate);
  const skip = leadIn(mp4, trak, timescale, config.sampleRate);
  return {
    codec: `mp4a.40.${config.objectType}`,
    sampleRate: config.sampleRate,
    channels: config.channels || view.getUint16(entry.body + 16),
    description,
    frames: timing.frames,
    skip,
    length: Math.max(0, timing.length - skip),
    samples: mp4.packets(tables),
  };
}

/**
 * `{ codec, description, width, height, frames }` for a film's picture.
 *
 * `frames` is every picture in the order it is shown, as `{ offset, size, key,
 * timestamp, duration }` (microseconds). A file whose frames are stored out of
 * the order they are shown is refused: a sting is encoded without them.
 */
export function readMp4Video(input) {
  const mp4 = openMp4(input);
  const { view, bytes } = mp4;
  const { inMedia } = mp4.track('vide') ?? fail('no picture track in this mp4');
  const timescale = mp4.timescale(inMedia);
  const tables = mp4.tables(inMedia);
  const entry = mp4.entry(tables);
  if (entry?.type !== 'avc1' && entry?.type !== 'avc3') throw new Error(`the picture is ${entry?.type ?? 'nothing'}, not H.264`);
  if (find(tables, 'ctts')) throw new Error('the picture stores its frames out of order');
  // A picture entry is 78 bytes of fields (its size at 24) before its own boxes.
  const avcC = mp4.need(mp4.children(entry.body + 78, entry.end), 'avcC');
  const description = bytes.slice(avcC.body, avcC.end);
  const hex = (at) => description[at].toString(16).padStart(2, '0');
  const packets = mp4.packets(tables);
  const durations = sampleDurations(mp4, mp4.need(tables, 'stts'), packets.length);
  const stss = find(tables, 'stss');
  const keys = stss ? new Set(Array.from({ length: view.getUint32(stss.body + 4) }, (_, i) => view.getUint32(stss.body + 8 + i * 4) - 1)) : null;
  let ticks = 0;
  const frames = packets.map((packet, index) => {
    const frame = {
      ...packet,
      key: keys ? keys.has(index) : true,
      timestamp: Math.round(ticks * 1e6 / timescale),
      duration: Math.round(durations[index] * 1e6 / timescale),
    };
    ticks += durations[index];
    return frame;
  });
  return {
    codec: `avc1.${hex(1)}${hex(2)}${hex(3)}`,
    description,
    width: view.getUint16(entry.body + 24),
    height: view.getUint16(entry.body + 26),
    frames,
  };
}

/** Whether these bytes begin as an mp4 does. */
export function looksLikeMp4(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.length > 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
}

/** The boxes of an mp4 and the tables every track keeps, shared by both readers. */
function openMp4(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = find(children(0, bytes.length), 'moov');
  if (!moov) throw new Error('not an mp4 with a table of contents');
  return {
    bytes, view, children, need,
    /** The first track whose handler is `kind` ('soun', 'vide'). */
    track(kind) {
      for (const trak of children(moov.body, moov.end).filter((box) => box.type === 'trak')) {
        const mdia = find(children(trak.body, trak.end), 'mdia');
        const inMedia = mdia ? children(mdia.body, mdia.end) : [];
        const hdlr = find(inMedia, 'hdlr');
        if (hdlr && text(hdlr.body + 8, 4) === kind) return { trak, inMedia };
      }
      return null;
    },
    timescale(inMedia) {
      const mdhd = need(inMedia, 'mdhd');
      return view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));
    },
    tables(inMedia) {
      const minf = need(inMedia, 'minf');
      const stbl = need(children(minf.body, minf.end), 'stbl');
      return children(stbl.body, stbl.end);
    },
    entry(tables) {
      const stsd = need(tables, 'stsd');
      return children(stsd.body + 8, stsd.end)[0];
    },
    packets,
  };

  /** Every packet's place in the file: chunks of packets, each chunk at an offset. */
  function packets(tables) {
    const stsz = need(tables, 'stsz');
    const fixed = view.getUint32(stsz.body + 4);
    const count = view.getUint32(stsz.body + 8);
    const stsc = need(tables, 'stsc');
    const runs = [];
    for (let i = 0, n = view.getUint32(stsc.body + 4); i < n; i += 1) {
      runs.push({ first: view.getUint32(stsc.body + 8 + i * 12), per: view.getUint32(stsc.body + 12 + i * 12) });
    }
    const wide = find(tables, 'co64');
    const chunks = wide ?? need(tables, 'stco');
    const chunkCount = view.getUint32(chunks.body + 4);
    const samples = [];
    for (let chunk = 1, run = 0; chunk <= chunkCount && samples.length < count; chunk += 1) {
      while (run + 1 < runs.length && runs[run + 1].first <= chunk) run += 1;
      let offset = wide
        ? view.getUint32(chunks.body + 8 + (chunk - 1) * 8) * 2 ** 32 + view.getUint32(chunks.body + 12 + (chunk - 1) * 8)
        : view.getUint32(chunks.body + 8 + (chunk - 1) * 4);
      for (let i = 0; i < runs[run].per && samples.length < count; i += 1) {
        const size = fixed || view.getUint32(stsz.body + 12 + samples.length * 4);
        if (offset + size > bytes.length) throw new Error('a packet lies outside the file');
        samples.push({ offset, size });
        offset += size;
      }
    }
    if (samples.length !== count || count === 0) throw new Error('the packets could not all be found');
    return samples;
  }

  function children(from, to) {
    const found = [];
    for (let at = from; at + 8 <= to;) {
      let size = view.getUint32(at);
      let body = at + 8;
      if (size === 1) { size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12); body = at + 16; }
      else if (size === 0) size = to - at;
      if (size < 8 || at + size > to) break;
      found.push({ type: text(at + 4, 4), body, end: at + size });
      at += size;
    }
    return found;
  }

  function need(list, type) {
    const box = find(list, type);
    if (!box) throw new Error(`this mp4 has no ${type}`);
    return box;
  }

  function text(at, length) { return String.fromCharCode(...bytes.subarray(at, at + length)); }
}

/** The decoder's own configuration, three descriptors deep. */
function specific({ view, bytes }, esds) {
  let at = esds.body + 4;
  const tag = () => {
    const id = view.getUint8(at++);
    let size = 0;
    for (let i = 0; i < 4; i += 1) {
      const byte = view.getUint8(at++);
      size = (size << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { id, size };
  };
  if (tag().id !== 0x03) throw new Error('unreadable AAC description');
  // After the id and flags: an optional dependency, an optional address, an optional clock.
  const flags = view.getUint8(at + 2);
  at += 3 + (flags & 0x80 ? 2 : 0);
  if (flags & 0x40) at += 1 + view.getUint8(at);
  if (flags & 0x20) at += 2;
  if (tag().id !== 0x04) throw new Error('unreadable AAC description');
  at += 13;
  const info = tag();
  if (info.id !== 0x05 || info.size < 2) throw new Error('unreadable AAC description');
  return bytes.slice(at, at + info.size);
}

/** AAC packets decode to equal sizes, but the last may end with padding. */
function packetTiming({ view }, stts, timescale, sampleRate) {
  const runs = view.getUint32(stts.body + 4);
  if (runs < 1) throw new Error('the sound has no timing');
  let ticks = 0;
  for (let i = 0; i < runs; i++) {
    ticks += view.getUint32(stts.body + 8 + i * 8) * view.getUint32(stts.body + 12 + i * 8);
  }
  return {
    frames: Math.round(view.getUint32(stts.body + 12) * sampleRate / timescale),
    length: Math.round(ticks * sampleRate / timescale),
  };
}

/** Each packet's length in the track's ticks, from the runs of equal lengths. */
function sampleDurations({ view }, stts, count) {
  const durations = [];
  for (let i = 0, runs = view.getUint32(stts.body + 4); i < runs && durations.length < count; i++) {
    const [times, ticks] = [view.getUint32(stts.body + 8 + i * 8), view.getUint32(stts.body + 12 + i * 8)];
    for (let k = 0; k < times && durations.length < count; k++) durations.push(ticks);
  }
  if (durations.length !== count) throw new Error('the picture has no timing for every frame');
  return durations;
}

/** What the edit list drops from the front: the encoder's lead-in. */
function leadIn(mp4, trak, timescale, sampleRate) {
  const { view } = mp4;
  const edts = find(mp4.children(trak.body, trak.end), 'edts');
  const elst = edts ? find(mp4.children(edts.body, edts.end), 'elst') : null;
  if (!elst || view.getUint32(elst.body + 4) < 1) return 0;
  const start = view.getUint8(elst.body) === 1
    ? view.getInt32(elst.body + 16) * 2 ** 32 + view.getUint32(elst.body + 20)
    : view.getInt32(elst.body + 12);
  return start > 0 ? Math.round(start * sampleRate / timescale) : 0;
}

function find(list, type) { return list.find((box) => box.type === type) ?? null; }

function fail(message) { throw new Error(message); }

/** What kind of AAC, how fast and how many channels, from the description's first bits. */
function audioConfig(description) {
  const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  let at = 0;
  const bits = (count) => {
    let value = 0;
    for (let i = 0; i < count; i += 1, at += 1) value = (value << 1) | ((description[at >> 3] >> (7 - (at & 7))) & 1);
    return value;
  };
  const objectType = bits(5);
  const index = bits(4);
  const sampleRate = index === 15 ? bits(24) : RATES[index];
  const channels = bits(4);
  if (objectType !== 2 || !sampleRate) throw new Error('only plain AAC is read');
  return { objectType, sampleRate, channels };
}
