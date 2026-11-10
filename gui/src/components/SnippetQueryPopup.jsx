import React, { useEffect, useRef, useState } from 'react';
import {
  Search, X, Copy, RefreshCw, ZoomIn, ZoomOut, Send, FileDown, StickyNote, Check, PenLine, MessageSquarePlus,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  MAX_TEXT_SCALE,
  MIN_TEXT_SCALE,
  TEXT_SCALE_STEP,
  useFloatingPosition,
  useRememberedTextScale,
} from '../hooks/useFloatingPopup';
import { TEXT_SCALE_STORAGE_KEY } from './TranslationPopup';
import { FormattedMessage } from '../utils/formatMessage';
import { buildLookupNoteText, formatLookupSource, PDF_NOTE_MAX_CHARS } from '../utils/snippetQueryExport';

/**
 * The "Look up" card: a one-off question about an excerpt and its answer,
 * kept apart from the chat (§2.13.4).
 *
 * `state` comes from useSnippetQuery; this component only renders it. The card
 * is dismissed by its close button or Escape, never by a click elsewhere —
 * unlike the translation popup, a stray click here would throw away a question
 * being typed or an answer already paid for, and the card is not modal, so the
 * document stays readable and selectable behind it.
 *
 * `noteAction` is passed only by the PDF viewer: { available, reason, onSave }.
 * Other surfaces have no PDF to write into, so the action is absent there
 * rather than disabled.
 */
