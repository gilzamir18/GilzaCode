import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createIdeCommandRunner,
  sameProjectPath,
  tabsAfterClose,
  tabsAfterOpen,
} from '../ideCommands.js';

const samePath = (a, b) => String(a) === String(b);

// A window with tabs, recording what the runner asked of it.
function fakeWindow({
  tabs = ['main.tex'],
  selected = 'main.tex',
  unsaved = [],
  project = '/p/thesis',
  reveal = { ok: true, page: 4 },
  problems = [],
  editorState = { mode: 'code', cursor: { line: 3, column: 1 }, selection: null },
  pdfView = null,
} = {}) {
  const calls = [];
  const deps = {
    getProjectPath: () => project,
    caseInsensitive: () => false,
    samePath,
    openFiles: () => tabs,
    selectedFile: () => selected,
    opensOutside: (path) => /\.(png|zip|docx)$/.test(path),
    hasNoLines: (path) => /\.pdf$/.test(path),
    isUnsaved: (path) => unsaved.includes(path),
    focusTab: async (path, line) => { calls.push(['focus', path, line]); },
    addBackgroundTab: async (path) => { calls.push(['background', path]); },
    closeTab: (path) => { calls.push(['close', path]); },
    revealInPdf: async (path, line) => {
      calls.push(['reveal', path, line]);
      return reveal;
    },
    setLayout: (mode) => { calls.push(['layout', mode]); },
    problems: () => problems,
    editorState: () => editorState,
    pdfView: () => pdfView,
  };
  return { run: createIdeCommandRunner(deps), calls };
}

const command = (action, args, project = '/p/thesis') => ({ id: '1', action, args, project_path: project });

test('opening a new file appends its tab and focuses it', () => {
  assert.deepEqual(
    tabsAfterOpen(['a.tex'], 'b.tex', { focus: true, currentFile: 'a.tex', samePath }),
    { openFiles: ['a.tex', 'b.tex'], currentFile: 'b.tex' },
  );
});

test('opening an open file keeps its place; a background open keeps the focus', () => {
  assert.deepEqual(
    tabsAfterOpen(['a.tex', 'b.tex'], 'a.tex', { focus: true, currentFile: 'b.tex', samePath }),
    { openFiles: ['a.tex', 'b.tex'], currentFile: 'a.tex' },
  );
  assert.deepEqual(
    tabsAfterOpen(['a.tex'], 'b.tex', { focus: false, currentFile: 'a.tex', samePath }),
    { openFiles: ['a.tex', 'b.tex'], currentFile: 'a.tex' },
  );
});

test('closing the focused tab hands the focus to the last one, as the tab bar does', () => {
  assert.deepEqual(
    tabsAfterClose(['a.tex', 'b.tex', 'c.tex'], 'b.tex', { currentFile: 'b.tex', samePath }),
    { openFiles: ['a.tex', 'c.tex'], currentFile: 'c.tex' },
  );
  assert.deepEqual(
    tabsAfterClose(['a.tex', 'b.tex'], 'a.tex', { currentFile: 'b.tex', samePath }),
    { openFiles: ['b.tex'], currentFile: 'b.tex' },
  );
  assert.deepEqual(
    tabsAfterClose(['a.tex'], 'a.tex', { currentFile: 'a.tex', samePath }),
    { openFiles: [], currentFile: '' },
  );
});

test('project roots compare without trailing slashes, and case only where paths fold', () => {
  assert.ok(sameProjectPath('/p/thesis/', '/p/thesis'));
  assert.ok(sameProjectPath('C:\\P\\Thesis', 'c:/p/thesis', { caseInsensitive: true }));
  assert.ok(!sameProjectPath('/p/Thesis', '/p/thesis'));
  assert.ok(!sameProjectPath('', ''));
});

test('open_file focuses the tab through the click handler and reports the tabs', async () => {
  const { run, calls } = fakeWindow();
  const result = await run(command('open_file', { path: 'ch/intro.tex', line: 12, focus: true }));
  assert.deepEqual(calls, [['focus', 'ch/intro.tex', 12]]);
  assert.deepEqual(result, { ok: true, open_files: ['main.tex', 'ch/intro.tex'], current_file: 'ch/intro.tex' });
});

test('a background open leaves the user on their tab', async () => {
  const { run, calls } = fakeWindow();
  const result = await run(command('open_file', { path: 'refs.bib', line: null, focus: false }));
  assert.deepEqual(calls, [['background', 'refs.bib']]);
  assert.equal(result.current_file, 'main.tex');
});

