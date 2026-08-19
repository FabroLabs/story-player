import { createStoryPlayer } from './embed.mjs';

export function createReactStoryPlayer(React) {
  requireReact(React);
  const { createElement, useEffect, useRef } = React;

  function StoryPlayer({
    story, assetBase, debug = false, perf = false, children: _children, ref: _ref, ...host
  }) {
    const hostRef = useRef(null);
    useEffect(() => {
      const player = createStoryPlayer(hostRef.current, { story, assetBase, debug, perf });
      void player.ready.catch(() => {
        // The plain player owns and renders its initialization error surface.
      });
      return () => player.destroy();
    }, [story, assetBase, debug, perf]);
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
