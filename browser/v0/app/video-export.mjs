/**
 * A story, saved as a video file: whether this device can record it, the one
 * audio path every sound goes through while it does, the recording itself, and
 * where the finished file goes.
 *
 * The recording is the performance played again from its start. The stage
 * canvas is backed at `VIDEO_SIZE` and captured as it is drawn, every audio
 * element the story opens is routed through one Web Audio graph, and a
 * `MediaRecorder` writes the two together into an mp4. So it takes as long as
 * the story. The export stage composites performance scenes, lesson boards or
 * legacy video plates, with captions and the brand mark.
 */

export const VIDEO_SIZE = Object.freeze({ width: 1280, height: 720 });
export const VIDEO_FPS = 24;
// H.264 with AAC first: the pair every phone's gallery plays. Then any mp4 the
// browser can make — a Chromium built without the licensed codecs makes VP9
// with Opus. A browser that can only make webm gets no button: the file is
// promised as an mp4.
export const MP4_TYPES = Object.freeze([
  'video/mp4;codecs=avc1.42E01F,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4;codecs=vp9,opus',
  'video/mp4',
]);
// About 13 MB a minute: a drawn picture compresses well, and the file is meant
// to be kept on a phone.
export const VIDEO_BITS_PER_SECOND = 1_600_000;
export const AUDIO_BITS_PER_SECOND = 96_000;
// The recorder emits once a second. Browser files remain in bounded memory;
// native hosts acknowledge bounded chunks without retaining the whole story.
const SLICE_MS = 1000;
export const EXPORT_CHUNK_BYTES = 512 * 1024;
export const EXPORT_QUEUE_BYTES = 8 * 1024 * 1024;
export const EXPORT_MEMORY_BYTES = 128 * 1024 * 1024;
// A link to a downloaded file is let go of once the download has surely begun.
const REVOKE_AFTER_MS = 60_000;

/**
 * The picture's bitrate for a file that has to fit in `limit` bytes.
 *
 * A take kept in memory has a ceiling, and a long story at the full rate would
 * reach it in its last minute, after all the waiting. So a long story is given
 * a little less per second rather than refused at the end; a take streamed to a
 * host (`limit` 0) has no ceiling and keeps the full rate.
 */
export function videoBitsFor(durationMs, limit) {
  if (!(limit > 0) || !(durationMs > 0)) return VIDEO_BITS_PER_SECOND;
  const fits = Math.floor(limit * 0.9 * 8 / (durationMs / 1000)) - AUDIO_BITS_PER_SECOND;
  return Math.max(300_000, Math.min(VIDEO_BITS_PER_SECOND, fits));
}

/**
 * Whether this story can be recorded here, and as which mp4.
 *
 * `{ ok: true, mimeType }`, or `{ ok: false, reason }` with the reason in words:
 * a host that draws its own controls is told why there is nothing to offer.
 */
export function recordingSupport({ story, board = null, stream = null, globalObject = globalThis }) {
  if (stream) return refused('a story that is still being written cannot be saved as a video');
  const Recorder = globalObject.MediaRecorder;
  if (typeof Recorder !== 'function' || typeof globalObject.MediaStream !== 'function') {
    return refused('this browser cannot record video');
  }
  if (typeof globalObject.HTMLCanvasElement?.prototype?.captureStream !== 'function') {
    return refused('this browser cannot record its canvas');
  }
  const Context = globalObject.AudioContext ?? globalObject.webkitAudioContext;
  if (typeof Context?.prototype?.createMediaStreamDestination !== 'function'
    || typeof Context.prototype.createMediaElementSource !== 'function') {
    return refused('this browser cannot record the story’s sound');
  }
  const mimeType = MP4_TYPES.find((type) => attempt(() => Recorder.isTypeSupported(type)) === true);
  if (!mimeType) return refused('this browser cannot record an mp4');
  return { ok: true, mimeType, reason: null };
}

/**
 * Whether a finished file can be kept here.
 *
 * A host that passes `download` keeps it itself. Otherwise the player offers the
 * phone's share sheet or a download — except inside an Android app's webview,
 * which has neither: its share is absent and a download of an in-memory file
 * reaches the app as a link it cannot open. That app passes `download`.
 */
export function savingSupported({ download = null, globalObject = globalThis } = {}) {
  if (typeof download === 'function') return true;
  return !isAndroidWebView(globalObject.navigator?.userAgent);
}

/**
 * The one way out for every sound while a recording is made.
 *
 * Each audio element the story opens is created here, fetched with CORS — a
 * cross-origin file the graph reads without it is heard as silence — and
 * connected both to the speakers and to `stream`, which the recorder takes. The
 * speakers have their own gain, so a recording can run with the room quiet.
 * An element the story has let go of (no `src` left) is disconnected the next
 * time one is opened, so a long story does not grow a graph of dead voices.
 */
export function createAudioTap(context) {
  const speakers = context.createGain();
  speakers.connect(context.destination);
  const capture = context.createMediaStreamDestination();
  const routed = new Map();
  return {
    stream: capture.stream,
    mute(on) {
      speakers.gain.value = on ? 0 : 1;
    },
    audio(src) {
      sweep();
      const media = new globalThis.Audio();
      media.crossOrigin = 'anonymous';
      if (src !== undefined) media.src = src;
      const node = context.createMediaElementSource(media);
      node.connect(speakers);
      node.connect(capture);
      routed.set(media, node);
      return media;
    },
    close() {
      for (const node of routed.values()) node.disconnect();
      routed.clear();
      speakers.disconnect();
    },
  };

  function sweep() {
    for (const [media, node] of routed) {
      if (media.getAttribute?.('src')) continue;
      node.disconnect();
      routed.delete(media);
    }
  }
}

