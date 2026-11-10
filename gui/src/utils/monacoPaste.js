export function pastePlainTextIntoMonaco(editor, text) {
  if (!editor || !text) return false;

  const model = editor.getModel?.();
  if (!model) return false;

  const selections = editor.getSelections?.() || [editor.getSelection?.()].filter(Boolean);
  if (!selections.length) return false;

  const normalizedText = String(text).replace(/\r\n|\r|\n/g, model.getEOL());
  const edits = selections.map(selection => ({
    range: selection,
    text: normalizedText,
    forceMoveMarkers: true,
  }));

  editor.pushUndoStop?.();
  const applied = editor.executeEdits('gilzabots-paste', edits);
  editor.pushUndoStop?.();

  if (applied && selections.length === 1) {
    const selection = selections[0];
    const startOffset = model.getOffsetAt({
      lineNumber: selection.startLineNumber,
      column: selection.startColumn,
    });
    const endPosition = model.getPositionAt(startOffset + normalizedText.length);
    editor.setSelection({
      startLineNumber: endPosition.lineNumber,
      startColumn: endPosition.column,
      endLineNumber: endPosition.lineNumber,
      endColumn: endPosition.column,
    });
  }

  editor.focus();
  return applied;
}
