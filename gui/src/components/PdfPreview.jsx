import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle, useCallback } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import { viewportPointToApp, viewportPxToApp } from '../utils/uiScale';
import { clampViewAnchor, isAnchorLaidOut, scrollTopForAnchor, viewAnchorAt } from '../utils/pdfViewState';
import { useTranslation } from 'react-i18next';
import { useCustomDialog } from './modals/CustomDialogProvider';
import { ArrowLeft, Download, PanelRightClose, ZoomIn, ZoomOut, RotateCcw, ChevronUp, ChevronDown, Search, X, MessageSquareOff, MessageSquare, Sparkles, MonitorPlay, RefreshCw } from 'lucide-react';
import PdfContextMenu, { ANNOTATION_COLORS } from './PdfContextMenu';
import TranslationPopup from './TranslationPopup';
import SpeechPopup from './SpeechPopup';
import SnippetQueryPopup from './SnippetQueryPopup';
import { useSnippetTranslation } from '../hooks/useSnippetTranslation';
import { useSnippetQuery } from '../hooks/useSnippetQuery';
import { useSnippetSpeech } from '../hooks/useSnippetSpeech';
import { readSelectionWithin } from '../utils/documentSelection';
import PdfAnnotationLayer from './PdfAnnotationLayer';
import PdfNotePopup from './PdfNotePopup';
import PdfPresentMode from './PdfPresentMode';
import { getPreference, setPreference } from '../utils/preferences.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const PDF_DOCUMENT_OPTIONS = {
  verbosity: pdfjs.VerbosityLevel.ERRORS,
};

const DEFAULT_PDF_SCALE = 1.2;

// How long a restored position may wait for the pages above it to be laid out.
// react-pdf sizes a page as soon as pdf.js loads it, before painting it, so this
// is normally a few polls; past the limit the position is applied to whatever
// layout exists rather than silently dropped.
const VIEW_RESTORE_INTERVAL_MS = 50;
const VIEW_RESTORE_ATTEMPTS = 100;

