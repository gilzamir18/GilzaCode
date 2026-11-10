import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sigma, Image as ImageIcon, Table, List, Quote, Code2,
  ChevronRight, Search, X, Plus,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// LatexSnippetsPanel
//
// A side panel (or dropdown) with categorized LaTeX templates that the user
// can insert at the Monaco cursor position. Each snippet is a pure-LaTeX
// string with optional placeholders in the form ${1:label} (VS Code-style
// snippet syntax) that Monaco's `editor.executeEdits` + `snippetInsert` can
// handle — but here we keep it simple: we insert raw text and let the user
// edit. Placeholders are left as plain text markers like <description>.
//
// Categories:
//   - Math (inline, display, aligned, cases, matrix)
//   - Figures (figure with includegraphics, subfigure)
//   - Tables (basic tabular, booktabs)
//   - Lists (itemize, enumerate, description)
//   - Quotes (quote, quotation)
//   - Code (verbatim, lstlisting, minted)
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIES = [
  {
    id: 'math',
    label: 'Math',
    icon: Sigma,
    snippets: [
      {
        label: 'Inline equation',
        description: '$E = mc^2$',
        body: '$${1:equation}$',
      },
      {
        label: 'Display equation',
        description: '\\[ ... \\]',
        body: '\\[\n  ${1:equation}\n\\]',
      },
      {
        label: 'Equation environment',
        description: '\\begin{equation} ... \\end{equation}',
        body: '\\begin{equation}\n  ${1:equation}\n  \\label{eq:${2:label}}\n\\end{equation}',
      },
      {
        label: 'Aligned (multi-line)',
        description: '\\begin{aligned} ... \\end{aligned}',
        body: '\\begin{aligned}\n  ${1:a} &= ${2:b} + ${3:c} \\\\\n  ${4:d} &= ${5:e}\n\\end{aligned}',
      },
      {
        label: 'Cases',
        description: '\\begin{cases} ... \\end{cases}',
        body: '\\begin{cases}\n  ${1:case 1} & \\text{if } ${2:condition 1} \\\\\n  ${3:case 2} & \\text{if } ${4:condition 2}\n\\end{cases}',
      },
      {
        label: 'Matrix',
        description: '\\begin{pmatrix} ... \\end{pmatrix}',
        body: '\\begin{pmatrix}\n  ${1:a} & ${2:b} \\\\\n  ${3:c} & ${4:d}\n\\end{pmatrix}',
      },
      {
        label: 'Fraction',
        description: '\\frac{num}{den}',
        body: '\\frac{${1:numerator}}{${2:denominator}}',
      },
      {
        label: 'Square root',
        description: '\\sqrt{x}',
        body: '\\sqrt{${1:expression}}',
      },
      {
        label: 'Sum / Integral',
        description: '\\sum_{i=0}^{n} ... \\int_a^b ...',
        body: '\\sum_{${1:i}=0}^{${2:n}} ${3:expression}',
      },
    ],
  },
  {
    id: 'figures',
    label: 'Figures',
    icon: ImageIcon,
    snippets: [
      {
        label: 'Figure with image',
        description: '\\begin{figure} ... \\includegraphics ... \\end{figure}',
        body: '\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=${1:0.8}\\textwidth]{${2:filename}}\n  \\caption{${3:Caption text}}\n  \\label{fig:${4:label}}\n\\end{figure}',
      },
      {
        label: 'Subfigures',
        description: '\\begin{subfigure} ... \\end{subfigure}',
        body: '\\begin{figure}[htbp]\n  \\centering\n  \\begin{subfigure}{${1:0.45}\\textwidth}\n    \\includegraphics[width=\\textwidth]{${2:file1}}\n    \\caption{${3:Caption 1}}\n  \\end{subfigure}\n  \\hfill\n  \\begin{subfigure}{${4:0.45}\\textwidth}\n    \\includegraphics[width=\\textwidth]{${5:file2}}\n    \\caption{${6:Caption 2}}\n  \\end{subfigure}\n  \\caption{${7:Main caption}}\n  \\label{fig:${8:label}}\n\\end{figure}',
      },
    ],
  },
  {
    id: 'tables',
    label: 'Tables',
    icon: Table,
    snippets: [
      {
        label: 'Basic table',
        description: '\\begin{tabular}{|c|c|c|}',
        body: '\\begin{table}[htbp]\n  \\centering\n  \\caption{${1:Table caption}}\n  \\label{tab:${2:label}}\n  \\begin{tabular}{|c|c|c|}\n    \\hline\n    ${3:Header 1} & ${4:Header 2} & ${5:Header 3} \\\\\n    \\hline\n    ${6:Cell 1} & ${7:Cell 2} & ${8:Cell 3} \\\\\n    ${9:Cell 4} & ${10:Cell 5} & ${11:Cell 6} \\\\\n    \\hline\n  \\end{tabular}\n\\end{table}',
      },
      {
        label: 'Booktabs table',
        description: '\\toprule / \\midrule / \\bottomrule',
        body: '\\begin{table}[htbp]\n  \\centering\n  \\caption{${1:Table caption}}\n  \\label{tab:${2:label}}\n  \\begin{tabular}{ccc}\n    \\toprule\n    ${3:Header 1} & ${4:Header 2} & ${5:Header 3} \\\\\n    \\midrule\n    ${6:Cell 1} & ${7:Cell 2} & ${8:Cell 3} \\\\\n    ${9:Cell 4} & ${10:Cell 5} & ${11:Cell 6} \\\\\n    \\bottomrule\n  \\end{tabular}\n\\end{table}',
      },
    ],
  },
  {
    id: 'lists',
    label: 'Lists',
    icon: List,
    snippets: [
      {
        label: 'Itemize',
        description: '\\begin{itemize} ... \\end{itemize}',
        body: '\\begin{itemize}\n  \\item ${1:First item}\n  \\item ${2:Second item}\n  \\item ${3:Third item}\n\\end{itemize}',
      },
      {
        label: 'Enumerate',
        description: '\\begin{enumerate} ... \\end{enumerate}',
        body: '\\begin{enumerate}\n  \\item ${1:First item}\n  \\item ${2:Second item}\n  \\item ${3:Third item}\n\\end{enumerate}',
      },
      {
        label: 'Description',
        description: '\\begin{description} ... \\end{description}',
        body: '\\begin{description}\n  \\item[${1:Term 1}] ${2:Description 1}\n  \\item[${3:Term 2}] ${4:Description 2}\n\\end{description}',
      },
    ],
  },
  {
    id: 'quotes',
    label: 'Quotes',
    icon: Quote,
    snippets: [
      {
        label: 'Quote',
        description: '\\begin{quote} ... \\end{quote}',
        body: '\\begin{quote}\n  ${1:Quoted text}\n\\end{quote}',
      },
      {
        label: 'Quotation',
        description: '\\begin{quotation} ... \\end{quotation}',
        body: '\\begin{quotation}\n  ${1:Quoted text}\n\\end{quotation}',
      },
    ],
  },
  {
    id: 'code',
    label: 'Code',
    icon: Code2,
    snippets: [
      {
        label: 'Verbatim',
        description: '\\begin{verbatim} ... \\end{verbatim}',
        body: '\\begin{verbatim}\n${1:code}\n\\end{verbatim}',
      },
      {
        label: 'Lstlisting',
        description: '\\begin{lstlisting}[language=Python]',
        body: '\\begin{lstlisting}[language=${1:Python}]\n${2:code}\n\\end{lstlisting}',
      },
      {
        label: 'Minted',
        description: '\\begin{minted}{python} ... \\end{minted}',
        body: '\\begin{minted}{${1:python}}\n${2:code}\n\\end{minted}',
      },
    ],
  },
];

