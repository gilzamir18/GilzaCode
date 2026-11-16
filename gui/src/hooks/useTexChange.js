import { useCallback, useRef, useState } from 'react';

/**
 * The lifecycle behind "Change .tex" (GLOSSARY.md): a conversation about an
 * excerpt of an Associated PDF, held in a card of its own, as Look up is.
 *
 * Each message goes to /api/tex-change/propose with the whole conversation,
 * since every `claude -p` call starts fresh. Claude answers with a question, a
 * message (the change cannot be made in that file) or a proposal. A proposal
 * is written only through `applyProposal`, which the viewer supplies; this
 * hook only records the outcome, so the card stays open for further requests.
 *
 * `state` is null or { x, y, excerpt, source, turns, draft, status, error,
 * file, lines }, where status is 'compose' | 'loading' | 'applying', and turns
 * are { role: 'user', text } or { role: 'assistant', kind, text, edits,
 * applied }. A failed request puts the message back into the draft, so the
 * conversation always ends with Claude's last answer or nothing.
 *
 * The race guard is Look up's: every request takes a ticket, and an answer
 * whose ticket has been superseded (the card was closed) is dropped.
 */
export function useTexChange({ model = '', projectPath = '', applyProposal } = {}) {
  const [state, setState] = useState(null);
  const requestRef = useRef(0);
  const stateRef = useRef(null);
  stateRef.current = state;

  // `source` is { pdfPath, page, anchors }: the anchors are the selection's
  // first and last points, in PDF points, for SyncTeX.
  const open = useCallback((excerpt, anchorPoint, source = {}) => {
    const text = String(excerpt || '').trim();
    if (!text) return;
    requestRef.current += 1;
    setState({
      x: anchorPoint?.x ?? 0,
      y: anchorPoint?.y ?? 0,
      excerpt: text,
      source,
      turns: [],
      draft: '',
      status: 'compose',
      error: '',
      file: '',
      lines: null,
    });
  }, []);

  const setDraft = useCallback((draft) => {
    setState((prev) => (prev ? { ...prev, draft } : prev));
  }, []);

  const submit = useCallback(async () => {
    const current = stateRef.current;
    const text = String(current?.draft || '').trim();
    if (!current || !text || current.status !== 'compose') return;
    const turns = [...current.turns, { role: 'user', text }];
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState((prev) => (prev ? { ...prev, turns, draft: '', status: 'loading', error: '' } : prev));
    try {
      const res = await fetch('/api/tex-change/propose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath,
          pdfPath: current.source?.pdfPath || '',
          page: current.source?.page || null,
          anchors: current.source?.anchors || [],
          excerpt: current.excerpt,
          model: model || '',
          turns,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (requestRef.current !== requestId) return;
      if (!res.ok) throw new Error(data.error || res.statusText || 'request failed');
      setState((prev) => (prev ? {
        ...prev,
        status: 'compose',
        file: data.file || prev.file,
        lines: Array.isArray(data.lines) ? data.lines : prev.lines,
        turns: [...turns, {
          role: 'assistant',
          kind: data.kind,
          text: data.text || '',
          edits: Array.isArray(data.edits) ? data.edits : [],
          applied: false,
        }],
      } : prev));
    } catch (err) {
      if (requestRef.current !== requestId) return;
      setState((prev) => (prev ? {
        ...prev, status: 'compose', turns: current.turns, draft: text, error: err.message,
      } : prev));
    }
  }, [model, projectPath]);

  // Applies the proposal at `index`. `applyProposal({ file, edits })` resolves
  // to { ok: true } or { ok: false, error }; a refusal (unsaved editor, file
  // changed) leaves the proposal unapplied and says why.
  const apply = useCallback(async (index) => {
    const current = stateRef.current;
    const turn = current?.turns?.[index];
    if (!current || !turn || turn.kind !== 'proposal' || turn.applied || current.status !== 'compose') return;
    if (!applyProposal) return;
    const ticket = requestRef.current;
    setState((prev) => (prev ? { ...prev, status: 'applying', error: '' } : prev));
    let outcome;
    try {
      outcome = await applyProposal({ file: current.file, edits: turn.edits });
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }
    if (requestRef.current !== ticket) return;
    setState((prev) => {
      if (!prev) return prev;
      if (!outcome?.ok) return { ...prev, status: 'compose', error: outcome?.error || 'apply failed' };
      return {
        ...prev,
        status: 'compose',
        turns: prev.turns.map((item, i) => (i === index ? { ...item, applied: true } : item)),
      };
    });
  }, [applyProposal]);

  const close = useCallback(() => {
    requestRef.current += 1;
    setState(null);
  }, []);

  return { state, open, setDraft, submit, apply, close };
}

export default useTexChange;
