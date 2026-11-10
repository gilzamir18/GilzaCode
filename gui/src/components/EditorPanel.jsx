import { Suspense, lazy, useRef, useEffect, useState, useCallback, useDeferredValue, useMemo } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { Files, RefreshCw, Save, X, Maximize2, Minimize2, GitCompare, Eye, EyeOff, Printer, Download, ZoomIn, ZoomOut, PlusSquare, Type, Trash2, FileText, HelpCircle, MoreHorizontal, Zap, PenLine, Columns2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './modals/CustomDialogProvider';
import { getLanguage } from '../utils/language';
import { useBundledMonaco } from '../monaco/useBundledMonaco';
import {
  COUNT_MODE_AUTO,
  countTextStats,
  nextCountMode,
  resolveCountMode,
} from '../utils/textStats';
import { setPreference } from '../utils/preferences';
import InlinePromptOverlay from './InlinePromptOverlay';
import EditorContextMenuOverlay from './EditorContextMenuOverlay';
import TabContextMenu from './TabContextMenu';
import MarkdownContextMenu from './MarkdownContextMenu';
import TranslationPopup from './TranslationPopup';
import SnippetQueryPopup from './SnippetQueryPopup';
import SpeechPopup from './SpeechPopup';
import { useSnippetTranslation } from '../hooks/useSnippetTranslation';
import { useSnippetQuery } from '../hooks/useSnippetQuery';
import { useSnippetSpeech } from '../hooks/useSnippetSpeech';
import { findSelectionHeading, readSelectionWithin } from '../utils/documentSelection';
import { FormattedMessage } from '../utils/formatMessage';
import { pastePlainTextIntoMonaco } from '../utils/monacoPaste';
import { viewportPointToApp } from '../utils/uiScale';
import { markerPathKey } from '../utils/fileMarkers';
import Split from 'react-split';
import PdfPreview from './PdfPreview';
import HtmlPreview from './HtmlPreview';
import LatexSnippetsPanel from './LatexSnippetsPanel';
import RichTextEditor from './RichTextEditor';

// The WYSIWYG mode pulls in the whole ProseMirror stack, so it is loaded only
// when a file is actually switched into it.
const LatexWysiwygEditor = lazy(() => import('../wysiwyg/LatexWysiwygEditor.jsx'));

// Center panel: file tabs + Monaco editor (or empty state when no file is open).
export default function EditorPanel({
  // A Claude model alias for the excerpt actions (translate, look up); empty uses
  // the backend's defaults (settings translate_model / lookup_model).
  chatModel = '',
  selectedFile,
  openFiles,
  fileContent,
  originalFileContents,
  unsavedFiles,
  isSaving,
  theme,
  uiScale = 1,
  editorFontSize,
  setEditorFontSize,
  editorTabSize,
  editorWordWrap,
  editorMinimap = 'on',
  handleFileSelect,
  handleCloseTab,
  handleCloseOtherTabs,
  handleCloseAllTabs,
  saveFile,
  handleEditorDidMount,
  setFileContent,
  isMaximized,
  onToggleMaximize,
  // Inline prompt props
  inlinePrompt,
  setInlinePrompt,
  onInlineSubmit,
  onToggleTerminal,
  activeProject,
  jumpToLine,
  setJumpToLine,
  triggerCompileRequest,
  onCompileRequestHandled,
  onLatexCompileError,
  onLatexCompileSuccess,
  // The last compile an agent ran ({ seq, success, log, ... }); shown here as
  // if Compile had been pressed.
  // An agent's reveal_in_pdf ({ seq, file, line, resolve }), answered through
  // its resolver once the PDF pane shows the line.
  pdfRevealRequest,
  externalCompile,
  pdfViewProbeRef,
  onFixLatexProblem,
  onAskAboutPdf,
  onAskAboutMarkdown,
  speechSettingsSignal = 0,
  onTextStatsChange,
  // Set by a layout that is built around a visible preview (the studio). It
  // seeds the preview layout flags on entry rather than controlling them, so
  // the toolbar toggles keep working once the user is inside the layout.
  openPreviewByDefault,
}) {
  const { t, i18n } = useTranslation();
  // Monaco ships in the bundle; <Editor>/<DiffEditor> mount only once it is
  // loaded, so their loader never reaches for the CDN (see bundledMonaco.js).
  const bundledMonaco = useBundledMonaco();
  const { showAlert } = useCustomDialog();
  const [isDiffMode, setIsDiffMode] = useState(false);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  // Side-by-side source + rendered preview for Markdown/HTML, the counterpart
  // of the .tex editor's PDF split. Like isPdfPreviewCollapsed (and unlike
  // isPreviewMode, which replaces the editor), it is a layout choice rather
  // than a per-file mode, so it survives switching tabs.
  const [isSplitPreview, setIsSplitPreview] = useState(false);
  // Rich Text mode is per-file (a Set of file paths currently in Rich Text
  // mode), so switching tabs never turns it off for a tab the user didn't
  // explicitly exit — only the toggle button (or an explicit action like
  // SyncTeX jump-to-source) should leave Rich Text mode for a given file.
  const [richTextFiles, setRichTextFiles] = useState(() => new Set());
  const isRichTextMode = !!selectedFile && richTextFiles.has(selectedFile);
  // WYSIWYG mode is per-file for the same reason Rich Text is. The two are
  // mutually exclusive: they are different editors over the same file, and
  // running both would mean two models racing to write it.
  const [wysiwygFiles, setWysiwygFiles] = useState(() => new Set());
  const isWysiwygMode = !!selectedFile && wysiwygFiles.has(selectedFile);
  const [isPdfPreviewCollapsed, setIsPdfPreviewCollapsed] = useState(true);
  const [showSnippetsPanel, setShowSnippetsPanel] = useState(false);
  const [showLatexHelp, setShowLatexHelp] = useState(false);
  const [showDocumentActionsMenu, setShowDocumentActionsMenu] = useState(false);
  const [editorContextMenu, setEditorContextMenu] = useState(null);
  // Right-click menu for the tab bar: { x, y, filePath } or null.
  const [tabContextMenu, setTabContextMenu] = useState(null);
  // Right-click menu for the rendered Markdown preview: { x, y, selectedText,
  // heading } or null. The preview had no menu at all before — the app
  // suppresses the native one globally — so a right-click there did nothing.
  const [markdownContextMenu, setMarkdownContextMenu] = useState(null);
  const [markdownZoomLevel, setMarkdownZoomLevel] = useState(1.0);
  const pendingEditorLineRef = useRef(null);
  // Last known Rich Text active/initial line, per file — keyed by file path
  // so switching tabs never leaks one file's scroll position into another's.
  // Used to place the Monaco cursor when leaving Rich Text mode.
  const richTextSourceLinesRef = useRef({});
  // Last known Rich Text scroll offset, per file. Restoring a pixel offset is
  // exact, whereas a source line is not — block heights depend on lazy
  // mounting and async math rendering.
  const richTextScrollTopsRef = useRef({});
  // Where each PDF view was left — page, position within it, zoom — keyed by
  // the document being viewed. Switching to a tab of another kind unmounts the
  // viewer, so without this every return to a PDF started again at page one.
  const pdfViewStatesRef = useRef({});
  const documentActionsMenuRef = useRef(null);
  // The element the rendered Markdown preview draws into. Selections are
  // scoped to it: text selected elsewhere in the app is not an excerpt of this
  // document, and translating it would quote something the user never pointed
  // at (utils/documentSelection.js).
  const markdownPreviewRef = useRef(null);

  // Same request, same race guard and same popup as the PDF viewer (§2.13).
  const {
    translation,
    translate: runTranslation,
    retry: retryTranslation,
    copy: copyTranslation,
    close: closeTranslation,
  } = useSnippetTranslation({
    model: chatModel,
    uiLanguage: i18n.language,
  });

  // "Look up": a one-off question answered in a card, never in the chat (§2.13.4).
  const {
    query: lookup,
    open: openLookup,
    setQuestion: setLookupQuestion,
    submit: submitLookup,
    compose: composeLookup,
    copy: copyLookup,
    saveMarkdown: saveLookupMarkdown,
    close: closeLookup,
  } = useSnippetQuery({
    model: chatModel,
    projectPath: activeProject?.project_path || '',
  });

  const {
    speech,
    availability: speechAvailability,
    refreshAvailability: refreshSpeechAvailability,
    speak,
    toggle: toggleSpeech,
    replay: replaySpeech,
    retry: retrySpeech,
    close: closeSpeech,
  } = useSnippetSpeech({ settingsSignal: speechSettingsSignal });

  // The selection is read here, at right-click time, and not when a menu item
  // is pressed: pressing one collapses the selection, so reading it in the
  // handler would find nothing and the action would silently do nothing.
  const handleMarkdownContextMenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const container = markdownPreviewRef.current;
    closeTranslation();
    // Re-read at menu-open time rather than caching for the session, so
    // configuring speech in Settings takes effect without reopening the file.
    refreshSpeechAvailability();
    setMarkdownContextMenu({
      ...viewportPointToApp(event.clientX, event.clientY),
      selectedText: readSelectionWithin(container),
      heading: findSelectionHeading(container),
    });
  };

  const handleCopyMarkdownSelection = (menu) => {
    if (!menu?.selectedText) return;
    Promise.resolve(navigator.clipboard?.writeText?.(menu.selectedText)).catch(() => {});
  };

  const handleAskAboutMarkdown = (menu) => {
    if (!onAskAboutMarkdown || !selectedFile) return;
    onAskAboutMarkdown({
      documentPath: selectedFile,
      heading: menu.heading || '',
      selectedText: menu.selectedText || '',
    });
  };

  const handleLookUpMarkdownSelection = (menu) => {
    openLookup(menu.selectedText, { x: menu.x, y: menu.y }, {
      surface: 'markdown',
      documentPath: selectedFile || '',
      heading: menu.heading || '',
    });
  };

  const handleTranslateMarkdownSelection = (menu) => {
    runTranslation(menu.selectedText, { x: menu.x, y: menu.y });
  };

  const handlePronounceMarkdownSelection = (menu) => {
    speak(menu.selectedText, { x: menu.x, y: menu.y });
  };

  
  const isPdfFile = selectedFile && selectedFile.toLowerCase().endsWith('.pdf');
  // Identity of the document the PDF viewer shows. A standalone PDF is its own
  // file; the compiled preview is the project's output, shared by every .tex
  // tab, so moving between the project's sources never resets it. The viewer
  // is keyed by this too, so opening a second PDF starts at its own position
  // instead of inheriting the scroll offset of the one before it.
  const pdfViewKey = isPdfFile
    ? `file:${activeProject?.project_path || ''}:${selectedFile}`
    : `latex:${activeProject?.project_path || ''}`;
  const rememberPdfViewState = (state) => { pdfViewStatesRef.current[pdfViewKey] = state; };
  const isHtmlFile = selectedFile && /\.(html|htm)$/i.test(selectedFile);
  const isMarkdownFile = !!selectedFile && selectedFile.toLowerCase().endsWith('.md');
  // Files that have a rendered preview at all — the only ones the preview
  // buttons are offered for, in either full or side-by-side layout.
  const isPreviewableFile = isMarkdownFile || !!isHtmlFile;
  const isSplitPreviewActive = isPreviewableFile && isSplitPreview && !isPreviewMode;
  // Zoom, print and the Ctrl+= shortcuts apply to whichever preview is on screen.
  const isPreviewVisible = (isPreviewableFile && isPreviewMode) || isSplitPreviewActive;
  const isTexRelatedFile = (filename) => {
    if (!filename) return false;
    const ext = filename.split('.').pop().toLowerCase();
    return ['tex', 'cls', 'sty', 'bib'].includes(ext);
  };
  const isTexFile = isTexRelatedFile(selectedFile);
  const isNormalLatexEditor = isTexFile && !isRichTextMode && !isWysiwygMode && !isPreviewMode;

  const updateEditorFontSize = useCallback((updater) => {
    if (!setEditorFontSize) return;
    setEditorFontSize(prev => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      setPreference('editorFontSize', next);
      return next;
    });
  }, [setEditorFontSize]);

  // PDF state
  const [pdfUrl, setPdfUrl] = useState(null);
  const [isCompiling, setIsCompiling] = useState(false);
  const [pdfErrorLog, setPdfErrorLog] = useState('');
  const [latexCompileProblem, setLatexCompileProblem] = useState(null);
  const [compileTiming, setCompileTiming] = useState(null);
  const [cleanMessage, setCleanMessage] = useState('');
  const [isTectonicAvailable, setIsTectonicAvailable] = useState(true);
  const [isPandocAvailable, setIsPandocAvailable] = useState(true);
  const [isInstallingTectonic, setIsInstallingTectonic] = useState(false);
  const [isInstallingPandoc, setIsInstallingPandoc] = useState(false);
  const [isExportingDocx, setIsExportingDocx] = useState(false);
  const [isCleaningLatex, setIsCleaningLatex] = useState(false);
  const pendingPdfSyncRef = useRef(null);
  // reveal_in_pdf's scroll, held while the viewer (re)loads the document.
  const pendingPdfRevealRef = useRef(null);
  const handledPdfRevealRef = useRef(0);
  const lastCompiledContentsRef = useRef({});
  const lastHandledCompileRequestIdRef = useRef(null);

  const findFirstModifiedLine = (oldText, newText) => {
    const normOld = (oldText || '').replace(/\r\n/g, '\n');
    const normNew = (newText || '').replace(/\r\n/g, '\n');
    if (normOld === normNew) return null;
    const oldLines = normOld.split('\n');
    const newLines = normNew.split('\n');
    const maxLines = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLines; i++) {
      if (oldLines[i] !== newLines[i]) {
        return i + 1;
      }
    }
    return 1;
  };

  useEffect(() => {
    if (selectedFile && fileContent !== undefined) {
      if (lastCompiledContentsRef.current[selectedFile] === undefined) {
        lastCompiledContentsRef.current[selectedFile] = fileContent;
      }
    }
  }, [selectedFile, fileContent]);

  const getCurrentEditorLine = () => (
    localEditorRef.current?.getPosition?.()?.lineNumber || null
  );

  const syncPdfToEditorLine = useCallback(async ({ line, filePath, projectPath }) => {
    if (!line || !filePath || !projectPath) return false;
    try {
      const res = await fetch(`/api/latex/synctex?action=tex2pdf&line=${line}&filePath=${encodeURIComponent(filePath)}&projectPath=${encodeURIComponent(projectPath)}`);
      const data = await res.json();
      if (res.ok && data.result?.page && pdfPreviewRef.current) {
        pdfPreviewRef.current.scrollTo(data.result.page, data.result.x, data.result.y, data.result.w, data.result.h);
        return true;
      }
      if (!res.ok || data.error) {
        setPdfErrorLog(`SyncTeX Forward Search failed: ${data.error || 'No result found'}`);
      }
    } catch (err) {
      setPdfErrorLog("SyncTeX request failed: " + err.message);
    }
    return false;
  }, []);

  const handlePdfDocumentReady = useCallback(() => {
    const reveal = pendingPdfRevealRef.current;
    if (reveal) {
      pendingPdfRevealRef.current = null;
      reveal();
    }
    const pending = pendingPdfSyncRef.current;
    if (!pending) return;
    pendingPdfSyncRef.current = null;
    syncPdfToEditorLine(pending);
  }, [syncPdfToEditorLine]);

  const handleInstallTectonic = async () => {
    setIsInstallingTectonic(true);
    try {
      const res = await fetch('/api/settings/install-tectonic', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsTectonicAvailable(true);
      } else {
        await showAlert(t('editorPanel.installTectonicError') + (data.error || ''));
      }
    } catch (err) {
      await showAlert(t('editorPanel.installTectonicError') + err);
    } finally {
      setIsInstallingTectonic(false);
    }
  };

  const checkTectonic = () => {
    fetch('/api/latex/check-tectonic')
      .then(r => r.json())
      .then(data => setIsTectonicAvailable(data.found))
      .catch(() => {});
  };

  const checkPandoc = () => {
    fetch('/api/latex/check-pandoc')
      .then(r => r.json())
      .then(data => setIsPandocAvailable(data.found))
      .catch(() => {});
  };

  useEffect(() => {
    checkTectonic();
    checkPandoc();
    const checkDocumentTools = () => {
      checkTectonic();
      checkPandoc();
    };
    window.addEventListener('focus', checkDocumentTools);
    return () => window.removeEventListener('focus', checkDocumentTools);
  }, []);

  // Clear PDF only when switching projects
  const prevProjectRef = useRef(activeProject?.project_path);
  useEffect(() => {
    if (activeProject?.project_path !== prevProjectRef.current) {
      setPdfUrl(null);
      setPdfErrorLog('');
      prevProjectRef.current = activeProject?.project_path;
    }
  }, [activeProject?.project_path]);

  // ── Restore or compile ──────────────────────────────────────────────────
  useEffect(() => {
    setIsDiffMode(false);
    setIsPreviewMode(false);
    // Rich Text mode is intentionally NOT reset here — it's per-file (see
    // richTextFiles above), so a tab stays in Rich Text mode when you switch
    // away and back to it.
    setShowSnippetsPanel(false);
    
    // Check if there is an existing PDF for this file
    let cancelled = false;
    if (selectedFile && selectedFile.toLowerCase().endsWith('.tex') && activeProject?.project_path) {
      fetch(`/api/latex/check-pdf?filePath=${encodeURIComponent(selectedFile)}&projectPath=${encodeURIComponent(activeProject.project_path)}`)
        .then(r => r.json())
        .then(data => {
          // A late answer for a file the user has already left must not
          // replace the current file's PDF or reopen a pane they collapsed.
          if (cancelled) return;
          if (data.found && (data.pdf_url || data.pdf_base64)) {
            setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
            setPdfErrorLog('');
            // Opening a .tex that already has a compiled PDF shows it beside
            // the source. The pane still starts collapsed for a file with no
            // PDF yet, where it would only hold an empty viewer.
            setIsPdfPreviewCollapsed(false);
          }
          // If not found, do NOT clear pdfUrl, so the main document's PDF remains visible
          // when clicking into an included file (e.g., apendice.tex).
        })
        .catch(() => {});
    }
    // We also do NOT clear pdfUrl if not a .tex file,
    // so users can see the PDF while editing .bib or .cls files.
    return () => { cancelled = true; };
  }, [selectedFile, activeProject?.project_path]);

  // A compile Claude Code ran with the compile_latex MCP tool (routes_ide.py). Success reloads the PDF the
  // same way opening the .tex finds it (check-pdf also points /api/latex/pdf
  // at that file); failure fills the error card. The pane is not expanded,
  // just as the Compile button does not expand it.
  useEffect(() => {
    if (!externalCompile) return undefined;
    if (!externalCompile.success) {
      setPdfErrorLog(externalCompile.log);
      setLatexCompileProblem({ source: 'latex_compile', ...externalCompile, message: externalCompile.log });
      return undefined;
    }
    setPdfErrorLog('');
    setLatexCompileProblem(null);
    if (!selectedFile || !selectedFile.toLowerCase().endsWith('.tex') || !activeProject?.project_path) {
      return undefined;
    }
    let cancelled = false;
    fetch(`/api/latex/check-pdf?filePath=${encodeURIComponent(selectedFile)}&projectPath=${encodeURIComponent(activeProject.project_path)}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data.found && (data.pdf_url || data.pdf_base64)) {
          setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Only a new compile is an event; a tab switch is handled by the effect above.
  }, [externalCompile?.seq]);

  // An agent's reveal_in_pdf: the forward search Ctrl+Click runs, for a line the
  // agent names. App focuses the tab at that line first, so the request is taken
  // up once it is the selected file. The PDF is found the way opening the .tex
  // finds it (check-pdf, which also points the SyncTeX lookup at that PDF), the
  // pane is opened, and the scroll waits for the viewer when it is loading.
  useEffect(() => {
    const request = pdfRevealRequest;
    if (!request || request.seq === handledPdfRevealRef.current) return;
    if (request.file !== selectedFile || !activeProject?.project_path) return;
    handledPdfRevealRef.current = request.seq;
    const { file, line, resolve } = request;
    const query = `filePath=${encodeURIComponent(file)}&projectPath=${encodeURIComponent(activeProject.project_path)}`;
    const hadPdf = Boolean(pdfUrl);
    const paneWasOpen = !isPdfPreviewCollapsed;
    (async () => {
      try {
        const check = await (await fetch(`/api/latex/check-pdf?${query}`)).json();
        if (!check.found && !hadPdf) {
          resolve({ ok: false, error: `${file} has no compiled PDF yet: the document has to be compiled first.` });
          return;
        }
        const res = await fetch(`/api/latex/synctex?action=tex2pdf&line=${line}&${query}`);
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          resolve({
            ok: false,
            error: `The PDF of ${file} has no SyncTeX data: compile the document fully (a draft pass writes none) and reveal again.`,
          });
          return;
        }
        if (!res.ok) {
          resolve({ ok: false, error: `The SyncTeX lookup failed: ${data.error || `HTTP ${res.status}`}.` });
          return;
        }
        const position = data.result;
        if (!position?.page) {
          resolve({
            ok: false,
            error: `Line ${line} of ${file} has no typeset output in the PDF: it is a comment, preamble or `
              + 'text the document does not include, or the PDF was compiled before that line was written.',
          });
          return;
        }
        const reveal = () => {
          pdfPreviewRef.current?.scrollTo(position.page, position.x, position.y, position.w, position.h);
          resolve({ ok: true, page: position.page });
        };
        if (check.found) setPdfUrl(check.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
        setIsPdfPreviewCollapsed(false);
        // A new URL reloads the viewer and an opened pane mounts one; either
        // reports through handlePdfDocumentReady once the pages exist.
        if (check.found || !paneWasOpen || !pdfPreviewRef.current) pendingPdfRevealRef.current = reveal;
        else reveal();
      } catch (err) {
        resolve({ ok: false, error: `The PDF lookup failed: ${err.message}` });
      }
    })();
  }, [pdfRevealRequest, selectedFile, activeProject?.project_path]);

  // Jump to line effect when switching files
  useEffect(() => {
    if (jumpToLine && jumpToLine.file === selectedFile && localEditorRef.current) {
      // Small delay to ensure editor is mounted and file is loaded
      setTimeout(() => {
        if (localEditorRef.current) {
          localEditorRef.current.revealLineInCenter(jumpToLine.line);
          localEditorRef.current.setPosition({ lineNumber: jumpToLine.line, column: 1 });
          if (jumpToLine.focusEditor !== false) localEditorRef.current.focus();
        }
        setJumpToLine(null);
      }, 100);
    }
  }, [selectedFile, jumpToLine, setJumpToLine]);

  const handleCompile = async (skipSave = false, partial = false, draft = false) => {
    setIsCompiling(true);
    setPdfErrorLog('');
    setCleanMessage('');
    setCompileTiming(null);
    if (!skipSave) {
      const saved = await saveFile({ suppressCompile: true });
      if (!saved) {
        setIsCompiling(false);
        return;
      }
    }
    const oldContent = lastCompiledContentsRef.current[selectedFile];
    const compileLine = findFirstModifiedLine(oldContent, fileContent);
    const compileFile = selectedFile;
    const compileProjectPath = activeProject?.project_path;
    try {
      const res = await fetch('/api/latex/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: fileContent,
          filePath: selectedFile,
          projectPath: activeProject?.project_path,
          projectName: activeProject?.name || '',
          mainFile: activeProject?.main_file || '',
          partial,
          draft,
        })
      });
      const data = await res.json();
      if (data.timing) setCompileTiming(data.timing);
      if (data.success) {
        setLatexCompileProblem(null);
        onLatexCompileSuccess?.({
          filePath: selectedFile,
          compiledMainFile: data.compiled_main_file || '',
          compileDebug: data.compile_debug || {},
          partial,
          draft,
        });
        const compileSynctexEnabled = data.compile_debug?.synctex_enabled !== false;
        if (compileLine && compileFile && compileProjectPath && compileSynctexEnabled) {
          pendingPdfSyncRef.current = {
            line: compileLine,
            filePath: compileFile,
            projectPath: compileProjectPath,
          };
        }
        lastCompiledContentsRef.current[compileFile] = fileContent;
        setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
      } else {
        const problem = {
          source: 'latex_compile',
          filePath: selectedFile,
          fileContent,
          projectPath: activeProject?.project_path || '',
          projectName: activeProject?.name || '',
          mainFile: activeProject?.main_file || '',
          compiledMainFile: data.compiled_main_file || '',
          log: data.log || 'LaTeX compilation failed.',
          message: data.log || 'LaTeX compilation failed.',
          compileDebug: data.compile_debug || {},
          partial: Boolean(partial),
          draft: Boolean(draft),
        };
        setPdfErrorLog(problem.log);
        setLatexCompileProblem(problem);
        onLatexCompileError?.({
          filePath: selectedFile,
          fileContent,
          projectPath: activeProject?.project_path || '',
          projectName: activeProject?.name || '',
          mainFile: activeProject?.main_file || '',
          compiledMainFile: data.compiled_main_file || '',
          log: data.log || 'LaTeX compilation failed.',
          compileDebug: data.compile_debug || {},
          partial,
          draft,
        });
        if (data.pdf_url || data.pdf_base64) setPdfUrl(data.pdf_url || `/api/latex/pdf?ts=${Date.now()}`);
        else setPdfUrl(null);
      }
    } catch (err) {
      const message = 'Failed to connect to backend: ' + err.message;
      const problem = {
        source: 'latex_compile',
        filePath: selectedFile,
        fileContent,
        projectPath: activeProject?.project_path || '',
        projectName: activeProject?.name || '',
        mainFile: activeProject?.main_file || '',
        compiledMainFile: '',
        log: message,
        message,
        compileDebug: {},
        partial: Boolean(partial),
        draft: Boolean(draft),
      };
      setPdfErrorLog(message);
      setLatexCompileProblem(problem);
      onLatexCompileError?.({
        filePath: selectedFile,
        fileContent,
        projectPath: activeProject?.project_path || '',
        projectName: activeProject?.name || '',
        mainFile: activeProject?.main_file || '',
        compiledMainFile: '',
        log: message,
        compileDebug: {},
        partial,
        draft,
      });
      setPdfUrl(null);
    } finally {
      setIsCompiling(false);
    }
  };

  const handleCleanLatex = async () => {
    if (!activeProject?.project_path) return;
    setIsCleaningLatex(true);
    setPdfErrorLog('');
    setCompileTiming(null);
    setCleanMessage('');
    try {
      const res = await fetch('/api/latex/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path })
      });
      const data = await res.json();
      if (data.success) {
        setPdfUrl(null);
        setCleanMessage(`Cleaned ${data.removed?.length || 0}`);
      } else {
        setPdfErrorLog((data.errors || ['Clean failed']).join('\n'));
      }
    } catch (err) {
      setPdfErrorLog('Failed to clean LaTeX artifacts: ' + err.message);
    } finally {
      setIsCleaningLatex(false);
    }
  };

  const handleInstallPandoc = async () => {
    setIsInstallingPandoc(true);
    try {
      const res = await fetch('/api/settings/install-pandoc', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        setIsPandocAvailable(true);
      } else {
        await showAlert(t('editorPanel.installPandocError') + (data.error || ''));
      }
    } catch (err) {
      await showAlert(t('editorPanel.installPandocError') + err);
    } finally {
      setIsInstallingPandoc(false);
    }
  };

  const handleExportDocx = async () => {
    const saved = await saveFile({ suppressCompile: true });
    if (!saved) return;
    setIsExportingDocx(true);
    setCleanMessage('');
    try {
      const res = await fetch('/api/latex/export-docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: fileContent,
          filePath: selectedFile,
          projectPath: activeProject?.project_path,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setCleanMessage(`DOCX: ${data.relative_output_path || data.output_path}`);
      } else {
        if (data.pandoc_found === false) setIsPandocAvailable(false);
        // Not the PDF preview's error panel: it is collapsed until the first
        // compile, and a DOCX failure is not a LaTeX compile error.
        await showAlert(t('editorPanel.exportDocxError', 'DOCX export failed: ') + (data.log || data.error || ''));
      }
    } catch (err) {
      await showAlert(t('editorPanel.exportDocxError', 'DOCX export failed: ') + err.message);
    } finally {
      setIsExportingDocx(false);
    }
  };

  const formatCompileTiming = (timing) => {
    if (!timing) return '';
    const seconds = timing.compile_seconds ?? timing.request_seconds;
    if (typeof seconds !== 'number') return '';
    return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  };

  useEffect(() => {
    const requestId = triggerCompileRequest?.id;
    if (!requestId || lastHandledCompileRequestIdRef.current === requestId) return;
    lastHandledCompileRequestIdRef.current = requestId;

    void (async () => {
      try {
        await handleCompile(true, triggerCompileRequest.partial === true);
      } finally {
        onCompileRequestHandled?.(requestId);
      }
    })();
  }, [triggerCompileRequest]);

  useEffect(() => {
    if (!showDocumentActionsMenu) return;
    const handlePointerDown = (event) => {
      if (!documentActionsMenuRef.current?.contains(event.target)) {
        setShowDocumentActionsMenu(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showDocumentActionsMenu]);

  const handlePrintPDF = () => {
    document.body.classList.add('printing-editor');
    window.print();
  };

  // Ref so the Monaco command closure always calls the latest callback,
  // even after React re-renders update isTerminalCollapsed state.
  const onToggleTerminalRef = useRef(onToggleTerminal);
  onToggleTerminalRef.current = onToggleTerminal;

  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  // The content Monaco creates a file's model with. @monaco-editor/react reads
  // `defaultValue` in the very commit whose `path` names a file it has no model
  // for yet, so it has to be the new file's content in that render. It used to
  // be refreshed by an effect, which runs after that commit: the new file's
  // model was created holding the previous file's text, and while the editor
  // kept keyboard focus (the sync below leaves a focused editor alone) the tab
  // showed — and the next tab switch cached — the other file's content. It is
  // keyed on the file rather than following every keystroke, since it is only
  // ever read when a model is created.
  const editorDefaultValue = useMemo(
    () => fileContent ?? '',
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedFile],
  );

  const localEditorRef = useRef(null);
  const monacoRef = useRef(null);
  const editorContainerRef = useRef(null);
  const pdfPreviewRef = useRef(null);
  // For the get_pdf_view MCP tool: what the PDF pane shows, or null.
  if (pdfViewProbeRef) {
    pdfViewProbeRef.current = () => {
      const view = pdfPreviewRef.current?.getViewState?.();
      if (!view || !selectedFile) return null;
      const source = isPdfFile ? '' : selectedFile;
      const document = isPdfFile
        ? selectedFile
        : String(activeProject?.main_file || selectedFile).replace(/\.tex$/i, '.pdf');
      return { document, ...(source ? { source_file: source } : {}), ...view };
    };
  }
  const pendingEditorValueRef = useRef(null);
  const pendingEditorFileRef = useRef(null);
  const pendingEditorChangeTimerRef = useRef(null);

  // ── Side-by-side preview scrolling ──────────────────────────────────────
  // The two panes are linked proportionally: the Markdown renderer produces no
  // source-line anchors, so there is nothing to map a source line onto, and a
  // scroll-height ratio is the only honest correspondence available. Only the
  // pane the pointer is over drives the other, which is what keeps the link
  // from feeding back on itself — mirroring a scroll offset triggers the other
  // pane's own scroll event, and two handlers echoing each other would fight.
  // Typing in the source pane commits a new buffer every 250 ms, and each
  // commit re-parses the whole document through Markdown + KaTeX. Deferring the
  // preview lets React drop intermediate buffers while the user is still
  // typing, so keystrokes are never blocked waiting on the render.
  const deferredPreviewContent = useDeferredValue(fileContent);

  const previewScrollRef = useRef(null);
  const scrollSourcePaneRef = useRef(null);
  const isSplitPreviewActiveRef = useRef(false);

  const syncPreviewScrollFromEditor = useCallback(() => {
    if (!isSplitPreviewActiveRef.current) return;
    if (scrollSourcePaneRef.current !== 'editor') return;
    const editor = localEditorRef.current;
    const preview = previewScrollRef.current;
    if (!editor || !preview) return;
    const editorRange = editor.getScrollHeight() - (editor.getLayoutInfo?.()?.height || 0);
    const previewRange = preview.scrollHeight - preview.clientHeight;
    if (editorRange <= 0 || previewRange <= 0) return;
    const ratio = Math.min(1, Math.max(0, editor.getScrollTop() / editorRange));
    preview.scrollTop = ratio * previewRange;
  }, []);

  const syncEditorScrollFromPreview = useCallback(() => {
    if (!isSplitPreviewActiveRef.current) return;
    if (scrollSourcePaneRef.current !== 'preview') return;
    const editor = localEditorRef.current;
    const preview = previewScrollRef.current;
    if (!editor || !preview) return;
    const editorRange = editor.getScrollHeight() - (editor.getLayoutInfo?.()?.height || 0);
    const previewRange = preview.scrollHeight - preview.clientHeight;
    if (editorRange <= 0 || previewRange <= 0) return;
    const ratio = Math.min(1, Math.max(0, preview.scrollTop / previewRange));
    editor.setScrollTop(ratio * editorRange);
  }, []);

  // Monaco commands and the sync callbacks are registered once, at mount, so
  // they read the current layout through refs instead of a stale closure.
  isSplitPreviewActiveRef.current = isSplitPreviewActive;
  const isPreviewVisibleRef = useRef(false);
  isPreviewVisibleRef.current = isPreviewVisible;

  const flushPendingEditorContent = useCallback(() => {
    if (pendingEditorChangeTimerRef.current) {
      clearTimeout(pendingEditorChangeTimerRef.current);
      pendingEditorChangeTimerRef.current = null;
    }
    if (pendingEditorValueRef.current === null) return;
    if (pendingEditorFileRef.current !== selectedFileRef.current) {
      pendingEditorValueRef.current = null;
      pendingEditorFileRef.current = null;
      return;
    }
    const nextValue = pendingEditorValueRef.current;
    pendingEditorValueRef.current = null;
    pendingEditorFileRef.current = null;
    setFileContent(nextValue);
  }, [setFileContent]);

  const scheduleEditorContentCommit = useCallback((nextValue) => {
    pendingEditorValueRef.current = nextValue ?? '';
    pendingEditorFileRef.current = selectedFileRef.current;
    if (pendingEditorChangeTimerRef.current) {
      clearTimeout(pendingEditorChangeTimerRef.current);
    }
    pendingEditorChangeTimerRef.current = setTimeout(flushPendingEditorContent, 250);
  }, [flushPendingEditorContent]);

  useEffect(() => () => {
    if (pendingEditorChangeTimerRef.current) {
      clearTimeout(pendingEditorChangeTimerRef.current);
      pendingEditorChangeTimerRef.current = null;
    }
  }, []);

  // ── Word / character counting ───────────────────────────────────────────
  // Counting is mode-aware (LaTeX, Markdown, plain text) so markup is not
  // mistaken for prose. The mode follows the file extension unless the user
  // overrides it from the status bar; overrides are kept per file.
  const [countModeOverrides, setCountModeOverrides] = useState({});
  const [editorSelectionText, setEditorSelectionText] = useState('');
  const selectionStatsTimerRef = useRef(null);

  const countModeOverride = (selectedFile && countModeOverrides[selectedFile]) || COUNT_MODE_AUTO;
  const resolvedCountMode = resolveCountMode(selectedFile, countModeOverride);

  const cycleCountMode = useCallback(() => {
    const file = selectedFileRef.current;
    if (!file) return;
    setCountModeOverrides(prev => ({
      ...prev,
      [file]: nextCountMode(prev[file] || COUNT_MODE_AUTO),
    }));
  }, []);

  // Selection counting is debounced: dragging a selection fires the Monaco
  // event on every mouse move, and each recount re-parses the selected text.
  const scheduleSelectionStats = useCallback((editor) => {
    if (selectionStatsTimerRef.current) clearTimeout(selectionStatsTimerRef.current);
    selectionStatsTimerRef.current = setTimeout(() => {
      selectionStatsTimerRef.current = null;
      const model = editor?.getModel?.();
      const selection = editor?.getSelection?.();
      if (!model || !selection || selection.isEmpty?.()) {
        setEditorSelectionText('');
        return;
      }
      setEditorSelectionText(model.getValueInRange(selection));
    }, 120);
  }, []);

  useEffect(() => {
    setEditorSelectionText('');
  }, [selectedFile, isRichTextMode, isWysiwygMode, isPreviewMode]);

  useEffect(() => () => {
    if (selectionStatsTimerRef.current) {
      clearTimeout(selectionStatsTimerRef.current);
      selectionStatsTimerRef.current = null;
    }
  }, []);

  // The PDF panel renders its own content — fileContent is not the text the
  // user sees, so no count is reported for it.
  const supportsTextStats = !!selectedFile && !isPdfFile;

  const documentTextStats = useMemo(
    () => (supportsTextStats ? countTextStats(fileContent ?? '', resolvedCountMode) : null),
    [supportsTextStats, fileContent, resolvedCountMode],
  );

  const selectionTextStats = useMemo(
    () => (supportsTextStats && editorSelectionText
      ? countTextStats(editorSelectionText, resolvedCountMode)
      : null),
    [supportsTextStats, editorSelectionText, resolvedCountMode],
  );

  const onTextStatsChangeRef = useRef(onTextStatsChange);
  onTextStatsChangeRef.current = onTextStatsChange;

  useEffect(() => {
    onTextStatsChangeRef.current?.(documentTextStats
      ? {
        ...documentTextStats,
        modeOverride: countModeOverride,
        selection: selectionTextStats,
        onCycleMode: cycleCountMode,
      }
      : null);
  }, [documentTextStats, selectionTextStats, countModeOverride, cycleCountMode]);

  // Clear the status bar when the editor panel goes away.
  useEffect(() => () => onTextStatsChangeRef.current?.(null), []);

  const syncEditorValue = useCallback((editor, nextValue) => {
    const model = editor?.getModel?.();
    if (!model) return;
    const normalizedValue = nextValue ?? '';
    if (model.getValue() === normalizedValue) return;

    if (pendingEditorChangeTimerRef.current) {
      clearTimeout(pendingEditorChangeTimerRef.current);
      pendingEditorChangeTimerRef.current = null;
    }
    pendingEditorValueRef.current = null;
    pendingEditorFileRef.current = null;

    const hadTextFocus = editor.hasTextFocus?.() || false;
    const viewState = editor.saveViewState?.();
    const selections = editor.getSelections?.();

    model.setValue(normalizedValue);

    if (viewState) {
      editor.restoreViewState?.(viewState);
    } else if (selections?.length) {
      editor.setSelections?.(selections);
    }
    if (hadTextFocus) editor.focus();
  }, []);

  // The file whose buffer the Monaco model was last brought in line with.
  const syncedEditorFileRef = useRef(null);

  useEffect(() => {
    if (isDiffMode || isRichTextMode || isWysiwygMode || isPreviewMode) return;
    const editor = localEditorRef.current;
    if (!editor) return;
    // While the user types, the model is ahead of `fileContent` (it is
    // committed on a debounce), so a focused editor or a pending commit is left
    // alone. A file switch is not typing: the model now on screen is the new
    // file's — one Monaco kept from an earlier visit, possibly older than the
    // buffer — and must show that file's buffer even when the switch did not
    // take the focus away, as when an agent's open_file swaps the tab under
    // the user's cursor.
    const switchedFile = syncedEditorFileRef.current !== selectedFile;
    syncedEditorFileRef.current = selectedFile;
    if (!switchedFile) {
      if (editor.hasTextFocus?.()) return;
      if (pendingEditorValueRef.current !== null) return;
    }
    syncEditorValue(editor, fileContent);
  }, [fileContent, isDiffMode, isRichTextMode, isWysiwygMode, isPreviewMode, selectedFile, syncEditorValue]);

  const revealEditorLine = useCallback((line) => {
    if (!line || !localEditorRef.current) return false;
    localEditorRef.current.revealLineInCenter(line);
    localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
    localEditorRef.current.focus();
    return true;
  }, []);

  const exitRichTextMode = useCallback((line = richTextSourceLinesRef.current[selectedFile]) => {
    if (line) pendingEditorLineRef.current = line;
    setRichTextFiles(prev => {
      if (!selectedFile || !prev.has(selectedFile)) return prev;
      const next = new Set(prev);
      next.delete(selectedFile);
      return next;
    });
  }, [selectedFile]);
  
  const exitWysiwygMode = useCallback((line = richTextSourceLinesRef.current[selectedFile]) => {
    if (line) pendingEditorLineRef.current = line;
    setWysiwygFiles(prev => {
      if (!selectedFile || !prev.has(selectedFile)) return prev;
      const next = new Set(prev);
      next.delete(selectedFile);
      return next;
    });
  }, [selectedFile]);

  const handleSyncTexNavigate = (line, file) => {
    // file is a project-relative path returned from the SyncTeX backend
    const normalizeSlash = (p) => (p || '').replace(/\\/g, '/');
    const normalizedFile = normalizeSlash(file);
    const normalizedSelected = normalizeSlash(selectedFile);

    // Guard against empty/invalid file paths from SyncTeX — these would
    // open a blank untitled tab in the editor.
    if (!file || !file.trim()) {
      if (isRichTextMode) {
        exitRichTextMode(line);
      } else if (localEditorRef.current) {
        localEditorRef.current.revealLineInCenter(line);
        localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
        localEditorRef.current.focus();
      }
      return;
    }

    if (normalizedFile !== normalizedSelected) {
      // Switching to a different file — handleFileSelect sets jumpToLine so
      // the editor navigates after the file loads. Exit Rich Text mode
      // first so Monaco mounts and can consume the jump target.
      if (isRichTextMode) exitRichTextMode(line);
      handleFileSelect(file, line);
    } else if (isRichTextMode) {
      // Same file, but Monaco is not mounted in Rich Text mode — exit to
      // Monaco and let the mount handler reveal the target line.
      exitRichTextMode(line);
    } else if (localEditorRef.current) {
      localEditorRef.current.revealLineInCenter(line);
      localEditorRef.current.setPosition({ lineNumber: line, column: 1 });
      localEditorRef.current.focus();
    }
  };

  // ── Insert LaTeX snippet at the current cursor position ──────────────────
  const handleInsertSnippet = (snippetBody) => {
    // In Rich Text mode, Monaco is not mounted — append to fileContent
    if (isRichTextMode) {
      setFileContent(fileContent + '\n' + snippetBody + '\n');
      setShowSnippetsPanel(false);
      return;
    }
    const ed = localEditorRef.current;
    if (!ed) {
      // Fallback: append to content
      setFileContent(fileContent + '\n' + snippetBody + '\n');
      setShowSnippetsPanel(false);
      return;
    }
    const position = ed.getPosition();
    const model = ed.getModel();
    if (!model || !position) return;
    // Insert with surrounding newlines for block snippets
    const lineContent = model.getLineContent(position.lineNumber);
    const isBlock = snippetBody.includes('\n');
    let text = snippetBody;
    if (isBlock && lineContent.trim() !== '') {
      text = '\n' + text;
    }
    ed.executeEdits('gilzabots-snippet', [{
      range: {
        startLineNumber: position.lineNumber,
        startColumn: position.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      text,
      forceMoveMarkers: true,
    }]);
    ed.focus();
    setShowSnippetsPanel(false);
  };

  // ── Jump from Rich Text block to source line in Monaco ──────────────────
  const handleRichTextJumpToSource = (line, _charOffset) => {
    // Leave whichever document editor is active and show Monaco at the target
    // line. Both modes render blocks they cannot edit as "jump to source", so
    // the same handler serves them.
    exitRichTextMode(line);
    exitWysiwygMode(line);
  };

  // Custom syntax definitions
  const handleBeforeMount = (monaco) => {
    const languages = monaco.languages.getLanguages();
    if (!languages.some(lang => lang.id === 'latex')) {
      monaco.languages.register({ id: 'latex' });
      monaco.languages.setMonarchTokensProvider('latex', {
        tokenizer: {
          root: [
            [/\\[a-zA-Z]+/, 'keyword'],
            [/\\./, 'string.escape'],
            [/%.*$/, 'comment'],
            [/[{}]/, 'delimiter.bracket'],
            [/\$/, 'string.quote'],
            [/[\[\]]/, 'delimiter.array'],
          ]
        }
      });
    }
  };

  const focusVisibleFindInput = useCallback((editor) => {
    const root = editor?.getDomNode?.()?.ownerDocument || document;
    const widgets = Array.from(root.querySelectorAll('.editor-widget.find-widget'))
      .filter(widget => widget.getAttribute('aria-hidden') !== 'true' && !widget.inert);
    const input = widgets
      .map(widget => widget.querySelector('.monaco-inputbox input, input[type="text"], textarea'))
      .find(Boolean);
    if (!input) return false;
    input.focus();
    input.select?.();
    return true;
  }, []);

  const focusFindInputAfterOpen = useCallback((editor) => {
    const tryFocus = () => focusVisibleFindInput(editor);
    requestAnimationFrame(() => {
      if (tryFocus()) return;
      setTimeout(tryFocus, 0);
      setTimeout(tryFocus, 50);
    });
  }, [focusVisibleFindInput]);

  // Wrap the external mount handler so we can also register the context-menu
  // actions and the Ctrl+L shortcut ourselves.
  const handleMount = (editor, monaco) => {
    const isDiff = typeof editor.getModifiedEditor === 'function';
    const actualEditor = isDiff ? editor.getModifiedEditor() : editor;

    localEditorRef.current = actualEditor;
    monacoRef.current = monaco;

    if (!isDiff) {
      syncEditorValue(actualEditor, fileContent);
    }

    if (isDiff) {
      const originalDispose = editor.dispose;
      editor.dispose = function() {
        try { editor.setModel(null); } catch (e) {}
        originalDispose.apply(this, arguments);
      };

      actualEditor.onDidChangeModelContent(() => {
        scheduleEditorContentCommit(actualEditor.getValue());
      });
    }

    actualEditor.onDidBlurEditorText?.(() => {
      flushPendingEditorContent();
    });

    actualEditor.onDidChangeCursorSelection?.(() => {
      scheduleSelectionStats(actualEditor);
    });

    actualEditor.onDidScrollChange?.(() => {
      syncPreviewScrollFromEditor();
    });

    // Typing is an editor-driven scroll even when the pointer is resting over
    // the preview, so it claims the link the same way a wheel or click does.
    actualEditor.onDidChangeModelContent?.(() => {
      scrollSourcePaneRef.current = 'editor';
    });
    actualEditor.onDidFocusEditorText?.(() => {
      scrollSourcePaneRef.current = 'editor';
    });

    // ── Forward Search (Ctrl+Click or Alt+Click on editor) ───────────────────────────────
    actualEditor.onMouseUp(async (e) => {
      // Check if Ctrl, Meta (Cmd on Mac), or Alt is pressed
      if (e.event.ctrlKey || e.event.metaKey || e.event.altKey) {
        const line = e.target.position?.lineNumber;
        const currentProject = activeProjectRef.current;
        const currentFile = selectedFileRef.current;
        
        if (line && currentProject?.project_path && currentFile) {
          syncPdfToEditorLine({
            line,
            filePath: currentFile,
            projectPath: currentProject.project_path,
          });
        }
      }
    });

    // ── Ctrl+J — toggle terminal ────────────────────────────────────────────
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyJ,
      () => {
        if (onToggleTerminalRef.current) onToggleTerminalRef.current();
      }
    );

    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF,
      () => {
        actualEditor.getAction('actions.find')?.run();
        focusFindInputAfterOpen(actualEditor);
      }
    );

    // ── Ctrl+L — open inline free prompt ────────────────────────────────────
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL,
      () => {
        const model = actualEditor.getModel();
        const sel = actualEditor.getSelection();
        if (!model || !sel) return;

        const selectedText = model.getValueInRange(sel);
        const pos = actualEditor.getPosition();

        // Get pixel coordinates near the cursor
        const coords = actualEditor.getScrolledVisiblePosition(pos);
        const domNode = actualEditor.getDomNode();
        const rect = domNode?.getBoundingClientRect() ?? { left: 200, top: 100 };

        setInlinePrompt({
          x: rect.left + (coords?.left ?? 60) + 20,
          y: rect.top + (coords?.top ?? 40) + 24,
          startLine: sel.startLineNumber,
          endLine: sel.endLineNumber,
          startColumn: sel.startColumn,
          endColumn: sel.endColumn,
          cursorCol: pos?.column ?? 1,
          selectedText,
          mode: 'free',
        });
      }
    );

    // ── Ctrl++ / Ctrl+- — Markdown preview zoom ───────────────────────────
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Equal,
      () => {
        if (isPreviewVisibleRef.current) {
          setMarkdownZoomLevel(prev => Math.min(2.0, prev + 0.1));
        }
      }
    );
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Minus,
      () => {
        if (isPreviewVisibleRef.current) {
          setMarkdownZoomLevel(prev => Math.max(0.5, prev - 0.1));
        }
      }
    );
    actualEditor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyNumpad0,
      () => {
        if (isPreviewVisibleRef.current) {
          setMarkdownZoomLevel(1.0);
        }
      }
    );

    // ── Paste via Ctrl+V keybinding (navigator.clipboard.readText may fail
    //    while context menu is open; using backend clipboard read instead).
    actualEditor.addAction({
      id: 'gilzabots.paste',
      label: 'Paste',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV],
      precondition: 'editorTextFocus',
      run: async (ed) => {
        let text = '';
        try {
          const res = await fetch('/api/clipboard/read');
          const data = await res.json();
          text = data.text ?? '';
        } catch (_) {}
        if (text) pastePlainTextIntoMonaco(ed, text);
      },
    });

    // Delegate to the parent-level mount handler (font-size, Ctrl+S, etc.)
    if (handleEditorDidMount) handleEditorDidMount(actualEditor, monaco);
    
    // Focus the editor when it is first mounted
    setTimeout(() => {
      const pendingLine = pendingEditorLineRef.current;
      if (pendingLine && revealEditorLine(pendingLine)) {
        pendingEditorLineRef.current = null;
      } else {
        actualEditor.focus();
      }
    }, 50);
  };

  // ── Custom context menu listener on the editor container ────────────────
  // Attached to the stable container div via ref, reads the current editor
  // from localEditorRef so it survives file switches and editor remounts.
  useEffect(() => {
    const container = editorContainerRef.current;
    if (!container) return;

    const handleContextMenu = (e) => {
      const ed = localEditorRef.current;
      const monaco = monacoRef.current;
      if (!ed || !monaco) return;

      // Only intercept right-clicks inside the editor area
      const editorDom = ed.getDomNode();
      if (!editorDom || !editorDom.contains(e.target)) return;

      e.preventDefault();
      e.stopPropagation();

      const model = ed.getModel();
      const sel = ed.getSelection();
      const pos = ed.getPosition();
      const hasSelection = sel && !sel.isEmpty();
      const selectedText = hasSelection ? model?.getValueInRange(sel) : '';

      // Positioned with left/top inside the zoomed app — see viewportPointToApp.
      const point = viewportPointToApp(e.clientX, e.clientY);
      setEditorContextMenu({
        x: point.x,
        y: point.y,
        editor: ed,
        monaco,
        hasSelection,
        selectedText,
        pos,
        sel,
      });
    };

    container.addEventListener('contextmenu', handleContextMenu, true);
    return () => container.removeEventListener('contextmenu', handleContextMenu, true);
  }, [selectedFile]);

  useEffect(() => {
    if (localEditorRef.current && selectedFile) {
      setTimeout(() => localEditorRef.current?.focus(), 50);
    }
  }, [selectedFile]);

  useEffect(() => {
    setShowLatexHelp(false);
  }, [selectedFile]);

  // Entering a preview-first layout opens the split the user would otherwise
  // have to reach for by hand: the side-by-side preview for Markdown/HTML and
  // the PDF pane for LaTeX, whichever the open file has. isPreviewMode is
  // cleared because a full preview replaces the editor the split exists to
  // pair the preview with.
  useEffect(() => {
    if (!openPreviewByDefault) return;
    setIsPreviewMode(false);
    setIsSplitPreview(true);
    setIsPdfPreviewCollapsed(false);
  }, [openPreviewByDefault]);

  if (!selectedFile) {
    return (
      <div className="vscode-editor-container" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <Files size={64} style={{ color: 'var(--vscode-border)', marginBottom: '16px' }} />
          <h3 style={{ fontSize: '14px', fontWeight: 'bold', color: 'var(--vscode-text-fg)', marginBottom: '4px' }}>{t('editorPanel.noFileOpen')}</h3>
          <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>{t('editorPanel.openFileHint')}</p>
        </div>
      </div>
    );
  }

  const minimapEnabled = editorMinimap !== 'off';

  // Monaco (or its diff variant) for every file that is not handled by a
  // dedicated panel. Shared by the plain editor layout and by the left pane of
  // the Markdown/HTML side-by-side layout, so the two can never drift apart.
  // Shown in place of Monaco until the bundled editor has loaded, and with the
  // reason and a retry if its chunk failed to load, instead of a placeholder
  // that waits forever.
  const renderMonacoStatus = () => (
    <div
      className="monaco-load-status"
      data-status={bundledMonaco.status}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '16px', textAlign: 'center' }}
    >
      {bundledMonaco.status === 'error' ? (
        <>
          <p style={{ fontSize: '13px', color: 'var(--vscode-errorForeground, var(--vscode-text-fg))' }}>
            {t('editorPanel.editorLoadFailed', 'The code editor could not be loaded.')}
          </p>
          <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)', wordBreak: 'break-word' }}>
            {String(bundledMonaco.error?.message || bundledMonaco.error || '')}
          </p>
          <button type="button" className="vscode-button" onClick={bundledMonaco.retry}>
            {t('editorPanel.editorLoadRetry', 'Try again')}
          </button>
        </>
      ) : (
        <p style={{ fontSize: '12px', color: 'var(--vscode-descriptionForeground)' }}>
          {t('editorPanel.editorLoading', 'Loading editor…')}
        </p>
      )}
    </div>
  );

  const renderPlainEditorSurface = () => (
    bundledMonaco.status !== 'ready' ? renderMonacoStatus() : isDiffMode ? (
      <DiffEditor
        height="100%"
        language={getLanguage(selectedFile)}
        theme={theme === 'light' ? 'light' : 'vs-dark'}
        original={originalFileContents ? (originalFileContents[selectedFile] || '') : ''}
        modified={fileContent}
        originalModelPath={`original-${selectedFile}`}
        modifiedModelPath={`modified-${selectedFile}`}
        keepCurrentOriginalModel
        keepCurrentModifiedModel
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        options={{
          contextmenu: false,
          minimap: { enabled: minimapEnabled },
          fontSize: editorFontSize,
          lineNumbers: 'on',
          tabSize: editorTabSize,
          wordWrap: editorWordWrap,
          automaticLayout: true,
          renderSideBySide: true,
          readOnly: false,
          originalEditable: false,
          fixedOverflowWidgets: true,
        }}
      />
    ) : (
      <Editor
        height="100%"
        path={selectedFile}
        language={getLanguage(selectedFile)}
        theme={theme === 'light' ? 'light' : 'vs-dark'}
        defaultValue={editorDefaultValue}
        beforeMount={handleBeforeMount}
        onChange={scheduleEditorContentCommit}
        onMount={handleMount}
        options={{
          contextmenu: false,
          minimap: { enabled: minimapEnabled },
          fontSize: editorFontSize,
          lineNumbers: 'on',
          tabSize: editorTabSize,
          wordWrap: editorWordWrap,
          automaticLayout: true,
          fixedOverflowWidgets: true,
        }}
      />
    )
  );

  // Rendered preview of a Markdown or HTML file. `linked` wires the scroller
  // into the side-by-side scroll sync; the HTML preview is a sandboxed iframe
  // with an opaque origin, so its scroll offset is unreachable from here and it
  // is deliberately left unlinked rather than faked.
  const renderRenderedPreview = (linked = false) => (
    isHtmlFile ? (
      <HtmlPreview
        html={fileContent}
        activeProjectPath={activeProject?.project_path}
        selectedFile={selectedFile}
        title={t('editorPanel.previewHtml')}
        zoomLevel={markdownZoomLevel}
      />
    ) : (
      <div
        ref={(el) => {
          markdownPreviewRef.current = el;
          // Only one of the two layouts is mounted at a time, so a single
          // element is the preview; the linked one additionally drives the
          // side-by-side scroll sync.
          if (linked) previewScrollRef.current = el;
        }}
        onScroll={linked ? syncEditorScrollFromPreview : undefined}
        onContextMenu={handleMarkdownContextMenu}
        style={{ padding: '20px', overflowY: 'auto', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, boxSizing: 'border-box' }}
        className="markdown-preview-container"
      >
        <FormattedMessage content={linked ? deferredPreviewContent : fileContent} projectPath={activeProject?.project_path} zoomLevel={markdownZoomLevel} />
      </div>
    )
  );

  const renderTexEditorSurface = () => (
    <div className="vscode-editor-container" style={{ position: 'relative', height: '100%' }}>
      {isWysiwygMode ? (
        <Suspense
          fallback={(
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', height: '100%', color: 'var(--vscode-descriptionForeground)' }}>
              <RefreshCw size={16} className="animate-spin" />
              <span>{t('wysiwyg.loading', { defaultValue: 'Loading WYSIWYG editor…' })}</span>
            </div>
          )}
        >
          <LatexWysiwygEditor
            key={selectedFile}
            source={fileContent}
            activeProjectPath={activeProject?.project_path}
            sourceTex={selectedFile}
            zoomLevel={markdownZoomLevel}
            onChange={setFileContent}
            onJumpToSource={handleRichTextJumpToSource}
            onActiveSourceLineChange={(line) => {
              if (line) richTextSourceLinesRef.current[selectedFile] = line;
            }}
          />
        </Suspense>
      ) : isRichTextMode ? (
        <RichTextEditor
          key={selectedFile}
          source={fileContent}
          activeProjectPath={activeProject?.project_path}
          sourceTex={selectedFile}
          zoomLevel={markdownZoomLevel}
          initialSourceLine={richTextSourceLinesRef.current[selectedFile] || 1}
          initialScrollTop={richTextScrollTopsRef.current[selectedFile] || 0}
          onChange={setFileContent}
          onJumpToSource={handleRichTextJumpToSource}
          onActiveSourceLineChange={(line) => {
            if (line) richTextSourceLinesRef.current[selectedFile] = line;
          }}
          onScrollTopChange={(top) => {
            richTextScrollTopsRef.current[selectedFile] = top;
          }}
        />
      ) : bundledMonaco.status !== 'ready' ? renderMonacoStatus() : isDiffMode ? (
        <DiffEditor
          height="100%"
          language={getLanguage(selectedFile)}
          theme={theme === 'light' ? 'light' : 'vs-dark'}
          original={originalFileContents ? (originalFileContents[selectedFile] || '') : ''}
          modified={fileContent}
          originalModelPath={`original-${selectedFile}`}
          modifiedModelPath={`modified-${selectedFile}`}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          beforeMount={handleBeforeMount}
          onMount={handleMount}
          options={{
            contextmenu: false,
            minimap: { enabled: minimapEnabled },
            fontSize: editorFontSize,
            lineNumbers: 'on',
            tabSize: editorTabSize,
            wordWrap: editorWordWrap,
            automaticLayout: true,
            renderSideBySide: true,
            readOnly: false,
            originalEditable: false,
            fixedOverflowWidgets: true,
          }}
        />
      ) : (
        <Editor
          height="100%"
          path={selectedFile}
          language={getLanguage(selectedFile)}
          theme={theme === 'light' ? 'light' : 'vs-dark'}
          defaultValue={editorDefaultValue}
          beforeMount={handleBeforeMount}
          onChange={scheduleEditorContentCommit}
          onMount={handleMount}
          options={{
            contextmenu: false,
            minimap: { enabled: minimapEnabled },
            fontSize: editorFontSize,
            lineNumbers: 'on',
            tabSize: editorTabSize,
            wordWrap: editorWordWrap,
            automaticLayout: true,
            fixedOverflowWidgets: true,
          }}
        />
      )}
      {showSnippetsPanel && (
        <LatexSnippetsPanel
          onInsert={handleInsertSnippet}
          onClose={() => setShowSnippetsPanel(false)}
        />
      )}
    </div>
  );

  return (
    <div ref={editorContainerRef} className="vscode-editor-panel" style={{ position: 'relative' }}>
      {/* Tab bar */}
      <div className="vscode-tabs">
        <div className="vscode-tab-list">
          {openFiles.map(filePath => {
            const isActive = filePath === selectedFile;
            const isUnsaved = Boolean(unsavedFiles?.has(markerPathKey(filePath)));

            return (
              <div
                key={filePath}
                onClick={() => handleFileSelect(filePath)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setTabContextMenu({ ...viewportPointToApp(e.clientX, e.clientY), filePath });
                }}
                className={`vscode-tab ${isActive ? 'active' : ''}`}
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                <span
                  className="vscode-tab-label"
                  title={filePath}
                  style={{ color: isActive ? '#ffffff' : 'var(--vscode-text-subtle)' }}
                >
                  {filePath.replace(/\\/g, '/').split('/').pop()}
                  {isUnsaved && <span title={t('explorer.unsaved', 'Unsaved changes')}> *</span>}
                </span>
                <button
                  onClick={(e) => handleCloseTab(filePath, e)}
                  className="vscode-tab-close-btn"
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="vscode-editor-actions">
          {isTexFile && (
            <button
              onClick={() => setIsPdfPreviewCollapsed(prev => !prev)}
              className={`vscode-editor-action-btn${!isPdfPreviewCollapsed ? ' vscode-editor-action-btn-primary' : ''}`}
              style={{ width: 'auto', minWidth: '36px', padding: '0 4px', gap: '2px' }}
              title={isPdfPreviewCollapsed ? t('editorPanel.showPdfPreview') : t('editorPanel.collapsePdfPreview')}
              aria-label={isPdfPreviewCollapsed ? t('editorPanel.showPdfPreview') : t('editorPanel.collapsePdfPreview')}
              aria-pressed={!isPdfPreviewCollapsed}
            >
              <FileText size={14} />
              <span style={{ fontSize: '11px', fontWeight: 700, lineHeight: 1 }}>PDF</span>
            </button>
          )}
          {isTexFile && isTectonicAvailable && (
            <button
              onClick={() => handleCompile(false, false)}
              disabled={isCompiling || isSaving}
              className="vscode-editor-action-btn vscode-editor-action-btn-primary"
              title={isCompiling
                ? t('editorPanel.compiling')
                : compileTiming
                  ? t('editorPanel.compileTooltipWithTiming', { timing: formatCompileTiming(compileTiming) })
                  : t('editorPanel.compileTooltip')}
              aria-label={isCompiling ? t('editorPanel.compiling') : t('editorPanel.compile')}
            >
              {(isCompiling || isSaving) ? <RefreshCw size={14} className="animate-spin" /> : <Printer size={14} />}
            </button>
          )}
          {isTexFile && isTectonicAvailable && (
            <button
              onClick={() => handleCompile(false, true)}
              disabled={isCompiling || isSaving}
              className="vscode-editor-action-btn"
              title={t('editorPanel.compilePartialTooltip')}
              aria-label={t('editorPanel.compilePartial')}
            >
              {(isCompiling || isSaving) ? <RefreshCw size={14} className="animate-spin" /> : <FileText size={14} />}
            </button>
          )}
          {isTexFile && isTectonicAvailable && (
            <button
              onClick={() => handleCompile(false, false, true)}
              disabled={isCompiling || isSaving}
              className="vscode-editor-action-btn"
              title={t('editorPanel.compileDraftTooltip')}
              aria-label={t('editorPanel.compileDraft')}
            >
              {(isCompiling || isSaving) ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
            </button>
          )}
          {isTexFile && (
            <div ref={documentActionsMenuRef} className="vscode-overflow-menu-wrap">
              <button
                onClick={() => setShowDocumentActionsMenu(prev => !prev)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={t('editorPanel.documentActions', 'Document actions')}
                aria-label={t('editorPanel.documentActions', 'Document actions')}
                aria-expanded={showDocumentActionsMenu}
              >
                <MoreHorizontal size={12} />
              </button>
              {showDocumentActionsMenu && (
                <div className="vscode-overflow-menu" role="menu">
                  {isTectonicAvailable && (
                    <button
                      type="button"
                      onClick={() => {
                        handleCleanLatex();
                        setShowDocumentActionsMenu(false);
                      }}
                      disabled={isCompiling || isSaving || isCleaningLatex}
                      className="vscode-overflow-menu-item"
                      role="menuitem"
                    >
                      {isCleaningLatex ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                      <span>{t('editorPanel.cleanLatexArtifacts', 'Clean LaTeX artifacts')}</span>
                    </button>
                  )}
                  {isPandocAvailable ? (
                    <button
                      type="button"
                      onClick={() => {
                        handleExportDocx();
                        setShowDocumentActionsMenu(false);
                      }}
                      disabled={isExportingDocx || isSaving}
                      className="vscode-overflow-menu-item"
                      role="menuitem"
                    >
                      {isExportingDocx ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                      <span>{isExportingDocx ? t('editorPanel.exportingDocx') : t('editorPanel.exportDocx')}</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        handleInstallPandoc();
                        setShowDocumentActionsMenu(false);
                      }}
                      disabled={isInstallingPandoc}
                      className="vscode-overflow-menu-item"
                      role="menuitem"
                    >
                      {isInstallingPandoc ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
                      <span>{isInstallingPandoc ? t('editorPanel.installingPandoc') : t('editorPanel.installPandoc')}</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {isTexFile && cleanMessage && !isCleaningLatex && !isCompiling && (
            <span
              style={{
                color: 'var(--vscode-descriptionForeground, #888)',
                fontSize: '11px',
                whiteSpace: 'nowrap',
              }}
            >
              {cleanMessage}
            </span>
          )}
          {isTexFile && !isTectonicAvailable && (
            <button
              onClick={handleInstallTectonic}
              disabled={isInstallingTectonic}
              className="vscode-editor-action-btn"
              title={t('editorPanel.installTectonicTooltip')}
              aria-label={isInstallingTectonic ? t('editorPanel.installingTectonic') : t('editorPanel.installTectonic')}
            >
              {isInstallingTectonic ? <RefreshCw size={14} className="animate-spin" /> : <Download size={14} />}
            </button>
          )}
          <button
            onClick={saveFile}
            disabled={isSaving}
            className="vscode-editor-action-btn"
            title={t('editorPanel.save')}
            aria-label={t('editorPanel.save')}
          >
            {isSaving ? <Save size={12} className="save-pulse" /> : <Save size={12} />}
          </button>

          <button
            onClick={() => setIsDiffMode(!isDiffMode)}
            className="vscode-bottom-panel-clear-btn"
            style={{ padding: '6px' }}
            title={isDiffMode ? t('editorPanel.disableDiff') : t('editorPanel.enableDiff')}
          >
            <GitCompare size={12} style={{ color: isDiffMode ? 'var(--vscode-fg-link)' : 'inherit' }} />
          </button>

          {isTexFile && (
            <>
              {isNormalLatexEditor && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                  <button
                    onClick={() => updateEditorFontSize(prev => Math.max(10, prev - 1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomOut')}
                  >
                    <ZoomOut size={12} />
                  </button>
                  <button
                    onClick={() => updateEditorFontSize(13)}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '4px 6px', minWidth: '38px', fontSize: '11px', color: 'var(--vscode-text-fg)' }}
                    title={t('editorPanel.resetZoom')}
                  >
                    {editorFontSize}px
                  </button>
                  <button
                    onClick={() => updateEditorFontSize(prev => Math.min(30, prev + 1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomIn')}
                  >
                    <ZoomIn size={12} />
                  </button>
                </div>
              )}
              <button
                onClick={() => {
                  if (isRichTextMode) {
                    exitRichTextMode();
                  } else {
                    const currentLine = localEditorRef.current?.getPosition?.()?.lineNumber;
                    if (currentLine) richTextSourceLinesRef.current[selectedFile] = currentLine;
                    // Entering from Monaco should land on the cursor's block,
                    // not wherever this file was scrolled to previously.
                    delete richTextScrollTopsRef.current[selectedFile];
                    if (selectedFile) {
                      setRichTextFiles(prev => (prev.has(selectedFile) ? prev : new Set(prev).add(selectedFile)));
                    }
                  }
                  exitWysiwygMode();
                  setIsPreviewMode(false);
                  setIsDiffMode(false);
                }}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isRichTextMode ? 'Exit Rich Text mode' : 'Rich Text mode (Overleaf-style: edit prose, complex blocks read-only)'}
              >
                <Type size={12} style={{ color: isRichTextMode ? 'var(--vscode-fg-link)' : 'inherit' }} />
              </button>
              <button
                onClick={() => {
                  if (isWysiwygMode) {
                    exitWysiwygMode();
                  } else {
                    const currentLine = localEditorRef.current?.getPosition?.()?.lineNumber;
                    if (currentLine) richTextSourceLinesRef.current[selectedFile] = currentLine;
                    if (selectedFile) {
                      setWysiwygFiles(prev => (prev.has(selectedFile) ? prev : new Set(prev).add(selectedFile)));
                    }
                  }
                  // The two document editors are mutually exclusive — see the
                  // note on wysiwygFiles.
                  exitRichTextMode();
                  setIsPreviewMode(false);
                  setIsDiffMode(false);
                }}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isWysiwygMode
                  ? t('wysiwyg.exit', { defaultValue: 'Exit WYSIWYG mode' })
                  : t('wysiwyg.enter', { defaultValue: 'WYSIWYG mode (edit the document directly; unmodelled LaTeX is preserved as written)' })}
              >
                <PenLine size={12} style={{ color: isWysiwygMode ? 'var(--vscode-fg-link)' : 'inherit' }} />
              </button>
              {(isRichTextMode || isWysiwygMode) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                  <button
                    onClick={() => setMarkdownZoomLevel(prev => Math.max(0.5, prev - 0.1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomOut')}
                  >
                    <ZoomOut size={12} />
                  </button>
                  <button
                    onClick={() => setMarkdownZoomLevel(1.0)}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '4px 6px', minWidth: '38px', fontSize: '11px', color: 'var(--vscode-text-fg)' }}
                    title={t('editorPanel.resetZoom')}
                  >
                    {Math.round(markdownZoomLevel * 100)}%
                  </button>
                  <button
                    onClick={() => setMarkdownZoomLevel(prev => Math.min(2.0, prev + 0.1))}
                    className="vscode-bottom-panel-clear-btn"
                    style={{ padding: '6px' }}
                    title={t('editorPanel.zoomIn')}
                  >
                    <ZoomIn size={12} />
                  </button>
                </div>
              )}
              <button
                onClick={() => setShowSnippetsPanel(!showSnippetsPanel)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title="Insert LaTeX snippet"
              >
                <PlusSquare size={12} style={{ color: showSnippetsPanel ? 'var(--vscode-fg-link)' : 'inherit' }} />
              </button>
            </>
          )}

          {isPreviewableFile && (
            <>
              {isPreviewVisible && (
                <>
                  {!isHtmlFile && (
                    <button
                      onClick={handlePrintPDF}
                      className="vscode-bottom-panel-clear-btn"
                      style={{ padding: '6px' }}
                      title={t('editorPanel.printPreview')}
                      aria-label={t('editorPanel.printPreview')}
                    >
                      <Printer size={12} />
                    </button>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px', marginLeft: '4px' }}>
                    <button
                      onClick={() => setMarkdownZoomLevel(prev => Math.max(0.5, prev - 0.1))}
                      className="vscode-bottom-panel-clear-btn"
                      style={{ padding: '6px' }}
                      title={t('editorPanel.zoomOut')}
                    >
                      <ZoomOut size={12} />
                    </button>
                    <span style={{ fontSize: '11px', minWidth: '35px', textAlign: 'center', color: 'var(--vscode-text-fg)' }}>
                      {Math.round(markdownZoomLevel * 100)}%
                    </span>
                    <button
                      onClick={() => setMarkdownZoomLevel(prev => Math.min(2.0, prev + 0.1))}
                      className="vscode-bottom-panel-clear-btn"
                      style={{ padding: '6px' }}
                      title={t('editorPanel.zoomIn')}
                    >
                      <ZoomIn size={12} />
                    </button>
                  </div>
                </>
              )}
              <button
                onClick={() => {
                  // The two preview layouts are alternatives, not stackable:
                  // the full preview hides the very editor the split pairs
                  // the preview with.
                  setIsSplitPreview(prev => !prev);
                  setIsPreviewMode(false);
                }}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isSplitPreviewActive
                  ? t('editorPanel.closeSplitPreview')
                  : t('editorPanel.showSplitPreview')}
                aria-label={isSplitPreviewActive
                  ? t('editorPanel.closeSplitPreview')
                  : t('editorPanel.showSplitPreview')}
                aria-pressed={isSplitPreviewActive}
              >
                <Columns2 size={12} style={{ color: isSplitPreviewActive ? 'var(--vscode-fg-link)' : 'inherit' }} />
              </button>
              <button
                onClick={() => {
                  setIsPreviewMode(prev => !prev);
                  setIsSplitPreview(false);
                }}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '6px' }}
                title={isHtmlFile
                  ? (isPreviewMode ? t('editorPanel.editHtml') : t('editorPanel.previewHtml'))
                  : (isPreviewMode ? t('editorPanel.editMarkdown') : t('editorPanel.previewMarkdown'))}
                aria-label={isHtmlFile
                  ? (isPreviewMode ? t('editorPanel.editHtml') : t('editorPanel.previewHtml'))
                  : (isPreviewMode ? t('editorPanel.editMarkdown') : t('editorPanel.previewMarkdown'))}
                aria-pressed={isPreviewMode}
              >
                {isPreviewMode ? <EyeOff size={12} style={{ color: 'var(--vscode-fg-link)' }} /> : <Eye size={12} />}
              </button>
            </>
          )}

          {isTexFile && (
            <button
              onClick={() => setShowLatexHelp(true)}
              className="vscode-bottom-panel-clear-btn"
              style={{ padding: '6px' }}
              title={t('editorPanel.latexHelpTitle')}
              aria-label={t('editorPanel.latexHelpTitle')}
              aria-expanded={showLatexHelp}
            >
              <HelpCircle size={12} style={{ color: showLatexHelp ? 'var(--vscode-fg-link)' : 'inherit' }} />
            </button>
          )}

          <button
            onClick={onToggleMaximize}
            className="vscode-bottom-panel-clear-btn"
            style={{ padding: '6px' }}
            title={isMaximized ? t('editorPanel.restoreEditor') : t('editorPanel.maximizeEditor')}
          >
            {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>

      {/* Monaco editor and PDF Preview Split */}
      <div style={{ flex: 1, minHeight: 0, height: 'calc(100% - 35px)' }}>
        {isPdfFile ? (
          <div style={{ height: '100%', background: 'var(--vscode-editor-bg)' }}>
            <PdfPreview
              key={pdfViewKey}
              chatModel={chatModel}
              ref={pdfPreviewRef}
              initialViewState={pdfViewStatesRef.current[pdfViewKey]}
              onViewStateChange={rememberPdfViewState}
              directUrl={`/api/file/raw?projectPath=${encodeURIComponent(activeProject?.project_path)}&filePath=${encodeURIComponent(selectedFile)}`}
              base64Pdf={null}
              isCompiling={false}
              errorLog={''}
              activeProject={activeProject}
              selectedFile={selectedFile}
              onSyncTexNavigate={handleSyncTexNavigate}
              onFixLatexProblem={onFixLatexProblem}
              onLatexCompileError={onLatexCompileError}
              onLatexCompileSuccess={onLatexCompileSuccess}
              onAskAboutPdf={onAskAboutPdf}
              speechSettingsSignal={speechSettingsSignal}
              uiScale={uiScale}
            />
          </div>
        ) : isTexFile && isPdfPreviewCollapsed ? (
          renderTexEditorSurface()
        ) : isTexFile ? (
          <Split
            sizes={[50, 50]}
            minSize={200}
            expandToMin={false}
            gutterSize={4}
            gutterAlign="center"
            snapOffset={30}
            dragInterval={1}
            direction="horizontal"
            cursor="col-resize"
            style={{ display: 'flex', height: '100%', width: '100%' }}
        >
          {renderTexEditorSurface()}
          <div style={{ height: '100%', background: 'var(--vscode-editor-bg)', borderLeft: '1px solid var(--vscode-border)' }}>
            <PdfPreview
              key={pdfViewKey}
              chatModel={chatModel}
              ref={pdfPreviewRef}
              initialViewState={pdfViewStatesRef.current[pdfViewKey]}
              onViewStateChange={rememberPdfViewState}
              base64Pdf={null}
              sourceUrl={pdfUrl}
              isCompiling={isCompiling} 
              errorLog={pdfErrorLog} 
              activeProject={activeProject}
              selectedFile={selectedFile}
              onSyncTexNavigate={handleSyncTexNavigate}
              onDocumentReady={handlePdfDocumentReady}
              onCollapse={() => setIsPdfPreviewCollapsed(true)}
              latexCompileProblem={latexCompileProblem}
              onFixLatexProblem={onFixLatexProblem}
              onAskAboutPdf={onAskAboutPdf}
              speechSettingsSignal={speechSettingsSignal}
              uiScale={uiScale}
            />
          </div>
          </Split>
        ) : isSplitPreviewActive ? (
          <Split
            sizes={[50, 50]}
            minSize={200}
            expandToMin={false}
            gutterSize={4}
            gutterAlign="center"
            snapOffset={30}
            dragInterval={1}
            direction="horizontal"
            cursor="col-resize"
            className="editor-split"
            style={{ display: 'flex', height: '100%', width: '100%' }}
          >
            <div
              className="vscode-editor-container editor-split-source"
              style={{ position: 'relative', height: '100%' }}
              onMouseEnter={() => { scrollSourcePaneRef.current = 'editor'; }}
              onWheel={() => { scrollSourcePaneRef.current = 'editor'; }}
              onPointerDown={() => { scrollSourcePaneRef.current = 'editor'; }}
            >
              {renderPlainEditorSurface()}
            </div>
            <div
              className="editor-split-preview"
              style={{ position: 'relative', height: '100%', background: 'var(--vscode-editor-bg)', borderLeft: '1px solid var(--vscode-border)' }}
              onMouseEnter={() => { scrollSourcePaneRef.current = 'preview'; }}
              onWheel={() => { scrollSourcePaneRef.current = 'preview'; }}
              onPointerDown={() => { scrollSourcePaneRef.current = 'preview'; }}
            >
              {renderRenderedPreview(true)}
            </div>
          </Split>
        ) : (
          <div className="vscode-editor-container" style={{ position: 'relative', height: '100%' }}>
            {isPreviewMode && isPreviewableFile ? renderRenderedPreview() : renderPlainEditorSurface()}
          </div>
        )}
      </div>

      <MarkdownContextMenu
        menu={markdownContextMenu}
        onClose={() => setMarkdownContextMenu(null)}
        onCopy={handleCopyMarkdownSelection}
        onAskAbout={handleAskAboutMarkdown}
        onLookUp={handleLookUpMarkdownSelection}
        onTranslate={handleTranslateMarkdownSelection}
        onPronounce={handlePronounceMarkdownSelection}
        canAsk={Boolean(onAskAboutMarkdown && activeProject && selectedFile)}
        canPronounce={speechAvailability.ready}
        pronounceUnavailableHint={speechAvailability.problem}
      />

      <TranslationPopup
        state={translation}
        onClose={closeTranslation}
        onRetry={retryTranslation}
        onCopy={copyTranslation}
        onSpeak={speechAvailability.ready ? speak : undefined}
      />

      <SnippetQueryPopup
        state={lookup}
        projectPath={activeProject?.project_path || ''}
        onClose={closeLookup}
        onQuestionChange={setLookupQuestion}
        onSubmit={submitLookup}
        onCompose={composeLookup}
        onCopy={copyLookup}
        onSaveMarkdown={saveLookupMarkdown}
      />

      <SpeechPopup
        state={speech}
        onClose={closeSpeech}
        onToggle={toggleSpeech}
        onReplay={replaySpeech}
        onRetry={retrySpeech}
      />

      {/* Inline prompt overlay (rendered inside the panel for correct stacking) */}
      {inlinePrompt && (
        <InlinePromptOverlay
          inlinePrompt={inlinePrompt}
          onSubmit={onInlineSubmit}
          onClose={() => setInlinePrompt(null)}
          isRunning={false}
        />
      )}

      {showLatexHelp && (
        <div className="latex-help-modal-backdrop" onClick={() => setShowLatexHelp(false)}>
          <div
            className="latex-help-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('editorPanel.latexHelpTitle')}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="latex-help-header">
              <span>{t('editorPanel.latexHelpTitle')}</span>
              <button
                onClick={() => setShowLatexHelp(false)}
                className="vscode-bottom-panel-clear-btn"
                style={{ padding: '3px' }}
                title={t('editorPanel.latexHelpClose')}
                aria-label={t('editorPanel.latexHelpClose')}
              >
                <X size={12} />
              </button>
            </div>
            <div className="latex-help-section-title">{t('editorPanel.latexHelpShortcutsTitle')}</div>
            <dl className="latex-help-list">
              <div>
                <dt>Ctrl+S</dt>
                <dd>{t('editorPanel.latexHelpSave')}</dd>
              </div>
              <div>
                <dt>Ctrl+L</dt>
                <dd>{t('editorPanel.latexHelpInline')}</dd>
              </div>
              <div>
                <dt>Ctrl+J</dt>
                <dd>{t('editorPanel.latexHelpTerminal')}</dd>
              </div>
              <div>
                <dt>Ctrl/Alt+Click</dt>
                <dd>{t('editorPanel.latexHelpSyncTex')}</dd>
              </div>
            </dl>
            <div className="latex-help-section-title">{t('editorPanel.latexHelpFeaturesTitle')}</div>
            <ul className="latex-help-feature-list">
              <li>{t('editorPanel.latexHelpCompile')}</li>
              <li>{t('editorPanel.latexHelpPartial')}</li>
              <li>{t('editorPanel.latexHelpRichText')}</li>
              <li>{t('editorPanel.latexHelpPreview')}</li>
              <li>{t('editorPanel.latexHelpSnippets')}</li>
            </ul>
          </div>
        </div>
      )}

      {/* Custom editor context menu (replaces Monaco's Shadow DOM menu) */}
      {editorContextMenu && (
        <EditorContextMenuOverlay
          menu={editorContextMenu}
          onClose={() => setEditorContextMenu(null)}
          setInlinePrompt={setInlinePrompt}
          t={t}
        />
      )}

      {/* Right-click menu for the tab bar */}
      <TabContextMenu
        menu={tabContextMenu}
        onClose={() => setTabContextMenu(null)}
        onCloseTab={handleCloseTab}
        onCloseOthers={handleCloseOtherTabs}
        onCloseAll={handleCloseAllTabs}
        tabCount={openFiles.length}
      />
    </div>
  );
}
