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
  elements, support, saving, download = null, runtime, begin, title, globalObject = globalThis,
}) {
  const { status, item, canvas } = elements;
  let take = null;
  let offered = null;
  let shown = null;
  let destroyed = false;
  item.hidden = !(support.ok && saving);
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
  async function record({ offer = false } = {}) {
    if (destroyed) throw new Error('this player was destroyed');
    if (!support.ok) throw new Error(support.reason);
    if (take) throw new Error('a video of this story is already being recorded');
    const player = runtime();
    if (!player) throw new Error('the story is not ready to be recorded yet');
    const Context = globalObject.AudioContext ?? globalObject.webkitAudioContext;
    const context = new Context();
    void Promise.resolve(context.resume?.()).catch(() => {});
    const tap = createAudioTap(context);
    tap.mute(true);
    const mine = { tap, recording: null, ending: false, failed: null, settle: null };
    const finished = new Promise((resolve, reject) => { mine.settle = { resolve, reject }; });
    // Settled before anybody awaits it when the take is stopped while the story
    // is still being got ready; awaited below either way.
    finished.catch(() => {});
    take = mine;
    offered = null;
    item.disabled = true;
    showStatus('recording', 'getting the story ready…');
    try {
      await player.beginExport({ output: tap, size: VIDEO_SIZE });
      if (mine.failed) throw mine.failed;
      const video = canvas.captureStream(VIDEO_FPS).getVideoTracks();
      const stream = new globalObject.MediaStream([...video, ...tap.stream.getAudioTracks()]);
      mine.recording = createRecording(stream, {
        mimeType: support.mimeType, globalObject, onError: (error) => stop(mine, error),
      });
      begin();
      sync();
      const blob = await finished;
      const file = new globalObject.File([blob], fileNameFor(title()), { type: 'video/mp4' });
      if (offer) offerFile(file);
      else closeStatus();
      return file;
    } catch (error) {
      mine.recording?.discard();
      if (error?.name === 'AbortError') closeStatus();
      else showStatus('failed', 'the video could not be made');
      throw error;
    } finally {
      if (take === mine) take = null;
      player.endExport();
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
    if (mine.ending || player.isPlaying()) mine.recording.resume();
    else mine.recording.pause();
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
    mine.ending = true;
    mine.recording.resume();
    showStatus('recording', 'finishing the video…');
    return new Promise((resolve) => { globalObject.setTimeout(resolve, TAIL_MS); })
      .then(() => mine.recording.finish())
      .then((blob) => mine.settle.resolve(blob), (error) => stop(mine, error));
  }

  function cancel() {
    if (take) stop(take, aborted());
  }

  /** The take is over without a file: stopped by the viewer, or failed. */
  function stop(mine, error) {
    if (mine.failed) return;
    mine.failed = error;
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
    status.root.hidden = false;
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