// `initialViewState` ({ scale, anchor }) is read once, at mount, and
// `onViewStateChange` reports the same shape as the user scrolls and zooms. The
// owner keeps it per document so a viewer unmounted by a tab switch comes back
// where it was left (see utils/pdfViewState.js).
const PdfPreview = forwardRef(({ chatModel = '', base64Pdf, sourceUrl, directUrl, isCompiling, errorLog, activeProject, selectedFile, onSyncTexNavigate, onCollapse, onDocumentReady, latexCompileProblem, onFixLatexProblem, onLatexCompileError, onLatexCompileSuccess, onAskAboutPdf, speechSettingsSignal = 0, isAgentRunning = false, uiScale = 1, initialViewState = null, onViewStateChange }, ref) => {
  const { t, i18n } = useTranslation();
  const { showAlert, showConfirm } = useCustomDialog();
  const [numPages, setNumPages] = useState(null);
  const [pdfUrl, setPdfUrl] = useState('');
  const [highlight, setHighlight] = useState(null);
  const [scale, setScale] = useState(() => (initialViewState?.scale > 0 ? initialViewState.scale : DEFAULT_PDF_SCALE));
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
  const [pdfTextPages, setPdfTextPages] = useState([]);
  const [canGoBack, setCanGoBack] = useState(false);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [contextMenu, setContextMenu] = useState(null);
  const [annotations, setAnnotations] = useState([]);
  // Ids of annotations the *rendered* bytes do not contain yet. Everything else is
  // already painted by pdf.js from its appearance stream, so drawing it again in
  // the overlay would double the color. Reset whenever the document is reloaded.
  const [freshAnnotationIds, setFreshAnnotationIds] = useState(() => new Set());
  const [annotationColor, setAnnotationColor] = useState(ANNOTATION_COLORS[0]);
  const [notePopup, setNotePopup] = useState(null);
  const [annotationError, setAnnotationError] = useState('');
  const [annotationTooltip, setAnnotationTooltip] = useState(null);
  const [isPresenting, setIsPresenting] = useState(false);
  const containerRef = useRef(null);

  // Translating an excerpt is not a PDF feature — the same request, the same
  // race guard and the same popup serve the Markdown preview (§2.13).
  const {
    translation,
    translate: runTranslation,
    retry: handleRetryTranslation,
    copy: handleCopyTranslation,
    close: closeTranslation,
  } = useSnippetTranslation({
    model: chatModel,
    uiLanguage: i18n.language,
  });

  // "Look up" answers a one-off question in a card of its own, never in the
  // chat (§2.13.4). The selection geometry is kept beside it so the answer can
  // become a note on exactly the passage that was asked about.
  const {
    query: lookup,
    open: openLookup,
    setQuestion: setLookupQuestion,
    submit: submitLookup,
    compose: composeLookup,
    copy: copyLookup,
    saveMarkdown: saveLookupMarkdown,
    markNoteSaved: markLookupNoteSaved,
    close: closeLookup,
  } = useSnippetQuery({
    model: chatModel,
    projectPath: activeProject?.project_path || '',
  });
  const lookupSelectionRef = useRef([]);

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
  const scrollPosRef = useRef(0);
  const restoreScrollPosRef = useRef(0);
  const isReloadingPdfRef = useRef(false);
  const pageNavRef = useRef(null);
  const searchInputRef = useRef(null);
  const pdfDocumentRef = useRef(null);
  const navigationHistoryRef = useRef([]);
  const pageScrollRafRef = useRef(null);
  // The position a newly mounted viewer returns to, consumed by its first
  // document load, and the latest position reported, which a zoom change reports
  // again together with the new scale.
  const pendingViewAnchorRef = useRef(initialViewState?.anchor || null);
  const lastViewAnchorRef = useRef(initialViewState?.anchor || null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;

  const searchNeedle = searchQuery.trim().toLowerCase();
  const hasSearchNeedle = searchNeedle.length > 0;

  const isTerminatedPdfWorkerError = (err) => (
    String(err?.message || err || '').toLowerCase().includes('worker task was terminated')
  );

  const countMatches = (text, needle) => {
    if (!text || !needle) return 0;
    let count = 0;
    let index = text.toLowerCase().indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = text.toLowerCase().indexOf(needle, index + needle.length);
    }
    return count;
  };

  const updateCurrentPageFromScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const pageEls = Array.from(container.querySelectorAll('[data-page-number]'));
    if (!pageEls.length) return;

    const containerRect = container.getBoundingClientRect();
    // Both terms must come from the same coordinate space. `containerRect` is in
    // real viewport pixels while `clientHeight` is a CSS length inside the app's
    // `zoom`, so mixing them put the "center" at 1/scale of the way down the
    // pane and reported the page above the one actually in view at any interface
    // scale above 100%. The rects the pages are compared against are viewport
    // values too, so the height has to come from the rect as well.
    const viewportCenter = containerRect.top + containerRect.height / 2;
    let bestPage = null;
    let bestDistance = Infinity;

    for (const pageEl of pageEls) {
      const rect = pageEl.getBoundingClientRect();
      const pageNumber = parseInt(pageEl.getAttribute('data-page-number'), 10);
      if (Number.isNaN(pageNumber)) continue;

      if (rect.top <= viewportCenter && rect.bottom >= viewportCenter) {
        bestPage = pageNumber;
        break;
      }

      const pageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(pageCenter - viewportCenter);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestPage = pageNumber;
      }
    }

    if (bestPage != null) {
      setCurrentPage((prev) => (prev === bestPage ? prev : bestPage));
    }
  }, []);

  // Every page's place in the scroll content, in the app CSS pixels `scrollTop`
  // uses — the same `offsetTop` measure `scrollToPage` relies on. A page is
  // `ready` once react-pdf has sized its canvas, which it does when pdf.js loads
  // the page and before painting it, so a ready page has its final height.
  // Only the wrappers: react-pdf's own page element inside each one carries
  // `data-page-number` too, and its `offsetTop` is measured from the wrapper.
  const pageLayout = () => {
    const container = containerRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll('.pdf-page-wrapper[data-page-number]'))
      .map((el) => ({
        page: parseInt(el.getAttribute('data-page-number'), 10),
        top: el.offsetTop,
        height: el.offsetHeight,
        ready: Boolean(el.querySelector('canvas')?.style.height),
      }))
      .filter((entry) => !Number.isNaN(entry.page));
  };

  const rememberViewAnchor = () => {
    const container = containerRef.current;
    if (!container) return;
    const pages = pageLayout();
    const anchor = viewAnchorAt(container.scrollTop, pages);
    // A position measured against placeholders would name the wrong page once
    // they grow, so it is not worth remembering.
    if (!anchor || !isAnchorLaidOut(anchor, pages)) return;
    lastViewAnchorRef.current = anchor;
    onViewStateChangeRef.current?.({ scale, anchor });
  };

  const handleScroll = () => {
    if (isReloadingPdfRef.current) return;
    if (containerRef.current) {
      scrollPosRef.current = containerRef.current.scrollTop;
    }

    if (pageScrollRafRef.current) return;
    pageScrollRafRef.current = window.requestAnimationFrame(() => {
      pageScrollRafRef.current = null;
      updateCurrentPageFromScroll();
      rememberViewAnchor();
    });
  };

  // A zoom with no scroll after it must still be remembered.
  useEffect(() => {
    onViewStateChangeRef.current?.({ scale, anchor: lastViewAnchorRef.current });
  }, [scale]);

  useEffect(() => {
    return () => {
      if (pageScrollRafRef.current) {
        window.cancelAnimationFrame(pageScrollRafRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!numPages) return undefined;

    const updateAfterLayout = window.setTimeout(updateCurrentPageFromScroll, 0);
    window.addEventListener('resize', updateCurrentPageFromScroll);
    return () => {
      window.clearTimeout(updateAfterLayout);
      window.removeEventListener('resize', updateCurrentPageFromScroll);
    };
  }, [numPages, scale, updateCurrentPageFromScroll]);

  const pushNavigationHistory = () => {
    if (!containerRef.current) return;

    const currentPosition = {
      page: currentPage,
      scale,
      scrollTop: containerRef.current.scrollTop,
    };
    const lastPosition = navigationHistoryRef.current[navigationHistoryRef.current.length - 1];
    if (
      lastPosition &&
      Math.abs(lastPosition.scrollTop - currentPosition.scrollTop) < 8 &&
      lastPosition.page === currentPosition.page &&
      lastPosition.scale === currentPosition.scale
    ) {
      return;
    }

    navigationHistoryRef.current = [...navigationHistoryRef.current.slice(-24), currentPosition];
    setCanGoBack(true);
  };

  const handleBackNavigation = () => {
    const previousPosition = navigationHistoryRef.current.pop();
    setCanGoBack(navigationHistoryRef.current.length > 0);
    if (!previousPosition || !containerRef.current) return;

    setScale(previousPosition.scale);
    setCurrentPage(previousPosition.page);
    setTimeout(() => {
      if (!containerRef.current) return;
      containerRef.current.scrollTo({ top: previousPosition.scrollTop, behavior: 'smooth' });
      scrollPosRef.current = previousPosition.scrollTop;
    }, 80);
  };

  const handlePdfPointerDownCapture = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const target = event.target;
    if (!target?.closest) return;

    const annotationLink = target.closest('.annotationLayer a, .annotationLayer [role="link"], .annotationLayer .linkAnnotation');
    if (annotationLink) {
      pushNavigationHistory();
    }
  };

  // The compiled preview renders the PDF of the project's main file, so an
  // included .tex file must not be reported as the document being viewed.
  const resolvePdfDocumentPath = () => {
    const normalize = (value) => String(value || '').replace(/\\/g, '/');
    const selected = normalize(selectedFile);
    if (selected.toLowerCase().endsWith('.pdf')) return selected;
    const source = normalize(activeProject?.main_file) || selected;
    if (!source) return '';
    return `${source.replace(/\.[^./]*$/, '')}.pdf`;
  };

  // Text the user selected inside this viewer, or '' when the selection is
  // empty or lives outside the PDF surface.
  const readPdfSelection = () => readSelectionWithin(containerRef.current);

  // ── Annotations ────────────────────────────────────────────────────────
  // Marks are stored inside the PDF itself (see gilzabots/pdf_annotations.py), so
  // they interoperate with Zotero, Acrobat and any other reader. That storage is
  // only appropriate for a standalone PDF: the compiled LaTeX preview is
  // regenerated on every build and would drop anything written into it.
  const isStandalonePdf = Boolean(directUrl) && String(selectedFile || '').toLowerCase().endsWith('.pdf');
  const canAnnotate = isStandalonePdf && Boolean(activeProject?.project_path);

  const annotationQuery = () => (
    `projectPath=${encodeURIComponent(activeProject?.project_path || '')}` +
    `&filePath=${encodeURIComponent(selectedFile || '')}`
  );

  // The rendered page box, which is what normalized 0..1 coordinates are relative
  // to. The canvas is used rather than the wrapper because the wrapper carries
  // shadow and spacing that are not part of the page.
  const pageBoxes = () => {
    const container = containerRef.current;
    if (!container) return [];
    return Array.from(container.querySelectorAll('[data-page-number]'))
      .map((wrapper) => {
        const canvas = wrapper.querySelector('canvas');
        if (!canvas) return null;
        const page = parseInt(wrapper.getAttribute('data-page-number'), 10);
        if (Number.isNaN(page)) return null;
        return { page, box: canvas.getBoundingClientRect() };
      })
      .filter(Boolean);
  };

  const pageAtPoint = (clientX, clientY) => (
    pageBoxes().find(({ box }) => (
      clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom
    )) || null
  );

  const normalizePoint = (clientX, clientY, box) => [
    (clientX - box.left) / box.width,
    (clientY - box.top) / box.height,
  ];

  // Merge the client rects of a selection into one rect per visual line. The DOM
  // returns a rect per text-node fragment, and overlapping fragments would stack
  // into a darker band where the translucent marks overlap.
  const mergeRectsByLine = (rects) => {
    const lines = [];
    rects.forEach((rect) => {
      const line = lines.find((candidate) => (
        Math.abs(candidate.top - rect.top) < rect.height * 0.5
        && Math.abs(candidate.bottom - rect.bottom) < rect.height * 0.5
      ));
      if (line) {
        line.left = Math.min(line.left, rect.left);
        line.right = Math.max(line.right, rect.right);
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      }
    });
    return lines;
  };

  // The current selection as normalized rects grouped by page. A selection that
  // spans a page break yields one entry per page, because an annotation belongs
  // to exactly one page.
  const readSelectionRectsByPage = () => {
    const selection = window.getSelection?.();
    const container = containerRef.current;
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !container) return [];
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return [];

    const boxes = pageBoxes();
    const byPage = new Map();
    Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
      .forEach((rect) => {
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const hit = boxes.find(({ box }) => (
          centerX >= box.left && centerX <= box.right && centerY >= box.top && centerY <= box.bottom
        ));
        if (!hit) return;
        if (!byPage.has(hit.page)) byPage.set(hit.page, { box: hit.box, rects: [] });
        byPage.get(hit.page).rects.push(rect);
      });

    return Array.from(byPage.entries()).map(([page, { box, rects }]) => ({
      page,
      rects: mergeRectsByLine(rects).map((line) => [
        (line.left - box.left) / box.width,
        (line.top - box.top) / box.height,
        (line.right - box.left) / box.width,
        (line.bottom - box.top) / box.height,
      ]),
    }));
  };

  const annotationAtPoint = (clientX, clientY) => {
    const hit = pageAtPoint(clientX, clientY);
    if (!hit) return null;
    const [nx, ny] = normalizePoint(clientX, clientY, hit.box);
    // Later annotations are drawn on top, so the last match is the one the user
    // sees under the cursor.
    return [...annotations]
      .filter((annotation) => annotation.page === hit.page)
      .reverse()
      .find((annotation) => (annotation.rects || []).some(([x0, y0, x1, y1]) => (
        nx >= x0 - 0.002 && nx <= x1 + 0.002 && ny >= y0 - 0.002 && ny <= y1 + 0.002
      ))) || null;
  };

  // Hovering a mark reveals its note. The pointer is never intercepted for this —
  // the overlay stays click-through so text selection keeps working — so the hover
  // is resolved geometrically against the same normalized rects, throttled to one
  // lookup per frame because the lookup measures page boxes from the DOM.
  const hoverRafRef = useRef(null);
  const handlePdfPointerMove = (event) => {
    if (!canAnnotate || !showAnnotations || annotations.length === 0) {
      if (annotationTooltip) setAnnotationTooltip(null);
      return;
    }
    if (hoverRafRef.current) return;
    const { clientX, clientY } = event;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      // The hit test compares two viewport measurements and stays there; only
      // the tooltip's own placement crosses into the zoomed app's coordinates.
      const found = annotationAtPoint(clientX, clientY);
      if (found && (found.content || '').trim()) {
        setAnnotationTooltip({ ...viewportPointToApp(clientX, clientY), annotation: found });
      } else {
        setAnnotationTooltip((prev) => (prev ? null : prev));
      }
    });
  };

  useEffect(() => () => {
    if (hoverRafRef.current) cancelAnimationFrame(hoverRafRef.current);
  }, []);

  const loadAnnotations = useCallback(async ({ markAsRendered = false } = {}) => {
    if (!canAnnotate) {
      setAnnotations([]);
      setFreshAnnotationIds(new Set());
      return;
    }
    try {
      const res = await fetch(`/api/pdf/annotations?${annotationQuery()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      const loaded = data.annotations || [];
      setAnnotations(loaded);
      // After a document (re)load, everything on disk is baked into the canvas.
      if (markAsRendered) setFreshAnnotationIds(new Set());
      setAnnotationError('');
    } catch (err) {
      // A PDF that cannot carry annotations is a normal thing to open; say so once
      // and leave the rest of the viewer working.
      setAnnotations([]);
      setAnnotationError(String(err.message || err));
    }
  }, [canAnnotate, activeProject?.project_path, selectedFile]);

  // Which bytes the viewer should render. Hiding annotations is a server-side
  // strip rather than a client-side switch: pdf.js paints marks into the page
  // canvas from their appearance streams and react-pdf hardcodes `annotationMode`
  // to ENABLE, so nothing on this side can unpaint them. Stripping the bytes also
  // hides annotation types this viewer does not draw itself — ink, stamps,
  // polygons from other software — which an overlay-only approach would leave
  // stuck on screen.
  const renderedPdfUrl = (bust = Date.now()) => {
    if (!canAnnotate || !directUrl) return directUrl;
    if (!showAnnotations) {
      return `/api/pdf/annotations/document?${annotationQuery()}&ts=${bust}`;
    }
    return `${directUrl}${directUrl.includes('?') ? '&' : '?'}annots=${bust}`;
  };

  // Refetch the rendered bytes so a change to an already-painted mark is visible.
  // Only needed when the canvas is showing something stale — a brand new mark is
  // covered by the overlay, which is instant and avoids the reload flash.
  const reloadRenderedPdf = () => {
    if (!directUrl) return;
    if (containerRef.current) {
      restoreScrollPosRef.current = containerRef.current.scrollTop;
    }
    isReloadingPdfRef.current = true;
    setPdfUrl(renderedPdfUrl());
  };

  // ── Recompile from source ──────────────────────────────────────────────
  // A standalone PDF the project builds from a .tex (name.pdf next to name.tex)
  // can be rebuilt from here without opening that .tex. The compiled preview
  // beside an open .tex is excluded: the editor owns its compile state.
  const [sourceTexFile, setSourceTexFile] = useState('');
  const [isRecompiling, setIsRecompiling] = useState(false);

  useEffect(() => {
    setSourceTexFile('');
    if (!isStandalonePdf || !activeProject?.project_path) return undefined;
    let cancelled = false;
    fetch(`/api/latex/pdf-source?projectPath=${encodeURIComponent(activeProject.project_path)}&pdfPath=${encodeURIComponent(selectedFile)}`)
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setSourceTexFile(data.texFile || ''); })
      .catch((err) => console.error('Could not resolve the PDF source file:', err));
    return () => { cancelled = true; };
  }, [isStandalonePdf, activeProject?.project_path, selectedFile]);

  const handleRecompileFromSource = async () => {
    if (!sourceTexFile || isRecompiling) return;
    // The build overwrites this PDF, and with it the annotations stored inside.
    if (annotations.length > 0) {
      const confirmed = await showConfirm(
        t('pdfPreview.recompileDropsAnnotations', 'Recompiling replaces this PDF with a new build of {{file}}. The {{count}} annotation(s) stored in it will be lost.', { file: sourceTexFile, count: annotations.length }),
        t('pdfPreview.recompileFromSource', 'Recompile from {{file}}', { file: sourceTexFile }),
        { destructive: true },
      );
      if (!confirmed) return;
    }
    setIsRecompiling(true);
    try {
      const res = await fetch('/api/latex/compile-pdf-source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject.project_path,
          pdfPath: selectedFile,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onLatexCompileSuccess?.({ filePath: sourceTexFile, compiledMainFile: data.compiled_main_file || sourceTexFile });
        reloadRenderedPdf();
      } else {
        reportRecompileFailure({
          log: data.log || 'LaTeX compilation failed.',
          compiledMainFile: data.compiled_main_file || '',
          fileContent: data.source_content || '',
        });
      }
    } catch (err) {
      reportRecompileFailure({ log: 'Failed to connect to backend: ' + err.message, compiledMainFile: '', fileContent: '' });
    } finally {
      setIsRecompiling(false);
    }
  };

  // Same problem record the editor's compile reports, so the failure also lands
  // in the Problems panel and "Fix with AI" works on the .tex that is not open.
  const reportRecompileFailure = async ({ log, compiledMainFile, fileContent }) => {
    const problem = {
      source: 'latex_compile',
      filePath: sourceTexFile,
      fileContent,
      projectPath: activeProject?.project_path || '',
      projectName: activeProject?.name || '',
      mainFile: activeProject?.main_file || '',
      compiledMainFile,
      log,
      message: log,
      compileDebug: {},
      partial: false,
      draft: false,
    };
    onLatexCompileError?.(problem);
    const title = t('pdfPreview.compileErrorTitle');
    if (!onFixLatexProblem || isAgentRunning) {
      showAlert(log, title);
      return;
    }
    const fix = await showConfirm(log, title, {
      okLabel: t('bottomPanel.fixWithAi'),
      cancelLabel: t('common.close'),
    });
    if (fix) onFixLatexProblem(problem);
  };

  const createAnnotation = async ({ page, kind, rects, color, content = '' }) => {
    try {
      const res = await fetch('/api/pdf/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject?.project_path || '',
          filePath: selectedFile || '',
          page,
          kind,
          rects,
          color,
          content,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      const created = data.annotation;
      setAnnotations((prev) => [...prev, created]);
      // Not in the rendered bytes yet, so the overlay draws it until a reload.
      setFreshAnnotationIds((prev) => new Set(prev).add(created.id));
      setAnnotationError('');
      window.getSelection?.()?.removeAllRanges();
      return created;
    } catch (err) {
      setAnnotationError(String(err.message || err));
      return null;
    }
  };

  const handleAnnotateSelection = async (menu, kind, color) => {
    const groups = menu.selectionRects || [];
    if (groups.length === 0) {
      // The menu only offers these actions when there is a selection, so an empty
      // geometry means the capture failed rather than that the user chose nothing.
      // Say so instead of doing nothing, which is indistinguishable from a bug.
      setAnnotationError(t('pdfPreview.annotationSelectionLost', 'Could not read the selected area. Select the text again and retry.'));
      return;
    }
    setAnnotationColor(color);
    setPreference('pdfAnnotationColor', color);
    // A selection crossing a page break becomes one annotation per page, since a
    // PDF annotation belongs to a single page.
    for (const group of groups) {
      // Sequential on purpose: each write is an incremental save of the same file.
      // eslint-disable-next-line no-await-in-loop
      await createAnnotation({ page: group.page, kind, rects: group.rects, color });
    }
  };

  // pdf.js builds its own popup for any markup annotation carrying text, but that
  // popup is styled by pdf.js rather than the app, only exists for marks already
  // in the loaded bytes (so a mark just created would behave differently), and for
  // sticky notes it loads an icon from `imageResourcesPath`, which react-pdf does
  // not configure — a broken image. The note marker and hover tooltip replace it,
  // so markup annotations are kept out of the HTML layer. Links and form widgets
  // stay: those are pdf.js behaviors worth having, and nothing here replaces them.
  // This only filters the HTML layer; the canvas still paints every annotation.
  const NATIVE_ANNOTATION_SUBTYPES = ['Link', 'Widget'];
  const filterNativeAnnotations = useCallback(
    ({ annotations: pageAnnotations }) => (
      (pageAnnotations || []).filter((a) => NATIVE_ANNOTATION_SUBTYPES.includes(a.subtype))
    ),
    [],
  );

  const handleOpenNoteFromMarker = (annotation, event) => {
    setAnnotationTooltip(null);
    if (!annotation.editable) {
      // A subtype this viewer cannot rewrite is readable, never editable.
      setAnnotationError(t('pdfContextMenu.annotationNotEditable', 'This annotation was made by other software and cannot be edited here.'));
      return;
    }
    setNotePopup({
      ...viewportPointToApp(event.clientX, event.clientY),
      value: annotation.content || '',
      mode: 'edit',
      annotationId: annotation.id,
      title: t('pdfNote.editTitle', 'Edit note'),
    });
  };

  // Persist a dragged marker. The mark itself is untouched: a highlight's quads
  // say which words are highlighted, so moving them would re-target the annotation
  // to different text. Only where the note sits changes.
  const handleMoveNoteMarker = async (annotation, point) => {
    setAnnotationTooltip(null);
    // Optimistic, so the marker stays where it was dropped instead of snapping
    // back while the write is in flight.
    setAnnotations((prev) => prev.map((a) => (a.id === annotation.id ? { ...a, marker: point } : a)));
    try {
      const res = await fetch('/api/pdf/annotations/marker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject?.project_path || '',
          filePath: selectedFile || '',
          id: annotation.id,
          point,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAnnotations((prev) => prev.map((a) => (a.id === data.annotation.id ? data.annotation : a)));
      setAnnotationError('');
      // A sticky note's marker *is* its icon, and the canvas already painted that
      // icon in the old spot, so the stale pixels have to be refetched. A markup
      // mark's balloon is drawn by this overlay alone and needs no reload.
      if (annotation.kind === 'note' && !freshAnnotationIds.has(annotation.id)) reloadRenderedPdf();
    } catch (err) {
      // Put it back where it was: pretending the move stuck would be a lie.
      setAnnotations((prev) => prev.map((a) => (a.id === annotation.id ? annotation : a)));
      setAnnotationError(String(err.message || err));
    }
  };

  const handleOpenNote = (menu) => {
    const target = menu.annotation;
    if (target) {
      setNotePopup({
        x: menu.x,
        y: menu.y,
        value: target.content || '',
        mode: 'edit',
        annotationId: target.id,
        title: t('pdfNote.editTitle', 'Edit note'),
      });
      return;
    }
    // A new sticky note is anchored where the user right-clicked.
    const hit = pageAtPoint(menu.x, menu.y);
    if (!hit) return;
    const [nx, ny] = normalizePoint(menu.x, menu.y, hit.box);
    setNotePopup({
      x: menu.x,
      y: menu.y,
      value: '',
      mode: 'create',
      page: hit.page,
      // The icon has a fixed size in every viewer; this is only its anchor.
      rects: [[nx, ny, Math.min(1, nx + 0.03), Math.min(1, ny + 0.02)]],
      title: t('pdfNote.addTitle', 'Add a note'),
    });
  };

  const handleSaveNote = async (value) => {
    if (!notePopup) return;
    setNotePopup((prev) => (prev ? { ...prev, saving: true, error: '' } : prev));

    if (notePopup.mode === 'create') {
      const created = await createAnnotation({
        page: notePopup.page,
        kind: 'note',
        rects: notePopup.rects,
        color: annotationColor,
        content: value,
      });
      setNotePopup(created ? null : (prev) => (prev ? { ...prev, saving: false, error: annotationError } : prev));
      return;
    }

    try {
      const res = await fetch('/api/pdf/annotations/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject?.project_path || '',
          filePath: selectedFile || '',
          id: notePopup.annotationId,
          content: value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAnnotations((prev) => prev.map((a) => (a.id === data.annotation.id ? data.annotation : a)));
      setNotePopup(null);
      setAnnotationError('');
      // The note text lives in the mark's popup, which pdf.js renders from the
      // file, so the canvas is now stale for an already-painted annotation.
      if (!freshAnnotationIds.has(notePopup.annotationId)) reloadRenderedPdf();
    } catch (err) {
      setNotePopup((prev) => (prev ? { ...prev, saving: false, error: String(err.message || err) } : prev));
    }
  };

  const handleRemoveAnnotation = async (menu) => {
    const target = menu.annotation;
    if (!target) return;
    try {
      const res = await fetch('/api/pdf/annotations/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: activeProject?.project_path || '',
          filePath: selectedFile || '',
          id: target.id,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAnnotations((prev) => prev.filter((a) => a.id !== target.id));
      const wasFresh = freshAnnotationIds.has(target.id);
      setFreshAnnotationIds((prev) => {
        const next = new Set(prev);
        next.delete(target.id);
        return next;
      });
      setAnnotationError('');
      // A mark the canvas already painted stays on screen until the bytes are
      // refetched; one that only the overlay was drawing disappears on its own.
      if (!wasFresh) reloadRenderedPdf();
    } catch (err) {
      setAnnotationError(String(err.message || err));
    }
  };

  // Toggling annotation visibility swaps the bytes being rendered. Kept in its own
  // effect rather than folded into the pdfUrl effect, which also resets the text
  // cache, search results and navigation history — none of which the toggle should
  // discard. The ref skips the initial run so mounting does not load twice.
  const lastShowAnnotationsRef = useRef(showAnnotations);
  useEffect(() => {
    if (lastShowAnnotationsRef.current === showAnnotations) return;
    lastShowAnnotationsRef.current = showAnnotations;
    if (!canAnnotate) return;
    if (containerRef.current) {
      restoreScrollPosRef.current = containerRef.current.scrollTop;
    }
    isReloadingPdfRef.current = true;
    setPdfUrl(renderedPdfUrl());
  }, [showAnnotations, canAnnotate]);

  // Restore the last highlighter color, so the choice carries across documents.
  useEffect(() => {
    const saved = getPreference('pdfAnnotationColor');
    if (saved && ANNOTATION_COLORS.includes(saved)) setAnnotationColor(saved);
  }, []);

  const handlePdfContextMenu = (event) => {
    event.preventDefault();
    const pageEl = event.target?.closest?.('[data-page-number]');
    const page = pageEl ? parseInt(pageEl.getAttribute('data-page-number'), 10) : currentPage;
    closeTranslation();
    // Re-read at menu-open time rather than cached for the session, so
    // configuring speech in Settings takes effect without reopening the PDF.
    refreshSpeechAvailability();
    setNotePopup(null);
    setContextMenu({
      ...viewportPointToApp(event.clientX, event.clientY),
      page: Number.isNaN(page) ? currentPage : page,
      selectedText: readPdfSelection(),
      // Captured here, not when the menu item is clicked: clicking an item (a
      // color swatch especially, since a <button> takes focus) collapses the
      // document selection, so reading it later finds nothing and the mark is
      // never created. `selectedText` was always captured this way; the geometry
      // has to be too.
      selectionRects: canAnnotate ? readSelectionRectsByPage() : [],
      annotation: canAnnotate ? annotationAtPoint(event.clientX, event.clientY) : null,
    });
  };

  const handleAskAboutPdf = (menu) => {
    if (!onAskAboutPdf) return;
    onAskAboutPdf({
      pdfPath: resolvePdfDocumentPath(),
      sourceFile: selectedFile || '',
      page: menu.page,
      totalPages: numPages || 0,
      selectedText: menu.selectedText || '',
    });
  };

  const handleTranslateSelection = (menu) => {
    runTranslation(menu.selectedText, { x: menu.x, y: menu.y });
  };

  const handleLookUpSelection = (menu) => {
    lookupSelectionRef.current = menu.selectionRects || [];
    openLookup(menu.selectedText, { x: menu.x, y: menu.y }, {
      surface: 'pdf',
      documentPath: resolvePdfDocumentPath(),
      // The compiled preview renders the main file's PDF; the .tex open in the
      // editor is a different file, and the agent is told about both.
      sourceFile: isStandalonePdf ? '' : (selectedFile || ''),
      page: menu.page,
      totalPages: numPages || 0,
    });
  };

  // Same gate as every other annotation (§2.14): only a PDF opened on its own,
  // never the compiled preview, which the next build overwrites.
  const lookupNoteRects = lookupSelectionRef.current;
  let lookupNoteReason = '';
  if (!canAnnotate) {
    lookupNoteReason = t('snippetQuery.noteCompiledPreview', 'Notes can only be saved in a PDF opened on its own. The compiled preview is regenerated on every build.');
  } else if (!showAnnotations) {
    lookupNoteReason = t('snippetQuery.noteAnnotationsHidden', 'Show annotations to save a note.');
  } else if (lookupNoteRects.length === 0) {
    lookupNoteReason = t('pdfPreview.annotationSelectionLost', 'Could not read the selected area. Select the text again and retry.');
  }

  // A selection crossing a page break is one highlight per page; the note goes
  // on the first, where the passage begins.
  const handleSaveLookupNote = async (noteText) => {
    const groups = lookupSelectionRef.current;
    if (groups.length === 0) return;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      // Sequential on purpose: each write is an incremental save of the same file.
      // eslint-disable-next-line no-await-in-loop
      const created = await createAnnotation({
        page: group.page,
        kind: 'highlight',
        rects: group.rects,
        color: annotationColor,
        content: index === 0 ? noteText : '',
      });
      if (!created) return;
    }
    markLookupNoteSaved();
  };

  const handlePronounceSelection = (menu) => {
    speak(menu.selectedText, { x: menu.x, y: menu.y });
  };

  const handleZoomIn = () => {
    setScale(prev => Math.min(prev + 0.2, 3.0));
  };

  const handleZoomOut = () => {
    setScale(prev => Math.max(prev - 0.2, 0.6));
  };

  const handleResetZoom = () => {
    setScale(DEFAULT_PDF_SCALE);
  };

  const focusSearchInput = () => {
    setTimeout(() => {
      if (searchInputRef.current) {
        searchInputRef.current.focus();
        searchInputRef.current.select();
      }
    }, 0);
  };

  const handleSearchToggle = () => {
    setIsSearchOpen((prev) => {
      const next = !prev;
      if (next) focusSearchInput();
      if (!next) clearSearch(false);
      return next;
    });
  };

  const clearSearch = (shouldFocus = true) => {
    setSearchQuery('');
    setSearchResults([]);
    setActiveSearchIndex(-1);
    if (shouldFocus) focusSearchInput();
  };

  const goToSearchResult = (index) => {
    if (!searchResults.length) return;
    const nextIndex = ((index % searchResults.length) + searchResults.length) % searchResults.length;
    setActiveSearchIndex(nextIndex);
    scrollToPage(searchResults[nextIndex].page);
  };

  const handleSearchSubmit = () => {
    if (!searchResults.length) return;
    goToSearchResult(activeSearchIndex >= 0 ? activeSearchIndex : 0);
  };

  const handleSearchPrev = () => {
    goToSearchResult((activeSearchIndex >= 0 ? activeSearchIndex : 0) - 1);
  };

  const handleSearchNext = () => {
    goToSearchResult((activeSearchIndex >= 0 ? activeSearchIndex : -1) + 1);
  };

  /**
   * Builds an array of SVG <rect> elements that highlight every occurrence of
   * `searchNeedle` in `pageItems` (the raw pdfjs text items for a single page).
   * Each item carries a 6-element transform matrix [a,b,c,d,e,f] and a width.
   * We compute the on-screen bounding box using the same approach PDF.js uses.
   */
  const buildHighlightRects = (pageItems, pageHeight, needle) => {
    if (!needle || !pageItems || !pageItems.length) return [];

    const rects = [];
    let globalIndex = 0; // character offset across items

    // Build a flat string and track item spans inside it
    const spans = [];
    let flat = '';
    for (const item of pageItems) {
      const s = item.str || '';
      spans.push({ start: flat.length, end: flat.length + s.length, item });
      flat += s;
      // PDF text items are NOT separated by spaces in the transform stream;
      // but we want multi-item matches so we add a space sentinel that won't
      // accidentally create a match.
      flat += ' ';
    }

    const lowerFlat = flat.toLowerCase();
    let cursor = 0;
    let idx = lowerFlat.indexOf(needle, cursor);

    while (idx !== -1) {
      const matchEnd = idx + needle.length;
      // Collect all items that overlap [idx, matchEnd)
      for (const { start, end, item } of spans) {
        if (end <= idx || start >= matchEnd) continue;
        // Fraction of the item that is highlighted
        const overlapStart = Math.max(start, idx) - start;
        const overlapEnd   = Math.min(end, matchEnd) - start;
        const itemLen = end - start;
        const fracStart = itemLen > 0 ? overlapStart / itemLen : 0;
        const fracEnd   = itemLen > 0 ? overlapEnd   / itemLen : 1;

        // PDF transform: [scaleX, skewY, skewX, scaleY, tx, ty]
        const [a, b, c, d, tx, ty] = item.transform;
        const itemW = item.width || 0;
        const itemH = item.height || Math.abs(d) || 10;

        // x from left edge of item, scaled by fractional coverage
        const x0 = tx + itemW * fracStart * (a > 0 ? 1 : -1);
        const x1 = tx + itemW * fracEnd   * (a > 0 ? 1 : -1);

        // PDF y-axis is bottom-up; convert to top-down viewport coords
        const yTop    = pageHeight - ty - itemH;
        const rectX   = Math.min(x0, x1);
        const rectW   = Math.abs(x1 - x0);

        rects.push({ x: rectX, y: yTop, w: rectW, h: itemH });
      }
      cursor = matchEnd;
      idx = lowerFlat.indexOf(needle, cursor);
    }
    return rects;
  };

  /**
   * Absolutely-positioned SVG overlay that paints search-hit highlight
   * rectangles on top of the canvas layer without touching the text layer.
   */
  const SearchHighlightLayer = ({ pageItems, pageWidth, pageHeight, needle, scaleFactor }) => {
    if (!needle || !pageItems) return null;
    const rects = buildHighlightRects(pageItems, pageHeight, needle);
    if (!rects.length) return null;
    return (
      <svg
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 5,
        }}
        viewBox={`0 0 ${pageWidth} ${pageHeight}`}
        preserveAspectRatio="none"
      >
        {rects.map((r, i) => (
          <rect
            key={i}
            x={r.x - 1}
            y={r.y - 1}
            width={r.w + 2}
            height={r.h + 2}
            fill="rgba(250, 204, 21, 0.45)"
            stroke="rgba(245, 158, 11, 0.75)"
            strokeWidth="1.5"
            rx="2"
          />
        ))}
      </svg>
    );
  };

  // ── Page navigation ────────────────────────────────────────────────────
  // Scroll the PDF container so the requested page is centered in view.
  // Uses the same [data-page-number] selector as the forward-search
  // highlight logic. Retries a few times in case the page element has not
  // been rendered yet by react-pdf.
  const scrollToPage = (pageNum, attempt = 0, rememberPosition = true) => {
    if (!containerRef.current || !numPages) return;
    const target = Math.max(1, Math.min(pageNum, numPages));
    const pageEl = containerRef.current.querySelector(`[data-page-number="${target}"]`);
    if (!pageEl && attempt < 10) {
      setTimeout(() => scrollToPage(target, attempt + 1, rememberPosition), 120);
      return;
    }
    if (pageEl) {
      if (rememberPosition) pushNavigationHistory();
      const offset = pageEl.offsetTop - containerRef.current.clientHeight / 2 + pageEl.clientHeight / 2;
      containerRef.current.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      setCurrentPage(target);
    }
  };

  const handlePageNavSubmit = () => {
    const n = parseInt(pageInput, 10);
    if (!isNaN(n)) {
      scrollToPage(n);
    }
    setPageInput('');
  };

  const handlePageNavPrev = () => {
    scrollToPage(currentPage - 1);
  };

  const handlePageNavNext = () => {
    scrollToPage(currentPage + 1);
  };

  useEffect(() => {
    let cancelled = false;

    const loadPageText = async () => {
      const pdfDocument = pdfDocumentRef.current;
      if (!pdfDocument || !numPages || !isSearchOpen || !hasSearchNeedle) {
        setPdfTextPages([]);
        return;
      }

      try {
        const pages = [];
        for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
          const page = await pdfDocument.getPage(pageNumber);
          if (cancelled) return;
          const viewport = page.getViewport({ scale: 1 });
          const textContent = await page.getTextContent();
          if (cancelled) return;
          // Store both plain text (for search counting) and raw items (for highlight rects)
          pages.push({
            text: textContent.items.map((item) => item.str || '').join(' '),
            items: textContent.items,
            width: viewport.width,
            height: viewport.height,
          });
        }
        if (!cancelled) {
          setPdfTextPages(pages);
        }
      } catch (err) {
        if (cancelled || isTerminatedPdfWorkerError(err)) {
          return;
        }
        console.error('PDF text extraction failed:', err);
        if (!cancelled) {
          setPdfTextPages([]);
        }
      }
    };

    loadPageText();

    return () => {
      cancelled = true;
    };
  }, [numPages, pdfUrl, isSearchOpen, hasSearchNeedle]);

  useEffect(() => {
    if (!searchNeedle || !pdfTextPages.length) {
      setSearchResults([]);
      setActiveSearchIndex(-1);
      return;
    }

    const results = [];
    pdfTextPages.forEach((pageData, pageIndex) => {
      const pageText = typeof pageData === 'string' ? pageData : pageData.text;
      const matches = countMatches(pageText, searchNeedle);
      for (let i = 0; i < matches; i += 1) {
        results.push({ page: pageIndex + 1 });
      }
    });

    setSearchResults(results);
    setActiveSearchIndex(results.length ? 0 : -1);
  }, [searchNeedle, pdfTextPages]);

  const handleSavePdf = () => {
    if (!pdfUrl) return;

    const selectedName = selectedFile?.replace(/\\/g, '/').split('/').pop() || 'document.pdf';
    const downloadName = selectedName.toLowerCase().endsWith('.pdf')
      ? selectedName
      : selectedName.replace(/\.[^.]*$/, '') + '.pdf';

    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = downloadName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // ── Presentation mode ──────────────────────────────────────────────────
  // Starts on the page in view and hands the last page shown back to the
  // viewer, so leaving a talk finds the document where the talk ended.
  const handleStartPresentation = () => {
    if (!pdfUrl || !numPages) return;
    setContextMenu(null);
    setAnnotationTooltip(null);
    setIsPresenting(true);
  };

  const handleExitPresentation = (page) => {
    setIsPresenting(false);
    if (page && page !== currentPage) scrollToPage(page);
  };

  // A compile error replaces the document with the error view (see below), and
  // a closed document leaves nothing to show. The presentation ends with it
  // rather than lingering hidden and reappearing on the next successful build.
  const hasRenderableDocument = !(errorLog && !directUrl) && Boolean(base64Pdf || sourceUrl || directUrl);
  useEffect(() => {
    if (!hasRenderableDocument) setIsPresenting(false);
  }, [hasRenderableDocument]);

  useEffect(() => {
    if (containerRef.current) {
      restoreScrollPosRef.current = containerRef.current.scrollTop;
      scrollPosRef.current = containerRef.current.scrollTop;
    }
    isReloadingPdfRef.current = true;

    if (directUrl) {
      setPdfUrl(directUrl);
    } else if (sourceUrl) {
      setPdfUrl(sourceUrl);
    } else if (base64Pdf) {
      setPdfUrl(`/api/latex/pdf?ts=${Date.now()}`);
    } else {
      setPdfUrl('');
      isReloadingPdfRef.current = false;
    }
    setPdfTextPages([]);
    setSearchResults([]);
    setActiveSearchIndex(-1);
    navigationHistoryRef.current = [];
    setCanGoBack(false);
    pdfDocumentRef.current = null;
  }, [base64Pdf, sourceUrl, directUrl]);

  // Return to a remembered position once the pages it depends on are laid out.
  // Abandoned if the document is replaced meanwhile (a recompile), since the new
  // load decides its own position.
  const restoreViewAnchor = (anchor, pdfDocument, attempt = 0) => {
    const container = containerRef.current;
    if (!container || pdfDocumentRef.current !== pdfDocument) return;
    const pages = pageLayout();
    if (!isAnchorLaidOut(anchor, pages) && attempt < VIEW_RESTORE_ATTEMPTS) {
      window.setTimeout(() => restoreViewAnchor(anchor, pdfDocument, attempt + 1), VIEW_RESTORE_INTERVAL_MS);
      return;
    }
    const top = scrollTopForAnchor(anchor, pages);
    if (top != null) {
      container.scrollTop = top;
      scrollPosRef.current = container.scrollTop;
    }
    isReloadingPdfRef.current = false;
    updateCurrentPageFromScroll();
    if (onDocumentReady) onDocumentReady();
  };

  function onDocumentLoadSuccess(pdfDocument) {
    pdfDocumentRef.current = pdfDocument;
    setNumPages(pdfDocument.numPages);
    setCurrentPage(1);
    // Only the first load after mounting returns to a remembered position; a
    // later reload (recompile, annotation toggle) keeps the scroll it had.
    const rememberedAnchor = clampViewAnchor(pendingViewAnchorRef.current, pdfDocument.numPages);
    pendingViewAnchorRef.current = null;
    if (rememberedAnchor) {
      restoreViewAnchor(rememberedAnchor, pdfDocument);
    } else {
      setTimeout(() => {
        if (containerRef.current) {
          const nextScrollTop = restoreScrollPosRef.current || scrollPosRef.current;
          containerRef.current.scrollTop = nextScrollTop;
          scrollPosRef.current = nextScrollTop;
        }
        isReloadingPdfRef.current = false;
        updateCurrentPageFromScroll();
        if (onDocumentReady) onDocumentReady();
      }, 150);
    }
    // Everything the file holds is now painted into the canvas, so the overlay
    // starts empty and only picks up marks made from here on.
    loadAnnotations({ markAsRendered: true });
  }
  
  const scrollToPosition = (page, x, y, w, h, attempt = 0, rememberPosition = true) => {
      if (!containerRef.current) return;
      const pageEl = containerRef.current.querySelector(`[data-page-number="${page}"]`);
      if (!pageEl && attempt < 10) {
        setTimeout(() => {
          scrollToPosition(page, x, y, w, h, attempt + 1, rememberPosition);
        }, 120);
        return;
      }
      if (pageEl) {
        const targetX = x * scale;
        const targetY = y * scale;
        const targetW = (w || 10) * scale;
        const targetH = (h || 14) * scale;
        
        // y from the backend is already the TOP of the bounding box (min_y - 10).
        // No need to subtract height.
        const top = targetY;
        
        setHighlight({ page, y: top, h: targetH });
        if (rememberPosition) pushNavigationHistory();
        
        containerRef.current.scrollTo({
          top: Math.max(0, pageEl.offsetTop + top - 150), // offset a bit to show context
          behavior: 'smooth'
        });
        
        // Remove highlight after 2.5 seconds
        setTimeout(() => {
          setHighlight(null);
        }, 2500);
      }
  };

  // Expose scroll method to parent for Forward Search (Editor -> PDF)
   useImperativeHandle(ref, () => ({
    scrollTo: scrollToPosition
  }));

  const handlePageDoubleClick = async (e, pageIndex) => {
    if (!e.ctrlKey && !e.metaKey) return;
    if (!activeProject?.project_path || !selectedFile) return;
    
    const rect = e.currentTarget.getBoundingClientRect();
    const rawX = e.clientX - rect.left;
    const rawY = e.clientY - rect.top;
    
    const ptX = viewportPxToApp(rawX) / scale;
    const ptY = viewportPxToApp(rawY) / scale;
    
    try {
      const res = await fetch(`/api/latex/synctex?action=pdf2tex&page=${pageIndex}&x=${ptX}&y=${ptY}&filePath=${encodeURIComponent(selectedFile)}&projectPath=${encodeURIComponent(activeProject.project_path)}`);
      const data = await res.json();
      if (data.result && data.result.line && onSyncTexNavigate) {
        // Use relFile (relative to project) for navigation; fall back to absolute file
        const navFile = data.result.relFile || data.result.file;
        onSyncTexNavigate(data.result.line, navFile);
      } else if (!res.ok) {
        console.warn("SyncTeX inverse search found no source:", data.error);
      }
    } catch (err) {
      console.error("SyncTeX inverse search failed:", err);
    }
  };

  // A fresh compile error must always take precedence over a cached PDF URL.
  // Otherwise an old successful preview masks the current failure.
  if (errorLog && !directUrl) {
    const parseErrors = (log) => {
      if (!log) return [];
      const lines = log.split('\n');
      const errors = [];
      for (const line of lines) {
        const lowerLine = line.toLowerCase();
        if (lowerLine.includes('error') || lowerLine.startsWith('!')) {
          if (
            lowerLine.includes('fontconfig error') || 
            lowerLine.includes('halted on potentially-recoverable error') ||
            lowerLine.includes('pdf file was not generated')
          ) {
            continue;
          }
          errors.push(line.trim());
        }
      }
      
      // Remove duplicates
      const uniqueErrors = [...new Set(errors)];
      
      if (uniqueErrors.length === 0 && log.trim().length > 0) {
        uniqueErrors.push(t('pdfPreview.genericCompileError'));
      }
      return uniqueErrors;
    };

    const displayErrors = parseErrors(errorLog);

    return (
      <div className="h-full w-full p-8 flex flex-col items-center justify-center overflow-y-auto" style={{ background: 'var(--vscode-editor-bg)', color: 'var(--vscode-text-fg)' }}>
        <div className="max-w-3xl w-full rounded-xl shadow-2xl overflow-hidden border border-red-500/30" style={{ background: 'var(--vscode-sidebar-bg)' }}>
          <div className="border-b p-6 flex items-center gap-4" style={{ background: 'var(--vscode-errorBackground)', borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 25%, transparent)' }}>
            <div className="p-3 rounded-full shrink-0" style={{ background: 'var(--vscode-errorBackground)' }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--vscode-errorForeground)' }}>
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-semibold" style={{ color: 'var(--vscode-errorForeground)' }}>{t('pdfPreview.compileErrorTitle')}</h2>
              <p className="text-sm mt-1" style={{ color: 'var(--vscode-descriptionForeground, #888)' }}>{t('pdfPreview.compileErrorDescription')}</p>
            </div>
            {latexCompileProblem && onFixLatexProblem && (
              <button
                type="button"
                className="vscode-button"
                onClick={() => onFixLatexProblem(latexCompileProblem)}
                disabled={isAgentRunning}
                title={isAgentRunning ? t('bottomPanel.fixWithAiBusy') : t('bottomPanel.fixWithAiTitle')}
                style={{ marginLeft: 'auto', padding: '6px 10px', fontSize: '12px', flexShrink: 0 }}
              >
                <Sparkles size={13} />
                <span>{t('bottomPanel.fixWithAi')}</span>
              </button>
            )}
          </div>
          
          <div className="p-6">
            <h3 className="text-xs font-semibold mb-4 uppercase tracking-wider" style={{ color: 'var(--vscode-descriptionForeground, #888)' }}>{t('pdfPreview.mainIssues')}</h3>
            <ul className="space-y-3 mb-6">
              {displayErrors.map((err, i) => (
                <li key={i} className="flex items-start gap-3 p-4 rounded-lg border" style={{ background: 'var(--vscode-errorBackground)', borderColor: 'color-mix(in srgb, var(--vscode-errorForeground) 18%, transparent)' }}>
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0" style={{ color: 'var(--vscode-errorForeground)' }}>
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <span className="text-sm font-mono break-words leading-relaxed" style={{ color: 'var(--vscode-text-fg)' }}>{err}</span>
                </li>
              ))}
            </ul>
            
            <details className="group">
              <summary className="cursor-pointer text-sm transition-colors flex items-center gap-2 select-none font-medium w-fit" style={{ color: 'var(--vscode-descriptionForeground, #888)' }}>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform group-open:rotate-90">
                  <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
                {t('pdfPreview.technicalDetails')}
              </summary>
              <div className="mt-4 p-4 rounded-lg overflow-x-auto border shadow-inner max-h-64 overflow-y-auto" style={{ background: 'var(--vscode-bg)', borderColor: 'var(--vscode-border)' }}>
                <pre className="text-[13px] font-mono whitespace-pre-wrap" style={{ color: 'var(--vscode-text-fg)' }}>{errorLog}</pre>
              </div>
            </details>
          </div>
        </div>
      </div>
    );
  }

  if (!base64Pdf && !sourceUrl && !directUrl) {
    return (
      <div className="flex items-center justify-center h-full w-full relative" style={{ background: 'var(--vscode-editor-bg)', color: 'var(--vscode-descriptionForeground, #888)' }}>
        <p>{t('pdfPreview.noDocument')}</p>
        {isCompiling && (
          <div className="pdf-preview-compile-overlay" role="status" aria-live="polite">
            <div className="pdf-preview-compile-panel">
              <div className="pdf-preview-compile-orbit" aria-hidden="true">
                <span className="pdf-preview-compile-page"></span>
              </div>
              <div className="pdf-preview-compile-text">
                <p className="pdf-preview-compile-title">{t('pdfPreview.compiling')}</p>
                <p className="pdf-preview-compile-subtitle">{t('pdfPreview.compilingSubtitle')}</p>
              </div>
              <div className="pdf-preview-compile-progress" aria-hidden="true">
                <span></span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full h-full relative overflow-hidden" style={{ background: 'var(--pdf-viewer-bg, var(--vscode-editor-bg))' }}>
      {(isCompiling || isRecompiling) && (
        <div className="pdf-preview-compile-overlay" role="status" aria-live="polite">
          <div className="pdf-preview-compile-panel">
            <div className="pdf-preview-compile-orbit" aria-hidden="true">
              <span className="pdf-preview-compile-page"></span>
            </div>
            <div className="pdf-preview-compile-text">
              <p className="pdf-preview-compile-title">{t('pdfPreview.compiling')}</p>
              <p className="pdf-preview-compile-subtitle">{t('pdfPreview.compilingSubtitle')}</p>
            </div>
            <div className="pdf-preview-compile-progress" aria-hidden="true">
              <span></span>
            </div>
          </div>
        </div>
      )}
      
      {/* PDF Controls */}
      <div 
        className="pdf-preview-controls flex items-center gap-1.5"
        style={{
          background: 'var(--vscode-sidebar-bg)',
          border: '1px solid var(--vscode-border)',
        }}
      >
        <button
          type="button"
          onClick={handleBackNavigation}
          disabled={!canGoBack}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: canGoBack ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
            opacity: canGoBack ? 1 : 0.5,
            cursor: canGoBack ? 'pointer' : 'default',
          }}
          onMouseEnter={(e) => { if (canGoBack) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = canGoBack ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('pdfPreview.backToPreviousPosition')}
          aria-label={t('pdfPreview.backToPreviousPosition')}
        >
          <ArrowLeft size={18} />
        </button>
        <button
          type="button"
          onClick={handleSavePdf}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.savePdf')}
        >
          <Download size={18} />
        </button>
        {sourceTexFile && (
          <button
            type="button"
            onClick={handleRecompileFromSource}
            disabled={isRecompiling}
            className="flex items-center justify-center rounded-md transition-colors"
            style={{
              width: '32px',
              height: '32px',
              background: 'var(--vscode-input-bg)',
              border: '1px solid var(--vscode-border)',
              color: 'var(--vscode-text-fg)',
              opacity: isRecompiling ? 0.5 : 1,
              cursor: isRecompiling ? 'default' : 'pointer',
            }}
            onMouseEnter={(e) => { if (!isRecompiling) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
            title={t('pdfPreview.recompileFromSource', 'Recompile from {{file}}', { file: sourceTexFile })}
            aria-label={t('pdfPreview.recompileFromSource', 'Recompile from {{file}}', { file: sourceTexFile })}
          >
            <RefreshCw size={18} className={isRecompiling ? 'animate-spin' : ''} />
          </button>
        )}
        <button
          type="button"
          onClick={handleStartPresentation}
          disabled={!pdfUrl || !numPages}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: pdfUrl && numPages ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
            opacity: pdfUrl && numPages ? 1 : 0.5,
            cursor: pdfUrl && numPages ? 'pointer' : 'default',
          }}
          onMouseEnter={(e) => { if (pdfUrl && numPages) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = pdfUrl && numPages ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('pdfPreview.present', 'Present (full screen)')}
          aria-label={t('pdfPreview.present', 'Present (full screen)')}
        >
          <MonitorPlay size={18} />
        </button>
        <button
          onClick={handleSearchToggle}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-input-bg)',
            border: `1px solid ${isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-border)'}`,
            color: isSearchOpen ? '#ffffff' : 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-input-bg)'; e.currentTarget.style.color = isSearchOpen ? '#ffffff' : 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = isSearchOpen ? 'var(--vscode-button-bg)' : 'var(--vscode-border)'; }}
          title={t('pdfPreview.searchPdf')}
        >
          <Search size={18} />
        </button>
        {isSearchOpen && (
          <div
            className="flex items-center rounded-md"
            style={{
              background: 'var(--vscode-input-bg)',
              border: '1px solid var(--vscode-border)',
              height: '32px',
              maxWidth: '260px',
            }}
          >
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) handleSearchPrev();
                else if (e.key === 'Enter') handleSearchSubmit();
                else if (e.key === 'Escape') clearSearch();
              }}
              placeholder={t('pdfPreview.searchPlaceholder')}
              style={{
                width: '118px',
                height: '100%',
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--vscode-text-fg)',
                fontSize: '12px',
                padding: '0 8px',
              }}
            />
            <span
              className="text-xs flex items-center px-1.5"
              style={{
                color: 'var(--vscode-descriptionForeground)',
                fontSize: '11px',
                whiteSpace: 'nowrap',
                borderLeft: '1px solid var(--vscode-border)',
                height: '100%',
              }}
            >
              {searchResults.length
                ? `${activeSearchIndex + 1}/${searchResults.length}`
                : searchNeedle
                  ? t('pdfPreview.noSearchResults')
                  : '0/0'}
            </span>
            <button
              type="button"
              onClick={handleSearchPrev}
              disabled={!searchResults.length}
              className="flex items-center justify-center transition-colors"
              style={{
                width: '28px',
                height: '100%',
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                borderLeft: '1px solid var(--vscode-border)',
                color: searchResults.length ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
                cursor: searchResults.length ? 'pointer' : 'default',
                opacity: searchResults.length ? 1 : 0.5,
                padding: 0,
              }}
              title={t('pdfPreview.previousMatch')}
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              onClick={handleSearchNext}
              disabled={!searchResults.length}
              className="flex items-center justify-center transition-colors"
              style={{
                width: '28px',
                height: '100%',
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                borderLeft: '1px solid var(--vscode-border)',
                color: searchResults.length ? 'var(--vscode-text-fg)' : 'var(--vscode-descriptionForeground)',
                cursor: searchResults.length ? 'pointer' : 'default',
                opacity: searchResults.length ? 1 : 0.5,
                padding: 0,
              }}
              title={t('pdfPreview.nextMatch')}
            >
              <ChevronDown size={16} />
            </button>
            <button
              type="button"
              onClick={clearSearch}
              className="flex items-center justify-center transition-colors"
              style={{
                width: '28px',
                height: '100%',
                appearance: 'none',
                background: 'transparent',
                border: 'none',
                borderLeft: '1px solid var(--vscode-border)',
                color: 'var(--vscode-text-fg)',
                cursor: 'pointer',
                padding: 0,
              }}
              title={t('pdfPreview.clearSearch')}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="flex items-center justify-center rounded-md transition-colors"
            style={{
              width: '32px',
              height: '32px',
              background: 'var(--vscode-input-bg)',
              border: '1px solid var(--vscode-border)',
              color: 'var(--vscode-text-fg)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
            title={t('editorPanel.collapsePdfPreview')}
          >
            <PanelRightClose size={18} />
          </button>
        )}
        <button
          onClick={handleZoomOut}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.zoomOut')}
        >
          <ZoomOut size={18} />
        </button>
        <span 
          className="text-xs font-semibold text-center rounded-md"
          style={{
            minWidth: '52px',
            padding: '6px 8px',
            background: 'var(--vscode-input-bg)',
            color: 'var(--vscode-text-fg)',
            border: '1px solid var(--vscode-border)',
          }}
        >
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={handleZoomIn}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: 'var(--vscode-text-fg)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.zoomIn')}
        >
          <ZoomIn size={18} />
        </button>
        <button
          onClick={handleResetZoom}
          disabled={scale === DEFAULT_PDF_SCALE}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: 'var(--vscode-input-bg)',
            border: '1px solid var(--vscode-border)',
            color: scale === DEFAULT_PDF_SCALE ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-text-fg)',
            opacity: scale === DEFAULT_PDF_SCALE ? 0.5 : 1,
            cursor: scale === DEFAULT_PDF_SCALE ? 'default' : 'pointer',
          }}
          onMouseEnter={(e) => { if (scale !== DEFAULT_PDF_SCALE) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = scale === DEFAULT_PDF_SCALE ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
          title={t('editorPanel.resetZoom')}
        >
          <RotateCcw size={18} />
        </button>
        {/* Annotation toggle */}
        <button
          onClick={() => setShowAnnotations(prev => !prev)}
          className="flex items-center justify-center rounded-md transition-colors"
          style={{
            width: '32px',
            height: '32px',
            background: showAnnotations ? 'var(--vscode-input-bg)' : 'var(--vscode-button-bg)',
            border: `1px solid ${showAnnotations ? 'var(--vscode-border)' : 'var(--vscode-button-bg)'}`,
            color: showAnnotations ? 'var(--vscode-text-fg)' : '#ffffff',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = showAnnotations ? 'var(--vscode-button-bg)' : 'var(--vscode-input-bg)';
            e.currentTarget.style.color = showAnnotations ? '#ffffff' : 'var(--vscode-text-fg)';
            e.currentTarget.style.borderColor = showAnnotations ? 'var(--vscode-button-bg)' : 'var(--vscode-border)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = showAnnotations ? 'var(--vscode-input-bg)' : 'var(--vscode-button-bg)';
            e.currentTarget.style.color = showAnnotations ? 'var(--vscode-text-fg)' : '#ffffff';
            e.currentTarget.style.borderColor = showAnnotations ? 'var(--vscode-border)' : 'var(--vscode-button-bg)';
          }}
          title={t(showAnnotations ? 'pdfPreview.annotationsOn' : 'pdfPreview.annotationsOff')}
        >
          {showAnnotations ? <MessageSquareOff size={18} /> : <MessageSquare size={18} />}
        </button>
        {/* Page navigation: prev / [input] of N / next */}
        {numPages && numPages > 1 && (
          <>
            <div style={{ width: '1px', height: '24px', background: 'var(--vscode-border)', margin: '0 2px' }} />
            <button
              onClick={handlePageNavPrev}
              disabled={currentPage <= 1}
              className="flex items-center justify-center rounded-md transition-colors"
              style={{
                width: '32px',
                height: '32px',
                background: 'var(--vscode-input-bg)',
                border: '1px solid var(--vscode-border)',
                color: currentPage <= 1 ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-text-fg)',
                opacity: currentPage <= 1 ? 0.5 : 1,
                cursor: currentPage <= 1 ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (currentPage > 1) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
              title={t('editorPanel.prevPage')}
            >
              <ChevronUp size={18} />
            </button>
            <div
              ref={pageNavRef}
              className="flex items-center rounded-md"
              style={{
                background: 'var(--vscode-input-bg)',
                border: '1px solid var(--vscode-border)',
                height: '32px',
              }}
              title={t('editorPanel.goToPage')}
            >
              <input
                type="text"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') handlePageNavSubmit(); }}
                onFocus={(e) => e.target.select()}
                placeholder={String(currentPage)}
                className="text-center"
                style={{
                  width: '32px',
                  height: '100%',
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--vscode-text-fg)',
                  fontSize: '12px',
                }}
              />
              <span
                className="text-xs flex items-center px-1.5"
                style={{
                  color: 'var(--vscode-descriptionForeground)',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                  borderLeft: '1px solid var(--vscode-border)',
                  height: '100%',
                }}
              >
                / {numPages}
              </span>
            </div>
            <button
              onClick={handlePageNavNext}
              disabled={currentPage >= numPages}
              className="flex items-center justify-center rounded-md transition-colors"
              style={{
                width: '32px',
                height: '32px',
                background: 'var(--vscode-input-bg)',
                border: '1px solid var(--vscode-border)',
                color: currentPage >= numPages ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-text-fg)',
                opacity: currentPage >= numPages ? 0.5 : 1,
                cursor: currentPage >= numPages ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (currentPage < numPages) { e.currentTarget.style.background = 'var(--vscode-button-bg)'; e.currentTarget.style.color = '#ffffff'; e.currentTarget.style.borderColor = 'var(--vscode-button-bg)'; } }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--vscode-input-bg)'; e.currentTarget.style.color = 'var(--vscode-text-fg)'; e.currentTarget.style.borderColor = 'var(--vscode-border)'; }}
              title={t('editorPanel.nextPage')}
            >
              <ChevronDown size={18} />
            </button>
          </>
        )}
      </div>
      
      <div 
        className="pdf-preview-scroll w-full h-full overflow-y-auto overflow-x-auto flex flex-col items-start"
        ref={containerRef}
        onScroll={handleScroll}
        onPointerDownCapture={handlePdfPointerDownCapture}
        onContextMenu={handlePdfContextMenu}
        onPointerMove={handlePdfPointerMove}
        onPointerLeave={() => setAnnotationTooltip(null)}
        style={{ background: 'var(--pdf-viewer-bg, var(--vscode-editor-bg))' }}
      >
        {pdfUrl && (
          <Document
            className="pdf-doc-stack"
            file={pdfUrl}
            options={PDF_DOCUMENT_OPTIONS}
            onLoadSuccess={onDocumentLoadSuccess}
            loading={<div style={{ color: 'var(--vscode-text-fg)' }}>{t('pdfPreview.loadingPdf')}</div>}
            error={<div style={{ color: 'var(--vscode-errorForeground)' }}>{t('pdfPreview.loadError')}</div>}
          >
            {Array.from(new Array(numPages || 0), (el, index) => (
              <React.Fragment key={`page_${index + 1}`}>
                {index > 0 && (
                  <div
                    className="pdf-page-divider"
                    role="separator"
                    aria-label={t('pdfPreview.pageDividerLabel', {
                      page: index + 1,
                      total: numPages,
                    })}
                  >
                    <span>
                      {t('pdfPreview.pageDividerLabel', {
                        page: index + 1,
                        total: numPages,
                      })}
                    </span>
                  </div>
                )}
              <div
                data-page-number={index + 1}
                className="pdf-page-wrapper shadow-2xl bg-white cursor-text relative"
                style={{ isolation: 'isolate' }}
                onDoubleClick={(e) => handlePageDoubleClick(e, index + 1)}
              >
                <Page
                  pageNumber={index + 1}
                  renderTextLayer={true}
                  renderAnnotationLayer={showAnnotations}
                  filterAnnotations={filterNativeAnnotations}
                  scale={scale}
                  /* The page is painted into a canvas, so the interface `zoom`
                     would merely stretch a bitmap and blur it. Folding the
                     scale into the device pixel ratio instead renders the
                     backing store at the size it is actually displayed at,
                     leaving `scale` — and the zoom percentage shown in the
                     toolbar — to mean what they meant before. */
                  devicePixelRatio={(window.devicePixelRatio || 1) * uiScale}
                />
                {/* Bounding-box search highlight overlay — drawn above the canvas,
                    does NOT touch the text layer so there is no double-text glitch */}
                {searchNeedle && pdfTextPages[index] && (
                  <SearchHighlightLayer
                    pageItems={pdfTextPages[index].items}
                    pageWidth={pdfTextPages[index].width}
                    pageHeight={pdfTextPages[index].height}
                    needle={searchNeedle}
                    scaleFactor={scale}
                  />
                )}
                
                {/* Annotations the loaded bytes do not carry yet. Everything
                    already in the file is painted by pdf.js from its appearance
                    stream, so this layer stays empty until the user marks
                    something. */}
                {canAnnotate && showAnnotations && (
                  <PdfAnnotationLayer
                    annotations={annotations.filter((a) => a.page === index + 1)}
                    pendingIds={freshAnnotationIds}
                    onOpenNote={handleOpenNoteFromMarker}
                    onMoveNote={handleMoveNoteMarker}
                  />
                )}

                {/* Visual Highlight for Forward Search */}
                {highlight && highlight.page === index + 1 && (
                  <div 
                    style={{
                      position: 'absolute',
                      zIndex: 99999,
                      left: 0,
                      top: `${highlight.y}px`,
                      width: '100%',
                      height: `${Math.max(highlight.h, 18)}px`,
                      backgroundColor: 'rgba(250, 204, 21, 0.25)',
                      borderLeft: '6px solid #ef4444',
                      pointerEvents: 'none',
                      boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
                      transition: 'opacity 0.3s ease-in'
                    }}
                  />
                )}
              </div>
              </React.Fragment>
            ))}
          </Document>
        )}
      </div>

      <PdfContextMenu
        menu={contextMenu}
        onClose={() => setContextMenu(null)}
        onAskAbout={handleAskAboutPdf}
        onLookUp={handleLookUpSelection}
        onTranslate={handleTranslateSelection}
        onPronounce={handlePronounceSelection}
        canPronounce={speechAvailability.ready}
        pronounceUnavailableHint={speechAvailability.problem}
        canAsk={Boolean(onAskAboutPdf)}
        canAnnotate={canAnnotate && showAnnotations}
        annotationColor={annotationColor}
        onAnnotate={handleAnnotateSelection}
        onEditNote={handleOpenNote}
        onRemoveAnnotation={handleRemoveAnnotation}
      />

      {/* Hover reading. The note editor takes over on click, so this stays a
          read-only glance and never steals focus. */}
      {annotationTooltip && !notePopup && (
        <div
          className="pdf-annotation-tooltip"
          role="tooltip"
          style={{
            left: `${Math.min(annotationTooltip.x + 14, viewportPxToApp(window.innerWidth) - 300)}px`,
            top: `${annotationTooltip.y + 16}px`,
          }}
        >
          {annotationTooltip.annotation.author && (
            <div className="pdf-annotation-tooltip-author">{annotationTooltip.annotation.author}</div>
          )}
          <div className="pdf-annotation-tooltip-body">{annotationTooltip.annotation.content}</div>
        </div>
      )}

      <PdfNotePopup
        state={notePopup}
        onSave={handleSaveNote}
        onCancel={() => setNotePopup(null)}
      />

      {canAnnotate && annotationError && (
        <div className="pdf-annotation-error" role="status">
          <span>{annotationError}</span>
          <button type="button" onClick={() => setAnnotationError('')} aria-label={t('pdfNote.dismiss', 'Dismiss')}>
            <X size={13} />
          </button>
        </div>
      )}

      <SpeechPopup
        state={speech}
        onClose={closeSpeech}
        onToggle={toggleSpeech}
        onReplay={replaySpeech}
        onRetry={retrySpeech}
      />

      <TranslationPopup
        state={translation}
        onClose={closeTranslation}
        onRetry={handleRetryTranslation}
        onCopy={handleCopyTranslation}
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
        noteAction={{
          available: !lookupNoteReason,
          reason: lookupNoteReason,
          onSave: handleSaveLookupNote,
        }}
      />

      {isPresenting && pdfUrl && (
        <PdfPresentMode
          fileUrl={pdfUrl}
          initialPageCount={numPages || 0}
          startPage={currentPage}
          uiScale={uiScale}
          onExit={handleExitPresentation}
        />
      )}
    </div>
  );
});

export default PdfPreview;
