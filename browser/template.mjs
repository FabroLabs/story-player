const STYLESHEET = new URL('./styles.css', import.meta.url).href;
// The line over the story's name in the opening ceremony. A host that mounts
// something other than a bedtime story — a counting lesson, say — says so with
// `kicker`; anything that is not a string with words in it is a host's mistake,
// and the bedtime line is the one every story in this player can honestly wear.
const KICKER = 'a bedtime story';

export function createPlayerTemplate(root, { stylesheet = STYLESHEET, kicker, chrome, board } = {}) {
  const document = root.ownerDocument ?? globalThis.document;
  const link = element(document, 'link', { rel: 'stylesheet', href: stylesheet });
  // No chrome of our own above the picture: what a site embeds is a rectangle
  // of video. The ⋯ menu and full screen sit together at the right of the
  // control bar, where every video player keeps them; closing and casting
  // belong to the page that mounted us. Subtitles are a row of that menu.
  const subtitles = element(document, 'button', {
    className: 'menu-item cc-button', type: 'button', 'aria-label': 'hide subtitles', 'aria-pressed': 'true',
  }, [
    element(document, 'span', { className: 'cc-mark', text: 'cc', 'aria-hidden': 'true' }),
    element(document, 'span', { className: 'menu-label', text: 'subtitles' }),
  ]);
  // Withdrawn until something can fill the screen: the host, or the browser.
  const fullscreen = element(document, 'button', {
    className: 'round-button fullscreen-button', type: 'button', 'aria-label': 'full screen', 'aria-pressed': 'false',
    hidden: '',
  }, [glyph(document)]);
  fullscreen.hidden = true;
  const debugToggle = element(document, 'button', {
    className: 'quiet-button', type: 'button', 'aria-label': 'open event log', 'aria-expanded': 'false',
  }, [element(document, 'span', { text: 'log', 'aria-hidden': 'true' })]);
  const poster = element(document, 'div', { className: 'plate-poster' });
  // `preload="auto"`: the plate is asked to play the instant its source is set,
  // so waiting for a readiness event before fetching would cost every scene
  // opening a round trip. The plate layer is what the camera transforms — the
  // poster and the video move together, under the canvas.
  const video = element(document, 'video', { className: 'plate-video', muted: '', loop: '', playsinline: '', preload: 'auto' });
  video.muted = true;
  video.loop = true;
  const plate = element(document, 'div', { className: 'plate-layer' }, [poster, video]);
  // One canvas for the whole cast. It is hidden from assistive technology on
  // purpose: its content changes twenty-four times a second and carries no text,
  // and what a screen reader needs from a story is the subtitle area below,
  // which is a live region.
  const canvas = element(document, 'canvas', { className: 'stage-canvas', 'aria-hidden': 'true' });
  const stage = element(document, 'div', { className: 'logical-stage' }, [
    plate,
    canvas,
    element(document, 'div', { className: 'stage-vignette', 'aria-hidden': 'true' }),
  ]);
  const title = element(document, 'h1', { text: 'preparing your story…' });
  const start = element(document, 'button', { className: 'start-button', type: 'button', disabled: '' }, [
    glyph(document),
    // Read out, not shown: the round button is the web app's opening, and a
    // play mark is the one word every child already knows.
    element(document, 'span', { className: 'start-label', text: 'begin story' }),
  ]);
  start.disabled = true;
  const status = element(document, 'p', { className: 'load-status', role: 'status', text: 'loading the story bundle' });
  const ceremony = element(document, 'div', { className: 'start-ceremony' }, [
    element(document, 'div', { className: 'ceremony-glow', 'aria-hidden': 'true' }),
    element(document, 'p', { className: 'eyebrow', text: eyebrowText(kicker) }), title, start, status,
  ]);
  const subtitle = element(document, 'p', { className: 'subtitle' });
  const mediaNote = element(document, 'p', { className: 'media-note' });
  const subtitleArea = element(document, 'div', {
    className: 'subtitle-wrap', 'aria-live': 'polite', 'aria-atomic': 'true',
  }, [subtitle, mediaNote]);
  // Playback caught up with the writer. `role="status"` rather than a live
  // region of its own: it is announced once when it appears, and the sentence
  // is the whole of what a viewer waiting on a story needs to be told.
  const waiting = element(document, 'div', { className: 'waiting-overlay', role: 'status', hidden: '' }, [
    element(document, 'span', { className: 'waiting-spinner', 'aria-hidden': 'true' }),
    element(document, 'p', { text: 'the storyteller is still writing…' }),
  ]);
  waiting.hidden = true;
  // Sound or pictures the story has reached have not landed, and the story holds on its last frame
  // until they do. Only a spinner, and only after a moment: most holds end before it would show.
  const hold = element(document, 'div', { className: 'hold-overlay', role: 'status', 'aria-label': 'loading', hidden: '' }, [
    element(document, 'span', { className: 'waiting-spinner', 'aria-hidden': 'true' }),
  ]);
  hold.hidden = true;
  const recording = createRecordingStatus(document);
  const end = element(document, 'div', { className: 'end-overlay', hidden: '' }, [
    element(document, 'span', { className: board?.layout === 'lesson-guide' ? 'end-star' : 'end-moon',
      text: board?.layout === 'lesson-guide' ? '✦' : '', 'aria-hidden': 'true' }),
    element(document, 'p', { text: board?.layout === 'lesson-guide' ? 'Great exploring!' : 'the end' }),
    element(document, 'span', { text: board?.layout === 'lesson-guide' ? 'See you next time!' : 'sleep well' }),
  ]);
  end.hidden = true;
  const card = createCardLayer(document);
  const badge = createBadge(document);
  const bedtime = createBedtimeLayers(document);
  const controls = createControlBar(document, { subtitles, fullscreen });
  // The event log's button, over the picture and out of the transport's way.
  // The host's own chrome (close, cast, parental, overflow) continues this row
  // on the page that mounted us; the player never draws those.
  // Withdrawn until the story begins, like the transport: a button painted over
  // the opening ceremony is the first thing a Tab lands on.
  const actions = element(document, 'div', { className: 'stage-actions', hidden: '' }, [debugToggle]);
  actions.hidden = true;
  // The mark a click leaves in the middle of the picture: the same shape every
  // video player draws when the pointer, rather than the transport, changed the
  // story's mind. It never takes a pointer of its own — what is under it is the
  // picture, and the picture is the switch.
  const flashMark = element(document, 'span', { className: 'flash-mark' });
  const flash = element(document, 'div', { className: 'stage-flash', 'aria-hidden': 'true' }, [flashMark]);
  // `tabindex="-1"`: not a tab stop, but focusABLE — the keys are read here, so
  // when the overlay withdraws under a button a click left focused, the focus
  // is moved here rather than out of the player altogether.
  const frame = element(document, 'section', {
    className: 'stage-frame', 'aria-label': 'story stage', tabindex: '-1',
  }, [
    element(document, 'div', { className: 'stage-letterbox', 'aria-hidden': 'true' }),
    stage, bedtime.sky, bedtime.scrim, flash, badge.root, actions, ceremony, waiting, hold, subtitleArea, end,
    recording.root, controls.root, card.layer, card.title.layer,
  ]);
  const shell = element(document, 'main', { className: 'player-shell' }, [frame]);
  const debugClose = element(document, 'button', { className: 'icon-button', type: 'button', 'aria-label': 'close event log', text: '×' });
  const debugList = element(document, 'ol', { className: 'event-list' });
  const debugCopy = element(document, 'button', { type: 'button', text: 'copy json' });
  const debugDownload = element(document, 'button', { type: 'button', text: 'download' });
  const debugStatus = element(document, 'span', { className: 'debug-status', role: 'status' });
  // The perf section: the last thing measured, in one line, above the entries.
  // Hidden until something measures, so a player mounted without `perf: true`
  // shows no empty box where numbers would be.
  const debugPerf = element(document, 'p', { className: 'perf-summary', hidden: '' });
  debugPerf.hidden = true;
  const debugPanel = element(document, 'aside', {
    className: 'debug-panel', 'aria-label': 'event log', 'aria-hidden': 'true', inert: '',
  }, [
    element(document, 'header', {}, [
      element(document, 'div', {}, [
        element(document, 'p', { className: 'eyebrow', text: 'playback trace' }),
        element(document, 'h2', { text: 'event log' }),
      ]), debugClose,
    ]),
    element(document, 'div', { className: 'debug-actions' }, [debugCopy, debugDownload, debugStatus]),
    debugPerf,
    debugList,
  ]);
  debugPanel.setAttribute('inert', '');
  if (chrome === 'host') {
    for (const node of [ceremony, controls.root, actions, badge.root, end, recording.root]) node.style.display = 'none';
  }
  root.replaceChildren(link, shell, debugPanel);
  return {
    title, status, start, ceremony, subtitles, subtitleArea, debugToggle, badge, card,
    // `stage`, `actions` and `flash` are the transport's, not the renderer's:
    // the picture is the play switch, the mark is what a click leaves on it,
    // and the actions row appears with the bar when the story begins.
    controls: { ...controls, frame, stage, actions, flash },
    stage: { frame, stage, canvas, plate, poster, video, subtitle, mediaNote, waiting, hold, end },
    recording,
    // A bedtime story's two extras, drawn by the player so every host gets the
    // same ones: the moon's dimming, and the moonlit wind-down after the story.
    dimming: { frame, scrim: bedtime.scrim, buttons: [controls.dim] },
    windDown: {
      frame, sky: bedtime.sky, layer: bedtime.layer, picture: bedtime.picture, shade: bedtime.shade,
      toggle: controls.toggle,
      line: controls.windLine, fill: controls.windFill, times: controls.windTimes,
      stop: controls.stop, chip: controls.chip,
    },
    debug: {
      panel: debugPanel, toggle: debugToggle, close: debugClose, copy: debugCopy,
      download: debugDownload, list: debugList, status: debugStatus, perf: debugPerf,
    },
  };
}

