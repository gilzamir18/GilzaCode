import test from 'node:test';
import assert from 'node:assert/strict';
import { graphicxInsertionOffset, illustrationReference, inlineEditAction, lastSelectedLine } from '../inlineEdit.js';

test('a selection of whole lines ends on its last line, not at column 1 of the next', () => {
  assert.equal(lastSelectedLine({ startLine: 3, endLine: 4, endColumn: 1 }), 3);
  assert.equal(lastSelectedLine({ startLine: 3, endLine: 4, endColumn: 5 }), 4);
  assert.equal(lastSelectedLine({ startLine: 3, endLine: 3, endColumn: 1 }), 3);
});

test('each inline prompt maps to replacing, inserting or illustrating', () => {
  assert.equal(inlineEditAction('refine', true), 'replace');
  assert.equal(inlineEditAction('generate', true), 'insert');
  assert.equal(inlineEditAction('createIllustration', true), 'illustrate');
  assert.equal(inlineEditAction('free', true), 'replace');
  assert.equal(inlineEditAction('free', false), 'insert');
});

test('an illustration is referenced the way each kind of file shows images', () => {
  const paths = { svg_path: 'illustrations/illustration_1.svg', pdf_path: 'illustrations/illustration_1.pdf' };
  assert.equal(illustrationReference('AULA_00/aula00.tex', paths, 'Ilustração'),
    '\\begin{figure}[htbp]\n\\centering\n\\includegraphics[width=0.8\\textwidth]{../illustrations/illustration_1.pdf}\n\\end{figure}');
  assert.equal(illustrationReference('a\\b\\notes.md', paths, 'Ilustração'), '![Ilustração](illustrations/illustration_1.svg)');
  assert.equal(illustrationReference('site/index.html', paths, 'Illustration'),
    '<img src="../illustrations/illustration_1.svg" alt="Illustration" />');
  assert.equal(illustrationReference('readme.txt', paths, 'x'), 'illustrations/illustration_1.svg');
});

test('graphicx is added before \\begin{document} only when nothing loads it', () => {
  const doc = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}';
  assert.equal(graphicxInsertionOffset(doc), doc.indexOf('\\begin{document}'));
  assert.equal(graphicxInsertionOffset('\\usepackage[final]{amsmath, graphicx}\n\\begin{document}'), null);
  assert.equal(graphicxInsertionOffset('\\documentclass[11pt]{beamer}\n\\begin{document}'), null);
  assert.equal(graphicxInsertionOffset('An included chapter.'), null);
});
