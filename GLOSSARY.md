# Glossary

**Associated PDF**
The PDF that a `.tex` file produces, found by name: `name.pdf` in the same
folder as `name.tex`. A `.tex` has at most one Associated PDF, and a PDF has at
most one `.tex` it comes from.
_Avoid_: compiled PDF (also used for the preview of an open `.tex`), linked PDF.

**Reading view** (pt-BR: *Leitura*)
A `.tex` shown through its Associated PDF alone, the PDF taking the whole
document area. It is what opening a `.tex` from the explorer shows when the
`.tex` has an Associated PDF.
_Avoid_: preview (the PDF beside an open `.tex`), fullscreen, present mode.

**Split view** (pt-BR: *Lado a lado*)
A `.tex` and its Associated PDF side by side, the source beside the PDF.
Opening a `.tex` at a given line shows Split view, because a line is a request
to see the source.

**Source view** (pt-BR: *Só o .tex*)
A `.tex` that has an Associated PDF shown alone, the source taking the whole
document area and the PDF hidden. The toolbar has one button per view —
Reading view, Split view, Source view — with the current one highlighted.

**Look up** (pt-BR: *Pesquisar*)
A one-off question about a selected excerpt, answered in its own card beside
the document rather than in the Claude Code panel. The user can ask follow-up
questions in the same card. It only reads; it never changes a file.
_Avoid_: Ask about (that one hands the excerpt to the Claude Code panel).

**Change .tex** (pt-BR: *Mudar .tex*)
An action on an excerpt selected in an Associated PDF. The user describes the
change in words, in a card that works like Look up. Claude proposes an edit to
the LaTeX source, and the edit is written only when the user confirms it.
_Avoid_: Fix with AI (that one acts on compile errors), Ask about.
