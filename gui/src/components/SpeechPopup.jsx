import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { readUiScale, viewportPxToApp } from '../utils/uiScale';
import { Volume2, X, Play, Pause, RotateCcw, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Gap kept between the player and the window edges, matching the translation
// popup's clamp so the two read as one family.
const VIEWPORT_MARGIN = 8;

/**
 * Compact floating player for a pronounced excerpt.
 *
 * Deliberately smaller than the translation popup and not draggable: it carries
 * a transport, not a document. It exists because a request that only plays
 * audio has nowhere to report a failure and no way to stop — pressing
 * "Pronounce" and hearing nothing is indistinguishable from a bug.
 *
 * `state` is { x, y, sourceText, status, error, kind } or null.
 */
export default function SpeechPopup({ state, onClose, onToggle, onReplay, onRetry }) {
  const { t } = useTranslation();
  const popupRef = useRef(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!state) return;
    setPosition({ x: state.x, y: state.y });
  }, [state?.x, state?.y, state?.sourceText]);

  useLayoutEffect(() => {
    if (!state || !popupRef.current) return;
    // `position` is a CSS length inside the zoomed app, while the rect and the
    // window are measured in viewport pixels; the bounds have to be brought
    // into the same space before they can be compared.
    const scale = readUiScale();
    const rect = popupRef.current.getBoundingClientRect();
    const maxX = Math.max(VIEWPORT_MARGIN, viewportPxToApp(window.innerWidth - rect.width, scale) - VIEWPORT_MARGIN);
    const maxY = Math.max(VIEWPORT_MARGIN, viewportPxToApp(window.innerHeight - rect.height, scale) - VIEWPORT_MARGIN);
    setPosition((prev) => {
      const x = Math.min(Math.max(VIEWPORT_MARGIN, prev.x), maxX);
      const y = Math.min(Math.max(VIEWPORT_MARGIN, prev.y), maxY);
      return x === prev.x && y === prev.y ? prev : { x, y };
    });
  }, [state, state?.status, position]);

  useEffect(() => {
    if (!state) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [state, onClose]);

  if (!state) return null;

  const { status, sourceText, error, kind } = state;
  const isPlaying = status === 'playing';

  // A classified failure gets a specific instruction; an unclassified one shows
  // what the backend said. Nothing here falls back to a generic "try again",
  // because the fix differs by cause.
  const errorText = (() => {
    if (kind === 'not_configured') {
      return error || t('speech.notConfigured', 'Pronunciation is not configured yet. Set it up in Settings > General > Pronunciation.');
    }
    if (kind === 'unsupported') {
      return error || t('speech.unsupported', 'The configured endpoint has no speech route.');
    }
    if (kind === 'connection') {
      return error || t('speech.connection', 'The speech endpoint could not be reached.');
    }
    if (kind === 'auth') {
      return error || t('speech.auth', 'The speech endpoint rejected the credentials.');
    }
    if (kind === 'undecodable') {
      return t('speech.undecodable', 'The audio arrived but this browser could not decode it. Try another output format in Settings.');
    }
    return t('speech.failed', 'Pronunciation failed: {{error}}', { error: error || '' });
  })();

  return (
    <div
      ref={popupRef}
      className="snippet-speech-popup"
      role="dialog"
      aria-label={t('speech.title', 'Pronunciation')}
      style={{ top: `${position.y}px`, left: `${position.x}px` }}
    >
      <div className="snippet-speech-popup-row">
        <Volume2 size={14} />

        {status === 'loading' && (
          <span className="snippet-speech-popup-status">
            <RefreshCw size={12} className="animate-spin" />
            <span>{t('speech.synthesizing', 'Synthesizing…')}</span>
          </span>
        )}

        {(status === 'playing' || status === 'paused' || status === 'done') && (
          <>
            <button
              type="button"
              className="snippet-speech-popup-btn"
              onClick={onToggle}
              title={isPlaying ? t('speech.pause', 'Pause') : t('speech.play', 'Play')}
              aria-label={isPlaying ? t('speech.pause', 'Pause') : t('speech.play', 'Play')}
            >
              {isPlaying ? <Pause size={13} /> : <Play size={13} />}
            </button>
            <button
              type="button"
              className="snippet-speech-popup-btn"
              onClick={onReplay}
              title={t('speech.replay', 'Play again')}
              aria-label={t('speech.replay', 'Play again')}
            >
              <RotateCcw size={13} />
            </button>
          </>
        )}

        {status === 'error' && (
          <button
            type="button"
            className="snippet-speech-popup-btn"
            onClick={onRetry}
            title={t('speech.retry', 'Try again')}
            aria-label={t('speech.retry', 'Try again')}
          >
            <RefreshCw size={13} />
          </button>
        )}

        <span className="snippet-speech-popup-text" title={sourceText}>{sourceText}</span>

        <button
          type="button"
          className="snippet-speech-popup-btn"
          onClick={onClose}
          title={t('common.close', 'Close')}
          aria-label={t('common.close', 'Close')}
        >
          <X size={13} />
        </button>
      </div>

      {status === 'error' && (
        <div className="snippet-speech-popup-error">{errorText}</div>
      )}
    </div>
  );
}
