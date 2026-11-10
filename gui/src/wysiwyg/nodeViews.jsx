// ─────────────────────────────────────────────────────────────────────────────
// nodeViews.jsx
//
// Node views for the parts of the document that are not plain text.
//
// Two different jobs live here:
//
//   - **Verbatim blocks** (`latex_raw`) get the same previews the block-preview
//     Rich Text mode already renders — figures, tables, TikZ, code, the
//     preamble. Those components are reused rather than reimplemented, so a
//     figure looks identical in both modes and there is one place to fix when
//     a preview is wrong. They are read-only by construction: the model has no
//     representation of their content, so the only safe edit is in the source.
//
//   - **Math** (`math_block`, `math_inline`) is editable. It renders through
//     KaTeX and swaps to a raw-LaTeX field on click, which keeps a half-typed
//     formula from ever reaching the surrounding prose — the failure mode of
//     editing math as ordinary inline text.
//
// The math views are built from plain DOM rather than React: they update on
// every keystroke, and a React root per formula costs more than it earns.
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { createRoot } from 'react-dom/client';
import katex from 'katex';

import {
  CodeBlock, CommentBlock, EnvironmentBlock, FigureBlock, GraphicBlock,
  MakeTitleBlock, PreambleBlock, TableBlock, TitlePageBlock,
} from '../components/RichTextEditor';

// Parser block kind → the preview component that renders it.
const RAW_COMPONENTS = {
  figure: FigureBlock,
  table: TableBlock,
  graphic: GraphicBlock,
  code: CodeBlock,
  environment: EnvironmentBlock,
  preamble: PreambleBlock,
  comment: CommentBlock,
  titlepage: TitlePageBlock,
  maketitle: MakeTitleBlock,
};

function renderKatex(target, math, displayMode) {
  try {
    katex.render(math || '', target, {
      displayMode,
      throwOnError: false,
      output: 'mathml',
      trust: false,
    });
    target.classList.remove('ltx-math-error');
  } catch (error) {
    target.textContent = math || '';
    target.classList.add('ltx-math-error');
    target.title = error?.message || 'Could not render this formula';
  }
}

// ── Verbatim blocks ─────────────────────────────────────────────────────────

class RawBlockView {
  constructor(node, view, getPos, options) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.options = options;

    this.dom = document.createElement('div');
    this.dom.className = `ltx-raw-host ltx-raw-${node.attrs.kind}`;
    this.dom.contentEditable = 'false';

    // A narrow strip on the left that ProseMirror still receives events for,
    // so the block can be selected and dragged even though the preview itself
    // swallows clicks (a figure preview has its own click targets).
    this.grip = document.createElement('div');
    this.grip.className = 'ltx-raw-grip';
    this.grip.title = 'Select this block';
    this.dom.appendChild(this.grip);

    this.mount = document.createElement('div');
    this.mount.className = 'ltx-raw-body';
    this.dom.appendChild(this.mount);

    this.root = createRoot(this.mount);
    this.render(node);
  }

  render(node) {
    const Component = RAW_COMPONENTS[node.attrs.kind] || EnvironmentBlock;
    const block = node.attrs.data || { type: node.attrs.kind, source: node.attrs.raw, raw: node.attrs.raw };
    this.root.render(
      <Component
        block={block}
        activeProjectPath={this.options.activeProjectPath}
        sourceTex={this.options.sourceTex}
        onJumpToSource={() => this.options.onJumpToSource?.(block)}
      />,
    );
  }

  update(node) {
    if (node.type !== this.node.type || node.attrs.kind !== this.node.attrs.kind) return false;
    this.node = node;
    this.render(node);
    return true;
  }

  selectNode() { this.dom.classList.add('ltx-selected'); }
  deselectNode() { this.dom.classList.remove('ltx-selected'); }

  // Everything outside the grip belongs to the preview.
  stopEvent(event) { return !this.grip.contains(event.target); }
  ignoreMutation() { return true; }

  destroy() {
    // React refuses to unmount a root synchronously from inside a render or
    // commit phase, which is where ProseMirror may call this.
    const root = this.root;
    queueMicrotask(() => root.unmount());
  }
}

// ── Display math ────────────────────────────────────────────────────────────