/**
 * The layer the intro and end cards are performed on: a second `<video>`, the
 * story's name, and the one control either card has.
 *
 * A second element rather than the plate's: the plate is the ground the camera
 * transforms every frame and `video-plate.mjs` is the only file that touches it,
 * so a card borrowing it would be a second owner of the picture. This one sits
 * over everything, transport included, and is withdrawn between the cards.
 *
 * The skip is its own control for the same reason: the transport belongs to the
 * story's clock, is hidden until the story begins, and is dead while it is
 * hidden — a button that has to work before the story starts cannot live in it.
 */
function createCardLayer(document) {
  const video = element(document, 'video', {
    className: 'card-video', muted: '', playsinline: '', preload: 'auto',
  });
  video.muted = true;
  const line = element(document, 'p', { className: 'card-line' });
  const skip = element(document, 'button', {
    className: 'card-skip', type: 'button', 'aria-label': 'skip the opening',
  }, [element(document, 'span', { text: 'skip' })]);
  const layer = element(document, 'div', { className: 'card-layer', hidden: '' }, [video, line, skip]);
  layer.hidden = true;
  return { layer, video, line, skip, title: createTitleLayer(document) };
}

/**
 * The intro card's title beat, on a layer of its own ABOVE the card.
 *
 * Above it and outside it, which is the whole reason this is a second element:
 * the curtain fades the card away from underneath the name, and the name stays
 * on over the story's first seconds before going on its own slower fade. Put
 * inside `.card-layer` it would leave with the film it was raised over.
 *
 * It takes no pointer — there is nothing on it to press, and the transport
 * underneath is live again the moment the story begins. The canvas is hidden
 * from assistive technology for the reason the stage's is: it changes many
 * times a second and carries no text. The name beside it is the text.
 */