/**
 * One take: the stream recorded into memory a slice at a time.
 *
 * `pause` and `resume` follow the story — a viewer's pause, a hold for a file,
 * a hidden tab — so the file has no frozen stretch where the story stood still.
 * `finish` resolves with the whole recording; `discard` throws it away. A
 * recorder that fails mid-take says so through `onError`, once.
 */
export function createRecording(stream, {
  mimeType, onError = () => {}, onChunk = null, globalObject = globalThis,
  memoryLimit = EXPORT_MEMORY_BYTES, queueLimit = EXPORT_QUEUE_BYTES, durationMs = 0,
}) {
  if (onChunk !== null && typeof onChunk !== 'function') throw new TypeError('onChunk must be a function');
  let recorder;
  try {
    recorder = new globalObject.MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: videoBitsFor(durationMs, onChunk ? 0 : memoryLimit),
      audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
    });
  } catch (error) {
    endTracks();
    throw error;
  }
  const chunks = [];
  let failure = null;
  let discarded = false;
  let completed = false;
  let bytes = 0;
  let queued = 0;
  let index = 0;
  let writes = Promise.resolve();
  const stopped = new Promise((resolve) => {
    recorder.addEventListener('stop', resolve, { once: true });
  });
  recorder.addEventListener('dataavailable', (event) => {
    if (discarded || failure || completed || !(event.data?.size > 0)) return;
    const data = event.data;
    bytes += data.size;
    if (!onChunk) {
      if (bytes > memoryLimit) return fail(new Error('this video exceeds the browser’s memory limit'));
      chunks.push(data);
      return;
    }
    queued += data.size;
    if (queued > queueLimit) return fail(new Error('the device could not save video data fast enough'));
    // Serial, bounded pieces: native hosts acknowledge each write before the
    // next. No base64 copy or full-story Blob is retained in the WebView.
    writes = writes.then(async () => {
      for (let offset = 0; offset < data.size; offset += EXPORT_CHUNK_BYTES) {
        if (discarded || failure) return;
        await onChunk(data.slice(offset, offset + EXPORT_CHUNK_BYTES), index++);
      }
    }).catch(fail).finally(() => { queued -= data.size; });
  });
  recorder.addEventListener('error', (event) => {
    fail(event?.error ?? new Error('the recording failed'));
  });
  try { recorder.start(SLICE_MS); }
  catch (error) { discarded = true; endTracks(); throw error; }
  return {
    pause() {
      if (recorder.state === 'recording') recorder.pause();
    },
    resume() {
      if (recorder.state === 'paused') recorder.resume();
    },
    async finish() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      await writes;
      endTracks();
      if (failure) throw failure;
      if (discarded) throw new DOMException('the recording was stopped', 'AbortError');
      if (bytes === 0) throw new Error('the recording came back empty');
      completed = true;
      if (onChunk) return { size: bytes, type: 'video/mp4' };
      return new Blob(chunks, { type: 'video/mp4' });
    },
    discard() {
      discarded = true;
      chunks.length = 0;
      if (recorder.state !== 'inactive') recorder.stop();
      endTracks();
    },
    bytes: () => bytes,
  };

  function fail(error) {
    if (failure || discarded || completed) return;
    failure = error;
    chunks.length = 0;
    if (recorder.state !== 'inactive') recorder.stop();
    endTracks();
    onError(error);
  }

  function endTracks() {
    for (const track of stream.getTracks()) track.stop();
  }
}

/** The story's title as a file name a phone and a desktop will both take. */
export function fileNameFor(title) {
  const name = String(title ?? '')
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return `${name || 'story'}.mp4`;
}

/**
 * Hand the finished file to whoever keeps it.
 *
 * The host, when it passed `download`. Otherwise a phone's share sheet, which is
 * the only way into an iPhone's photos (its Save Video), and a download
 * everywhere else: Android keeps it in Downloads, where its gallery finds it,
 * and a desktop has a downloads folder. Both need a fresh tap — a share or a
 * download minutes after the press that started the recording is refused — so
 * this is called from the press that asks for the file, never at the end of the
 * recording. A share the viewer closed rejects with `AbortError`.
 */
export async function saveVideoFile(file, { download = null, container, globalObject = globalThis }) {
  if (typeof download === 'function') {
    await download(file);
    return;
  }
  const navigator = globalObject.navigator;
  if (prefersShareSheet(globalObject) && attempt(() => navigator.canShare?.({ files: [file] })) === true) {
    await navigator.share({ files: [file], title: file.name.replace(/\.mp4$/, '') });
    return;
  }
  const url = globalObject.URL.createObjectURL(file);
  const link = container.ownerDocument.createElement('a');
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  container.append(link);
  link.click();
  link.remove();
  globalObject.setTimeout(() => globalObject.URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

function prefersShareSheet(globalObject) {
  const coarse = attempt(() => globalObject.matchMedia?.('(pointer: coarse)')?.matches) === true;
  return coarse && !/\bAndroid\b/.test(globalObject.navigator?.userAgent ?? '');
}

/** Android's system webview names itself `wv` beside the Android version. */
function isAndroidWebView(userAgent) {
  return /\bAndroid\b/.test(userAgent ?? '') && /\bwv\b/.test(userAgent ?? '');
}

function refused(reason) {
  return { ok: false, mimeType: null, reason };
}

function attempt(work) {
  try {
    return work();
  } catch {
    return undefined;
  }
}
