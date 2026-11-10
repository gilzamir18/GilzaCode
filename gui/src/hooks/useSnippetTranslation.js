import { useCallback, useRef, useState } from 'react';

/**
 * The request lifecycle behind "Translate selection", shared by every surface
 * that offers it.
 *
 * This used to live inside PdfPreview. Nothing in it was PDF-specific — the
 * backend says so itself (gilzabots/translation.py: "any caller that has a text
 * snippet and a target language can use it") — and a second copy in the
 * Markdown preview would have been a second place for the request-id race
 * guard to be got wrong.
 *
 * The guard is the part worth naming: a translation the user has moved on from
 * must not overwrite the one they are waiting for, so every request takes a
 * ticket and a late answer whose ticket has been superseded is dropped rather
 * than rendered. Closing the popup takes a ticket too, which is what makes an
 * in-flight request unable to reopen it.
 *
 * `state` is { x, y, sourceText, status, targetLanguage, translatedText,
 * error } or null, which is exactly what TranslationPopup renders.
 */
export function useSnippetTranslation({ model, uiLanguage } = {}) {
  const [translation, setTranslation] = useState(null);
  const requestRef = useRef(0);

  const translate = useCallback(async (snippet, anchorPoint) => {
    const text = String(snippet || '').trim();
    if (!text) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    setTranslation({
      x: anchorPoint?.x ?? 0,
      y: anchorPoint?.y ?? 0,
      sourceText: text,
      status: 'loading',
      targetLanguage: '',
      translatedText: '',
      error: '',
    });

    try {
      // Read the configured target language at request time so a change in
      // Settings takes effect without reopening the document.
      const settings = await fetch('/api/settings/translation')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const targetLang = (settings?.translate_target_lang || '').trim() || uiLanguage || 'en';

      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          target_lang: targetLang,
          model: model || '',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestRef.current !== requestId) return;
      if (!res.ok) {
        throw new Error(data.error || res.statusText || 'request failed');
      }
      setTranslation((prev) => (prev ? {
        ...prev,
        status: 'done',
        targetLanguage: data.target_language || targetLang,
        translatedText: data.translated_text || '',
      } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setTranslation((prev) => (prev ? { ...prev, status: 'error', error: err.message } : prev));
    }
  }, [model, uiLanguage]);

  // A retry reuses the same excerpt *and* the same coordinates, so a popup the
  // user has already dragged somewhere comfortable stays where they put it.
  const retry = useCallback(() => {
    setTranslation((prev) => {
      if (prev?.sourceText) translate(prev.sourceText, { x: prev.x, y: prev.y });
      return prev;
    });
  }, [translate]);

  const copy = useCallback((text) => {
    if (!text) return;
    Promise.resolve(navigator.clipboard?.writeText?.(text)).catch(() => {});
  }, []);

  const close = useCallback(() => {
    requestRef.current += 1;
    setTranslation(null);
  }, []);

  return { translation, translate, retry, copy, close };
}

export default useSnippetTranslation;