function createTitleLayer(document) {
  const canvas = element(document, 'canvas', { className: 'card-title-sprite', 'aria-hidden': 'true' });
  const name = element(document, 'p', { className: 'card-title-name' });
  const layer = element(document, 'div', { className: 'card-title', hidden: '' }, [canvas, name]);
  layer.hidden = true;
  return { layer, canvas, name };
}

/**
 * The story's own name, over the picture, where the mockup puts it — not in a
 * bar above the stage. An embedded player has no header, so anything the viewer
 * should read while the story plays is drawn on the stage or nowhere.
 */
function createBadge(document) {
  const name = element(document, 'p', { className: 'story-name' });
  const root = element(document, 'div', { className: 'story-badge' }, [name]);
  return { root, name };
}

/**
 * A bedtime story's layers over the picture: the moonlit sky its wind-down
 * comes up on, and the moon's scrim — under the captions and the controls, so
 * the picture darkens and the words do not.
 */
function createBedtimeLayers(document) {
  // The sky comes up over its base colour: the ground is opaque from the first
  // instant, and the layer on it is what the reveal fades in.
  const picture = element(document, 'img', { className: 'sky-picture', alt: '', decoding: 'async' });
  const shade = element(document, 'span', { className: 'sky-shade' });
  const layer = element(document, 'div', { className: 'sky-layer' }, [picture, shade]);
  const sky = element(document, 'div', { className: 'sky', 'aria-hidden': 'true', hidden: '' }, [layer]);
  sky.hidden = true;
  const scrim = element(document, 'span', { className: 'stage-dim', 'aria-hidden': 'true' });
  return { sky, layer, picture, shade, scrim };
}

/**
 * The story being saved as a video, over the picture and out of the dock's way:
 * how far the recording has got with a way to stop it, then the finished file
 * with the tap that saves it. One element whose words change, so the corner a
 * viewer is watching never moves.
 */
function createRecordingStatus(document) {
  const label = element(document, 'span', { className: 'recording-label' });
  const action = element(document, 'button', { className: 'recording-action', type: 'button', hidden: '' }, [
    glyph(document), element(document, 'span', { text: 'save video' }),
  ]);
  action.hidden = true;
  const dismiss = element(document, 'button', { className: 'recording-dismiss', type: 'button' });
  const root = element(document, 'div', { className: 'recording-status', role: 'status', hidden: '' }, [
    element(document, 'span', { className: 'recording-dot', 'aria-hidden': 'true' }), label, action, dismiss,
  ]);
  root.hidden = true;
  return { root, label, action, dismiss };
}

