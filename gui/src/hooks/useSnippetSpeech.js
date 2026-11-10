import { useCallback, useEffect, useRef, useState } from 'react';
import { UNAVAILABLE, availabilityFromSettings } from '../utils/featureAvailability.js';

/**
 * The request and playback lifecycle behind "Pronounce selection".
 *
 * The audio is synthesized by the backend and played by an `<audio>` element
 * here. The browser's own `speechSynthesis` is deliberately *not* used: the
 * desktop shell is QtWebEngine, which exposes the API but ships no Chromium TTS
 * backend, so `getVoices()` is empty and `speak()` fails with `not-allowed`
 * even on a machine with speech-dispatcher installed. Reaching for it as a
 * fallback would put the feature's most common failure on the platform the app
 * actually runs on.
 *
 * Availability is re-read whenever the menu opens rather than cached for the
 * session, the same way the translation target language is read at request
 * time: a change in Settings takes effect without reopening the document.
 *
 * `speech` is { x, y, sourceText, status, error, kind } or null, where status
 * is 'loading' | 'playing' | 'paused' | 'done' | 'error'.
 */
export function useSnippetSpeech({ model, language, settingsSignal = 0 } = {}) {
  // `offered` is what the user asked for in Settings; `ready` is whether it can
  // actually run. Keeping them apart is what lets a surface show a disabled
  // control *with its reason* instead of hiding it, so a half-finished setup is
  // visible rather than silently absent.
  const [availability, setAvailability] = useState({ ...UNAVAILABLE });
  const [speech, setSpeech] = useState(null);
  const requestRef = useRef(0);
  const audioRef = useRef(null);
  const objectUrlRef = useRef('');

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = '';
    }
  }, []);

  // A blob URL that outlives the component leaks the whole audio payload.
  useEffect(() => releaseAudio, [releaseAudio]);

  const refreshAvailability = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/speech');
      if (!res.ok) throw new Error('unavailable');
      const next = availabilityFromSettings(await res.json());
      setAvailability(next);
      return next;
    } catch {
      // The backend not answering is not the same as speech being misconfigured,
      // but from the menu's point of view the action is equally unavailable.
      const next = { ...UNAVAILABLE };
      setAvailability(next);
      return next;
    }
  }, []);

  // Re-read when the settings that govern this change. The menus also refresh
  // on open, but a surface whose *control* is what gets gated has no such
  // moment — see useDictation, where this was the actual defect.
  useEffect(() => { refreshAvailability(); }, [refreshAvailability, settingsSignal]);

  const speak = useCallback(async (snippet, anchorPoint, options = {}) => {
    const text = String(snippet || '').trim();
    if (!text) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    releaseAudio();

    setSpeech({
      x: anchorPoint?.x ?? 0,
      y: anchorPoint?.y ?? 0,
      sourceText: text,
      status: 'loading',
      error: '',
      kind: '',
    });

    try {
      const res = await fetch('/api/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model: model || '',
          lang: options.language ?? language ?? '',
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const failure = new Error(data.error || res.statusText || 'request failed');
        failure.kind = data.kind || '';
        throw failure;
      }

      const blob = await res.blob();
      if (requestRef.current !== requestId) return;

      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;

      const audio = audioRef.current || new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.onended = () => {
        if (requestRef.current === requestId) {
          setSpeech((prev) => (prev ? { ...prev, status: 'done' } : prev));
        }
      };
      audio.onerror = () => {
        if (requestRef.current === requestId) {
          setSpeech((prev) => (prev ? {
            ...prev,
            status: 'error',
            // The bytes arrived but will not decode — almost always a type the
            // engine and the browser disagree on, which is worth saying rather
            // than reporting as a generic failure.
            kind: 'undecodable',
            error: '',
          } : prev));
        }
      };

      await audio.play();
      if (requestRef.current !== requestId) return;
      setSpeech((prev) => (prev ? { ...prev, status: 'playing' } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setSpeech((prev) => (prev ? {
        ...prev,
        status: 'error',
        error: err.message || '',
        kind: err.kind || '',
      } : prev));
    }
  }, [model, language, releaseAudio]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    setSpeech((prev) => {
      if (!prev) return prev;
      if (prev.status === 'playing') {
        audio.pause();
        return { ...prev, status: 'paused' };
      }
      // Replaying a finished utterance starts it over rather than resuming at
      // its end, where play() would return immediately.
      if (prev.status === 'done') audio.currentTime = 0;
      audio.play().catch(() => {});
      return { ...prev, status: 'playing' };
    });
  }, []);

  const replay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.src) return;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    setSpeech((prev) => (prev ? { ...prev, status: 'playing' } : prev));
  }, []);

  const retry = useCallback(() => {
    setSpeech((prev) => {
      if (prev?.sourceText) speak(prev.sourceText, { x: prev.x, y: prev.y });
      return prev;
    });
  }, [speak]);

  const close = useCallback(() => {
    requestRef.current += 1;
    releaseAudio();
    setSpeech(null);
  }, [releaseAudio]);

  return { speech, availability, refreshAvailability, speak, toggle, replay, retry, close };
}

export default useSnippetSpeech;
