import { createFileSaveQueue } from './utils/fileSave.js';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from 'react-i18next';
import i18n from './i18n/index.js';

// Utils
import { getPreference, setPreference } from './utils/preferences';
import { UI_SCALE_DEFAULT, UI_SCALE_KEY_STEP, clampUiScale, roundUiScale, viewportPointToApp, viewportPxToApp } from './utils/uiScale';
import { enterLayout, layoutAfterOpeningFile, layoutAllowsChatToggle, layoutDocksSidebar, layoutShowsEditor } from './utils/layoutModes';
import { createIdeCommandRunner } from './utils/ideCommands.js';
import { DEFAULT_THOUGHT_CONTEXT_TOKENS } from './utils/thoughtTail';
import {
  clampLogMessage,
  fitLogMessage as fitMergedLogMessage,
  joinMergedLogMessage,
} from './utils/logMerge';
import { resolveInlineCreatePath } from './utils/inlineCreate';
import { collectTreePaths, outermostPaths } from './utils/explorerSelection';
import { markerPathKey, unsavedFilePaths } from './utils/fileMarkers';

// Hooks
import { useResizing } from './hooks/useResizing';

// Layout components
import ActivityBar from './components/ActivityBar';
import StatusBar from './components/StatusBar';
import ExplorerSidebar from './components/ExplorerSidebar';
import GitSidebar from './components/GitSidebar';
import SearchSidebar from './components/SearchSidebar';
import EditorPanel from './components/EditorPanel';
import ClaudePanel from './components/ClaudePanel';
import {
  STUDIO_BOTTOM_HEIGHT_DEFAULT,
  STUDIO_CHAT_WIDTH_DEFAULT,
  studioGridTemplate,
} from './utils/studioLayout';
import BottomPanel from './components/BottomPanel';
import ContextMenu from './components/ContextMenu';
import { buildAskAboutDocumentPrompt } from './utils/askAboutPrompt';
import MoveToModal from './components/MoveToModal';

// Modals
import NewProjectModal from './components/modals/NewProjectModal';
import EditProjectModal from './components/modals/EditProjectModal';
import SettingsModal from './components/modals/SettingsModal';
import ConfirmModal from './components/modals/ConfirmModal';
import AlertModal from './components/modals/AlertModal';
import DirPickerModal from './components/modals/DirPickerModal';
import DeleteProjectModal from './components/modals/DeleteProjectModal';
import CloudSyncModal from './components/modals/CloudSyncModal';
import CloudDownloadModal from './components/modals/CloudDownloadModal';
import { useCustomDialog } from './components/modals/CustomDialogProvider';

// How long the editor panel gets to carry out a reveal-in-PDF request, loading
// the PDF included (used by the MCP tools in phase 4).
const PDF_REVEAL_TIMEOUT_MS = 12000;

const normalizeEditorPathKey = (filePath, caseInsensitive = false) => {
  if (!filePath) return '';
  let normalized = String(filePath)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
  const parts = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  normalized = parts.join('/');
  return caseInsensitive ? normalized.toLowerCase() : normalized;
};

const isBinaryEditorFile = (filePath) => {
  if (!filePath) return false;
  return /\.pdf$/i.test(String(filePath));
};

const SYSTEM_APP_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tiff', 'tif', 'psd', 'ai', 'raw', 'cr2', 'nef', 'heic', 'heif',
  // Audio
  'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma', 'opus', 'mid', 'midi',
  // Video
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm4v', '3gp',
  // Archives
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso', 'cab', 'dmg', 'pkg',
  // Non-supported Office / Documents
  'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'xlsm', 'odt', 'ods', 'odp', 'epub', 'pages', 'numbers', 'key',
  // Executables / Binaries / Compiled / Database / Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'pyc', 'pyo', 'pyd', 'o', 'obj', 'a', 'lib', 'class', 'jar', 'war', 'ear', 'apk', 'msi', 'deb', 'rpm'
]);

