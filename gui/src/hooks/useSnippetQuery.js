import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from '../components/modals/CustomDialogProvider';
import {
  buildLookupMarkdown,
  normalizeLookupPath,
  suggestLookupPath,
} from '../utils/snippetQueryExport';

/**
 * The lifecycle behind "Look up the selection…", shared by every surface that
 * offers it (§2.13.4).
 *
 * A look-up is a one-off question about an excerpt, answered in a card of its
 * own. It never touches the chat: no turn, no history, no memory. The answer
 * is kept only when the user saves it — as a Markdown file here, or as a PDF
 * note through the viewer, which owns the annotation endpoints.
 *
 * The race guard is the translation hook's: every request takes a ticket, and a
 * late answer whose ticket has been superseded is dropped rather than rendered.
 * Closing the card takes a ticket too, so a request in flight cannot reopen it.
 *
 * `state` is null or { x, y, excerpt, source, question, status, answer,
 * truncated, filesRead, error, noteSaved, savedPath, saving }, where status is
 * 'compose' | 'loading' | 'done' | 'error'.
 */
export function useSnippetQuery({ model = '', projectPath = '' } = {}) {
  const { t } = useTranslation();
  const { showPrompt, showAlert } = useCustomDialog();
  const [query, setQuery] = useState(null);
  const requestRef = useRef(0);
  // The latest state, for callbacks that must not be recreated on every keystroke.
  const queryRef = useRef(null);
  queryRef.current = query;

  const open = useCallback((excerpt, anchorPoint, source = {}) => {
    const text = String(excerpt || '').trim();
    if (!text) return;
    requestRef.current += 1;
    setQuery({
      x: anchorPoint?.x ?? 0,
      y: anchorPoint?.y ?? 0,
      excerpt: text,
      source,
      question: '',
      status: 'compose',
      answer: '',
      truncated: false,
      filesRead: [],
      error: '',
      noteSaved: false,
      savedPath: '',
      saving: false,
    });
  }, []);

  const setQuestion = useCallback((question) => {
    setQuery((prev) => (prev && prev.status === 'compose' ? { ...prev, question } : prev));
  }, []);

  const submit = useCallback(async () => {
    const current = queryRef.current;
    const question = String(current?.question || '').trim();
    if (!current || !question) return;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setQuery((prev) => (prev ? {
      ...prev,
      status: 'loading',
      answer: '',
      truncated: false,
      filesRead: [],
      error: '',
      noteSaved: false,
      savedPath: '',
    } : prev));

    try {
      const res = await fetch('/api/snippet-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          excerpt: current.excerpt,
          question,
          model: model || '',
          projectPath: projectPath || '',
          source: current.source || {},
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestRef.current !== requestId) return;
      if (!res.ok) {
        throw new Error(data.error || res.statusText || 'request failed');
      }
      setQuery((prev) => (prev ? {
        ...prev,
        status: 'done',
        answer: data.answer || '',
        truncated: Boolean(data.truncated),
        filesRead: Array.isArray(data.files_read) ? data.files_read : [],
      } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setQuery((prev) => (prev ? { ...prev, status: 'error', error: err.message } : prev));
    }
  }, [model, projectPath]);

  // Back to the question, keeping the excerpt. `keepQuestion` is for editing a
  // question that failed or needs rewording; a new question starts empty.
  const compose = useCallback((keepQuestion) => {
    requestRef.current += 1;
    setQuery((prev) => (prev ? {
      ...prev,
      status: 'compose',
      question: keepQuestion ? prev.question : '',
      answer: '',
      truncated: false,
      filesRead: [],
      error: '',
      noteSaved: false,
      savedPath: '',
    } : prev));
  }, []);

  const copy = useCallback((text) => {
    if (!text) return;
    Promise.resolve(navigator.clipboard?.writeText?.(text)).catch(() => {});
  }, []);

  const markNoteSaved = useCallback(() => {
    setQuery((prev) => (prev ? { ...prev, noteSaved: true } : prev));
  }, []);

  const close = useCallback(() => {
    requestRef.current += 1;
    setQuery(null);
  }, []);

  // Asks for a project-relative path and writes the file, refusing to overwrite
  // anything already there (`exclusive`). The card stays open throughout.
  const saveMarkdown = useCallback(async () => {
    const current = queryRef.current;
    if (!current || current.status !== 'done' || !projectPath) return;
    setQuery((prev) => (prev ? { ...prev, saving: true } : prev));
    try {
      const content = buildLookupMarkdown(t, {
        excerpt: current.excerpt,
        question: current.question,
        answer: current.answer,
        source: current.source,
        model,
        date: new Date(),
        truncated: current.truncated,
        filesRead: current.filesRead,
      });
      let suggestion = suggestLookupPath(current.question);
      let message = t('snippetQuery.savePrompt', 'Save the answer as a Markdown file in the project:');
      // Bounded: each pass is a user answering a dialog, and cancelling ends it.
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const typed = await showPrompt(message, suggestion, t('snippetQuery.saveTitle', 'Save as Markdown'));
        if (typed === null || typed === undefined) return;
        const filePath = normalizeLookupPath(typed);
        if (!filePath) {
          message = t('snippetQuery.saveInvalidPath', 'Enter a file name, for example lookups/answer.md.');
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch('/api/file/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath, filePath, content, exclusive: true }),
        });
        // eslint-disable-next-line no-await-in-loop
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          suggestion = filePath;
          message = t('snippetQuery.saveExists', '{{path}} already exists. Choose another name:', { path: filePath });
          continue;
        }
        if (!res.ok) {
          // eslint-disable-next-line no-await-in-loop
          await showAlert(
            t('snippetQuery.saveFailed', 'Could not save the file: {{error}}', { error: data.error || res.statusText }),
            t('snippetQuery.saveTitle', 'Save as Markdown'),
          );
          return;
        }
        setQuery((prev) => (prev ? { ...prev, savedPath: filePath } : prev));
        return;
      }
    } finally {
      setQuery((prev) => (prev ? { ...prev, saving: false } : prev));
    }
  }, [t, model, projectPath, showPrompt, showAlert]);

  return {
    query,
    open,
    setQuestion,
    submit,
    compose,
    copy,
    saveMarkdown,
    markNoteSaved,
    close,
  };
}

export default useSnippetQuery;
