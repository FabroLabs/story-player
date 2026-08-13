/**
 * The player's front door — this file, `performers.mjs` and `urls.mjs` are the
 * shell, the part of the player that is not a version.
 *
 * It does the four things that must happen before anybody can know which
 * performer to run: read `?story=`, fetch the bundle, parse it, and ask
 * `performerFor` who plays it. Then it hands over — the performer receives a
 * story already parsed and a URL already resolved, and owns everything after,
 * including the begin click. `performStory` must settle at handover: anything
 * that fails later belongs to the performer's own surface, not to this one.
 */
import { performerFor } from './performers.mjs';
import { resolveStoryUrl } from './urls.mjs';

let handedOver = false;

// Subtitles are the shell's, not a version's: the toggle only shows and hides
// an element `index.html` owns, it needs no story, and wiring it here means a
// future `player/v1/` inherits it instead of re-implementing it. It is also
// live before handover, so a reader can turn them off while a bundle is still
// being fetched.
const SUBTITLES_KEY = 'storytime:subtitles';

wireSubtitleToggle();
dispatch().catch(showLoadError);

function wireSubtitleToggle() {
  const button = document.getElementById('subtitle-toggle');
  // The whole area, not the line inside it: the note that sits under the
  // subtitle reads "narration unavailable · read along", which is a lie the
  // moment there is nothing left to read along with.
  const area = document.getElementById('subtitle-area');
  if (!button || !area) return;

  // Default ON: a story nobody can hear is still followable, and somebody who
  // has never touched this button should get the narration written down.
  // `localStorage` can throw outright (private mode, file:// in some browsers)
  // and losing the preference must never cost the button.
  const stored = read(SUBTITLES_KEY);
  apply(stored !== 'off');

  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-pressed') !== 'true';
    apply(next);
    write(SUBTITLES_KEY, next ? 'on' : 'off');
  });

  function apply(on) {
    area.hidden = !on;
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'hide subtitles' : 'show subtitles');
  }
}

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // a preference that cannot be remembered is not a failure worth showing
  }
}

async function dispatch() {
  const params = new URLSearchParams(window.location.search);
  const storyPath = params.get('story');
  if (!storyPath) throw new Error('add ?story=build/…/story.json to choose a story');

  const storyUrl = resolveStoryUrl(storyPath, window.location.href);
  const response = await fetch(storyUrl);
  if (!response.ok) throw new Error(`story bundle request failed (${response.status})`);
  const story = await response.json();
  const assetBase = document.querySelector('meta[name="storytime-asset-base"]')?.content;

  const performer = performerFor(story);
  const { performStory } = await import(performer);
  // Handover is the moment the drawer starts existing, so the check that the
  // performer can actually be handed to belongs on this side of it — a module
  // that loads but exports nothing usable is still the shell's failure.
  if (typeof performStory !== 'function') {
    throw new Error(`performer ${performer} does not export performStory`);
  }

  handedOver = true;
  await performStory(story, { storyUrl, assetBase });
}

function showLoadError(error) {
  // First, and before any DOM: catching the rejection is what stops the browser
  // from printing it, and the drawer that would have held it belongs to a
  // performer that never loaded. The message alone is not the failure — a broken
  // module makes `import()` name the file it asked for, not the dependency that
  // actually failed, and only the stack tells them apart. If the writes below
  // throw on a stale index.html, this has already gone out.
  console.error(error);

  const status = document.getElementById('load-status');
  status.textContent = error.message;
  status.classList.add('is-error');
  document.getElementById('story-title').textContent = 'this story could not be opened';
  document.getElementById('start-button').disabled = true;

  // The event drawer is wired by the performer, so before handover there is
  // nothing behind the log button — and a bundle that never opened has no
  // playback to trace anyway. Offering a button that would do nothing is worse
  // than not offering it. After handover the drawer is live and holds this
  // failure: the performer logs what happens inside itself.
  if (!handedOver) document.getElementById('debug-toggle').hidden = true;
}
