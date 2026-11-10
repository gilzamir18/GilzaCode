/**
 * The prompt "Ask about" stages in the chat composer.
 *
 * "Ask about" only ever pre-fills the composer — it starts no agent run, so the
 * user completes the question and presses Send like any other turn (§2.13).
 * The shape of the staged text is the same whichever document it came from, so
 * it lives here rather than once per viewer: the PDF viewer names a page, the
 * Markdown preview names a section, and everything else about the prompt is
 * identical.
 *
 * `locator` and `sourceFileLine` are already-localized strings; an empty one
 * drops its line instead of leaving a label with nothing after it.
 */

export function buildAskAboutDocumentPrompt(t, {
  documentPath,
  projectPath = '',
  sourceFile = '',
  sourceFileLabel = '',
  locator = '',
  selectedText = '',
  excerptLabel = '',
} = {}) {
  const showSourceFile = Boolean(sourceFile) && Boolean(sourceFileLabel) && sourceFile !== documentPath;

  // '' means "this line does not apply" and is dropped below. The PDF version
  // of this builder also carried two bare '' entries as blank-line separators,
  // which the same filter has always removed before they could reach the
  // composer — the staged prompt has never had blank lines between its parts.
  // They are left out here rather than kept as no-ops; changing the spacing
  // would be a change to the prompt, which is not what this move is for.
  return [
    `${t('app.askAboutPdfPrompt', 'Consulting about')} ${documentPath}`,
    `- ${t('app.projectPathLabel', 'Project path')}: ${projectPath}`,
    showSourceFile ? `- ${sourceFileLabel}: ${sourceFile}` : '',
    locator ? `- ${locator}` : '',
    selectedText
      ? [
        `${excerptLabel}:`,
        '````text',
        selectedText,
        '````',
        '',
      ].join('\n')
      : '',
    // Left open on purpose: the composer is pre-filled, not sent, so the caret
    // lands here for the user to finish the question and press Send.
    t('app.askAboutPdfQuestionLabel', 'My question:') + ' ',
  ].filter((part) => part !== '').join('\n');
}


/**
 * The prompt staged when an excerpt is quoted from a conversation.
 *
 * The chat has no document path and no locator, so it stages the excerpt alone.
 * The excerpt is fenced for the same reason it is in the document builder: text
 * lifted out of a rendered surface must not read as instructions when it lands
 * back in the composer.
 */
export function buildQuoteExcerptPrompt(t, excerpt) {
  const quoted = String(excerpt || '').trim();
  if (!quoted) return '';
  return [
    `${t('app.quotedExcerptLabel', 'About this excerpt')}:`,
    '````text',
    quoted,
    '````',
    '',
    t('app.askAboutPdfQuestionLabel', 'My question:') + ' ',
  ].join('\n');
}