export default function LatexSnippetsPanel({ onInsert, onClose }) {
  const { t } = useTranslation();
  const [activeCategory, setActiveCategory] = useState(CATEGORIES[0].id);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      snippets: cat.snippets.filter(
        s => s.label.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.snippets.length > 0);
  }, [search]);

  const current = filtered.find(c => c.id === activeCategory) || filtered[0];

  const handleInsert = (snippet) => {
    // Convert VS Code-style placeholders (${1:label}) to plain markers for
    // insertion. Monaco snippet API would be nicer, but executeEdits is
    // always available and keeps this component decoupled from Monaco.
    const body = snippet.body.replace(/\$\{(\d+):([^}]*)\}/g, '$2');
    onInsert(body);
  };

  return (
    <div
      style={{
        position: 'absolute',
        top: '35px',
        right: '8px',
        width: '320px',
        maxHeight: '70%',
        background: 'var(--vscode-editor-bg, #1e1e1e)',
        border: '1px solid var(--vscode-widget-border, #3c3c3c)',
        borderRadius: '6px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 10px',
          borderBottom: '1px solid var(--vscode-widget-border, #3c3c3c)',
        }}
      >
        <Plus size={14} style={{ color: 'var(--vscode-accent, #007acc)' }} />
        <span style={{ fontSize: '12px', fontWeight: 'bold', color: 'var(--vscode-text-fg)' }}>
          LaTeX Snippets
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          className="vscode-bottom-panel-clear-btn"
          style={{ padding: '4px' }}
          title={t('common.close', 'Close')}
        >
          <X size={12} />
        </button>
      </div>

      {/* Search */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--vscode-widget-border, #3c3c3c)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            background: 'var(--vscode-input-bg, #2d2d2d)',
            border: '1px solid var(--vscode-input-border, #3c3c3c)',
            borderRadius: '4px',
            padding: '4px 8px',
          }}
        >
          <Search size={12} style={{ color: 'var(--vscode-descriptionForeground, #888)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search snippets..."
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--vscode-input-fg, var(--vscode-text-fg))',
              fontSize: '12px',
            }}
          />
        </div>
      </div>

      {/* Body: category tabs + snippet list */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Category sidebar */}
        <div
          style={{
            width: '110px',
            borderRight: '1px solid var(--vscode-widget-border, #3c3c3c)',
            overflowY: 'auto',
          }}
        >
          {filtered.map(cat => {
            const Icon = cat.icon;
            const isActive = current && cat.id === current.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  width: '100%',
                  padding: '8px 10px',
                  background: isActive ? 'var(--vscode-list-activeSelectionBg, #094771)' : 'transparent',
                  border: 'none',
                  borderBottom: '1px solid var(--vscode-widget-border, #2a2a2a)',
                  color: isActive ? 'var(--vscode-list-activeSelectionFg, #ffffff)' : 'var(--vscode-text-fg)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '11px',
                }}
              >
                <Icon size={12} />
                <span>{cat.label}</span>
              </button>
            );
          })}
        </div>

        {/* Snippet list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {current && current.snippets.map((snip, i) => (
            <button
              key={i}
              onClick={() => handleInsert(snip)}
              style={{
                display: 'block',
                width: '100%',
                padding: '8px 12px',
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--vscode-widget-border, #2a2a2a)',
                cursor: 'pointer',
                textAlign: 'left',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-list-hoverBg, #2a2d2e)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <ChevronRight size={10} style={{ color: 'var(--vscode-descriptionForeground, #888)' }} />
                <span style={{ fontSize: '12px', color: 'var(--vscode-text-fg)', fontWeight: '500' }}>
                  {snip.label}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)', marginLeft: '16px', marginTop: '2px', fontFamily: 'monospace' }}>
                {snip.description}
              </div>
            </button>
          ))}
          {current && current.snippets.length === 0 && (
            <div style={{ padding: '16px', fontSize: '11px', color: 'var(--vscode-descriptionForeground, #888)' }}>
              No snippets found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

