import { firstPaintAssets, preload, queueRemainingScenes } from './asset-preloader.mjs';
import { AudioDirector } from './directors/audio-director.mjs';
import { StoryClock } from './clock.mjs';
import { DebugPanel, ObservableEventLog } from './debug-panel.mjs';
import { PlaybackDirector } from './directors/playback-director.mjs';
import { StageRenderer } from './stage/stage-renderer.mjs';
import { resolveStoryAssets } from './urls.mjs';
import { routeWarning } from './warning-router.mjs';

const dom = collectDom();
const params = new URLSearchParams(window.location.search);
const debug = new DebugPanel(dom.debug, params.get('debug') === '1');
const clock = new StoryClock();
const log = new ObservableEventLog(clock, (entry, entries) => debug.addEntry(entry, entries));
let playback = null;

/**
 * Perform a v0 bundle. `player/shell/main.mjs` has already read the version off it
 * and chosen this module; the story arrives parsed and the URL resolved, so
 * there is nothing left here to fetch or to doubt. Returns once the begin click
 * is armed — the shell's error surface is for the load, not for the story.
 */
export function performStory(story, { storyUrl, assetBase }) {
  try {
    // Project the whole bundle once, before any consumer exists. Every
    // preloader, renderer and recovery path then sees the exact same URL.
    const runtimeStory = resolveStoryAssets(story, assetBase);
    document.title = runtimeStory.title ? `${runtimeStory.title} · storytime` : 'storytime';
    dom.title.textContent = runtimeStory.title ?? 'tonight’s story';

    let director;
    const warn = (detail) => routeWarning(detail, director, log);
    const stage = new StageRenderer(dom.stage, warn);
    const audio = new AudioDirector(runtimeStory.audio, warn);
    director = new PlaybackDirector({ story: runtimeStory, storyUrl, stage, audio, clock, log });
    playback = { director, stage, audio, story: runtimeStory };

    // The begin button waits for the first scene's sheets. Before this the
    // story started instantly and then assembled itself on screen — every
    // sheet fetched the moment a clip first needed it, which on a slow link
    // means the first minute is a slideshow of half-drawn characters. A story
    // that starts three seconds later and then plays whole is the better
    // trade, and it is the only one a viewer can see.
    armStart(runtimeStory);
  } catch (error) {
    // The drawer belongs to this module, and by now it is live. The shell will
    // paint the message; a failure that happened in here must also leave the
    // structured trace anyone debugging it will go looking for — but the
    // report writes DOM of its own, so it is never allowed to become the
    // error. If the drawer is the thing that broke, the real cause still gets
    // out.
    try {
      log.warning({ type: 'bundle', message: error.message });
    } catch { /* the original error is the one worth having */ }
    throw error;
  }
}

async function armStart(story) {
  const urls = firstPaintAssets(story, story.scenes?.[0]);
  dom.start.disabled = true;
  try {
    await preload(urls, {
      onProgress: (done, total) => {
        dom.status.textContent = total
          ? `loading the opening… ${done}/${total}`
          : 'ready when you are';
      },
    });
  } catch (error) {
    // Never a reason not to start: `preload` already swallows a broken asset,
    // so reaching here means something stranger — and a story that will not
    // begin is worse than one that begins with a gap in it.
    log.warning({ type: 'media', asset: 'preload', message: error.message });
  }
  dom.status.textContent = 'ready when you are';
  dom.start.disabled = false;
  dom.start.addEventListener('click', startStory, { once: true });
}

async function startStory() {
  dom.start.disabled = true;
  dom.status.textContent = 'opening the story…';
  void playback.audio.unlock();
  clock.start();
  playback.stage.startAnimation();
  dom.ceremony.classList.add('is-gone');
  // Everything after scene 1, one scene at a time, while scene 1 plays. Not
  // awaited: it is a cache warm, and the story must never wait on it.
  void queueRemainingScenes(playback.story, {
    onScene: (index, count) => log.append({
      scene_index: index, line: null, kind: 'note',
      detail: { type: 'media', asset: 'preload', scene: index, assets: count },
    }),
  });

  try {
    await playback.director.play();
  } catch (error) {
    playback.director.warning({ type: 'playback', message: error.message });
    dom.ceremony.classList.remove('is-gone');
    dom.title.textContent = 'the story paused';
    dom.status.textContent = 'open the event log for details';
    dom.status.classList.add('is-error');
  }
}

function collectDom() {
  const byId = (id) => document.getElementById(id);
  return {
    title: byId('story-title'),
    status: byId('load-status'),
    start: byId('start-button'),
    ceremony: byId('start-ceremony'),
    stage: {
      frame: byId('stage-frame'),
      stage: byId('logical-stage'),
      camera: byId('camera-layer'),
      plate: byId('plate-layer'),
      poster: byId('plate-poster'),
      video: byId('plate-video'),
      sprites: byId('sprite-layer'),
      subtitle: byId('subtitle'),
      mediaNote: byId('media-note'),
      end: byId('end-overlay'),
    },
    debug: {
      panel: byId('debug-panel'),
      toggle: byId('debug-toggle'),
      close: byId('debug-close'),
      copy: byId('copy-log'),
      download: byId('download-log'),
      list: byId('event-list'),
      status: byId('debug-status'),
    },
  };
}