test('a file the IDE hands to another application is refused, never launched', async () => {
  const { run, calls } = fakeWindow();
  const result = await run(command('open_file', { path: 'fig.png', focus: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /not a file the IDE opens in a tab/);
  assert.deepEqual(calls, []);
});

test('a line in a PDF is refused', async () => {
  const { run, calls } = fakeWindow();
  const result = await run(command('open_file', { path: 'main.pdf', line: 3, focus: true }));
  assert.match(result.error, /no lines to scroll to/);
  assert.deepEqual(calls, []);
});

test('a command for a project the window is not showing changes nothing', async () => {
  const { run, calls } = fakeWindow({ project: '/p/other' });
  const result = await run(command('open_file', { path: 'main.tex', focus: true }));
  assert.match(result.error, /showing another project/);
  assert.deepEqual(calls, []);
});

test('close_file refuses a tab with unsaved edits', async () => {
  const { run, calls } = fakeWindow({ tabs: ['main.tex', 'b.tex'], unsaved: ['b.tex'] });
  const result = await run(command('close_file', { path: 'b.tex' }));
  assert.match(result.error, /unsaved edits/);
  assert.deepEqual(calls, []);
});

test('close_file of a tab that is not open lists the open ones', async () => {
  const { run } = fakeWindow({ tabs: ['main.tex'] });
  const result = await run(command('close_file', { path: 'gone.tex' }));
  assert.match(result.error, /gone\.tex is not open.*Open tabs: main\.tex\./);
});

test('close_file closes a clean tab and reports where the focus went', async () => {
  const { run, calls } = fakeWindow({ tabs: ['main.tex', 'b.tex'], selected: 'b.tex' });
  const result = await run(command('close_file', { path: 'b.tex' }));
  assert.deepEqual(calls, [['close', 'b.tex']]);
  assert.deepEqual(result, { ok: true, open_files: ['main.tex'], current_file: 'main.tex' });
});

test('an unknown command and a handler failure are answered, not dropped', async () => {
  const { run } = fakeWindow();
  assert.match((await run(command('rm_rf', { path: 'x' }))).error, /does not know the command/);

  const failing = createIdeCommandRunner({
    getProjectPath: () => '/p',
    caseInsensitive: () => false,
    samePath,
    openFiles: () => [],
    selectedFile: () => '',
    opensOutside: () => false,
    hasNoLines: () => false,
    isUnsaved: () => false,
    focusTab: async () => {},
    addBackgroundTab: async () => { throw new Error('HTTP 404'); },
    closeTab: () => {},
  });
  const result = await failing(command('open_file', { path: 'a.tex', focus: false }, '/p'));
  assert.match(result.error, /failed to carry out 'open_file': HTTP 404/);
});

test('reveal_in_pdf focuses the source at the line, then runs the forward search', async () => {
  const { run, calls } = fakeWindow();
  const result = await run(command('reveal_in_pdf', { path: 'ch/intro.tex', line: 30 }));
  assert.deepEqual(calls, [['focus', 'ch/intro.tex', 30], ['reveal', 'ch/intro.tex', 30]]);
  assert.deepEqual(result, {
    ok: true, page: 4, open_files: ['main.tex', 'ch/intro.tex'], current_file: 'ch/intro.tex',
  });
});

test('reveal_in_pdf passes on the reason the pane could not show the line', async () => {
  const { run } = fakeWindow({ reveal: { ok: false, error: 'no SyncTeX data' } });
  const result = await run(command('reveal_in_pdf', { path: 'main.tex', line: 3 }));
  assert.deepEqual(result, { ok: false, error: 'no SyncTeX data' });
});

test('reveal_in_pdf refuses a file that is not LaTeX source, or no line, before moving anything', async () => {
  const { run, calls } = fakeWindow();
  assert.match((await run(command('reveal_in_pdf', { path: 'refs.bib', line: 3 }))).error, /not LaTeX source/);
  assert.match((await run(command('reveal_in_pdf', { path: 'main.tex' }))).error, /1-based source line/);
  assert.deepEqual(calls, []);
});

test('set_layout switches to a known layout and refuses an unknown one', async () => {
  const { run, calls } = fakeWindow();
  assert.deepEqual(await run(command('set_layout', { layout: 'document' })), { ok: true, layout: 'document' });
  const unknown = await run(command('set_layout', { layout: 'zen' }));
  assert.match(unknown.error, /no 'zen' layout\. Layouts: ide, chat, studio, document\./);
  assert.deepEqual(calls, [['layout', 'document']]);
});

test('get_problems answers with the panel entries in plain fields', async () => {
  const { run } = fakeWindow({
    problems: [{
      id: '0.3', tool: 'LaTeX compiler', severity: 'error', source: 'latex_compile',
      filePath: 'ch\\intro.tex', timestamp: '10:02:03', message: 'Undefined control sequence', log: 'x'.repeat(10),
    }],
  });
  assert.deepEqual(await run(command('get_problems', {})), {
    ok: true,
    problems: [{
      tool: 'LaTeX compiler', severity: 'error', source: 'latex_compile',
      file: 'ch/intro.tex', time: '10:02:03', message: 'Undefined control sequence',
    }],
  });
});

test('commands that name no file still belong to the project on screen', async () => {
  const { run, calls } = fakeWindow({ project: '/p/other' });
  const result = await run(command('set_layout', { layout: 'review' }));
  assert.match(result.error, /showing another project/);
  assert.doesNotMatch(result.error, /which file/);
  assert.deepEqual(calls, []);
});

test('get_editor_state reports tabs, unsaved tabs and the focused tab\'s selection', async () => {
  const selection = { text: 'E = mc^2', start_line: 10, end_line: 10 };
  const { run, calls } = fakeWindow({
    tabs: ['main.tex', 'notes.md'], unsaved: ['notes.md'],
    editorState: { mode: 'code', cursor: { line: 10, column: 12 }, selection },
  });
  assert.deepEqual(await run(command('get_editor_state', {})), {
    ok: true, project_path: '/p/thesis', open_files: ['main.tex', 'notes.md'], current_file: 'main.tex',
    unsaved_files: ['notes.md'], mode: 'code', cursor: { line: 10, column: 12 }, selection,
  });
  assert.deepEqual(calls, []);
});

test('get_pdf_view answers what the PDF pane shows, and says so when nothing is shown', async () => {
  const view = { document: 'paper.pdf', page: 3, total_pages: 9, selected_text: 'a result' };
  assert.deepEqual(await (fakeWindow({ pdfView: view }).run)(command('get_pdf_view', {})), { ok: true, ...view });
  assert.match((await (fakeWindow().run)(command('get_pdf_view', {}))).error, /No PDF is shown/);
});

test('reading the window is refused for a project it is not showing', async () => {
  const { run } = fakeWindow({ project: '/p/other' });
  assert.match((await run(command('get_editor_state', {}))).error, /showing another project/);
});
