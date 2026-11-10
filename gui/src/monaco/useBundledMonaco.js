import { useCallback, useEffect, useState } from 'react';

// Loads the bundled Monaco (see bundledMonaco.js) once per page, on first use,
// so the editor's few megabytes are not parsed before the window first paints.
//
// `<Editor>` / `<DiffEditor>` must not mount before this resolves: they call
// the loader's `init()` on mount, and an `init()` that runs before
// `loader.config({ monaco })` falls back to the CDN.
let pending = null;

export function loadBundledMonaco() {
  if (!pending) {
    pending = import('./bundledMonaco.js').then((module) => module.default);
    // A failed chunk load is reported, not cached: the next attempt imports
    // again instead of replaying the same rejection for the whole session.
    pending.catch(() => { pending = null; });
  }
  return pending;
}

export function useBundledMonaco() {
  const [state, setState] = useState({ status: 'loading', error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', error: null });
    loadBundledMonaco().then(
      () => { if (!cancelled) setState({ status: 'ready', error: null }); },
      (error) => {
        console.error('[GilzaBots] The bundled code editor failed to load:', error);
        if (!cancelled) setState({ status: 'error', error });
      },
    );
    return () => { cancelled = true; };
  }, [attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, retry };
}
