/**
 * Where the sound is inside an m4a.
 *
 * A fast take mixes the story's sound itself, and a bed can be twenty minutes
 * of which the story hears eighteen seconds. Decoding the whole file to find
 * them costs hundreds of megabytes; this reads the file's own table of
 * contents instead, so only the packets a moment needs are decoded.
 *
 * It reads the one shape the engine writes — AAC in an ordinary, unfragmented
 * mp4 — and refuses anything else by throwing, which sends the take back to
 * the recording it was before. Pure: bytes in, a description out.
 */

/**
 * `{ codec, sampleRate, channels, description, skip, samples }`.
 *
 * `samples` is every packet as `{ offset, size }` into the same bytes, each
 * `frames` sound samples long. `skip` is how many samples the file's own edit
 * list drops from the start: an AAC encoder's lead-in, which is not the sound.
 */
export function readM4a(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = find(children(0, bytes.length), 'moov');
  if (!moov) throw new Error('not an mp4 with a table of contents');
  for (const trak of children(moov.body, moov.end).filter((box) => box.type === 'trak')) {
    const mdia = find(children(trak.body, trak.end), 'mdia');
    const inMedia = mdia ? children(mdia.body, mdia.end) : [];
    const hdlr = find(inMedia, 'hdlr');
    if (!hdlr || text(hdlr.body + 8, 4) !== 'soun') continue;
    return track(trak, inMedia);
  }
  throw new Error('no sound track in this mp4');

  function track(trak, inMedia) {
    const mdhd = need(inMedia, 'mdhd');
    const timescale = view.getUint32(mdhd.body + (view.getUint8(mdhd.body) === 1 ? 20 : 12));
    const minf = need(inMedia, 'minf');
    const stbl = need(children(minf.body, minf.end), 'stbl');
    const tables = children(stbl.body, stbl.end);
    const stsd = need(tables, 'stsd');
    const entry = children(stsd.body + 8, stsd.end)[0];
    if (entry?.type !== 'mp4a') throw new Error(`the sound is ${entry?.type ?? 'nothing'}, not AAC`);
    // A sound entry is 28 bytes of fields before its own boxes; QuickTime's
    // older second version of it keeps sixteen more.
    const version = view.getUint16(entry.body + 8);
    const esds = need(children(entry.body + 28 + (version === 1 ? 16 : 0), entry.end), 'esds');
    const description = specific(esds);
    const config = audioConfig(description);
    const frames = packetFrames(need(tables, 'stts'), timescale, config.sampleRate);
    return {
      codec: `mp4a.40.${config.objectType}`,
      sampleRate: config.sampleRate,
      channels: config.channels || view.getUint16(entry.body + 16),
      description,
      frames,
      skip: leadIn(trak, timescale, config.sampleRate),
      samples: packets(tables),
    };
  }

  /** The decoder's own configuration, three descriptors deep. */
  function specific(esds) {
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
        if (offset + size > bytes.length) throw new Error('a sound packet lies outside the file');
        samples.push({ offset, size });
        offset += size;
      }
    }
    if (samples.length !== count || count === 0) throw new Error('the sound packets could not all be found');
    return samples;
  }

  /** How long a packet is, which for AAC is one number for the whole file. */
  function packetFrames(stts, timescale, sampleRate) {
    if (view.getUint32(stts.body + 4) < 1) throw new Error('the sound has no timing');
    return Math.round(view.getUint32(stts.body + 12) * sampleRate / timescale);
  }

  /** What the edit list drops from the front: the encoder's lead-in. */
  function leadIn(trak, timescale, sampleRate) {
    const edts = find(children(trak.body, trak.end), 'edts');
    const elst = edts ? find(children(edts.body, edts.end), 'elst') : null;
    if (!elst || view.getUint32(elst.body + 4) < 1) return 0;
    const start = view.getUint8(elst.body) === 1
      ? view.getInt32(elst.body + 16) * 2 ** 32 + view.getUint32(elst.body + 20)
      : view.getInt32(elst.body + 12);
    return start > 0 ? Math.round(start * sampleRate / timescale) : 0;
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

function find(list, type) { return list.find((box) => box.type === type) ?? null; }

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

/** Whether these bytes begin as an mp4 does. */
export function looksLikeMp4(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  return bytes.length > 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp';
}