/**
 * The control bar: position, transport, the ⋯ menu and full screen.
 *
 * The scrub is a `div` with `role="slider"` rather than an `<input type=range>`
 * because the fill and the handle are drawn from one fraction the runtime
 * already has, and a range input would need its own value plumbing to say the
 * same thing. Everything a pointer can do here, the keyboard can do too — the
 * handlers live in `v0/app/controls.mjs`.
 *
 * The web app's watch dock: play and the two skips, the line with its times,
 * then the ⋯ menu — subtitles, the bedtime moon, saving the story as a video —
 * and full screen; under them the bedside row, the wind-down's Stop and the
 * word the quiet after it ends on. Where they stand — one row on a big player,
 * two on a phone — is the stylesheet's, read off the player's own size.
 */
function createControlBar(document, { subtitles, fullscreen }) {
  const fill = element(document, 'div', { className: 'scrub-fill' });
  const handle = element(document, 'div', { className: 'scrub-handle' });
  const scrub = element(document, 'div', {
    className: 'scrub',
    role: 'slider',
    tabindex: '0',
    'aria-label': 'story position',
    'aria-valuemin': '0',
    'aria-valuemax': '0',
    'aria-valuenow': '0',
  }, [fill, handle]);
  const at = element(document, 'span', { className: 'time-at', text: '0:00' });
  const total = element(document, 'span', { className: 'time-total', text: '0:00' });
  const toggle = element(document, 'button', {
    className: 'round-button play-button', type: 'button', 'aria-label': 'play', disabled: '',
  }, [glyph(document)]);
  toggle.disabled = true;
  const back = element(document, 'button', {
    className: 'round-button skip-back', type: 'button', 'aria-label': 'back ten seconds',
  }, [glyph(document)]);
  const forward = element(document, 'button', {
    className: 'round-button skip-forward', type: 'button', 'aria-label': 'forward ten seconds',
  }, [glyph(document)]);
  const dim = element(document, 'button', {
    className: 'menu-item dim-button', type: 'button', 'aria-pressed': 'false', hidden: '',
  }, [glyph(document), element(document, 'span', { className: 'menu-label', text: 'dim screen' })]);
  dim.hidden = true;
  // Withdrawn until the player knows this device can record the story and keep
  // the file (`video-export.mjs`).
  const save = element(document, 'button', {
    className: 'menu-item save-button', type: 'button', hidden: '',
  }, [glyph(document), element(document, 'span', { className: 'menu-label', text: 'save video' })]);
  save.hidden = true;
  const more = element(document, 'button', {
    className: 'round-button more-button', type: 'button', 'aria-label': 'more options',
    'aria-haspopup': 'true', 'aria-expanded': 'false',
  }, [glyph(document)]);
  const menu = element(document, 'div', {
    className: 'more-menu', role: 'group', 'aria-label': 'more options', hidden: '',
  }, [subtitles, dim, save]);
  menu.hidden = true;
  // The wind-down's own line and readout: it counts down a sound, not the
  // story, so nothing on it can be dragged.
  const windFill = element(document, 'div', { className: 'wind-fill' });
  const windLine = element(document, 'div', {
    className: 'wind-line', role: 'progressbar', 'aria-label': 'wind-down',
    'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0',
  }, [windFill]);
  const windTimes = element(document, 'span', { className: 'wind-times' });
  const stop = element(document, 'button', { className: 'bedside-button stop-button', type: 'button' }, [
    glyph(document), element(document, 'span', { text: 'Stop' }),
  ]);
  const chip = element(document, 'span', { className: 'quiet-chip' });
  const root = element(document, 'div', {
    className: 'controls', role: 'group', 'aria-label': 'playback controls', hidden: '',
  }, [
    element(document, 'div', { className: 'dock' }, [
      element(document, 'div', { className: 'transport' }, [toggle, back, forward]),
      element(document, 'div', { className: 'timeline' }, [
        scrub,
        element(document, 'span', { className: 'times' }, [at, total]),
        windLine,
        windTimes,
      ]),
      element(document, 'div', { className: 'side-buttons' }, [more, fullscreen]),
    ]),
    menu,
    element(document, 'div', { className: 'bedside' }, [stop, chip]),
  ]);
  root.hidden = true;
  return {
    root, scrub, fill, handle, at, total, back, forward, toggle, fullscreen,
    more, menu, save, dim, windLine, windFill, windTimes, stop, chip,
  };
}

/** A glyph the stylesheet draws from a path: see `.glyph` in `styles.css`. */
function glyph(document) {
  return element(document, 'span', { className: 'glyph', 'aria-hidden': 'true' });
}

function eyebrowText(kicker) {
  return typeof kicker === 'string' && kicker.trim() ? kicker.trim() : KICKER;
}

function element(document, tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (name === 'text') node.textContent = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}