const isUnsupportedSystemFile = (filePath) => {
  if (!filePath) return false;
  const parts = String(filePath).split('.');
  if (parts.length <= 1) return false;
  const ext = parts.pop().toLowerCase();
  return SYSTEM_APP_EXTENSIONS.has(ext);
};

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const { t } = useTranslation();
  const { showAlert } = useCustomDialog();

  // ── Projects / files ──────────────────────────────────────────────────────
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const isCaseInsensitiveProjectPath = Boolean(
    activeProject?.project_path?.includes('\\') ||
    /^[a-z]:/i.test(activeProject?.project_path || '') ||
    navigator.userAgent.toLowerCase().includes('windows')
  );
  const filePathKey = (filePath) => normalizeEditorPathKey(filePath, isCaseInsensitiveProjectPath);
  const sameFilePath = (left, right) => filePathKey(left) === filePathKey(right);
  const isFileInsidePath = (filePath, parentPath) => {
    const parentKey = filePathKey(parentPath);
    const childKey = filePathKey(filePath);
    return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
  };
  const replaceFilePathPrefix = (filePath, oldPath, newPath) => {
    if (!isFileInsidePath(filePath, oldPath)) return filePath;
    const normalizedFile = String(filePath).replace(/\\/g, '/');
    const normalizedOld = String(oldPath).replace(/\\/g, '/').replace(/\/+$/g, '');
    const oldSegments = normalizedOld.split('/').filter(Boolean).length;
    const suffix = normalizedFile.split('/').filter(Boolean).slice(oldSegments).join('/');
    return suffix ? `${newPath}/${suffix}` : newPath;
  };
  // Keep the unsaved marker's disk baseline under the paths the buffers move
  // to. Mutated in place: saveFile treats a new object as a project switch.
  const moveDiskContents = (oldPath, newPath) => {
    const cache = diskFileContentsRef.current;
    const moves = Object.keys(cache)
      .filter(key => isFileInsidePath(key, oldPath))
      .map(key => [key, replaceFilePathPrefix(key, oldPath, newPath), cache[key]]);
    for (const [key] of moves) delete cache[key];
    for (const [, moved, content] of moves) cache[moved] = content;
  };
  const dropDiskContents = (path) => {
    const cache = diskFileContentsRef.current;
    for (const key of Object.keys(cache)) if (isFileInsidePath(key, path)) delete cache[key];
  };
  const dedupeOpenFileList = (files, preferredPath = null) => {
    const preferredKey = preferredPath ? filePathKey(preferredPath) : null;
    const seen = new Set();
    return files.reduce((deduped, file) => {
      const key = filePathKey(file);
      if (!key || seen.has(key)) return deduped;
      seen.add(key);
      deduped.push(preferredKey === key ? preferredPath : file);
      return deduped;
    }, []);
  };
  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(null);
  // Word/character statistics reported by the editor panel (mode-aware:
  // LaTeX, Markdown or plain text), rendered in the status bar.
  const [editorTextStats, setEditorTextStats] = useState(null);
  const [selectedNodes, setSelectedNodes] = useState(new Set());
  const [renamingNodePath, setRenamingNodePath] = useState(null);
  // Provisional tree row for creating a file or directory in place.
  const [pendingCreate, setPendingCreate] = useState(null);
  const inlineCreateIdRef = useRef(0);
  useEffect(() => { setPendingCreate(null); }, [activeProject?.project_path]);
  const [fileContent, setFileContentState] = useState('');
  // Every editor surface updates the ref synchronously, so an HTTP response
  // cannot observe the previous render's text between typing and an effect.
  const fileContentRef = useRef('');
  const setFileContent = useCallback(value => {
    const next = typeof value === 'function' ? value(fileContentRef.current) : value;
    fileContentRef.current = next;
    setFileContentState(next);
  }, []);
  const [openFiles, setOpenFiles] = useState([]);
  const [fileContents, setFileContents] = useState({});

  // Baseline of the diff view (the file at git HEAD), not of the unsaved
  // marker: that one compares with the disk (see utils/fileMarkers.js).
  const [originalFileContents, setOriginalFileContents] = useState({});
  const [rightClickedNode, setRightClickedNode] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // ── Chat / agent ──────────────────────────────────────────────────────────
  // Read by the stream handler, which a running turn captured before a change.
  const thoughtContextTokensRef = useRef(DEFAULT_THOUGHT_CONTEXT_TOKENS);
  // Bumped whenever a speech or dictation setting is saved. The surfaces that
  // gate a *control* on readiness (the chat's microphone above all) have no
  // "on open" moment to re-read at, so they watch this instead — see
  // hooks/useDictation.js.
  const [speechSettingsSignal, setSpeechSettingsSignal] = useState(0);
  const bumpSpeechSettings = useCallback(() => setSpeechSettingsSignal((n) => n + 1), []);

  // ── Bottom panel ──────────────────────────────────────────────────────────
  const [terminalLogs, setTerminalLogs] = useState([]);
  const [problems, setProblems] = useState([]);
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(true);
  const [activeBottomTab, setActiveBottomTab] = useState('terminal');
  const [panelMaxLines, setPanelMaxLines] = useState(() => {
    const stored = getPreference('panelMaxLines');
    const parsed = stored !== null ? Number(stored) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
  });

  // ── UI state ──────────────────────────────────────────────────────────────
  const [layoutMode, setLayoutMode] = useState('ide');
  // The studio: editor + preview across the top, chat and terminal side by side
  // beneath, workspace explorer docked left. See utils/studioLayout.js.
  const isStudioLayout = layoutMode === 'studio';
  // The document layout: the open .tex/.md and its own preview (the PDF for
  // LaTeX, the rendered document for Markdown/HTML) across the full width, with
  // neither chat nor terminal on screen. It renders the same EditorPanel as the
  // IDE layout and only seeds the panel's preview flags, so every toolbar
  // toggle keeps working once the user is inside it.
  const isDocumentLayout = layoutMode === 'document';
  // Layouts that show the editor and its preview, and therefore share the IDE
  // layout's docked sidebar and resize handle. See utils/layoutModes.js.
  const isEditorLayout = layoutShowsEditor(layoutMode);
  // The chat layout: Claude Code across the centre, the explorer docked left.
  const isChatLayout = layoutMode === 'chat';
  const docksSidebar = layoutDocksSidebar(layoutMode);
  // The right-hand panel that used to hold GilzaBots' chat now holds Claude Code.
  const [isChatVisible, setIsChatVisible] = useState(false);
  // Text handed to the Claude Code panel to paste into its prompt ({ seq, text }).
  const [claudePromptRequest, setClaudePromptRequest] = useState(null);
  const claudePromptSeqRef = useRef(0);
  // Asks the panel to start a new Claude Code session ({ seq }): saving another
  // model provider closed the one started with the old environment.
  const [claudeRestartRequest, setClaudeRestartRequest] = useState(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState('explorer');
  // The Search tab's query, options and last results, kept here so they
  // survive switching sidebar tabs; the token focuses its field (Ctrl+Shift+F).
  const [searchState, setSearchState] = useState({
    query: '', caseSensitive: false, wholeWord: false, regex: false,
    projectPath: null, response: null, error: '',
  });
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [contextMenu, setContextMenu] = useState(null);
  const [clipboardNode, setClipboardNode] = useState(null);
  const [jumpToLine, setJumpToLine] = useState(null);
  // The agent's reveal_in_pdf, carried out by the editor panel's forward search
  // ({ seq, file, line, resolve }; see requestPdfReveal).
  const [pdfRevealRequest, setPdfRevealRequest] = useState(null);
  const pdfRevealSeqRef = useRef(0);
  // The last compile Claude Code ran through the MCP bridge ({ seq, success, log, ... }).
  const [externalCompile, setExternalCompile] = useState(null);
  // Set by the editor panel: what its PDF pane shows (get_pdf_view).
  const pdfViewProbeRef = useRef(null);
  const [dirPicker, setDirPicker] = useState(null);
  const [alertMessage, setAlertMessage] = useState('');
  // A confirmation the interface itself asks ({ prompt, options, callback }).
  const [confirmRequest, setConfirmRequest] = useState(null);

  useEffect(() => {
    const nativeAlert = window.alert;
    window.alert = (message) => setAlertMessage(String(message ?? ''));
    return () => { window.alert = nativeAlert; };
  }, []);

  // ── Git ───────────────────────────────────────────────────────────────────
  const [gitChanges, setGitChanges] = useState([]);
  const [commitMessage, setCommitMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);
  const currentGitRootPath = activeProject?.git_root_path || '';
  const gitQuerySuffix = () => {
    if (!activeProject) return '';
    const params = new URLSearchParams({ projectPath: activeProject.project_path });
    if (currentGitRootPath) params.set('gitRootPath', currentGitRootPath);
    return params.toString();
  };
  const gitRequestPayload = (extra = {}) => ({
    projectPath: activeProject?.project_path,
    ...(currentGitRootPath ? { gitRootPath: currentGitRootPath } : {}),
    ...extra,
  });

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  const [draggedNode, setDraggedNode] = useState(null);
  const [dragOverPath, setDragOverPath] = useState(null);
  const [moveModal, setMoveModal] = useState(null);

  // ── Panel sizing ──────────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(330);
  const [chatWidth, setChatWidth] = useState(400);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(240);
  // The studio arranges the same panels in a different geometry, so it keeps
  // its own sizes: sharing them would mean a chat widened for the studio's
  // bottom row also widening the IDE's right-hand dock, and a bottom row sized
  // to hold a conversation reopening as a 700px terminal in the IDE.
  const [studioChatWidth, setStudioChatWidth] = useState(STUDIO_CHAT_WIDTH_DEFAULT);
  const [studioBottomHeight, setStudioBottomHeight] = useState(STUDIO_BOTTOM_HEIGHT_DEFAULT);
  const [isEditorMaximized, setIsEditorMaximized] = useState(false);
  const [isBottomMaximized, setIsBottomMaximized] = useState(false);
  // The studio's whole geometry is this one grid template: the panels below are
  // the IDE's own components kept at their existing positions in the tree — so
  // switching layouts never remounts the editor or tears down a live terminal —
  // and only their CSS placement changes.
  const studioGrid = useMemo(() => studioGridTemplate({
    chatWidth: studioChatWidth,
    bottomHeight: studioBottomHeight,
    isChatVisible,
    isTerminalVisible: !isTerminalCollapsed,
    isEditorMaximized,
    isBottomMaximized,
  }), [studioChatWidth, studioBottomHeight, isChatVisible, isTerminalCollapsed, isEditorMaximized, isBottomMaximized]);

  // ── Modals ─────────────────────────────────────────────────────────────────
  const [showNewProjectModal, setShowNewProjectModal] = useState(false);
  const [importError, setImportError] = useState('');
  const [newProjName, setNewProjName] = useState('');
  const [newProjPath, setNewProjPath] = useState('');
  const [newProjError, setNewProjError] = useState('');

  const [editingProject, setEditingProject] = useState(null);
  const [editProjError, setEditProjError] = useState('');
  const [projectToDelete, setProjectToDelete] = useState(null);
  // What /api/cloud/link said about the project being deleted, so the dialog
  // can offer to delete its cloud copy too.
  const [deleteCloudLink, setDeleteCloudLink] = useState(null);
  const [isCloudSyncOpen, setIsCloudSyncOpen] = useState(false);
  const [isCloudDownloadOpen, setIsCloudDownloadOpen] = useState(false);
  const [cloudDownloadParent, setCloudDownloadParent] = useState('');
  // Mirrors the project's cloud status so the activity bar and status bar can
  // show it without opening the panel.
  const [cloudStatus, setCloudStatus] = useState(null);
  // Per-file sync state for the explorer's badges, keyed by POSIX path.
  const [cloudFileStates, setCloudFileStates] = useState(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // ── Global Models ─────────────────────────────────────────────────────────

  // ── IDE settings ──────────────────────────────────────────────────────────
  const [settingsTab, setSettingsTab] = useState('general');
  const [theme, setTheme] = useState(() => getPreference('theme', 'dark'));
  // Accessibility interface scale. Unlike the other appearance settings this
  // one lives in ui_settings.json rather than localStorage: it is the setting a
  // user with low vision cannot work around if it silently resets, and the
  // backend store is the one whose stated purpose is surviving restarts.
  const [uiScale, setUiScale] = useState(UI_SCALE_DEFAULT);
  const [editorFontSize, setEditorFontSize] = useState(() => Number(getPreference('editorFontSize', 13)));
  const [editorTabSize, setEditorTabSize] = useState(() => Number(getPreference('editorTabSize', 4)));
  const [editorWordWrap, setEditorWordWrap] = useState(() => getPreference('editorWordWrap', 'on'));
  const [editorMinimap, setEditorMinimap] = useState(() => getPreference('editorMinimap', 'on'));
  const [showHiddenWorkspaceFiles, setShowHiddenWorkspaceFiles] = useState(false);

  // ── Accessibility interface scale ───────────────────────────────────────
  // The factor is published as a CSS custom property on the document element;
  // `.vscode-app` turns it into a `zoom` over the whole interface. Monaco
  // (automaticLayout) and xterm (a ResizeObserver on its container) both see
  // their container change size in the zoomed coordinate space and re-fit on
  // their own, so no manual relayout is needed here.
  useEffect(() => {
    document.documentElement.style.setProperty('--ui-scale', String(uiScale));
  }, [uiScale]);

  // Restore the stored scale on startup (localStorage is not reliable in the
  // webview, so this setting is owned by the backend).
  useEffect(() => {
    fetch('/api/settings/appearance')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => { if (cfg) setUiScale(clampUiScale(cfg.ui_scale)); })
      .catch(() => { });
  }, []);

  // The scale is applied immediately but written back on a trailing delay:
  // dragging the settings slider walks through every step in between, and each
  // one would otherwise rewrite ui_settings.json.
  const uiScaleSaveTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(uiScaleSaveTimerRef.current), []);

  const applyUiScale = useCallback((value) => {
    const next = roundUiScale(value);
    setUiScale(next);
    clearTimeout(uiScaleSaveTimerRef.current);
    uiScaleSaveTimerRef.current = setTimeout(() => {
      fetch('/api/settings/appearance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ui_scale: next }),
      }).catch(() => { });
    }, 300);
    return next;
  }, []);

  useEffect(() => {
    fetch('/api/settings/workspace')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.show_hidden_workspace_files !== undefined) {
          setShowHiddenWorkspaceFiles(Boolean(cfg.show_hidden_workspace_files));
        }
      })
      .catch(() => { });
  }, []);

  // ── Optional dependencies ─────────────────────────────────────────────────

  // ── Ephemeral Agent Params ────────────────────────────────────────────────

  const [triggerCompileRequest, setTriggerCompileRequest] = useState(null);

  // ── Inline prompt (editor Ctrl+L / context-menu Refine, Generate, Illustrate) ──
  // The editor still asks for an instruction in place; the instruction then goes
  // to Claude Code, which edits the file itself (GilzaBots ran its own agent and
  // replaced the selection).
  const [inlinePrompt, setInlinePrompt] = useState(null);

  // ── Inline prompt (editor Ctrl+L / context-menu actions) ────────────────

  // ── Refs ──────────────────────────────────────────────────────────────────
  const terminalRef = useRef(null);
  const terminalInstanceRef = useRef(null);
  const logEndRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const saveFileRef = useRef(null);
  const diskFileContentsRef = useRef({});
  const fileContentsRef = useRef(fileContents);
  fileContentsRef.current = fileContents;
  // Recomputed on every render rather than memoized: the disk baseline is a
  // ref, and each write to it comes with a buffer state update (fileContent /
  // fileContents), which is what brings the render.
  const unsavedFiles = new Set(unsavedFilePaths({
    openFiles,
    fileContents,
    activeFile: selectedFile,
    activeContent: fileContent,
    diskContents: diskFileContentsRef.current,
    isBinary: isBinaryEditorFile,
  }).map(markerPathKey));
  const fileSaveQueueRef = useRef(createFileSaveQueue());
  const pendingSaveCountRef = useRef(0);
  const documentContextRef = useRef(null);
  documentContextRef.current = {
    projectPath: activeProject?.project_path, selectedFile,
    getContent: getCurrentTextFileContent,
  };
  const gitStatusRequestRef = useRef(null);
  const lastEditorInputAtRef = useRef(0);
  const importFileInputRef = useRef(null);
  const importTargetPathRef = useRef('');

  function getCurrentTextFileContent() {
    if (selectedFile && !isBinaryEditorFile(selectedFile)) {
      const editorValue = editorRef.current?.getModel?.()?.getValue?.();
      if (typeof editorValue === 'string') return editorValue;
    }
    return fileContentRef.current;
  }

  async function refreshSelectedFileFromDiskIfUnmodified() {
    if (!activeProject?.project_path || !selectedFile) return;
    if (isBinaryEditorFile(selectedFile)) return;
    if (editorRef.current?.hasTextFocus?.()) return;
    if (Date.now() - lastEditorInputAtRef.current < 1500) return;
    const lastDiskContent = diskFileContentsRef.current[selectedFile];
    if (lastDiskContent === undefined || fileContentRef.current !== lastDiskContent) return;
    try {
      const res = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.content === lastDiskContent) return;
      diskFileContentsRef.current[selectedFile] = data.content;
      setFileContent(data.content);
      setFileContents(prev => ({ ...prev, [selectedFile]: data.content }));
      setOriginalFileContents(prev => ({ ...prev, [selectedFile]: data.content }));
      addLog('info', t('app.reloadedFromDisk', { path: selectedFile }));
    } catch {
      // Ignore transient file reads; the next refresh/focus will try again.
    }
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────
  const { startResizing } = useResizing({
    setSidebarWidth,
    setChatWidth,
    setBottomPanelHeight,
    sidebarWidth,
    chatWidth,
    bottomPanelHeight,
    studioChatWidth,
    setStudioChatWidth,
    studioBottomHeight,
    setStudioBottomHeight,
  });

  // ── Effects ───────────────────────────────────────────────────────────────
  useEffect(() => { fetchProjects(); }, []);

  // Restore language from backend on startup (localStorage not reliable in webview)
  useEffect(() => {
    fetch('/api/settings/language')
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (cfg?.lang) {
          i18n.changeLanguage(cfg.lang);
        } else {
          // No saved preference — push current detected language to backend
          const detected = i18n.language?.startsWith('pt') ? 'pt' : 'en';
          fetch('/api/settings/language', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lang: detected }),
          }).catch(() => { });
        }
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    if (!showNewProjectModal) setNewProjError('');
  }, [showNewProjectModal]);

  // The last project opened, so that re-rendering the same project (e.g. after
  // saving its settings) does not close its tabs; they are only reset when a
  // different project is opened.
  const prevProjectNameRef = useRef(null);

  useEffect(() => {
    if (activeProject) {
      fetchFiles();
      if (prevProjectNameRef.current !== activeProject.name) {
        prevProjectNameRef.current = activeProject.name;
        setOpenFiles([]);
        setSelectedFile(null);
        setFileContent('');
        setFileContents({});
        setOriginalFileContents({});
        setGitChanges([]);
        setTerminalLogs([]);
        setProblems([]);
        setCommitMessage('');
      }
    } else {
      setFiles([]);
      setSelectedFile(null);
      setFileContent('');
      setOpenFiles([]);
      setFileContents({});
      setOriginalFileContents({});
      setProblems([]);
      setGitChanges([]);
      setTerminalLogs([]);
      setCommitMessage('');
      prevProjectNameRef.current = null;
    }
  }, [activeProject]);

  useEffect(() => {
    if (!activeProject || !selectedFile) return;
    if (isBinaryEditorFile(selectedFile)) {
      setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
      return;
    }
    fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(gitData => {
        if (gitData && gitData.content !== undefined) {
          setOriginalFileContents(prev => ({ ...prev, [selectedFile]: gitData.content }));
        } else {
          setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
        }
      })
      .catch(() => {
        setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
      });
  }, [currentGitRootPath, selectedFile, activeProject]);

  useEffect(() => {
    const disableContextMenu = (e) => e.preventDefault();
    const closeMenu = () => setContextMenu(null);
    document.addEventListener('contextmenu', disableContextMenu);
    document.addEventListener('click', closeMenu);
    return () => {
      document.removeEventListener('contextmenu', disableContextMenu);
      document.removeEventListener('click', closeMenu);
    };
  }, []);

  // Chat auto-scroll lives in ChatPanel, which owns the scroll container and
  // only follows new content while the user is parked at the bottom.

  // Global keyboard shortcuts (Ctrl+S, Ctrl+J, Ctrl+T, Ctrl+/- zoom)
  useEffect(() => {
    // Match the physical key alongside the character. `e.key` is resolved by the
    // platform's keyboard/compose layer, which is not always available in a
    // packaged runtime; `e.code` names the physical key and stays correct there.
    const handleKeyDown = (e) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && (e.key === 's' || e.code === 'KeyS')) { e.preventDefault(); saveFileRef.current?.(); }
      else if (isCtrl && (e.key === 'j' || e.code === 'KeyJ')) {
        e.preventDefault();
        if (isBottomMaximized) {
          setIsBottomMaximized(false);
        } else if (isTerminalCollapsed) {
          setIsTerminalCollapsed(false);
        } else {
          setIsTerminalCollapsed(true);
        }
      }
      // Ctrl+T does what the Activity Bar chat button does, and is a no-op in
      // the layouts where that button is disabled. Opening the chat also puts
      // the caret in its composer, so the shortcut leads straight to typing.
      else if (isCtrl && !e.shiftKey && !e.altKey && (e.key === 't' || e.code === 'KeyT')) {
        e.preventDefault();
        if (!layoutAllowsChatToggle(layoutMode)) return;
        const nextVisible = !isChatVisible;
        setIsChatVisible(nextVisible);
        if (isEditorMaximized) setIsEditorMaximized(false);
      }
      // Ctrl+Shift+F opens the Search tab (never closes it, unlike its Activity
      // Bar button) and puts the caret in its field.
      else if (isCtrl && e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF')) {
        e.preventDefault();
        if (!layoutDocksSidebar(layoutMode)) setLayoutMode('ide');
        if (isEditorMaximized) setIsEditorMaximized(false);
        setActiveSidebarTab('search');
        setSearchFocusToken(token => token + 1);
      }
      // Interface scale — Shift distinguishes these from the editor's own
      // Ctrl +/- font size, which stays bound to the focused editor. With Shift
      // held, `e.key` reports the shifted character ('+', '_', ')'), so the
      // physical `e.code` is matched alongside it.
      else if (isCtrl && e.shiftKey && (e.key === '+' || e.key === '=' || e.code === 'Equal' || e.code === 'NumpadAdd')) {
        e.preventDefault();
        applyUiScale(uiScale + UI_SCALE_KEY_STEP);
      }
      else if (isCtrl && e.shiftKey && (e.key === '_' || e.key === '-' || e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        e.preventDefault();
        applyUiScale(uiScale - UI_SCALE_KEY_STEP);
      }
      else if (isCtrl && e.shiftKey && (e.key === ')' || e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) {
        e.preventDefault();
        applyUiScale(UI_SCALE_DEFAULT);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isBottomMaximized, isTerminalCollapsed, uiScale, applyUiScale, layoutMode, isChatVisible, isEditorMaximized]);

  useEffect(() => {
    setPreference('theme', theme);
    if (theme === 'light') document.body.classList.add('light-theme');
    else document.body.classList.remove('light-theme');
    // `color-scheme` is declared on :root, so the html element keeps the dark
    // palette (native scrollbars, form controls and the UA selection color)
    // unless it is switched here as well.
    document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  }, [theme]);

  useEffect(() => {
    if (activeProject) fetchGitStatus();
    else setGitChanges([]);
  }, [activeProject]);

  useEffect(() => {
    diskFileContentsRef.current = {};
  }, [activeProject?.project_path]);

  useEffect(() => {
    if (!activeProject) return;
    // Each refresh walks the project tree and runs `git status` under the
    // server's exclusive-work lock, which every other request waits on. A
    // hidden window shows neither, so it skips them and catches up when it is
    // shown again. Coming back fires both `focus` and `visibilitychange`; the
    // second one, a moment after the first, is the same refresh twice.
    let lastRefresh = 0;
    const refreshWorkspace = () => {
      if (document.hidden) return;
      const now = Date.now();
      if (now - lastRefresh < 1000) return;
      lastRefresh = now;
      fetchFiles();
      fetchGitStatus();
      refreshSelectedFileFromDiskIfUnmodified();
    };
    const interval = setInterval(refreshWorkspace, 10000);
    window.addEventListener('focus', refreshWorkspace);
    document.addEventListener('visibilitychange', refreshWorkspace);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', refreshWorkspace);
      document.removeEventListener('visibilitychange', refreshWorkspace);
    };
  // fileContent intentionally excluded: the guard in refreshSelectedFileFromDiskIfUnmodified
  // now reads fileContentRef.current (always current) instead of a closure-captured value,
  // so there is no need to recreate this effect on every keystroke.
  // showHiddenWorkspaceFiles is included so the polling closure's fetchFiles() default
  // parameter always matches the current toggle (otherwise a stale closure would
  // periodically overwrite the file list with the toggle value from when the effect
  // was last created, making hidden files flicker on/off).
  }, [activeProject, currentGitRootPath, selectedFile, showHiddenWorkspaceFiles]);

  useEffect(() => {
    if (activeSidebarTab === 'git' && activeProject) fetchGitStatus();
  }, [activeSidebarTab, activeProject, currentGitRootPath]);

  // Un-maximize editor if all files are closed
  useEffect(() => {
    if (openFiles.length === 0 && isEditorMaximized) {
      setIsEditorMaximized(false);
    }
  }, [openFiles, isEditorMaximized]);

  useEffect(() => {
    setOpenFiles(prev => {
      const deduped = dedupeOpenFileList(prev, selectedFile);
      return deduped.length === prev.length && deduped.every((file, index) => file === prev[index])
        ? prev
        : deduped;
    });
  }, [isCaseInsensitiveProjectPath, selectedFile]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const trimToLimit = (arr, limit) => arr.length > limit ? arr.slice(arr.length - limit) : arr;

  const normalizeLogAgent = (agent) => String(agent || '').trim().replace(/^@+/, '');
  const sanitizeVisibleStreamChunk = (value) => String(value ?? '').replace(/<\/?think>/gi, '');
  const mergeableLogTypes = new Set(['thought', 'reflection', 'stream_chunk', 'stdout', 'stderr']);
  const thinkingLogTypes = new Set(['thought', 'reflection', 'stream_chunk']);
  const shouldMergeLog = (left, right) => (
    left
    && right
    && left.type === right.type
    && mergeableLogTypes.has(left.type)
    && normalizeLogAgent(left.agent) === normalizeLogAgent(right.agent)
  );
  // Reasoning keeps its most recent part, within the configured size; other
  // entries keep their beginning (gilzabots gui_src/src/utils/logMerge.js).
  const fitLogMessage = (message, type) => (
    fitMergedLogMessage(message, type, thoughtContextTokensRef.current)
  );

  const addLog = (type, message, agent) =>
    setTerminalLogs(prev => {
      const cleanMessage = type === 'stream_chunk'
        ? sanitizeVisibleStreamChunk(message)
        : String(message ?? '');
      if (!cleanMessage) return prev;
      const cleanAgent = normalizeLogAgent(agent);
      let next;
      if (mergeableLogTypes.has(type)) {
        const candidate = { type, agent: cleanAgent };
        for (let index = prev.length - 1; index >= 0; index -= 1) {
          const existing = prev[index];
          if (shouldMergeLog(existing, candidate)) {
            next = [...prev];
            next[index] = {
              ...existing,
              agent: normalizeLogAgent(existing.agent),
              // Reasoning keeps its *recent* part, as the reloaded history does
              // (`fitLogMessage`). Clamping to the first characters instead
              // froze the Agent Thinking panel mid-turn: past the cap every new
              // chunk was appended and cut away again, so the panel sat on the
              // opening lines while the chat preview moved with the stream.
              message: fitLogMessage(joinMergedLogMessage(existing.message, cleanMessage, type), type),
            };
            break;
          }
          if (
            thinkingLogTypes.has(type)
            && thinkingLogTypes.has(existing.type)
            && !shouldMergeLog(existing, candidate)
          ) {
            break;
          }
        }
      }
      if (!next) next = [...prev, { type, message: clampLogMessage(cleanMessage), agent: cleanAgent, timestamp: new Date().toLocaleTimeString() }];
      return trimToLimit(next, panelMaxLines);
    });

  const addProblem = ({ tool = t('app.agentTool', 'Agent'), message, severity = 'error', ...metadata }) => {
    if (!message) return;
    setProblems(prev => trimToLimit([
      ...prev,
      {
        id: Math.random().toString(),
        tool,
        message,
        severity,
        timestamp: new Date().toLocaleTimeString(),
        ...metadata,
      },
    ], panelMaxLines));
  };

  const compactForLatexFixPrompt = (value, limit) => {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
  };

  const summarizeCompileTarget = (compileDebug = {}) => {
    const target = compileDebug.selected_main_rel || compileDebug.selected_main_file || '';
    const input = compileDebug.compiler_input_tex || '';
    const cwd = compileDebug.compiler_cwd || '';
    const returncode = compileDebug.compiler_returncode;
    return [
      target ? `Selected main file: ${target}` : '',
      input ? `Compiler input: ${input}` : '',
      cwd ? `Compiler working directory: ${cwd}` : '',
      returncode !== undefined && returncode !== '' ? `Compiler return code: ${returncode}` : '',
    ].filter(Boolean).join('\n');
  };

  const buildLatexFixPrompt = (problem) => {
    const filePath = problem.filePath || selectedFile || '';
    const compiledMainFile = problem.compiledMainFile || activeProject?.main_file || '';
    const compileDebug = problem.compileDebug || {};
    const compileTarget = summarizeCompileTarget(compileDebug);
    const articleContent = problem.fileContent ?? fileContent ?? '';
    const log = problem.log || problem.message || '';
    const compileMode = problem.partial ? 'partial compilation' : 'full compilation';
    const draftMode = problem.draft ? 'draft mode enabled' : 'draft mode disabled';

    return [
      'Task: Fix the LaTeX compilation error in this GilzaBots project.',
      '',
      'Use the chat_orchestrator workflow: diagnose the compiler error, inspect project files when needed, edit the relevant file(s) with the available tools, and finish with a concise summary of what changed.',
      'Do not guess silently. If the log points to a different file than the selected file, prioritize the compiler location and read that file before editing.',
      '',
      'Project context:',
      `- Project: ${activeProject?.project_name || activeProject?.name || problem.projectName || '(unknown)'}`,
      `- Project path: ${activeProject?.project_path || problem.projectPath || ''}`,
      `- Selected article/file: ${filePath || '(none)'}`,
      `- Configured main file: ${activeProject?.main_file || problem.mainFile || '(none)'}`,
      `- Compiled main file: ${compiledMainFile || '(unresolved)'}`,
      `- Mode: ${compileMode}; ${draftMode}`,
      compileTarget ? `\nCompiler target details:\n${compileTarget}` : '',
      '',
      'Compiler error log:',
      '````text',
      compactForLatexFixPrompt(log, 20000),
      '````',
      '',
      'Selected article/file content at the time of compilation:',
      '````latex',
      compactForLatexFixPrompt(articleContent, 60000),
      '````',
      '',
      'Please correct the project files based on the error above. After editing, explain which file(s) changed and whether the user should compile again.',
    ].filter(part => part !== '').join('\n');
  };

  const handleLatexCompileSuccess = () => {
    setProblems(prev => prev.filter(problem => problem.source !== 'latex_compile'));
  };

  const handleLatexCompileError = (details) => {
    setProblems(prev => prev.filter(problem => problem.source !== 'latex_compile'));
    addProblem({
      tool: t('app.latexCompilerTool', 'LaTeX compiler'),
      message: details.log || t('app.latexCompileFailed', 'LaTeX compilation failed.'),
      severity: 'error',
      source: 'latex_compile',
      filePath: details.filePath || '',
      fileContent: details.fileContent || '',
      projectPath: details.projectPath || '',
      projectName: details.projectName || '',
      mainFile: details.mainFile || '',
      compiledMainFile: details.compiledMainFile || '',
      log: details.log || '',
      compileDebug: details.compileDebug || {},
      partial: Boolean(details.partial),
      draft: Boolean(details.draft),
    });
  };

  // ── API calls ─────────────────────────────────────────────────────────────
  const fetchProjects = async (forceSelectName) => {
    try {
      const res = await fetch('/api/projects/list');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
        if (data.projects?.length > 0) {
          if (forceSelectName) {
            const forced = data.projects.find(p => p.name === forceSelectName && p.exists);
            if (forced) { handleSelectProject(forced); return; }
          }
          if (!activeProject) {
            // Owned by the backend (ui_settings.json): localStorage is per
            // origin, and the origin changes with the server port.
            const lastActiveProjectName = data.last_active_project || '';
            let projToSelect = null;
            if (lastActiveProjectName) {
              projToSelect = data.projects.find(p => p.name === lastActiveProjectName && p.exists);
            }
            if (!projToSelect) {
              projToSelect = data.projects.find(p => p.exists);
            }
            if (projToSelect) handleSelectProject(projToSelect);
          }
        }
      }
    } catch (err) { addLog('error', t('app.failedToLoadProjects', { error: err.message })); }
  };

  const fetchFiles = async (showHiddenOverride = showHiddenWorkspaceFiles) => {
    if (!activeProject) return;
    try {
      const res = await fetch(`/api/files?projectPath=${encodeURIComponent(activeProject.project_path)}&showHiddenFiles=${showHiddenOverride ? 'true' : 'false'}`);
      if (res.ok) { const data = await res.json(); setFiles(data.files || []); }
      else { const e = await res.json(); addLog('error', t('app.failedToListFiles', { error: e.error })); }
    } catch (err) { addLog('error', t('app.fileCallError', { error: err.message })); }
  };

  const handleShowHiddenWorkspaceFilesChange = (checked) => {
    setShowHiddenWorkspaceFiles(checked);
    fetch('/api/settings/workspace', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ show_hidden_workspace_files: checked }),
    }).catch(() => { });
    fetchFiles(checked);
  };

  useEffect(() => {
    if (activeProject) fetchFiles(showHiddenWorkspaceFiles);
  }, [showHiddenWorkspaceFiles]);

  const fetchGitStatus = async () => {
    if (!activeProject) return;
    if (gitStatusRequestRef.current) return gitStatusRequestRef.current;

    const request = (async () => {
      try {
        const res = await fetch(`/api/git/status?${gitQuerySuffix()}&t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          setGitChanges(data.files || []);
        }
      } catch (err) {
        console.error('Failed to fetch git status', err);
      } finally {
        gitStatusRequestRef.current = null;
      }
    })();
    gitStatusRequestRef.current = request;
    return request;
  };

  // After a pass that downloaded or a resolved conflict, the explorer and the
  // Git view show what is on disk now.
  const refreshWorkspaceFiles = async () => {
    await Promise.all([fetchFiles(), fetchGitStatus()]);
  };

  // Cloud sync status for the active project. Fetching it is also what
  // registers the project with the backend's sync scheduler, so this runs
  // whenever a project becomes active — not only when the panel is open.
  const refreshCloudStatus = useCallback(async () => {
    if (!activeProject?.project_path) { setCloudStatus(null); return; }
    try {
      const params = new URLSearchParams({
        projectPath: activeProject.project_path,
        project: activeProject.name || '',
      });
      const res = await fetch(`/api/cloud/status?${params}`);
      const payload = await res.json();
      setCloudStatus(payload.error ? null : payload);
    } catch (_) {
      setCloudStatus(null);
    }
  }, [activeProject?.project_path, activeProject?.name]);

  // Which files are synced, waiting, moving or conflicted — the explorer marks
  // each one, the way a desktop Drive client does.
  const refreshCloudFileStates = useCallback(async () => {
    if (!activeProject?.project_path) { setCloudFileStates(null); return; }
    try {
      const params = new URLSearchParams({ projectPath: activeProject.project_path });
      const res = await fetch(`/api/cloud/file-states?${params}`);
      const payload = await res.json();
      setCloudFileStates(payload?.enabled ? payload.states : null);
    } catch (_) {
      setCloudFileStates(null);
    }
  }, [activeProject?.project_path]);

  useEffect(() => { refreshCloudStatus(); }, [refreshCloudStatus]);

  const cloudPassRunning = !!cloudStatus?.syncing || !!cloudStatus?.progress?.active;

  useEffect(() => {
    // A background pass finishes without telling the front-end, so the status
    // line is refreshed on a tick. Polling only while sync is on keeps a
    // project that never uses the feature from paying for it. While a pass is
    // actually running the tick speeds up: that is when the footer is showing
    // which file is moving, and a 20 s refresh would make it a slideshow.
    if (!cloudStatus?.settings?.enabled) { setCloudFileStates(null); return undefined; }
    const tick = () => { refreshCloudStatus(); refreshCloudFileStates(); };
    tick();
    const timer = setInterval(tick, cloudPassRunning ? 1000 : 20000);
    return () => clearInterval(timer);
  }, [cloudStatus?.settings?.enabled, cloudPassRunning, refreshCloudStatus, refreshCloudFileStates]);

  const rememberLastActiveProject = (projectName) => {
    fetch('/api/settings/last-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_name: projectName }),
    }).then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }).catch(err => addLog('error', t('app.failedToRememberProject', { error: err.message })));
  };

  const handleSelectProject = (proj) => {
    if (proj.exists === false) {
      addLog('error', t('app.projectDirMissing', { path: proj.project_path }));
      return;
    }

    let currentContents = { ...fileContents };
    if (selectedFile) {
      currentContents[selectedFile] = fileContent;
    }

    const dirtyFiles = unsavedFilePaths({
      openFiles,
      fileContents: currentContents,
      diskContents: diskFileContentsRef.current,
      isBinary: isBinaryEditorFile,
    });

    if (dirtyFiles.length > 0) {
      setConfirmRequest({
        prompt: t('app.unsavedProjectSwitchPrompt', { count: dirtyFiles.length }),
        options: ['yes', 'no', 'cancel'],
        callback: async (val) => {
          if (val === 'cancel') return;
          if (val === 'yes') {
            for (const filePath of dirtyFiles) {
              try {
                await fetch('/api/file/write', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ projectPath: activeProject.project_path, filePath, content: currentContents[filePath] })
                });
              } catch (e) { }
            }
          }
          setActiveProject(proj);
          rememberLastActiveProject(proj.name);
          addLog('info', t('app.projectSelected', { name: proj.project_name || proj.name }));
        }
      });
      return;
    }

    setActiveProject(proj);
    rememberLastActiveProject(proj.name);
    addLog('info', t('app.projectSelected', { name: proj.project_name || proj.name }));
  };

  const handleGitCommit = async (e) => {
    if (e) e.preventDefault();
    if (!activeProject || !commitMessage.trim() || isCommitting) return;
    setIsCommitting(true);
    addLog('info', t('app.commitCreating', { message: commitMessage }));
    try {
      const res = await fetch('/api/git/commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ message: commitMessage })),
      });
      const data = await res.json();
      if (res.ok) { addLog('info', t('app.commitSuccess')); setCommitMessage(''); fetchGitStatus(); }
      else { addLog('error', t('app.commitFailed', { error: data.error || t('app.unknownError') })); }
    } catch (err) { addLog('error', t('app.commitError', { error: err.message })); }
    finally { setIsCommitting(false); }
  };

  const handleStageFile = async (filePath) => {
    if (!activeProject) return false;
    try {
      const res = await fetch('/api/git/stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath, action: 'stage' })),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('app.unknownError'));
      }
      fetchGitStatus();
      return true;
    } catch (err) {
      addLog('error', t('app.stageError', { error: err.message }));
      return false;
    }
  };

  const handleStageAllFiles = async () => {
    if (!activeProject) return false;
    try {
      const res = await fetch('/api/git/stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath: '__all__', action: 'stage' })),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('app.unknownError'));
      }
      fetchGitStatus();
      return true;
    } catch (err) {
      addLog('error', t('app.stageError', { error: err.message }));
      return false;
    }
  };

  const handleUnstageFile = async (filePath) => {
    if (!activeProject) return false;
    try {
      const res = await fetch('/api/git/stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath, action: 'unstage' })),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t('app.unknownError'));
      }
      fetchGitStatus();
      return true;
    } catch (err) {
      addLog('error', t('app.unstageError', { error: err.message }));
      return false;
    }
  };

  const handleDiscardFile = async (filePath) => {
    if (!activeProject) return;
    try {
      const res = await fetch('/api/git/discard', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gitRequestPayload({ filePath })),
      });
      if (res.ok) {
        addLog('info', t('app.changesDiscarded', { path: filePath }));
        setFileContents(prev => {
          const next = { ...prev };
          delete next[filePath];
          return next;
        });
        if (sameFilePath(selectedFile, filePath)) {
          const readRes = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(filePath)}&t=${Date.now()}`);
          if (readRes.ok) {
            const data = await readRes.json();
            diskFileContentsRef.current[filePath] = data.content;
            setFileContent(data.content);
            setFileContents(prev => ({ ...prev, [filePath]: data.content }));
            setOriginalFileContents(prev => ({ ...prev, [filePath]: data.content }));
          } else {
            delete diskFileContentsRef.current[filePath];
            setOpenFiles(prev => prev.filter(f => !sameFilePath(f, filePath)));
            setSelectedFile(null);
            setFileContent('');
            setOriginalFileContents(prev => {
              const next = { ...prev };
              delete next[filePath];
              return next;
            });
          }
        }
        fetchGitStatus();
        fetchFiles();
        return;
      }
      if (res.ok) { addLog('info', t('app.changesDiscarded', { path: filePath })); fetchGitStatus(); fetchFiles(); }
      else { const d = await res.json(); addLog('error', t('app.discardFailed', { error: d.error })); }
    } catch (err) { addLog('error', t('app.discardChangesError', { error: err.message })); }
  };

  // ── File operations ────────────────────────────────────────────────────────
  const handleNodeSelect = (nodePath, isDirectory, e) => {
    if (e.ctrlKey || e.metaKey) {
      setSelectedNodes(prev => {
        const next = new Set(prev);
        if (next.has(nodePath)) next.delete(nodePath);
        else next.add(nodePath);
        return next;
      });
      return;
    }

    // Normal click clears multi-selection
    setSelectedNodes(new Set());
    if (!isDirectory) {
      handleFileSelect(nodePath);
    }
  };

  // Ctrl+A in the workspace tree: every file and directory, including those in
  // collapsed folders.
  const handleSelectAllNodes = () => {
    setSelectedNodes(new Set(collectTreePaths(files)));
  };

  // Opening a file has to put the editor on screen, but only the layouts that
  // hide it need leaving: forcing 'ide' from the studio or the document layout
  // would drop the user out of a layout that is already showing the file they
  // just picked.
  const revealEditorLayout = useCallback(() => {
    setLayoutMode(layoutAfterOpeningFile);
  }, []);

  // The diff view's baseline for a freshly read file: its content at git HEAD,
  // or empty when it has none.
  const loadHeadBaseline = (filePath) => {
    fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(filePath)}&t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(gitData => {
        if (gitData && gitData.content !== undefined) {
          setOriginalFileContents(prev => ({ ...prev, [filePath]: gitData.content }));
        } else {
          setOriginalFileContents(prev => ({ ...prev, [filePath]: '' }));
        }
      })
      .catch(() => {
        setOriginalFileContents(prev => ({ ...prev, [filePath]: '' }));
      });
  };

  // `focusEditor: false` scrolls to `jumpLine` without moving the keyboard
  // focus: an agent showing the user a file must not pull them out of the chat
  // composer they may be typing in. `column` (1-based, Monaco's UTF-16 units)
  // and `length` select a range on that line, as a search result does.
  const handleFileSelect = async (filePath, jumpLine = null, { focusEditor = true, column = null, length = 0 } = {}) => {
    if (!activeProject) return;
    setIsBottomMaximized(false);
    if (selectedFile) {
      const currentContent = getCurrentTextFileContent();
      setFileContents(prev => ({ ...prev, [selectedFile]: currentContent }));
      fileContentRef.current = currentContent;
    }
    if (isUnsupportedSystemFile(filePath)) {
      if (await handleOpenInSystem(filePath)) {
        addLog('info', t('app.openedInSystemApp', { path: filePath }));
      }
      return;
    }
    if (isBinaryEditorFile(filePath)) {
      setOpenFiles(prev => {
        const deduped = dedupeOpenFileList(prev, filePath);
        return deduped.some(openFile => sameFilePath(openFile, filePath))
          ? deduped.map(openFile => sameFilePath(openFile, filePath) ? filePath : openFile)
          : [...deduped, filePath];
      });
      setFileContent('');
      setSelectedFile(filePath);
      revealEditorLayout();
      return;
    }
    const cachedFilePath = Object.keys(fileContents).find(path => sameFilePath(path, filePath)) || filePath;
    setOpenFiles(prev => {
      const deduped = dedupeOpenFileList(prev, filePath);
      return deduped.some(openFile => sameFilePath(openFile, filePath))
        ? deduped.map(openFile => sameFilePath(openFile, filePath) ? filePath : openFile)
        : [...deduped, filePath];
    });
    if (cachedFilePath !== filePath) {
      setFileContents(prev => ({ ...prev, [filePath]: prev[cachedFilePath] }));
      if (diskFileContentsRef.current[cachedFilePath] !== undefined) {
        diskFileContentsRef.current[filePath] = diskFileContentsRef.current[cachedFilePath];
      }
      setOriginalFileContents(prev => (
        prev[cachedFilePath] === undefined ? prev : { ...prev, [filePath]: prev[cachedFilePath] }
      ));
    }
    if (fileContents[cachedFilePath] !== undefined) {
      setFileContent(fileContents[cachedFilePath]);
      setSelectedFile(filePath);
      revealEditorLayout(); // Put the editor on screen if the layout hides it
      if (jumpLine !== null) {
        setJumpToLine({ file: filePath, line: jumpLine, column, length, focusEditor });
      }
      return;
    }
    try {
      const res = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        diskFileContentsRef.current[filePath] = data.content;
        setFileContent(data.content);
        setFileContents(prev => ({ ...prev, [filePath]: data.content }));
        setOriginalFileContents(prev => ({ ...prev, [filePath]: data.content }));
        setSelectedFile(filePath);
        revealEditorLayout(); // Put the editor on screen if the layout hides it
        if (jumpLine !== null) {
          setJumpToLine({ file: filePath, line: jumpLine, column, length, focusEditor });
        }

        loadHeadBaseline(filePath);
      }
      else {
        addLog('error', t('app.fileReadFailed', { path: filePath }));
        setSelectedFile(filePath);
        setFileContent('');
        revealEditorLayout();
      }
    } catch (err) {
      addLog('error', t('app.readError', { error: err.message }));
      setSelectedFile(filePath);
      setFileContent('');
      revealEditorLayout();
    }
  };

  const saveFile = async ({ suppressCompile = false } = {}) => {
    if (!activeProject || !selectedFile) return false;
    // The PDF panel is a read-only viewer: there is nothing to write back.
    if (isBinaryEditorFile(selectedFile)) return false;
    const currentContent = getCurrentTextFileContent();
    fileContentRef.current = currentContent;
    if (currentContent !== fileContent) {
      setFileContent(currentContent);
    }
    const projectPath = activeProject.project_path;
    const filePath = selectedFile;
    const diskCache = diskFileContentsRef.current;
    const sameProject = () => documentContextRef.current?.projectPath === projectPath
      && diskFileContentsRef.current === diskCache;
    setFileContents(prev => ({ ...prev, [filePath]: currentContent }));
    pendingSaveCountRef.current += 1;
    setIsSaving(true);
    return fileSaveQueueRef.current.run(projectPath, filePathKey(filePath), async () => {
      try {
        // Check only once preceding saves have completed. A queued older write
        // may otherwise overwrite the version this save thought was on disk.
        if (diskCache[filePath] === currentContent) return true;
        const res = await fetch('/api/file/write', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: activeProject.project_path, filePath: selectedFile, content: currentContent }),
        });
        if (res.ok) {
          if (!sameProject()) return true;
          addLog('info', t('app.fileSaved', { path: filePath }));
          diskCache[filePath] = currentContent;
          // A save acknowledges a snapshot: typing that arrived while it was in
          // flight stays the live buffer.
          const live = documentContextRef.current;
          const activeDocument = sameFilePath(live.selectedFile, filePath);
          const liveContent = activeDocument ? live.getContent() : undefined;
          setFileContents(prev => {
            // Closing/renaming a tab must not resurrect it when a save returns.
            if (!Object.hasOwn(prev, filePath)) return prev;
            return { ...prev, [filePath]: activeDocument ? liveContent : prev[filePath] };
          });

          fetch(`/api/git/file-at-head?${gitQuerySuffix()}&filePath=${encodeURIComponent(selectedFile)}&t=${Date.now()}`)
            .then(r => r.ok ? r.json() : null)
            .then(gitData => {
              if (!sameProject()) return;
              if (gitData && gitData.content !== undefined) {
                setOriginalFileContents(prev => ({ ...prev, [selectedFile]: gitData.content }));
              } else {
                setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
              }
            })
            .catch(() => {
              if (!sameProject()) return;
              // Do not overwrite originalFileContents on error or 404 if it's unwanted, but actually we should set to empty if untracked.
              setOriginalFileContents(prev => ({ ...prev, [selectedFile]: '' }));
            });
          fetchGitStatus();
          if (activeDocument && !suppressCompile && selectedFile && selectedFile.toLowerCase().match(/\.(tex|cls|sty|bib)$/)) {
            const compileFull = activeProject.compile_on_save_full === true;
            const compilePartial = activeProject.compile_on_save_partial !== false;
            if (compileFull || compilePartial) {
              setTriggerCompileRequest({
                id: Date.now(),
                partial: !compileFull && compilePartial,
              });
            }
          }
          return true;
        }
        else {
          addLog('error', t('app.fileSaveFailedPath', { path: selectedFile }));
          return false;
        }
      } catch (err) {
        addLog('error', t('app.writeError', { error: err.message }));
        return false;
      }
      finally {
        pendingSaveCountRef.current -= 1;
        setIsSaving(pendingSaveCountRef.current > 0);
      }
    });
  };

  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);

  // ── Buffers vs. files the agent wrote ─────────────────────────────────────

  const handleCloseTab = (filePath, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (sameFilePath(selectedFile, filePath)) {
      const currentContent = getCurrentTextFileContent();
      fileContentRef.current = currentContent;
      setFileContents(prev => ({ ...prev, [filePath]: currentContent }));
    }
    setOpenFiles(prev => {
      const remaining = prev.filter(f => !sameFilePath(f, filePath));
      if (sameFilePath(selectedFile, filePath)) {
        if (remaining.length > 0) {
          const next = remaining[remaining.length - 1];
          setSelectedFile(next);
          setFileContent(isBinaryEditorFile(next) ? '' : (fileContents[next] || ''));
        }
        else { setSelectedFile(null); setFileContent(''); }
      }
      return remaining;
    });
  };

  // A tab an agent opens without focusing it. Its content is read now, as
  // handleFileSelect reads a focused one: closing the focused tab shows its
  // neighbour from the buffer cache, and a tab with nothing cached there would
  // show an empty editor whose save would empty the file.
  const openBackgroundTab = async (filePath) => {
    if (!activeProject) return;
    if (!isBinaryEditorFile(filePath) && fileContentsRef.current[filePath] === undefined) {
      const res = await fetch(`/api/file/read?projectPath=${encodeURIComponent(activeProject.project_path)}&filePath=${encodeURIComponent(filePath)}`);
      if (!res.ok) throw new Error(`could not read ${filePath} (HTTP ${res.status})`);
      const data = await res.json();
      diskFileContentsRef.current[filePath] = data.content;
      setFileContents(prev => (prev[filePath] === undefined ? { ...prev, [filePath]: data.content } : prev));
      setOriginalFileContents(prev => ({ ...prev, [filePath]: data.content }));
      loadHeadBaseline(filePath);
    }
    setOpenFiles(prev => (prev.some(f => sameFilePath(f, filePath)) ? prev : [...prev, filePath]));
  };

  // Hands reveal_in_pdf to the editor panel, which answers through the request's
  // resolver. An answered request is cleared, so a panel that remounts later
  // never replays it, and one no panel takes up (the editor is not on screen)
  // is answered with that rather than left to the backend's timeout.
  const requestPdfReveal = (filePath, line) => new Promise((resolve) => {
    let timer = null;
    const finish = (answer) => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
      setPdfRevealRequest(prev => (prev?.resolve === finish ? null : prev));
      resolve(answer);
    };
    timer = setTimeout(() => finish({
      ok: false,
      error: `The editor did not show ${filePath} in the PDF pane within ${PDF_REVEAL_TIMEOUT_MS / 1000} s.`,
    }), PDF_REVEAL_TIMEOUT_MS);
    pdfRevealSeqRef.current += 1;
    setPdfRevealRequest({ seq: pdfRevealSeqRef.current, file: filePath, line, resolve: finish });
  });

  // ── Commands from Claude Code (MCP bridge → /api/ide/events) ───────────────
  const MAX_REPORTED_SELECTION = 20000;
  const editorStateForClaude = () => {
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    if (!editor || !model || !selectedFile || isBinaryEditorFile(selectedFile)) {
      return { mode: selectedFile && isBinaryEditorFile(selectedFile) ? 'viewer' : 'none', cursor: null, selection: null };
    }
    const position = editor.getPosition?.();
    const range = editor.getSelection?.();
    let selection = null;
    if (range && !range.isEmpty()) {
      const text = model.getValueInRange(range);
      selection = {
        text: text.slice(0, MAX_REPORTED_SELECTION),
        ...(text.length > MAX_REPORTED_SELECTION ? { truncated: true } : {}),
        start_line: range.startLineNumber, start_column: range.startColumn,
        end_line: range.endLineNumber, end_column: range.endColumn,
      };
    }
    return {
      mode: 'code',
      cursor: position ? { line: position.lineNumber, column: position.column } : null,
      selection,
    };
  };

  const ideCommandDepsRef = useRef(null);
  ideCommandDepsRef.current = {
    getProjectPath: () => documentContextRef.current?.projectPath || '',
    caseInsensitive: () => isCaseInsensitiveProjectPath,
    samePath: sameFilePath,
    openFiles: () => openFiles,
    selectedFile: () => selectedFile,
    opensOutside: isUnsupportedSystemFile,
    hasNoLines: isBinaryEditorFile,
    isUnsaved: (filePath) => {
      const live = documentContextRef.current;
      return unsavedFilePaths({
        openFiles: [filePath],
        fileContents: fileContentsRef.current,
        activeFile: live?.selectedFile,
        activeContent: live?.getContent(),
        diskContents: diskFileContentsRef.current,
        isBinary: isBinaryEditorFile,
      }).length > 0;
    },
    focusTab: (filePath, line) => handleFileSelect(filePath, line, { focusEditor: false }),
    addBackgroundTab: openBackgroundTab,
    closeTab: (filePath) => handleCloseTab(filePath),
    revealInPdf: requestPdfReveal,
    setLayout: (mode) => enterLayout(mode, {
      hasOpenDocument: !!selectedFile,
      setLayoutMode,
      setActiveSidebarTab,
      setIsChatVisible,
      setIsTerminalCollapsed,
      setActiveBottomTab,
    }),
    problems: () => problems,
    editorState: editorStateForClaude,
    pdfView: () => pdfViewProbeRef.current?.() || null,
  };
  const ideCommandRunnerRef = useRef(null);
  if (!ideCommandRunnerRef.current) {
    const deps = new Proxy({}, { get: (_, name) => ideCommandDepsRef.current[name] });
    ideCommandRunnerRef.current = createIdeCommandRunner(deps);
  }

  // One stream for the whole window. A command is answered even when refused, so
  // the MCP tool fails with the reason instead of timing out (gilzacode/ide_control.py).
  useEffect(() => {
    const events = new EventSource('/api/ide/events');
    events.onmessage = (message) => {
      let data;
      try { data = JSON.parse(message.data); } catch { return; }
      if (data.type === 'latex_compiled') {
        setExternalCompile(data);
        return;
      }
      if (data.type !== 'command') return;
      const reads = data.action === 'get_editor_state' || data.action === 'get_pdf_view' || data.action === 'get_problems';
      Promise.resolve(ideCommandRunnerRef.current(data))
        .then((result) => {
          if (!reads) {
            addLog(result.ok ? 'info' : 'error', result.ok
              ? t('app.claudeCommandDone', 'Claude Code: {{action}} {{path}}', { action: data.action, path: data.args?.path || data.args?.layout || '' })
              : t('app.claudeCommandRefused', 'Claude Code command {{action}} not carried out: {{error}}', { action: data.action, error: result.error }));
          }
          return fetch('/api/ide/result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...result, id: data.id }),
          });
        })
        .catch((err) => console.error('Failed to answer a Claude Code command', err));
    };
    return () => events.close();
  }, []);

  // Keeps only `filePath` open. When it is not the active tab we go through
  // handleFileSelect first, so its content is loaded/persisted exactly like a
  // regular tab switch before the other tabs disappear.
  const handleCloseOtherTabs = async (filePath) => {
    if (!sameFilePath(selectedFile, filePath)) {
      await handleFileSelect(filePath);
    } else {
      const currentContent = getCurrentTextFileContent();
      fileContentRef.current = currentContent;
      setFileContents(prev => ({ ...prev, [filePath]: currentContent }));
    }
    setOpenFiles(prev => prev.filter(f => sameFilePath(f, filePath)));
  };

  const handleCloseAllTabs = () => {
    if (selectedFile) {
      const currentContent = getCurrentTextFileContent();
      fileContentRef.current = currentContent;
      setFileContents(prev => ({ ...prev, [selectedFile]: currentContent }));
    }
    setOpenFiles([]);
    setSelectedFile(null);
    setFileContent('');
  };

  // New files and new directories are created in place: a provisional row
  // appears in the target directory of the workspace tree and the user types
  // the name there (`InlineCreateNode`).
  const beginInlineCreate = (kind, parentPath) => {
    if (!activeProject) return;
    setContextMenu(null);
    setRenamingNodePath(null);
    inlineCreateIdRef.current += 1;
    setPendingCreate({ id: inlineCreateIdRef.current, kind, parentPath: parentPath || '' });
  };

  const handleCreateNewFile = (parentPath) => beginInlineCreate('file', parentPath);
  const handleCreateNewDir = (parentPath) => beginInlineCreate('dir', parentPath);

  const cancelInlineCreate = () => setPendingCreate(null);

  // Resolves to a message shown under the provisional row (which stays open for
  // correction), or to null once the entry exists. Creation is exclusive: the
  // server refuses an existing path instead of overwriting it.
  const submitInlineCreate = async (name) => {
    const request = pendingCreate;
    if (!request || !activeProject) return null;
    const resolved = resolveInlineCreatePath({ parentPath: request.parentPath, name });
    if (resolved.cancelled) {
      setPendingCreate(null);
      return null;
    }
    if (resolved.error) {
      return t('explorerSidebar.inlineCreateInvalidName', 'Use a relative name without empty, "." or ".." segments.');
    }

    const targetPath = resolved.path;
    const isDir = request.kind === 'dir';
    try {
      let res;
      if (isDir) {
        res = await fetch('/api/file/mkdir', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: activeProject.project_path, dirPath: targetPath, exclusive: true }),
        });
      } else {
        res = await fetch('/api/file/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: activeProject.project_path, filePath: targetPath, content: '', exclusive: true }),
        });
      }

      if (!res.ok) {
        if (res.status === 409) {
          return t('explorerSidebar.inlineCreateExists', '"{{name}}" already exists at this location. Choose a different name.', { name: targetPath.split('/').pop() });
        }
        const body = await res.json().catch(() => ({}));
        const message = body.error || `HTTP ${res.status}`;
        addLog('error', isDir ? t('app.dirCreateError', { error: message }) : t('app.fileCreateError', { error: message }));
        return message;
      }

      setPendingCreate(null);
      addLog('info', isDir ? t('app.dirCreated', { path: targetPath }) : t('app.fileCreated', { path: targetPath }));
      await fetchFiles();
      if (!isDir) await handleFileSelect(targetPath);
      return null;
    } catch (err) {
      addLog('error', isDir ? t('app.dirCreateCallError', { error: err.message }) : t('app.fileCreateCallError', { error: err.message }));
      return err.message;
    }
  };

  const handleImportFile = (parentPath = '') => {
    if (!activeProject) return;
    importTargetPathRef.current = parentPath || '';
    setContextMenu(null);
    importFileInputRef.current?.click();
  };

  const handleImportFileSelected = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length || !activeProject) return;

    const targetDir = importTargetPathRef.current || '';
    let lastImportedPath = null;

    for (const file of files) {
      const formData = new FormData();
      formData.append('projectPath', activeProject.project_path);
      formData.append('targetDir', targetDir);
      formData.append('file', file, file.name);

      try {
        const res = await fetch('/api/file/import', {
          method: 'POST',
          body: formData,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('app.importFailed'));
        addLog('info', t('app.fileImported', { path: data.filePath || file.name }));
        if (data.filePath) lastImportedPath = data.filePath;
      } catch (err) {
        addLog('error', t('app.importFileError', { error: err.message }));
      }
    }

    await fetchFiles();
    if (lastImportedPath) await handleFileSelect(lastImportedPath);
  };

  const handleRenameNode = (node) => {
    if (!activeProject || !node) return;
    setPendingCreate(null);
    setRenamingNodePath(node.path);
  };

  const executeRenameNode = async (node, newPath) => {
    setRenamingNodePath(null);
    if (!activeProject || !node || !newPath || newPath === node.path) return;
    try {
      const res = await fetch('/api/file/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, oldPath: node.path, newPath })
      });
      if (res.ok) {
        addLog('info', t('app.itemRenamed', { itemType: t(node.isDirectory ? 'app.itemTypeDirectory' : 'app.itemTypeFile'), oldPath: node.path, newPath }));
        if (!node.isDirectory) {
          setOpenFiles(prev => dedupeOpenFileList(prev.map(f => sameFilePath(f, node.path) ? newPath : f), newPath));
          setFileContents(prev => {
            const n = { ...prev };
            const oldKey = Object.keys(n).find(k => sameFilePath(k, node.path));
            if (oldKey !== undefined) { n[newPath] = n[oldKey]; delete n[oldKey]; }
            return n;
          });
          setOriginalFileContents(prev => {
            const n = { ...prev };
            const oldKey = Object.keys(n).find(k => sameFilePath(k, node.path));
            if (oldKey !== undefined) { n[newPath] = n[oldKey]; delete n[oldKey]; }
            return n;
          });
          if (sameFilePath(selectedFile, node.path)) setSelectedFile(newPath);
        } else {
          setOpenFiles(prev => dedupeOpenFileList(prev.map(f => replaceFilePathPrefix(f, node.path, newPath)), newPath));
          setFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[replaceFilePathPrefix(k, node.path, newPath)] = v; return n; });
          setOriginalFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[replaceFilePathPrefix(k, node.path, newPath)] = v; return n; });
          if (isFileInsidePath(selectedFile, node.path)) setSelectedFile(prev => replaceFilePathPrefix(prev, node.path, newPath));
        }
        moveDiskContents(node.path, newPath);
        await fetchFiles();
      } else {
        const e = await res.json();
        addLog('error', t('app.fileRenameError', { error: e.error }));
      }
    } catch (err) {
      addLog('error', t('app.renameError', { error: err.message }));
    }
  };

  // Saves `changes` (see gilzacode/projects.py UPDATABLE) and mirrors the result.
  const saveProjectChanges = async (name, changes) => {
    const res = await fetch('/api/projects/update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, changes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('app.unknownError'));
    setProjects(prev => prev.map(p => (p.name === data.name ? { ...p, ...data } : p)));
    if (activeProject?.name === data.name) setActiveProject(prev => (prev ? { ...prev, ...data } : prev));
    return data;
  };

  const handleSetMainFile = async (node) => {
    if (!activeProject || !node || node.isDirectory) return;
    try {
      // Calculate relative path from project root
      let relPath = node.path;
      if (activeProject.project_path && node.path.startsWith(activeProject.project_path)) {
        relPath = node.path.substring(activeProject.project_path.length);
        if (relPath.startsWith('/') || relPath.startsWith('\\')) {
          relPath = relPath.substring(1);
        }
      }

      await saveProjectChanges(activeProject.name, { main_file: relPath });
      addLog('info', t('app.mainFileSet', { path: relPath }));
    } catch (err) {
      addLog('error', t('app.mainFileSetError', { error: err.message }));
    }
  };

  const handleDeleteNode = async (node) => {
    if (!activeProject || !node) return;

    // A node that is part of the multi-selection deletes the whole selection.
    // Paths inside a selected directory go with it, so only the outermost ones
    // are deleted (a child deleted after its folder would fail as missing).
    const nodesToDelete = (selectedNodes && selectedNodes.has(node.path))
      ? outermostPaths(Array.from(selectedNodes))
      : [node.path];

    const isMulti = nodesToDelete.length > 1 || nodesToDelete[0] !== node.path;
    let msg = '';
    if (isMulti) {
      msg = t('app.deleteMultiPrompt', 'Are you sure you want to delete {{count}} selected items? All internal files in directories will also be removed!', { count: nodesToDelete.length });
    } else {
      if (node.isDirectory) {
        msg = t('app.deleteSingleDir', 'Are you sure you want to delete the directory "{{name}}"? All internal files will also be removed!', { name: node.path });
      } else {
        msg = t('app.deleteSingleFile', 'Are you sure you want to delete the file "{{name}}"?', { name: node.path });
      }
    }

    setConfirmRequest({
      prompt: msg,
      options: ['yes', 'no'],
      default: 'no',
      callback: async (value) => {
        if (value !== 'yes') return;
        try {
          let successCount = 0;
          for (const pathToDelete of nodesToDelete) {
            const res = await fetch('/api/file/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, filePath: pathToDelete }) });
            if (res.ok) {
              successCount++;
              setOpenFiles(prev => prev.filter(f => !isFileInsidePath(f, pathToDelete)));
              setFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) if (!isFileInsidePath(k, pathToDelete)) n[k] = v; return n; });
              setOriginalFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) if (!isFileInsidePath(k, pathToDelete)) n[k] = v; return n; });
              dropDiskContents(pathToDelete);
              if (isFileInsidePath(selectedFile, pathToDelete)) {
                // If it's the current file, we can't reliably pick the 'last' open file easily in a loop, so we just clear it.
                setSelectedFile(null); setFileContent('');
              }
            } else {
              const e = await res.json(); addLog('error', t('app.deletePathFailed', { path: pathToDelete, error: e.error }));
            }
          }
          if (successCount > 0) {
            addLog('info', t('app.itemsDeleted', { count: successCount }));
            setSelectedNodes(new Set()); // clear multi-selection
            await fetchFiles();
          }
        } catch (err) { addLog('error', t('app.deleteError', { error: err.message })); }
      }
    });
  };

  // Moves one or more nodes (files/directories) into targetDirPath ('' = project root).
  const handleMoveNode = async (paths, targetDirPath) => {
    if (!activeProject || !paths || paths.length === 0) return;
    // A selected directory carries its selected contents along.
    const uniquePaths = outermostPaths(paths);
    let successCount = 0;
    for (const oldPath of uniquePaths) {
      const nodeName = oldPath.replace(/\\/g, '/').split('/').pop();
      const newPath = targetDirPath ? `${targetDirPath}/${nodeName}` : nodeName;
      if (sameFilePath(oldPath, newPath)) continue;
      if (isFileInsidePath(targetDirPath || '', oldPath)) { addLog('error', t('app.moveDirectoryIntoItself')); continue; }
      try {
        const res = await fetch('/api/file/rename', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: activeProject.project_path, oldPath, newPath }) });
        if (res.ok) {
          successCount++;
          setOpenFiles(prev => dedupeOpenFileList(prev.map(f => isFileInsidePath(f, oldPath) ? replaceFilePathPrefix(f, oldPath, newPath) : f), newPath));
          setFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[isFileInsidePath(k, oldPath) ? replaceFilePathPrefix(k, oldPath, newPath) : k] = v; return n; });
          setOriginalFileContents(prev => { const n = {}; for (const [k, v] of Object.entries(prev)) n[isFileInsidePath(k, oldPath) ? replaceFilePathPrefix(k, oldPath, newPath) : k] = v; return n; });
          moveDiskContents(oldPath, newPath);
          if (isFileInsidePath(selectedFile, oldPath)) setSelectedFile(prev => replaceFilePathPrefix(prev, oldPath, newPath));
        } else {
          const e = await res.json();
          addLog('error', t('app.movePathFailed', { path: oldPath, error: e.error }));
        }
      } catch (err) { addLog('error', t('app.moveError', { error: err.message })); }
    }
    if (successCount > 0) {
      addLog('info', t('app.itemsMoved', { count: successCount }));
      setSelectedNodes(new Set());
      await fetchFiles();
    }
  };

  const handleOpenMoveModal = (node) => {
    setContextMenu(null);
    if (!activeProject || !node) return;
    const paths = (selectedNodes && selectedNodes.has(node.path) && selectedNodes.size > 1)
      ? Array.from(selectedNodes)
      : [node.path];
    setMoveModal({ paths });
  };

  const confirmMoveModal = async (targetDirPath) => {
    if (!moveModal) return;
    const paths = moveModal.paths;
    setMoveModal(null);
    await handleMoveNode(paths, targetDirPath);
  };

  // ── Project CRUD ──────────────────────────────────────────────────────────
  const handleCreateProject = async (e) => {
    if (e) e.preventDefault();
    setNewProjError('');

    const sep = navigator.userAgent.toLowerCase().includes('windows') ? '\\' : '/';
    let basePath = newProjPath;
    if (basePath.endsWith(sep)) basePath = basePath.slice(0, -1);
    const finalProjectPath = `${basePath}${sep}${newProjName}`;

    try {
      const res = await fetch('/api/projects/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_name: newProjName, project_path: finalProjectPath }),
      });
      if (res.ok) {
        const created = await res.json();
        addLog('info', t('app.projectRegistered', { name: newProjName }));
        setShowNewProjectModal(false); setNewProjName(''); setNewProjPath('');
        fetchProjects(created.name);
      } else { const err = await res.json(); setNewProjError(err.error || t('app.projectCreateError')); addLog('error', t('app.projectCreateFailed', { error: err.error })); }
    } catch (err) { setNewProjError(err.message || t('app.projectCreateError')); addLog('error', t('app.projectCreateFailed', { error: err.message })); }
  };

  const handleDeleteProject = (projName) => {
    setDeleteCloudLink(null);
    setProjectToDelete(projName);
    // Whether the dialog can offer to delete the cloud copy too. Local state
    // only, so the dialog does not wait on the network.
    const projectPath = projects.find(p => p.name === projName)?.project_path
      || (activeProject?.name === projName ? activeProject.project_path : '');
    if (!projectPath) return;
    fetch(`/api/cloud/link?${new URLSearchParams({ projectPath })}`)
      .then(res => res.json())
      .then(link => setDeleteCloudLink(link && !link.error ? link : null))
      .catch(() => setDeleteCloudLink(null));
  };

  const confirmDeleteProject = async (deleteDir, deleteCloud = false) => {
    if (!projectToDelete) return;
    const projName = projectToDelete;
    setProjectToDelete(null);
    setDeleteCloudLink(null);
    try {
      const res = await fetch('/api/projects/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: projName, delete_dir: deleteDir, delete_cloud: deleteCloud }) });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        addLog('info', t('app.projectRemoved', { name: projName }));
        if (data?.cloud?.deleted) addLog('info', t('app.projectCloudCopyRemoved', { defaultValue: 'Cloud copy of {{name}} deleted.', name: projName }));
        if (activeProject?.name === projName) setActiveProject(null);
        fetchProjects();
      } else {
        const data = await res.json();
        addLog('error', t('app.projectDeleteError', { error: data.error }));
        showAlert(t('app.projectDeleteError', { error: data.error }));
      }
    } catch (err) { addLog('error', t('app.projectDeleteError', { error: err.message })); }
  };

  const openEditModal = async (e, proj) => {
    e.stopPropagation();
    let fresh = proj;
    try {
      const res = await fetch('/api/projects/list');
      if (res.ok) {
        const { projects: list } = await res.json();
        const found = list.find(p => p.name === proj.name);
        if (found) fresh = found;
      }
    } catch (_) { }
    setEditProjError('');
    const compileOnSaveFull = fresh.compile_on_save_full === true;
    const compileOnSavePartial = !compileOnSaveFull && fresh.compile_on_save_partial !== false;
    setEditingProject({
      name: fresh.name, project_name: fresh.project_name || fresh.name, project_path: fresh.project_path || '',
      main_file: fresh.main_file || '', git_root_path: fresh.git_root_path || '',
      compile_on_save_partial: compileOnSavePartial, compile_on_save_full: compileOnSaveFull,
    });
  };

  const handleUpdateProject = async (e) => {
    e.preventDefault();
    if (!editingProject) return;
    setEditProjError('');
    try {
      const updated = await saveProjectChanges(editingProject.name, {
        project_name: editingProject.project_name,
        project_path: editingProject.project_path,
        main_file: editingProject.main_file || '',
        git_root_path: editingProject.git_root_path || '',
        compile_on_save_partial: editingProject.compile_on_save_partial === true && editingProject.compile_on_save_full !== true,
        compile_on_save_full: editingProject.compile_on_save_full === true,
      });
      addLog('info', t('app.projectUpdated', { name: updated.project_name }));
      setEditingProject(null);
      // Auto-selects the project once its path is fixed, so repairing a project
      // whose folder had moved takes effect immediately.
      await fetchProjects(updated.name);
    } catch (err) { setEditProjError(err.message || t('app.projectUpdateError')); addLog('error', t('app.projectUpdateFailed', { error: err.message })); }
  };

  // ── Dir picker ────────────────────────────────────────────────────────────
  // The server returns the parent/drive entries even when the folder itself
  // cannot be listed, plus an error describing why the listing failed.
  const fetchDirListing = async (path) => {
    const res = await fetch('/api/fs/dirs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    const data = await res.json();
    let error = '';
    if (!res.ok) {
      error = res.status === 403
        ? t('dirPickerModal.permissionDenied')
        : t('dirPickerModal.listError', { error: data.error || t('app.unknownError') });
    }
    return { current: data.current || path, dirs: data.dirs || [], error };
  };

  const openDirPicker = async (target, startPath) => {
    const path = startPath || '~';
    try {
      setDirPicker({ target, ...(await fetchDirListing(path)) });
    } catch (e) {
      setDirPicker({ target, current: path, dirs: [], error: t('dirPickerModal.listError', { error: e.message }) });
    }
  };

  const navigateDirPicker = async (path) => {
    try {
      const listing = await fetchDirListing(path);
      setDirPicker(prev => ({ ...prev, ...listing }));
    } catch (e) {
      setDirPicker(prev => ({ ...prev, error: t('dirPickerModal.listError', { error: e.message }) }));
    }
  };

  const updateActiveGitRoot = async (gitRootPath) => {
    if (!activeProject) return;
    try {
      const data = await saveProjectChanges(activeProject.name, { git_root_path: gitRootPath || '' });
      addLog('info', gitRootPath ? t('app.gitRootSet', { path: data.git_root_path }) : t('app.gitRootReset'));
      fetchGitStatus();
    } catch (err) {
      addLog('error', t('app.gitRootSetError', { error: err.message }));
    }
  };

  // Cloud download: opening the panel resolves a sensible default parent folder
  // so the common case is "press Download", not "go find the home directory".
  const openCloudDownload = async () => {
    setIsCloudDownloadOpen(true);
    if (cloudDownloadParent) return;
    try {
      const res = await fetch('/api/fs/dirs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '~' })
      });
      const data = await res.json();
      if (data.current) setCloudDownloadParent(data.current);
    } catch (e) { /* the user can still pick a folder by hand */ }
  };

  const handleProjectDownloaded = (project) => {
    setIsCloudDownloadOpen(false);
    const downloaded = (project?.report?.downloaded || []).length;
    addLog('info', t('app.projectDownloaded', {
      name: project.project_name || project.name,
      count: downloaded,
      defaultValue: '{{name}} downloaded from the cloud ({{count}} file(s)).',
    }));
    fetchProjects(project.name);
  };

  const confirmDirPicker = async () => {
    if (!dirPicker) return;
    if (dirPicker.target === 'new') setNewProjPath(dirPicker.current);
    else if (dirPicker.target === 'git-root') {
      await updateActiveGitRoot(dirPicker.current);
    }
    else if (dirPicker.target === 'edit-git-root') {
      setEditingProject(p => ({ ...p, git_root_path: dirPicker.current }));
    }
    else if (dirPicker.target === 'cloud-download') {
      setCloudDownloadParent(dirPicker.current);
    }
    else if (dirPicker.target === 'import') {
      // Call import-project API
      try {
        const res = await fetch('/api/projects/import', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_path: dirPicker.current })
        });
        const data = await res.json();
        if (res.ok) {
          addLog('info', t('app.projectImported', { name: data.project_name }));
          setImportError('');
          fetchProjects(data.name);
        } else {
          setImportError(data.error || t('app.importProjectError'));
          addLog('error', t('app.importProjectErrorDetail', { error: data.error }));
        }
      } catch (err) {
        setImportError(t('app.errorWithMessage', { error: err.message }));
        addLog('error', t('app.importFileError', { error: err.message }));
      }
    }
    else setEditingProject(p => ({ ...p, project_path: dirPicker.current }));
    setDirPicker(null);
  };

  // ── Context menu ──────────────────────────────────────────────────────────
  const handleWorkspaceContextMenu = (e) => {
    if (!activeProject) return;
    e.preventDefault(); e.stopPropagation();
    setRightClickedNode(null);
    setContextMenu(viewportPointToApp(e.clientX, e.clientY));
  };

  const handleNodeContextMenu = (e, node) => {
    if (!activeProject) return;
    e.preventDefault(); e.stopPropagation();
    setRightClickedNode(node);
    setContextMenu(viewportPointToApp(e.clientX, e.clientY));
  };

  // Resolves to whether the desktop actually took the file, so a caller never
  // announces an open that the system opener refused.
  const handleOpenInSystem = async (node) => {
    setContextMenu(null);
    if (!activeProject || !node) return false;
    const targetPath = typeof node === 'string' ? node : (node.path || node);
    try {
      const res = await fetch('/api/file/open-explorer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: activeProject.project_path, filePath: targetPath })
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${res.status}`);
      }
      return true;
    } catch (err) {
      console.error('Failed to open in system:', err);
      addLog('error', t('app.openSystemError', { error: err.message }));
      return false;
    }
  };

  const handleCopyNode = (node) => {
    setClipboardNode(node);
    setContextMenu(null);
  };

  const handlePasteNode = async (parentPath) => {
    setContextMenu(null);
    if (!clipboardNode || !activeProject) return;
    try {
      const targetName = clipboardNode.name;
      const targetPath = parentPath ? `${parentPath}/${targetName}` : targetName;
      const res = await fetch('/api/file/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject.project_path,
          sourcePath: clipboardNode.path,
          targetPath: targetPath,
        }),
      });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || t('app.pasteFailed'));
      }
      fetchFiles();
    } catch (err) {
      addLog('error', t('app.pasteError', { error: err.message }));
    }
  };

  // ── Agent ─────────────────────────────────────────────────────────────────

  // ── Monitors (PROJECT_DESIGN 2.24) ─────────────────────────────────────

  // "Fix with AI" stages the error report in Claude Code's prompt, like "Ask about":
  // the user reviews it and sends it. (GilzaBots opened a new chat and sent it.)
  const handleFixLatexProblem = (problem) => {
    if (!activeProject || !problem) return;
    stageClaudePrompt(buildLatexFixPrompt(problem));
  };

  // "Ask about" only stages the question: it opens the Claude Code panel and hands
  // the prompt to it, which pastes it into Claude Code's composer without sending
  // (PROJECT_DESIGN.md §2). The user completes the prompt and sends it themselves.
  //
  // The staged text has one shape for every document (utils/askAboutPrompt.js);
  // only the locator differs, because a PDF has pages and a rendered Markdown
  // preview has sections.
  const stageClaudePrompt = (prompt) => {
    setIsChatVisible(true);
    claudePromptSeqRef.current += 1;
    setClaudePromptRequest({ seq: claudePromptSeqRef.current, text: prompt });
  };

  const buildInlineClaudePrompt = (request, instruction) => {
    const file = selectedFile || '';
    const { startLine, endLine, selectedText, mode } = request;
    const hasSelection = Boolean(selectedText && selectedText.trim());
    const where = hasSelection
      ? (startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`)
      : `line ${startLine}, column ${request.cursorCol ?? request.startColumn ?? 1}`;
    const fence = '````';
    const excerpt = hasSelection ? `\n\nSelected text:\n${fence}\n${selectedText}\n${fence}` : '';
    if (mode === 'createIllustration') {
      return `In ${file} (${where}): create an SVG illustration for the selected text, save it in the project, and reference it from ${file}.\n\nInstruction: ${instruction}${excerpt}`;
    }
    return `In ${file} (${where}): ${instruction}${hasSelection ? '\nApply it to the selected text and edit the file directly.' : '\nInsert the result at that position and edit the file directly.'}${excerpt}`;
  };

  const handleInlineSubmit = (instruction) => {
    if (!inlinePrompt || !activeProject || !String(instruction || '').trim()) return;
    stageClaudePrompt(buildInlineClaudePrompt(inlinePrompt, instruction.trim()));
    setInlinePrompt(null);
  };

  const handleAskAboutPdf = ({ pdfPath, sourceFile, page, totalPages, selectedText } = {}) => {
    if (!activeProject || !pdfPath) return;
    const locator = totalPages
      ? `${t('app.pdfPageLabel', 'Page')} ${page}/${totalPages}`
      : `${t('app.pdfPageLabel', 'Page')} ${page}`;
    stageClaudePrompt(buildAskAboutDocumentPrompt(t, {
      documentPath: pdfPath,
      projectPath: activeProject?.project_path || '',
      sourceFile,
      sourceFileLabel: t('app.pdfSourceFileLabel', 'LaTeX source open in the editor'),
      locator,
      selectedText,
      excerptLabel: t('app.pdfSelectedExcerptLabel', 'Excerpt selected in the PDF viewer'),
    }));
  };

  const handleAskAboutMarkdown = ({ documentPath, heading, selectedText } = {}) => {
    if (!activeProject || !documentPath) return;
    // A rendered preview has no page numbers and no dependable mapping back to
    // source lines, so the section the excerpt was read in is the locator. It
    // is omitted rather than guessed when the excerpt sits above the first
    // heading.
    stageClaudePrompt(buildAskAboutDocumentPrompt(t, {
      documentPath,
      projectPath: activeProject?.project_path || '',
      locator: heading ? `${t('app.markdownSectionLabel', 'Section')}: ${heading}` : '',
      selectedText,
      excerptLabel: t('app.markdownSelectedExcerptLabel', 'Excerpt selected in the Markdown preview'),
    }));
  };

  const sendConfirmResponse = (value) => {
    const request = confirmRequest;
    setConfirmRequest(null);
    request?.callback?.(value);
  };

  // ── Editor mount ──────────────────────────────────────────────────────────
  const handleEditorDidMount = (editor, monaco) => {
    editorRef.current = editor;
    if (monaco) monacoRef.current = monaco;

    editor.onDidChangeModelContent(() => {
      lastEditorInputAtRef.current = Date.now();
      fileContentRef.current = editor.getValue();
    });

    editor.onKeyDown((e) => {
      const ev = e.browserEvent;
      const isCtrl = ev.ctrlKey || ev.metaKey;
      if (isCtrl && (ev.key === '+' || ev.key === '=' || ev.code === 'Equal' || ev.code === 'NumpadAdd')) {
        ev.preventDefault(); ev.stopPropagation();
        setEditorFontSize(prev => { const v = Math.min(30, prev + 1); setPreference('editorFontSize', v); return v; });
      } else if (isCtrl && (ev.key === '-' || ev.code === 'Minus' || ev.code === 'NumpadSubtract')) {
        ev.preventDefault(); ev.stopPropagation();
        setEditorFontSize(prev => { const v = Math.max(10, prev - 1); setPreference('editorFontSize', v); return v; });
      }
    });

    // Ctrl+S is registered as a Monaco command rather than matched on
    // browserEvent.key: the keybinding service resolves the physical key, so the
    // shortcut survives runtimes where the character cannot be resolved. This is
    // how every other editor shortcut (Ctrl+J, Ctrl+F, Ctrl+L) is already bound.
    if (monaco) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveFileRef.current?.();
      });
    }
  };

  // ── Inline submit — called by InlinePromptOverlay ─────────────────────────
  /**
   * Builds a context-prefixed prompt and sends it to the agent.
   * Also stores the current selection range so that auto-replace can fire
   * when the agent returns the modified code.
   */

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="vscode-app">
      <input
        ref={importFileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleImportFileSelected}
      />
      <div className="vscode-main">

        {/* Activity Bar */}
        <ActivityBar
          activeSidebarTab={activeSidebarTab}
          setActiveSidebarTab={(tab) => {
            setActiveSidebarTab(tab);
            if (isEditorMaximized) setIsEditorMaximized(false);
          }}
          isChatVisible={isChatVisible}
          setIsChatVisible={(val) => {
            setIsChatVisible(val);
            if (isEditorMaximized) setIsEditorMaximized(false);
          }}
          gitChangesCount={gitChanges.length}
          onOpenSettings={() => setIsSettingsOpen(true)}
          layoutMode={layoutMode}
          setLayoutMode={setLayoutMode}
          hasOpenDocument={!!selectedFile}
          isTerminalCollapsed={isTerminalCollapsed}
          setIsTerminalCollapsed={setIsTerminalCollapsed}
          setActiveBottomTab={setActiveBottomTab}
          onOpenProjectSettings={(e) => { if (activeProject) openEditModal(e, activeProject); }}
          hasActiveProject={!!activeProject}
          onOpenCloudSync={() => setIsCloudSyncOpen(true)}
          cloudEnabled={!!cloudStatus?.settings?.enabled}
        />

        {/* Left Sidebar */}
        {!isEditorMaximized && activeSidebarTab && docksSidebar && (
          <aside className="vscode-sidebar" style={{ width: `${sidebarWidth}px` }}>
            {activeSidebarTab === 'explorer' ? (
              <ExplorerSidebar
                projects={projects}
                activeProject={activeProject}
                handleSelectProject={handleSelectProject}
                onNewProject={() => setShowNewProjectModal(true)}
                onImportProject={() => { setImportError(''); openDirPicker('import', '~'); }}
                onDownloadFromCloud={openCloudDownload}
                importError={importError}
                onClearImportError={() => setImportError('')}
                files={files}
                selectedFile={selectedFile}
                selectedNodes={selectedNodes}
                unsavedFiles={unsavedFiles}
                handleNodeSelect={handleNodeSelect}
                onSelectAllNodes={handleSelectAllNodes}
                handleFileSelect={handleFileSelect}
                handleNodeContextMenu={handleNodeContextMenu}
                handleWorkspaceContextMenu={handleWorkspaceContextMenu}
                draggedNode={draggedNode}
                setDraggedNode={setDraggedNode}
                dragOverPath={dragOverPath}
                setDragOverPath={setDragOverPath}
                handleMoveNode={handleMoveNode}
                fetchFiles={fetchFiles}
                showHiddenWorkspaceFiles={showHiddenWorkspaceFiles}
                onShowHiddenWorkspaceFilesChange={handleShowHiddenWorkspaceFilesChange}
                openEditModal={openEditModal}
                handleDeleteProject={handleDeleteProject}
                renamingNodePath={renamingNodePath}
                setRenamingNodePath={setRenamingNodePath}
                executeRenameNode={executeRenameNode}
                cloudFileStates={cloudFileStates}
                pendingCreate={pendingCreate}
                onInlineCreateSubmit={submitInlineCreate}
                onInlineCreateCancel={cancelInlineCreate}
              />
            ) : activeSidebarTab === 'search' ? (
              <SearchSidebar
                activeProject={activeProject}
                showHiddenFiles={showHiddenWorkspaceFiles}
                searchState={searchState}
                setSearchState={setSearchState}
                focusToken={searchFocusToken}
                onOpenMatch={(path, match) => handleFileSelect(path, match.line, { column: match.column, length: match.length })}
              />
            ) : (
              <GitSidebar
                activeProject={activeProject}
                gitChanges={gitChanges}
                fetchGitStatus={fetchGitStatus}
                commitMessage={commitMessage}
                setCommitMessage={setCommitMessage}
                isCommitting={isCommitting}
                handleGitCommit={handleGitCommit}
                onStageFile={handleStageFile}
                onStageAllFiles={handleStageAllFiles}
                onUnstageFile={handleUnstageFile}
                onDiscardFile={handleDiscardFile}
                gitRootPath={currentGitRootPath}
                onPickGitRoot={() => openDirPicker('git-root', currentGitRootPath || activeProject?.project_path || '~')}
                onClearGitRoot={() => updateActiveGitRoot('')}
              />
            )}
          </aside>
        )}

        {/* Left resize handle */}
        {!isEditorMaximized && activeSidebarTab && docksSidebar && (
          <div className="vscode-resizer-horizontal" onMouseDown={(e) => startResizing(e, 'left')} />
        )}

        {/* Center — Editor + Bottom Panel */}
        <main
          className={`vscode-editor-panel ${isStudioLayout ? 'vscode-studio-layout' : ''}`}
          style={{
            flex: isChatLayout ? 0 : 1,
            display: isChatLayout ? 'none' : isStudioLayout ? 'grid' : 'flex',
            // Inline, because the flex/grid switch above is inline too and a
            // class-level template would lose to it.
            ...(isStudioLayout ? { gridTemplateColumns: studioGrid.gridTemplateColumns, gridTemplateRows: studioGrid.gridTemplateRows } : {}),
          }}
        >
          {!isBottomMaximized && isEditorLayout && (
            <EditorPanel
              selectedFile={selectedFile}
              openFiles={openFiles}
              fileContent={fileContent}
              originalFileContents={originalFileContents}
              unsavedFiles={unsavedFiles}
              isSaving={isSaving}
              theme={theme}
              uiScale={uiScale}
              editorFontSize={editorFontSize}
              setEditorFontSize={setEditorFontSize}
              editorTabSize={editorTabSize}
              editorWordWrap={editorWordWrap}
              editorMinimap={editorMinimap}
              handleFileSelect={handleFileSelect}
              handleCloseTab={handleCloseTab}
              handleCloseOtherTabs={handleCloseOtherTabs}
              handleCloseAllTabs={handleCloseAllTabs}
              saveFile={saveFile}
              handleEditorDidMount={handleEditorDidMount}
              setFileContent={setFileContent}
              jumpToLine={jumpToLine}
              setJumpToLine={setJumpToLine}
              isMaximized={isEditorMaximized}
              onToggleMaximize={() => setIsEditorMaximized(!isEditorMaximized)}
              inlinePrompt={inlinePrompt}
              setInlinePrompt={setInlinePrompt}
              onInlineSubmit={handleInlineSubmit}
              onToggleTerminal={() => {
                if (isEditorMaximized) {
                  setIsEditorMaximized(false);
                  setIsTerminalCollapsed(false);
                  setActiveBottomTab('terminal');
                  setBottomPanelHeight(Math.floor(viewportPxToApp(window.innerHeight) / 2));
                  return;
                }
                if (isTerminalCollapsed) {
                  setIsTerminalCollapsed(false);
                  setActiveBottomTab('terminal');
                } else if (activeBottomTab === 'terminal') {
                  setIsTerminalCollapsed(true);
                } else {
                  setActiveBottomTab('terminal');
                }
              }}
              activeProject={activeProject}
              triggerCompileRequest={triggerCompileRequest}
              onCompileRequestHandled={(requestId) => {
                setTriggerCompileRequest(prev => (
                  prev?.id === requestId ? null : prev
                ));
              }}
              onLatexCompileError={handleLatexCompileError}
              onLatexCompileSuccess={handleLatexCompileSuccess}
              pdfRevealRequest={pdfRevealRequest}
              externalCompile={externalCompile}
              pdfViewProbeRef={pdfViewProbeRef}
              onFixLatexProblem={handleFixLatexProblem}
              onAskAboutPdf={handleAskAboutPdf}
              onAskAboutMarkdown={handleAskAboutMarkdown}
              speechSettingsSignal={speechSettingsSignal}
              onTextStatsChange={setEditorTextStats}
              openPreviewByDefault={isStudioLayout || isDocumentLayout}
            />
          )}

          {/* Studio drag handles. They are grid items like the panels, so they
              sit between the cells without wrapping anything in a container —
              which is what keeps the panels' tree positions untouched. */}
          {isStudioLayout && studioGrid.showRowResizer && (
            <div
              className="vscode-resizer-vertical vscode-studio-row-resizer"
              onMouseDown={(e) => startResizing(e, 'studio-bottom')}
            />
          )}
          {isStudioLayout && studioGrid.showColumnResizer && (
            <div
              className="vscode-resizer-horizontal vscode-studio-col-resizer"
              onMouseDown={(e) => startResizing(e, 'studio-chat')}
            />
          )}

          {isStudioLayout && isChatVisible && !isEditorMaximized && (
            <ClaudePanel
              fillContainer
              activeProject={activeProject}
              theme={theme}
              uiScale={uiScale}
              promptRequest={claudePromptRequest}
              restartRequest={claudeRestartRequest}
              onClose={() => setIsChatVisible(false)}
            />
          )}
          <div
            className={isStudioLayout ? 'vscode-studio-terminal-cell' : undefined}
            style={{
              display: isStudioLayout
                ? (isEditorMaximized || isTerminalCollapsed ? 'none' : 'flex')
                : (isEditorMaximized || layoutMode !== 'ide' ? 'none' : 'contents'),
            }}
          >
            <BottomPanel
              activeBottomTab={activeBottomTab}
              setActiveBottomTab={setActiveBottomTab}
              isTerminalCollapsed={isTerminalCollapsed}
              setIsTerminalCollapsed={setIsTerminalCollapsed}
              terminalLogs={terminalLogs}
              setTerminalLogs={setTerminalLogs}
              problems={problems}
              setProblems={setProblems}
              bottomPanelHeight={bottomPanelHeight}
              activeProject={activeProject}
              terminalRef={terminalRef}
              terminalInstanceRef={terminalInstanceRef}
              logEndRef={logEndRef}
              startResizing={startResizing}
              isBottomMaximized={isBottomMaximized}
              onToggleMaximizeBottom={() => setIsBottomMaximized(!isBottomMaximized)}
              theme={theme}
              uiScale={uiScale}
              fillContainer={isStudioLayout}
            />
          </div>
        </main>

        {/* Right resize handle */}
        {!isEditorMaximized && isChatVisible && layoutMode === 'ide' && (
          <div className="vscode-resizer-horizontal" onMouseDown={(e) => startResizing(e, 'right')} />
        )}

        {/* Claude Code panel (where GilzaBots had its chat): docked right in the
            IDE layout, across the centre in the chat layout. */}
        {((!isEditorMaximized && layoutMode === 'ide' && isChatVisible) || isChatLayout) && (
          <ClaudePanel
            width={chatWidth}
            fillContainer={isChatLayout}
            activeProject={activeProject}
            theme={theme}
            uiScale={uiScale}
            promptRequest={claudePromptRequest}
            restartRequest={claudeRestartRequest}
            onClose={() => (isChatLayout ? setLayoutMode('ide') : setIsChatVisible(false))}
          />
        )}
      </div>

      {/* Status Bar */}
      <StatusBar
        activeProject={activeProject}
        textStats={editorTextStats}
        cloudStatus={cloudStatus}
        onOpenCloudSync={() => setIsCloudSyncOpen(true)}
      />

      {/* ── Overlays / Modals ── */}
      <AlertModal message={alertMessage} onClose={() => setAlertMessage('')} />

      {showNewProjectModal && (
        <NewProjectModal
          onClose={() => setShowNewProjectModal(false)}
          onSubmit={handleCreateProject}
          newProjName={newProjName} setNewProjName={setNewProjName}
          newProjPath={newProjPath} setNewProjPath={setNewProjPath}
          newProjError={newProjError}
          onOpenDirPicker={openDirPicker}
        />
      )}

      {editingProject && (
        <EditProjectModal
          editingProject={editingProject}
          setEditingProject={setEditingProject}
          onClose={() => setEditingProject(null)}
          onSubmit={handleUpdateProject}
          editProjError={editProjError}
          onOpenDirPicker={openDirPicker}
        />
      )}

      {isSettingsOpen && (
        <SettingsModal
          onSpeechSettingsChange={bumpSpeechSettings}
          onClaudeSessionReplaced={() => setClaudeRestartRequest(r => ({ seq: (r?.seq || 0) + 1 }))}
          onClose={() => setIsSettingsOpen(false)}
          settingsTab={settingsTab}
          setSettingsTab={setSettingsTab}
          theme={theme} setTheme={setTheme}
          uiScale={uiScale} applyUiScale={applyUiScale}
          editorFontSize={editorFontSize} setEditorFontSize={setEditorFontSize}
          editorTabSize={editorTabSize} setEditorTabSize={setEditorTabSize}
          editorWordWrap={editorWordWrap} setEditorWordWrap={setEditorWordWrap}
          editorMinimap={editorMinimap} setEditorMinimap={setEditorMinimap}
          panelMaxLines={panelMaxLines}
          setPanelMaxLines={(val) => { setPanelMaxLines(val); setPreference('panelMaxLines', val); }}
          onLanguageChange={(lang) => {
            fetch('/api/settings/language', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lang }),
            }).catch(() => { });
          }}
        />
      )}

      {confirmRequest && <ConfirmModal confirmRequest={confirmRequest} onConfirm={sendConfirmResponse} />}

      {isCloudSyncOpen && (
        <CloudSyncModal
          activeProject={activeProject}
          onClose={() => { setIsCloudSyncOpen(false); refreshCloudStatus(); }}
          onWorkspaceChanged={refreshWorkspaceFiles}
        />
      )}

      {isCloudDownloadOpen && (
        <CloudDownloadModal
          parentPath={cloudDownloadParent}
          onPickParentPath={() => openDirPicker('cloud-download', cloudDownloadParent || '~')}
          onClose={() => setIsCloudDownloadOpen(false)}
          onDownloaded={handleProjectDownloaded}
        />
      )}

      <DeleteProjectModal
        projectToDelete={projectToDelete}
        folderMissing={projects.find(p => p.name === projectToDelete)?.exists === false}
        cloudLink={deleteCloudLink}
        onCancel={() => { setProjectToDelete(null); setDeleteCloudLink(null); }}
        onConfirm={confirmDeleteProject}
      />

      <DirPickerModal
        dirPicker={dirPicker}
        onNavigate={navigateDirPicker}
        onConfirm={confirmDirPicker}
        onClose={() => setDirPicker(null)}
      />

      <MoveToModal
        moveModal={moveModal}
        files={files}
        isFileInsidePath={isFileInsidePath}
        onConfirm={confirmMoveModal}
        onClose={() => setMoveModal(null)}
      />

      <ContextMenu
        contextMenu={contextMenu}
        rightClickedNode={rightClickedNode}
        handleCreateNewFile={handleCreateNewFile}
        handleCreateNewDir={handleCreateNewDir}
        handleImportFile={handleImportFile}
        handleRenameNode={handleRenameNode}
        handleDeleteNode={handleDeleteNode}
        handleCopyNode={handleCopyNode}
        handlePasteNode={handlePasteNode}
        handleOpenInSystem={handleOpenInSystem}
        handleSetMainFile={handleSetMainFile}
        handleMoveToNode={handleOpenMoveModal}
        clipboardNode={clipboardNode}
      />
    </div>
  );
}
