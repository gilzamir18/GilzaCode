import { useCallback, useEffect, useRef, useState } from 'react';

import { viewportPxToApp } from '../utils/uiScale.js';
import {
  applyPresentationAction,
  clampPresentationIndex,
  presentationClickAction,
  presentationKeyAction,
} from '../utils/presentationNavigation.js';

// The lifecycle of a full-screen presentation overlay (the PDF viewer's):
// focus, fullscreen, the viewport the content is fitted into, and keyboard and
// click navigation.
//
// It asks for real browser fullscreen but does not depend on getting it: in the
// packaged app the request can be refused, and a presentation that only works
// with permission is not a presentation. The overlay the caller renders covers
// the viewport either way.
//
// `viewport` is already in the app's CSS pixels. `window.innerWidth`/
// `innerHeight` are real viewport pixels and would become CSS lengths inside the
// zoomed subtree (see `.vscode-app` in index.css), making the content exactly
// `uiScale` times too large and pushing its bottom-right corner off the screen.

const measureViewport = (uiScale) => ({
  width: viewportPxToApp(window.innerWidth, uiScale),
  height: viewportPxToApp(window.innerHeight, uiScale),
});

export function usePresentation({ count, startIndex = 0, uiScale = 1, onExit }) {
  const hostRef = useRef(null);
  const [requestedIndex, setRequestedIndex] = useState(startIndex);
  const [viewport, setViewport] = useState(() => measureViewport(uiScale));

  const index = clampPresentationIndex(requestedIndex, count);

  const exit = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    onExit?.(index);
  }, [index, onExit]);

  useEffect(() => {
    hostRef.current?.focus();
    hostRef.current?.requestFullscreen?.().catch(() => {});
    return () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const measure = () => setViewport(measureViewport(uiScale));
    measure();
    window.addEventListener('resize', measure);
    // Entering or leaving fullscreen changes the viewport without firing a
    // resize on every backend, so the content is re-fitted on that too.
    document.addEventListener('fullscreenchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('fullscreenchange', measure);
    };
  }, [uiScale]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const action = presentationKeyAction(event.key);
      if (!action) return;
      event.preventDefault();
      if (action === 'exit') {
        exit();
        return;
      }
      setRequestedIndex((i) => applyPresentationAction(i, action, count));
    };
    // Capture phase: the editor's own shortcuts must not see these keys while
    // a presentation is running.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [count, exit]);

  const handleClick = useCallback((event) => {
    const action = presentationClickAction(event.clientX, window.innerWidth);
    setRequestedIndex((i) => applyPresentationAction(i, action, count));
  }, [count]);

  return { hostRef, index, viewport, handleClick };
}
