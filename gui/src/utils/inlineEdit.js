// Inline edits (gilzacode/inline_edit.py): what the editor's Refine, Generate
// content, Create illustration and Ctrl+L prompts ask for, and how an
// illustration is referenced from the file it was made for.

// The backend's action for an inline prompt. A Ctrl+L prompt ('free') rewrites
// the selection when there is one and inserts at the cursor otherwise.
export function inlineEditAction(mode, hasSelection) {
  if (mode === 'createIllustration') return 'illustrate';
  if (mode === 'generate') return 'insert';
  if (mode === 'refine') return 'replace';
  return hasSelection ? 'replace' : 'insert';
}

// The last line a selection covers, below which an illustration's reference
// goes. A selection of whole lines (a triple click, Shift+Down) ends at column
// 1 of the next line, which it does not cover.
export function lastSelectedLine({ startLine, endLine, endColumn }) {
  return endLine > startLine && endColumn === 1 ? endLine - 1 : endLine;
}

// The file's position as '../' steps up to the project root.
function upToRoot(file) {
  const depth = String(file || '').replace(/\\/g, '/').split('/').filter(Boolean).length - 1;
  return depth > 0 ? '../'.repeat(depth) : '';
}

// The text that shows an illustration saved at the project root's
// illustrations/ in `file`, as GilzaBots wrote it. LaTeX takes the PDF copy,
// relative to the file; the Markdown preview resolves image paths from the
// project root.
export function illustrationReference(file, { svg_path: svgPath, pdf_path: pdfPath }, alt) {
  const ext = String(file || '').split('.').pop().toLowerCase();
  const up = upToRoot(file);
  if (ext === 'tex') {
    return `\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{${up}${pdfPath}}\n\\end{figure}`;
  }
  if (ext === 'md' || ext === 'markdown') return `![${alt}](${svgPath})`;
  if (ext === 'html' || ext === 'htm') return `<img src="${up}${svgPath}" alt="${alt}" />`;
  return `${up}${svgPath}`;
}

const GRAPHICX = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\bgraphicx\b[^}]*\}/;

// Where `\usepackage{graphicx}` has to go for \includegraphics to work: the
// offset of \begin{document}, or null when the package is already loaded (or
// the file has no preamble of its own, such as an included chapter). Beamer
// loads graphicx itself.
export function graphicxInsertionOffset(content) {
  const text = String(content || '');
  if (GRAPHICX.test(text) || /\\documentclass\s*(?:\[[^\]]*\])?\s*\{beamer\}/.test(text)) return null;
  const index = text.indexOf('\\begin{document}');
  return index === -1 ? null : index;
}