export default function SnippetQueryPopup({
  state,
  projectPath = '',
  onClose,
  onQuestionChange,
  onSubmit,
  onCompose,
  onCopy,
  onSaveMarkdown,
  noteAction,
}) {
  const { t } = useTranslation();
  const popupRef = useRef(null);
  const questionRef = useRef(null);
  const [noteSaving, setNoteSaving] = useState(false);
  // The same remembered size as the translation popup: someone who needs larger
  // text in one excerpt popup needs it in the other.
  const [textScale, changeTextScale] = useRememberedTextScale(TEXT_SCALE_STORAGE_KEY);

  const { position, isDragging, startDrag } = useFloatingPosition(popupRef, {
    anchor: state,
    anchorKey: state?.excerpt,
    measureKey: `${state?.status}:${textScale}:${state?.answer?.length || 0}`,
  });

  const status = state?.status;
  const saving = Boolean(state?.saving);

  useEffect(() => {
    if (status === 'compose') questionRef.current?.focus();
  }, [status, state?.excerpt]);

  useEffect(() => {
    if (!state) return undefined;
    const handleKey = (e) => {
      // While the save dialog is open, Escape belongs to the dialog.
      if (e.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [state, saving, onClose]);

  if (!state) return null;

  const { excerpt, source, question, answer, truncated, filesRead, error, noteSaved, savedPath } = state;
  const sourceLine = formatLookupSource(t, source);
  const canSend = Boolean(String(question || '').trim());

  const noteText = status === 'done' ? buildLookupNoteText(t, { question, answer }) : '';
  const noteTooLong = noteText.length > PDF_NOTE_MAX_CHARS;
  let noteDisabledReason = '';
  if (noteAction && !noteAction.available) noteDisabledReason = noteAction.reason;
  else if (noteTooLong) {
    noteDisabledReason = t(
      'snippetQuery.noteTooLong',
      'This answer is too long for a PDF note ({{length}} of {{max}} characters). Save it as Markdown instead.',
      { length: noteText.length, max: PDF_NOTE_MAX_CHARS },
    );
  }

  const handleSaveNote = async () => {
    if (!noteAction || noteDisabledReason || noteSaved || noteSaving) return;
    setNoteSaving(true);
    try {
      await noteAction.onSave(noteText);
    } finally {
      setNoteSaving(false);
    }
  };

  const footerButton = (key, Icon, label, onClick, { disabled = false, title } = {}) => (
    <button
      key={key}
      type="button"
      className="vscode-bottom-panel-clear-btn snippet-query-footer-btn"
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <Icon size={12} />
      <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={popupRef}
      className={`snippet-translate-popup snippet-query-popup${isDragging ? ' is-dragging' : ''}`}
      role="dialog"
      aria-label={t('snippetQuery.title', 'Look up')}
      style={{ top: `${position.y}px`, left: `${position.x}px`, '--snippet-translate-text-scale': textScale }}
    >
      <div
        className={`snippet-translate-popup-header${isDragging ? ' is-dragging' : ''}`}
        onPointerDown={startDrag}
        title={t('translation.dragHint', 'Drag to move this window')}
      >
        <Search size={14} />
        <span>{t('snippetQuery.title', 'Look up')}</span>
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
          {sourceLine && <span className="snippet-query-source"> · {sourceLine}</span>}
        </span>
        <div className="snippet-translate-popup-source">{excerpt}</div>

        {status === 'compose' ? (
          <>
            <label className="snippet-translate-popup-label" htmlFor="snippet-query-question">
              {t('snippetQuery.questionLabel', 'Your question')}
            </label>
            <textarea
              id="snippet-query-question"
              ref={questionRef}
              className="snippet-query-question-input"
              value={question}
              rows={3}
              placeholder={t('snippetQuery.questionPlaceholder', 'Ask something about this excerpt...')}
              onChange={(e) => onQuestionChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  if (canSend) onSubmit();
                }
              }}
            />
            <span className="snippet-query-hint">
              {t('snippetQuery.sendHint', 'Ctrl+Enter to send. The answer is not added to the chat.')}
            </span>
          </>
        ) : (
          <>
            <span className="snippet-translate-popup-label">{t('snippetQuery.questionLabel', 'Your question')}</span>
            <div className="snippet-query-question">{question}</div>
          </>
        )}

        {status === 'loading' && (
          <div className="snippet-translate-popup-status">
            <RefreshCw size={13} className="animate-spin" />
            <span>{t('snippetQuery.loading', 'Looking it up... the assistant may read files in the project.')}</span>
          </div>
        )}

        {status === 'error' && (
          <div className="snippet-translate-popup-error">
            {t('snippetQuery.failed', 'The look-up failed: {{error}}', { error })}
          </div>
        )}

        {status === 'done' && (
          <>
            <span className="snippet-translate-popup-label">{t('snippetQuery.answerLabel', 'Answer')}</span>
            <div className="snippet-query-answer">
              <FormattedMessage content={answer} projectPath={projectPath || null} />
            </div>
            {truncated && (
              <div className="snippet-query-warning" role="status">
                {t('snippetQuery.truncatedNotice', 'The answer reached the length limit and may be incomplete.')}
              </div>
            )}
            {filesRead?.length > 0 && (
              <div className="snippet-query-files">
                {t('snippetQuery.filesRead', 'Read: {{files}}', { files: filesRead.join(', ') })}
              </div>
            )}
            {savedPath && (
              <div className="snippet-query-saved" role="status">
                <Check size={12} />
                <span>{t('snippetQuery.savedTo', 'Saved to {{path}}', { path: savedPath })}</span>
              </div>
            )}
          </>
        )}
      </div>

      <div className="snippet-translate-popup-footer snippet-query-footer">
        {status === 'compose' && footerButton('send', Send, t('snippetQuery.send', 'Send'), onSubmit, {
          disabled: !canSend,
          title: canSend ? undefined : t('snippetQuery.needsQuestion', 'Write a question first.'),
        })}

        {status === 'error' && (
          <>
            {footerButton('retry', RefreshCw, t('translation.retry', 'Try again'), onSubmit)}
            {footerButton('edit', PenLine, t('snippetQuery.editQuestion', 'Edit question'), () => onCompose(true))}
          </>
        )}

        {status === 'done' && (
          <>
            {footerButton('copy', Copy, t('snippetQuery.copy', 'Copy answer'), () => onCopy(answer))}
            {footerButton('md', FileDown, t('snippetQuery.saveMarkdown', 'Save as Markdown'), onSaveMarkdown, {
              disabled: !projectPath || saving,
              title: projectPath ? undefined : t('snippetQuery.saveNeedsProject', 'Open a project to save files.'),
            })}
            {noteAction && footerButton(
              'note',
              noteSaved ? Check : StickyNote,
              noteSaved
                ? t('snippetQuery.noteSaved', 'Saved as PDF note')
                : t('snippetQuery.saveNote', 'Save as PDF note'),
              handleSaveNote,
              { disabled: Boolean(noteDisabledReason) || noteSaved || noteSaving, title: noteDisabledReason || undefined },
            )}
            {footerButton('new', MessageSquarePlus, t('snippetQuery.newQuestion', 'New question'), () => onCompose(false))}
          </>
        )}
      </div>
    </div>
  );
}
