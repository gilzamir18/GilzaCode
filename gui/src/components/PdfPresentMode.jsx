// ─────────────────────────────────────────────────────────────────────────────
// PdfPresentMode.jsx
//
// Full-screen presentation of a PDF, one page at a time, fitted to the screen.
// A Beamer deck ships every overlay as its own page, so paging through the PDF
// *is* stepping through the talk; nothing Beamer-specific is needed here.
//
// Fullscreen, navigation keys, click-to-advance and the zoom-corrected viewport
// come from `usePresentation`.
//
// Three decisions:
//   • It loads its own <Document> from the same URL the viewer renders, rather
//     than borrowing the viewer's PDFDocumentProxy. The viewer's document is
//     destroyed and replaced on every recompile; a borrowed proxy would then
//     fail mid-talk, while an owned <Document> simply reloads and keeps the page.
//   • The pages on either side of the current one stay mounted and rendered,
//     hidden. A canvas repaints asynchronously, so mounting a page only when it
//     is reached would flash black on every advance.
//   • No text or annotation layer. Every click on the page is navigation, so a
//     selectable text layer or a link would only compete with it.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useTranslation } from 'react-i18next';

import { usePresentation } from '../hooks/usePresentation.js';
import { fitScale } from '../utils/presentationNavigation.js';

// Module-level so react-pdf sees the same object on every render; a new options
// object would reload the document.
const PDF_DOCUMENT_OPTIONS = {
  verbosity: pdfjs.VerbosityLevel.ERRORS,
};

export default function PdfPresentMode({ fileUrl, initialPageCount = 0, startPage = 1, uiScale = 1, onExit }) {
  const { t } = useTranslation();
  const [pdfDocument, setPdfDocument] = useState(null);
  // Known before this document loads, so a presentation started on page 12
  // opens on page 12 instead of waiting for the count to arrive.
  const [pageCount, setPageCount] = useState(initialPageCount);
  // Page sizes at scale 1 (the page's own rotation applied), keyed by page
  // number. Pages of one PDF may differ in size and orientation, so each page
  // is fitted on its own.
  const [pageSizes, setPageSizes] = useState(() => new Map());

  // Pages are 1-based to the viewer and 0-based to the shared hook.
  const handleExit = useCallback((pageIndex) => onExit?.(pageIndex + 1), [onExit]);
  const { hostRef, index, viewport, handleClick } = usePresentation({
    count: pageCount,
    startIndex: Math.max(0, startPage - 1),
    uiScale,
    onExit: handleExit,
  });

  // A new URL means a recompiled or re-stripped PDF: react-pdf destroys the old
  // document, so nothing may be measured against it while the new one loads.
  useEffect(() => {
    setPdfDocument(null);
    setPageSizes(new Map());
  }, [fileUrl]);

  const currentPage = index + 1;
  const mountedPages = [currentPage - 1, currentPage, currentPage + 1]
    .filter((page) => page >= 1 && (!pageCount || page <= pageCount));

  const handleLoadSuccess = (loaded) => {
    setPageSizes(new Map());
    setPdfDocument(loaded);
    setPageCount(loaded.numPages);
  };

  const mountedKey = mountedPages.join(',');
  useEffect(() => {
    if (!pdfDocument) return undefined;
    let cancelled = false;
    const missing = mountedPages.filter((page) => !pageSizes.has(page));
    if (missing.length === 0) return undefined;

    Promise.all(missing.map(async (page) => {
      const proxy = await pdfDocument.getPage(page);
      // Same call react-pdf makes to size a page, so the fit matches the canvas.
      const { width, height } = proxy.getViewport({ scale: 1, rotation: proxy.rotate });
      return [page, { width, height }];
    }))
      .then((entries) => {
        if (cancelled) return;
        setPageSizes((prev) => {
          const next = new Map(prev);
          entries.forEach(([page, size]) => next.set(page, size));
          return next;
        });
      })
      .catch((err) => {
        // A cancelled request belongs to a document that has since been replaced
        // and will be measured again; anything else leaves that page undrawn.
        if (!cancelled) console.error('PDF presentation could not measure a page:', err);
      });

    return () => { cancelled = true; };
  }, [pdfDocument, mountedKey, pageSizes]);

  return (
    <div
      ref={hostRef}
      className="pdf-present"
      tabIndex={-1}
      role="dialog"
      aria-label={t('pdfPreview.presentationLabel', 'PDF presentation')}
      onClick={handleClick}
    >
      <Document
        className="pdf-present-document"
        file={fileUrl}
        options={PDF_DOCUMENT_OPTIONS}
        onLoadSuccess={handleLoadSuccess}
        loading={<div className="pdf-present-status">{t('pdfPreview.loadingPdf')}</div>}
        error={<div className="pdf-present-status">{t('pdfPreview.loadError')}</div>}
      >
        {pdfDocument && mountedPages.map((page) => {
          const size = pageSizes.get(page);
          const scale = size ? fitScale(size.width, size.height, viewport.width, viewport.height) : 0;
          if (!scale) return null;
          return (
            <div
              key={page}
              className="pdf-present-page"
              style={{ visibility: page === currentPage ? 'visible' : 'hidden' }}
              aria-hidden={page === currentPage ? undefined : true}
            >
              <Page
                pageNumber={page}
                scale={scale}
                renderTextLayer={false}
                renderAnnotationLayer={false}
                loading={null}
                /* As in the viewer: the page is a canvas, so the interface
                   scale goes into the backing store's pixel ratio instead of
                   stretching a bitmap rendered at the unzoomed size. */
                devicePixelRatio={(window.devicePixelRatio || 1) * uiScale}
              />
            </div>
          );
        })}
      </Document>
      {pageCount > 0 && (
        <div className="pdf-present-hud">{currentPage} / {pageCount}</div>
      )}
    </div>
  );
}
