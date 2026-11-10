// Where a PDF viewer is scrolled to, kept so the viewer can be unmounted — which
// is what switching to another tab does — and come back to the same place.
//
// The position is a page plus a fraction of that page's height, not a pixel
// offset. A freshly mounted viewer lays its pages out one at a time, as pdf.js
// reports each page's size, so a pixel offset applied before that finishes
// lands on whatever happens to be there at the time; an anchor names the page it
// means and can wait for it. It also survives a recompile that changed the
// height of the pages above it, which a pixel offset does not.
//
// All positions are app CSS pixels (`offsetTop`, `offsetHeight`, `scrollTop`),
// the units the viewer already scrolls in, so the interface scale never enters.

/**
 * The anchor for a scroll offset. `pages` is `[{ page, top, height }]` in
 * document order; pages not laid out yet (height 0) are ignored. Scrolled above
 * the first page — into the viewer's top padding — anchors to the first page
 * with a negative fraction, so the padding is restored too.
 */
export const viewAnchorAt = (scrollTop, pages) => {
  const laidOut = (pages || []).filter((p) => p.height > 0);
  if (laidOut.length === 0) return null;
  let chosen = laidOut[0];
  for (const candidate of laidOut) {
    if (candidate.top > scrollTop) break;
    chosen = candidate;
  }
  return { page: chosen.page, offset: (scrollTop - chosen.top) / chosen.height };
};

/** The scroll offset an anchor stands for, or null when its page is not laid out. */
export const scrollTopForAnchor = (anchor, pages) => {
  if (!anchor) return null;
  const target = (pages || []).find((p) => p.page === anchor.page);
  if (!target || !(target.height > 0)) return null;
  return Math.max(0, target.top + anchor.offset * target.height);
};

/**
 * Whether an anchor can be restored yet: its page and every page above it have
 * their final size. Anything above that is still a placeholder would shift the
 * target as soon as it grows.
 */
export const isAnchorLaidOut = (anchor, pages) => {
  if (!anchor) return false;
  const upToAnchor = (pages || []).filter((p) => p.page <= anchor.page);
  return upToAnchor.some((p) => p.page === anchor.page) && upToAnchor.every((p) => p.ready);
};

/**
 * An anchor made valid for a document of `pageCount` pages, or null when it is
 * unusable. A document that lost pages while the viewer was away — recompiled
 * in the meantime — opens at the top of its new last page.
 */
export const clampViewAnchor = (anchor, pageCount) => {
  const page = Math.trunc(Number(anchor?.page));
  if (!(page >= 1)) return null;
  const offset = Number.isFinite(anchor.offset) ? anchor.offset : 0;
  if (pageCount > 0 && page > pageCount) return { page: pageCount, offset: 0 };
  return { page, offset };
};
