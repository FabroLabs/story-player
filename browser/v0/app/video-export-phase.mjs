import { NARRATION_GRACE_MS } from '../policy.mjs';
import { clockText } from './controls.mjs';
import {
  VIDEO_FPS, VIDEO_SIZE, createAudioTap, createRecording, fileNameFor, saveVideoFile,
} from './video-export.mjs';

// The story stops on its last word, and the word is let finish rather than cut
// (`media-scheduler.mjs`). The take runs on this long over the held last frame
// so the file keeps it too.
const TAIL_MS = NARRATION_GRACE_MS;

/**
 * Saving the story as a video, from the press to the file.
 *
 * A take is the story played again from its start, muted in the room and heard
 * by the recording, with a pill at the top of the picture saying how far it has
 * got and offering to stop. The runtime does the playing (`beginExport`,
 * `endExport`); this file owns the recorder, the audio graph the take is heard
 * through, and the pill. A take follows the story: when the story pauses — the
 * viewer, a hold for a file, a hidden tab — the recording pauses with it, so the
 * file has no frozen stretch in it.
 *
 * From the ⋯ menu the finished file is offered — "video ready", and the tap
 * that saves it. A host calling `recordVideo` is handed the file instead and
 * keeps it itself.
 */
export function createVideoExport({
  elements, support, saving, download = null, runtime, begin, title, hostControls = false, globalObject = globalThis,
}) {
  const { status, item, canvas } = elements;
  let take = null;
  let offered = null;
  let shown = null;
  let destroyed = false;
  let snapshot = Object.freeze({ status: 'idle', tMs: 0, durationMs: 0, bytes: 0 });
  const document = status.root.ownerDocument ?? globalObject.document;
  const hidden = () => { if (document?.visibilityState === 'hidden') pause(); };
  document?.addEventListener?.('visibilitychange', hidden);
  globalObject.window?.addEventListener?.('pagehide', pause);
  item.hidden = hostControls || !(support.ok && saving);
  const onItem = () => { void record({ offer: true }).catch(() => {}); };
  const onAction = () => { void saveOffered(); };
  const onDismiss = () => {
    if (take) cancel();
    else closeStatus();
  };
  item.addEventListener('click', onItem);
  status.action.addEventListener('click', onAction);
  status.dismiss.addEventListener('click', onDismiss);

  return {
    canRecord: () => support.ok,
    record,
    cancel,
    pause,
    resume,
    state: () => snapshot,
    sync,
    endOfStory,
    active: () => take !== null,
    destroy,
  };

  /**
   * Record the story, and resolve with the mp4.
   *
   * Called from a press: the audio graph the take is heard through may only
   * start inside one, so it is built before anything is awaited.
   */
  async function record({ offer = false, onProgress = null, onChunk = null, signal = null } = {}) {
    if (destroyed) throw new Error('this player was destroyed');
    if (signal?.aborted) throw aborted();
    if (onProgress !== null && typeof onProgress !== 'function') throw new TypeError('onProgress must be a function');
    if (onChunk !== null && typeof onChunk !== 'function') throw new TypeError('onChunk must be a function');
    if (offer && onChunk) throw new TypeError('a streamed recording is kept by the host');
    if (document?.visibilityState === 'hidden') throw new Error('keep the app open while saving');
    if (!support.ok) throw new Error(support.reason);
    if (take) throw new Error('a video of this story is already being recorded');
    const player = runtime();
    if (!player) throw new Error('the story is not ready to be recorded yet');
    const Context = globalObject.AudioContext ?? globalObject.webkitAudioContext;
    const context = new Context();
    void Promise.resolve(context.resume?.()).catch(() => {});
    const tap = createAudioTap(context);
    tap.mute(true);
    const mine = {
      tap, recording: null, ending: false, failed: null, settle: null, onProgress,
      paused: false, tail: null, tailRemaining: TAIL_MS, tailStarted: 0, tailDone: null,
    };
    const finished = new Promise((resolve, reject) => { mine.settle = { resolve, reject }; });
    // Settled before anybody awaits it when the take is stopped while the story
    // is still being got ready; awaited below either way.
    finished.catch(() => {});
    take = mine;
    offered = null;
    item.disabled = true;
    signal?.addEventListener?.('abort', cancel, { once: true });
    emit(mine, 'preparing', { tMs: 0 });
    showStatus('recording', 'getting the story ready…');
    try {
      await Promise.race([
        player.beginExport({ output: tap, size: VIDEO_SIZE, onError: (error) => stop(mine, error) }),
        finished,
      ]);
      if (mine.failed) throw mine.failed;
      const video = canvas.captureStream(VIDEO_FPS).getVideoTracks();
      const stream = new globalObject.MediaStream([...video, ...tap.stream.getAudioTracks()]);
      mine.recording = createRecording(stream, {
        mimeType: support.mimeType, globalObject, onChunk, onError: (error) => stop(mine, error),
      });
      begin();
      if (mine.paused || document?.visibilityState === 'hidden') pause();
      sync();
      const blob = await finished;
      const file = onChunk
        ? { name: fileNameFor(title()), type: 'video/mp4', size: blob.size }
        : new globalObject.File([blob], fileNameFor(title()), { type: 'video/mp4' });
      emit(mine, 'ready');
      if (offer) offerFile(file);
      else closeStatus();
      return file;
    } catch (error) {
      mine.recording?.discard();
      emit(mine, error?.name === 'AbortError' ? 'cancelled' : 'failed', { message: error?.message });
      if (error?.name === 'AbortError') closeStatus();
      else showStatus('failed', 'the video could not be made');
      throw error;
    } finally {
      signal?.removeEventListener?.('abort', cancel);
      clearTail(mine);
      player.endExport();
      if (take === mine) take = null;
      tap.close();
      void Promise.resolve(context.close?.()).catch(() => {});
      item.disabled = false;
    }
  }

  /** The story moved, stopped or went on: the recording follows, and the pill says where it is. */
  function sync() {
    const mine = take;
    if (!mine?.recording || mine.failed) return;
    const player = runtime();
    if (!mine.ending && player.isPlaying() && document?.visibilityState !== 'hidden') mine.paused = false;
    if (!mine.paused && (mine.ending || player.isPlaying())) mine.recording.resume();
    else mine.recording.pause();
    emit(mine, mine.paused || (!mine.ending && !player.isPlaying()) ? 'paused' : mine.ending ? 'finishing' : 'recording');
    if (mine.ending) return;
    const { tMs, durationMs } = player.getState();
    showStatus('recording', `saving video · ${clockText(tMs)} / ${clockText(durationMs)}`);
  }

  /**
   * The story reached its end inside a take: the last frame is held for the
   * tail, then the file is written. What the runtime would otherwise play here
   * — an end card, a bedtime wind-down — is not part of the take, and is not
   * played after it either. Answers `null` outside a take.
   */
  function endOfStory() {
    const mine = take;
    if (!mine?.recording || mine.failed) return null;
    if (mine.ending) return mine.tailDone?.promise ?? null;
    mine.ending = true;
    showStatus('recording', 'finishing the video…');
    const promise = new Promise((resolve) => { mine.tailDone = { resolve }; });
    mine.tailDone.promise = promise;
    runTail(mine);
    return promise;
  }

  function runTail(mine) {
    if (mine.failed || mine.paused || mine.tail !== null) return;
    mine.recording.resume();
    emit(mine, 'finishing');
    mine.tailStarted = now();
    mine.tail = globalObject.setTimeout(async () => {
      mine.tail = null;
      try { mine.settle.resolve(await mine.recording.finish()); }
      catch (error) { stop(mine, error); }
      finally { mine.tailDone?.resolve(); }
    }, mine.tailRemaining);
  }

  function clearTail(mine) {
    if (mine.tail !== null) {
      globalObject.clearTimeout(mine.tail);
      mine.tail = null;
      mine.tailRemaining = Math.max(0, mine.tailRemaining - (now() - mine.tailStarted));
    }
  }

  function pause() {
    const mine = take;
    if (!mine || mine.failed) return;
    mine.paused = true;
    clearTail(mine);
    if (runtime()?.pauseExport) runtime().pauseExport();
    else runtime()?.pause();
    mine.recording?.pause();
    emit(mine, 'paused');
  }

  function resume() {
    const mine = take;
    if (!mine || mine.failed || document?.visibilityState === 'hidden') return;
    mine.paused = false;
    if (!mine.recording) return;
    if (mine.ending) { runtime()?.resumeExportTail(); runTail(mine); }
    else runtime()?.play();
    sync();
  }

  function emit(mine, status, extra = {}) {
    const state = runtime()?.getState() ?? {};
    snapshot = Object.freeze({
      status, tMs: state.tMs ?? 0, durationMs: state.durationMs ?? 0,
      bytes: mine.recording?.bytes() ?? 0, ...extra,
    });
    try { mine.onProgress?.(snapshot); } catch { /* host presentation cannot break the file */ }
  }

  function now() { return globalObject.performance?.now?.() ?? Date.now(); }

  function cancel() {
    if (take) stop(take, aborted());
  }

  /** The take is over without a file: stopped by the viewer, or failed. */
  function stop(mine, error) {
    if (mine.failed) return;
    mine.failed = error;
    clearTail(mine);
    mine.tailDone?.resolve();
    mine.recording?.discard();
    runtime()?.pause();
    mine.settle.reject(error);
  }

  function offerFile(file) {
    offered = file;
    showStatus('ready', 'video ready');
  }

  /** The press that asks for the file: a share or a download needs a fresh one. */
  async function saveOffered() {
    const file = offered;
    if (!file) return;
    try {
      await saveVideoFile(file, { download, container: status.root, globalObject });
      closeStatus();
    } catch (error) {
      // The share sheet was closed: the file is still here, and so is its button.
      if (error?.name === 'AbortError') return;
      offered = null;
      showStatus('failed', 'the video could not be saved');
    }
  }

  function showStatus(kind, text) {
    status.root.hidden = hostControls;
    status.root.classList.toggle('is-ready', kind === 'ready');
    status.root.classList.toggle('is-failed', kind === 'failed');
    status.action.hidden = kind !== 'ready';
    status.dismiss.textContent = kind === 'recording' ? 'cancel' : 'close';
    if (text === shown) return;
    shown = text;
    status.label.textContent = text;
  }

  function closeStatus() {
    offered = null;
    shown = null;
    status.root.hidden = true;
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    document?.removeEventListener?.('visibilitychange', hidden);
    globalObject.window?.removeEventListener?.('pagehide', pause);
    if (take) stop(take, aborted());
    offered = null;
    item.removeEventListener('click', onItem);
    status.action.removeEventListener('click', onAction);
    status.dismiss.removeEventListener('click', onDismiss);
  }
}

function aborted() {
  return new DOMException('the recording was stopped', 'AbortError');
}
