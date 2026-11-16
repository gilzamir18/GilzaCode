import React, { useEffect, useRef } from 'react';
import { FilePen, X, RefreshCw, ZoomIn, ZoomOut, Send, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  TEXT_SCALE_STEP,
  useFloatingPosition,
  useRememberedTextScale,
} from '../hooks/useFloatingPopup';
import { TEXT_SCALE_STORAGE_KEY } from './TranslationPopup';

/**
 * The "Change .tex" card (GLOSSARY.md): the user describes a change to the
 * excerpt they selected in an Associated PDF, Claude answers with a question,
 * a message or a proposal, and a proposal is applied only by its button.
 *
 * It works like the Look up card: not modal, dismissed only by its close
 * button or Escape, so the PDF stays readable and a request being typed is
 * not thrown away by a stray click. `state` comes from useTexChange.
 */
export default function TexChangePopup({ state, onClose, onDraftChange, onSubmit, onApply }) {
  const { t } = useTranslation();
  const popupRef = useRef(null);
  const draftRef = useRef(null);
  const [textScale, changeTextScale] = useRememberedTextScale(TEXT_SCALE_STORAGE_KEY);

  const { position, isDragging, startDrag } = useFloatingPosition(popupRef, {
    anchor: state,
    anchorKey: state?.excerpt,
    measureKey: `${state?.status}:${textScale}:${state?.turns?.length || 0}`,
  });

  const status = state?.status;

  useEffect(() => {
    if (status === 'compose') draftRef.current?.focus();
  }, [status, state?.excerpt]);

  useEffect(() => {
    if (!state) return undefined;
    const handleKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [state, onClose]);

  if (!state) return null;

  const { excerpt, turns, draft, error, file, lines } = state;
  const busy = status !== 'compose';
  const canSend = !busy && Boolean(String(draft || '').trim());
  const lastIndex = turns.length - 1;
  const where = file
    ? (lines && lines[0] !== lines[1]
      ? t('texChange.whereLines', '{{file}}, lines {{first}}–{{last}}', { file, first: lines[0], last: lines[1] })
      : t('texChange.whereLine', '{{file}}, line {{line}}', { file, line: lines?.[0] }))
    : '';

  const renderTurn = (turn, index) => {
    if (turn.role === 'user') {
      return (
        <div key={index} className="tex-change-turn tex-change-turn-user">
          <span className="snippet-translate-popup-label">{t('texChange.you', 'You')}</span>
          <div className="snippet-query-question">{turn.text}</div>
        </div>
      );
    }
    const isProposal = turn.kind === 'proposal';
    const canApply = isProposal && index === lastIndex && !turn.applied;
    return (
      <div key={index} className={`tex-change-turn tex-change-turn-${turn.kind}`}>
        <span className="snippet-translate-popup-label">
          {turn.kind === 'question'
            ? t('texChange.claudeAsks', 'Claude asks')
            : isProposal ? t('texChange.proposal', 'Proposed change') : t('texChange.claude', 'Claude')}
        </span>
        <div className="snippet-query-answer">{turn.text}</div>
        {isProposal && turn.edits.map((edit, editIndex) => (
          <div key={editIndex} className="tex-change-edit">
            <pre className="tex-change-before" aria-label={t('texChange.before', 'Before')}>{edit.before}</pre>
            <pre className="tex-change-after" aria-label={t('texChange.after', 'After')}>{edit.after || ' '}</pre>
          </div>
        ))}
        {turn.applied && (
          <div className="snippet-query-saved" role="status">
            <Check size={12} />
            <span>{t('texChange.applied', 'Applied to {{file}}. The PDF is being rebuilt.', { file })}</span>
          </div>
        )}
        {canApply && (
          <button
            type="button"
            className="vscode-bottom-panel-clear-btn snippet-query-footer-btn tex-change-apply"
            onClick={() => onApply(index)}
            disabled={busy}
          >
            <Check size={12} />
            <span>{t('texChange.apply', 'Apply')}</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      ref={popupRef}
      className={`snippet-translate-popup snippet-query-popup tex-change-popup${isDragging ? ' is-dragging' : ''}`}
      role="dialog"
      aria-label={t('texChange.title', 'Change .tex')}
      style={{ top: `${position.y}px`, left: `${position.x}px`, '--snippet-translate-text-scale': textScale }}
    >
      <div
        className={`snippet-translate-popup-header${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={startDrag}
        title={t('translation.dragHint', 'Drag to move this window')}
      >
        <FilePen size={14} />
        <span>{t('texChange.title', 'Change .tex')}</span>
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

      <div className="snippet-translate-popup-body snippet-query-body">
        <span className="snippet-translate-popup-label">
          {t('translation.selectedExcerpt', 'Selected excerpt')}
          {where && <span className="snippet-query-source"> · {where}</span>}
        </span>
        <div className="snippet-translate-popup-source">{excerpt}</div>

        {turns.map(renderTurn)}

        {status === 'loading' && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>{t('texChange.loading', 'Claude is reading the source and preparing a proposal...')}</span>
          </div>
        )}
        {status === 'applying' && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>{t('texChange.applying', 'Applying the change...')}</span>
          </div>
        )}
        {error && <div className="snippet-translate-popup-error" role="alert">{error}</div>}

        <label className="snippet-translate-popup-label" htmlFor="tex-change-draft">
          {turns.length === 0
            ? t('texChange.describeLabel', 'What should change?')
            : t('texChange.replyLabel', 'Reply or ask for another change')}
        </label>
        <textarea
          id="tex-change-draft"
          ref={draftRef}
          className="snippet-query-question-input"
          value={draft}
          rows={3}
          disabled={busy}
          placeholder={t('texChange.placeholder', 'For example: make this sentence shorter and more formal.')}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
        />
        <span className="snippet-query-hint">
          {t('texChange.sendHint', 'Ctrl+Enter to send. Nothing is written until you press Apply.')}
        </span>
      </div>

      <div className="snippet-translate-popup-footer snippet-query-footer">
        <button
          type="button"
          className="vscode-bottom-panel-clear-btn snippet-query-footer-btn"
          onClick={onSubmit}
          disabled={!canSend}
          title={canSend ? undefined : t('texChange.needsText', 'Describe the change first.')}
        >
          <Send size={12} />
          <span>{t('snippetQuery.send', 'Send')}</span>
        </button>
      </div>
    </div>
  );
}