class MathBlockView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.editing = false;

    this.dom = document.createElement('div');
    this.dom.className = 'ltx-math-block-host';
    this.dom.contentEditable = 'false';

    this.preview = document.createElement('div');
    this.preview.className = 'ltx-math-preview';
    this.preview.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.beginEditing();
    });
    this.dom.appendChild(this.preview);

    this.input = document.createElement('textarea');
    this.input.className = 'ltx-math-input';
    this.input.spellcheck = false;
    this.input.addEventListener('blur', () => this.commit());
    this.input.addEventListener('input', () => this.autoSize());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
      // Enter inserts a newline (formulas are multi-line); Ctrl/Cmd+Enter ends
      // the edit, matching how the rest of the app commits an inline field.
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.commit();
      }
    });
    this.dom.appendChild(this.input);

    this.renderPreview();
  }

  renderPreview() {
    const math = this.node.attrs.math || '';
    if (!math.trim()) {
      this.preview.textContent = 'Empty formula — click to edit';
      this.preview.classList.add('ltx-math-empty');
    } else {
      this.preview.classList.remove('ltx-math-empty');
      renderKatex(this.preview, math, true);
    }
    this.dom.classList.toggle('ltx-editing', this.editing);
  }

  autoSize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${this.input.scrollHeight}px`;
  }

  beginEditing() {
    this.editing = true;
    this.input.value = this.node.attrs.math || '';
    this.dom.classList.add('ltx-editing');
    this.input.focus();
    this.autoSize();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  cancel() {
    this.editing = false;
    this.dom.classList.remove('ltx-editing');
    this.view.focus();
  }

  commit() {
    if (!this.editing) return;
    this.editing = false;
    this.dom.classList.remove('ltx-editing');
    const value = this.input.value;
    if (value === (this.node.attrs.math || '')) return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, math: value }),
    );
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.editing) this.renderPreview();
    return true;
  }

  selectNode() { this.dom.classList.add('ltx-selected'); }
  deselectNode() { this.dom.classList.remove('ltx-selected'); }
  stopEvent() { return this.editing; }
  ignoreMutation() { return true; }
}

// ── Inline math ─────────────────────────────────────────────────────────────

class MathInlineView {
  constructor(node, view, getPos) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;
    this.editing = false;

    this.dom = document.createElement('span');
    this.dom.className = 'ltx-math-inline-host';
    this.dom.contentEditable = 'false';

    this.preview = document.createElement('span');
    this.preview.className = 'ltx-math-inline-preview';
    this.preview.addEventListener('mousedown', (event) => {
      event.preventDefault();
      this.beginEditing();
    });
    this.dom.appendChild(this.preview);

    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'ltx-math-inline-input';
    this.input.spellcheck = false;
    this.input.addEventListener('blur', () => this.commit());
    this.input.addEventListener('input', () => this.autoSize());
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); this.commit(); this.view.focus(); }
      if (event.key === 'Escape') { event.preventDefault(); this.cancel(); }
    });
    this.dom.appendChild(this.input);

    this.renderPreview();
  }

  renderPreview() {
    const math = this.node.attrs.math || '';
    if (!math.trim()) {
      this.preview.textContent = '∅';
      this.preview.classList.add('ltx-math-empty');
    } else {
      this.preview.classList.remove('ltx-math-empty');
      renderKatex(this.preview, math, false);
    }
  }

  autoSize() {
    // An input cannot size to its content on its own; a character-count based
    // width keeps the formula from being clipped as it is typed.
    this.input.style.width = `${Math.max(4, this.input.value.length + 1)}ch`;
  }

  beginEditing() {
    this.editing = true;
    this.input.value = this.node.attrs.math || '';
    this.dom.classList.add('ltx-editing');
    this.autoSize();
    this.input.focus();
    this.input.select();
  }

  cancel() {
    this.editing = false;
    this.dom.classList.remove('ltx-editing');
    this.view.focus();
  }

  commit() {
    if (!this.editing) return;
    this.editing = false;
    this.dom.classList.remove('ltx-editing');
    const value = this.input.value;
    if (value === (this.node.attrs.math || '')) return;
    const pos = this.getPos();
    if (typeof pos !== 'number') return;
    this.view.dispatch(
      this.view.state.tr.setNodeMarkup(pos, null, { ...this.node.attrs, math: value }),
    );
  }

  update(node) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    if (!this.editing) this.renderPreview();
    return true;
  }

  selectNode() { this.dom.classList.add('ltx-selected'); }
  deselectNode() { this.dom.classList.remove('ltx-selected'); }
  stopEvent() { return this.editing; }
  ignoreMutation() { return true; }
}

// ── Unmodelled inline commands ──────────────────────────────────────────────

class InlineRawView {
  constructor(node) {
    this.dom = document.createElement('span');
    this.dom.className = 'ltx-inline-raw-chip';
    this.dom.contentEditable = 'false';
    this.dom.textContent = node.attrs.raw || '';
    this.dom.title = 'Preserved as written — edit in the source view';
  }

  update(node) {
    if (node.type.name !== 'inline_raw') return false;
    this.dom.textContent = node.attrs.raw || '';
    return true;
  }

  selectNode() { this.dom.classList.add('ltx-selected'); }
  deselectNode() { this.dom.classList.remove('ltx-selected'); }
  ignoreMutation() { return true; }
}

/**
 * Build the node view table for an editor instance.
 *
 * @param {{activeProjectPath?: string, sourceTex?: string,
 *          onJumpToSource?: (block: object) => void}} options
 */
export function buildNodeViews(options = {}) {
  return {
    latex_raw: (node, view, getPos) => new RawBlockView(node, view, getPos, options),
    math_block: (node, view, getPos) => new MathBlockView(node, view, getPos),
    math_inline: (node, view, getPos) => new MathInlineView(node, view, getPos),
    inline_raw: (node) => new InlineRawView(node),
  };
}
