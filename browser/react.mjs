import { createStoryPlayer } from './embed.mjs';

export function createReactStoryPlayer(React) {
  requireReact(React);
  const { createElement, useEffect, useRef } = React;

  function StoryPlayer({
    story, assetBase, plates = null, stream = null, cards = null, board = null, kicker = null,
    download = null, videoControls = 'player', debug = false, perf = false, children: _children, ref: _ref, ...host
  }) {
    // A story still being written is grown through `appendScene` on the handle,
    // and this component keeps no handle — it remounts whenever the story object
    // changes identity, which for a growing story is every scene. Refused rather
    // than dropped into `host`, where it would become an attribute on a div and
    // a player that quietly showed the end at the end of the prefix.
    if (stream) {
      throw new TypeError('a story that is still being written must be mounted with createStoryPlayer, not this component');
    }
    const hostRef = useRef(null);
    // Read through a ref: an inline function is a new identity on every render,
    // and a new identity must not remount a story. Only whether there is one
    // remounts it, because that decides whether the player can offer the file.
    const downloadRef = useRef(download);
    useEffect(() => {
      downloadRef.current = download;
    }, [download]);
    const keepsVideos = typeof download === 'function';
    useEffect(() => {
      const player = createStoryPlayer(hostRef.current, {
        story, assetBase, plates, cards, board, kicker, debug, perf, videoControls,
        download: keepsVideos ? (file) => downloadRef.current?.(file) : null,
      });
      void player.ready.catch(() => {
        // The plain player owns and renders its initialization error surface.
      });
      return () => player.destroy();
    }, [story, assetBase, plates, cards, board, kicker, keepsVideos, debug, perf, videoControls]);
    return createElement('div', { ...host, ref: hostRef });
  }

  StoryPlayer.displayName = 'FabroStoryPlayer';
  return StoryPlayer;
}

function requireReact(React) {
  if (!React || typeof React !== 'object') throw new TypeError('React must be an object');
  for (const name of ['createElement', 'useEffect', 'useRef']) {
    if (typeof React[name] !== 'function') throw new TypeError(`React.${name} must be a function`);
  }
}
