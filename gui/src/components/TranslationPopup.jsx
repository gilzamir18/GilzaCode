import React, { useEffect, useRef } from 'react';
import { Languages, X, Copy, RefreshCw, ZoomIn, ZoomOut, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  TEXT_SCALE_STEP,
  useFloatingPosition,
  useRememberedTextScale,
} from '../hooks/useFloatingPopup';

export const TEXT_SCALE_STORAGE_KEY = 'snippetTranslationTextScale';
// The popup used to belong to the PDF viewer and stored its scale under this
// key. Renaming the key would quietly reset a preference someone chose because
// they need larger text, so the old value is still read when the new key is
// absent; the next change writes the new one.
const LEGACY_TEXT_SCALE_STORAGE_KEY = 'pdfTranslationTextScale';

/**
 * Floating popup that shows the translation of a document excerpt.
 *
 * `state` is { x, y, sourceText, status, targetLanguage, translatedText,
 * error } or null when the popup is closed. The parent owns the
 * request; this component only renders whichever phase the request is in.
 *
 * `onSpeak` is optional and omitted when pronunciation is not configured, so
 * the popup never shows a control that can only fail. Both the excerpt and the
 * translation get one: hearing the passage you just translated is the pairing
 * the two features exist for, and the two sides are in different languages.
 */
export default function TranslationPopup({ state, onClose, onRetry, onCopy, onSpeak }) {
  const { t } = useTranslation();
  const popupRef = useRef(null);
  const [textScale, changeTextScale] = useRememberedTextScale(
    TEXT_SCALE_STORAGE_KEY,
    LEGACY_TEXT_SCALE_STORAGE_KEY,
  );

  // A new translation re-anchors the popup at the click that asked for it; a
  // retry reuses the same coordinates and the same excerpt, so a popup the user
  // has already dragged somewhere comfortable stays put.
  const { position, isDragging, startDrag } = useFloatingPosition(popupRef, {
    anchor: state,
    anchorKey: state?.sourceText,
    measureKey: `${state?.status}:${textScale}`,
  });

  useEffect(() => {
    if (!state) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const handleClick = (e) => {
      // The speech player is a sibling overlay this popup can open. Pressing
      // pause on it is not "clicking away from the translation", so it must not
      // dismiss the text the audio is reading.
      if (e.target?.closest?.('.snippet-speech-popup')) return;
      if (popupRef.current && !popupRef.current.contains(e.target)) onClose();
    };
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('mousedown', handleClick, true);
    return () => {
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('mousedown', handleClick, true);
    };
  }, [state, onClose]);

  if (!state) return null;

  const { status, sourceText, targetLanguage, translatedText, error } = state;

  return (
    <div
      ref={popupRef}
      className={`snippet-translate-popup${isDragging ? ' is-dragging' : ''}`}
      role="dialog"
      aria-label={t('translation.title', 'Translation')}
      style={{ top: `${position.y}px`, left: `${position.x}px`, '--snippet-translate-text-scale': textScale }}
    >
      <div
        className={`snippet-translate-popup-header${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={startDrag}
        title={t('translation.dragHint', 'Drag to move this window')}
      >
        <Languages size={14} />
        <span>{t('translation.title', 'Translation')}</span>
        <span className="snippet-translate-popup-header-spacer" />
        <button
          type="button"
          className="snippet-translate-popup-zoom-btn"
          onClick={() => changeTextScale(-TEXT_SCALE_STEP)}
          disabled={textScale <= MIN_TEXT_SCALE}
          title={t('translation.decreaseText', 'Decrease text size')}
          aria-label={t('translation.decreaseText', 'Decrease text size')}
        >
          <ZoomOut size={14} />
        </button>
        <span className="snippet-translate-popup-zoom-level" aria-live="polite">
          {Math.round(textScale * 100)}%
        </span>
        <button
          type="button"
          className="snippet-translate-popup-zoom-btn"
          onClick={() => changeTextScale(TEXT_SCALE_STEP)}
          disabled={textScale >= MAX_TEXT_SCALE}
          title={t('translation.increaseText', 'Increase text size')}
          aria-label={t('translation.increaseText', 'Increase text size')}
        >
          <ZoomIn size={14} />
        </button>
        <button
          type="button"
          className="snippet-translate-popup-close"
          onClick={onClose}
          title={t('common.close', 'Close')}
          aria-label={t('common.close', 'Close')}
        >
          <X size={14} />
        </button>
      </div>

      <div className="snippet-translate-popup-body">
        <span className="snippet-translate-popup-label">
          {t('translation.selectedExcerpt', 'Selected excerpt')}
          {onSpeak && (
            <button
              type="button"
              className="snippet-translate-popup-speak"
              onClick={() => onSpeak(sourceText, { x: position.x, y: position.y })}
              title={t('translation.speakSource', 'Pronounce the excerpt')}
              aria-label={t('translation.speakSource', 'Pronounce the excerpt')}
            >
              <Volume2 size={12} />
            </button>
          )}
        </span>
        <div className="snippet-translate-popup-source">{sourceText}</div>

        {status === 'loading' && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>{t('translation.translatingTo', 'Translating to {{language}}...', { language: targetLanguage })}</span>
          </div>
        )}

        {status === 'error' && (
          <div className="snippet-translate-popup-error">
            {t('translation.failed', 'Translation failed: {{error}}', { error })}
          </div>
        )}

        {status === 'done' && (
          <>
            <span className="snippet-translate-popup-label">
              {t('translation.to', 'Translated to {{to}}', { to: targetLanguage })}
              {onSpeak && (
                <button
                  type="button"
                  className="snippet-translate-popup-speak"
                  onClick={() => onSpeak(translatedText, { x: position.x, y: position.y }, { language: targetLanguage })}
                  title={t('translation.speakResult', 'Pronounce the translation')}
                  aria-label={t('translation.speakResult', 'Pronounce the translation')}
                >
                  <Volume2 size={12} />
                </button>
              )}
            </span>
            <div className="snippet-translate-popup-result">{translatedText}</div>
          </>
        )}
      </div>

      <div className="snippet-translate-popup-footer">
        {status === 'done' && (
          <button
            type="button"
            className="vscode-bottom-panel-clear-btn"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}
            onClick={() => onCopy(translatedText)}
          >
            <Copy size={12} />
            <span>{t('translation.copy', 'Copy translation')}</span>
          </button>
        )}
        {status === 'error' && (
          <button
            type="button"
            className="vscode-bottom-panel-clear-btn"
            style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}
            onClick={onRetry}
          >
            <RefreshCw size={12} />
            <span>{t('translation.retry', 'Try again')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
