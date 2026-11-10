"""Reading annotations stored inside the PDF file itself.

The viewer's annotation tools target **standalone PDFs** -- a paper, a spec, a
reference someone opened in the editor -- not the PDF that ``pdflatex`` regenerates
on every compile. That distinction is what makes writing into the file the right
storage: nothing overwrites it behind the user's back, so the annotations can live
in the place the PDF format already reserves for them instead of in a sidecar only
GilzaCode can read.

Storing them natively makes the format a two-way street. Highlights a user already
made in Zotero, Acrobat or a tablet reader show up here with no import step, and
highlights made here travel back out when the file is shared. A private JSON
sidecar would read nothing and export nothing.

Coordinates cross the wire **normalized to 0..1** against the page box rather than
as PDF points. The viewer knows its own zoom and the browser gives it CSS pixels;
normalizing on that side means the scale factor cancels out before it can be got
wrong. ``Page.rect`` reports the *rotated* box, which is exactly the box pdf.js
lays out, so a normalized value means the same thing on both sides.

PyMuPDF's annotation writers do **not** share that space: they take coordinates in
the page's unrotated space. A normalized rect is therefore mapped through
``Page.derotation_matrix`` on the way in and read back through
``Page.rotation_matrix`` on the way out. Skipping that step puts every mark on a
rotated page in the wrong quadrant, and it fails quietly -- the rect handed back
still looks plausible, so only rendering the page and finding the painted pixels
shows it. That is what the rotation tests check.

Identity is the annotation's PDF cross-reference number (``xref``). Incremental
saves append rather than renumber, so an xref stays valid across later edits and
deletions of other annotations in the same file.
"""

from __future__ import annotations

import os
from typing import Any

# Markup kinds the viewer can create. Each maps to a standard PDF annotation
# subtype, which is what makes them readable by other PDF software.
QUAD_KINDS = ("highlight", "underline", "strikeout", "squiggly")
POINT_KINDS = ("note",)
SUPPORTED_KINDS = QUAD_KINDS + POINT_KINDS

# Subtype -> viewer kind, for reading back annotations this module did not write.
_SUBTYPE_TO_KIND = {
    "Highlight": "highlight",
    "Underline": "underline",
    "StrikeOut": "strikeout",
    "Squiggly": "squiggly",
    "Text": "note",
    "FreeText": "note",
}

DEFAULT_COLOR = "#facc15"
DEFAULT_AUTHOR = "GilzaCode"

# A note's clickable icon has no meaningful size of its own; PDF viewers draw it
# at a fixed size. This is the box we hand PyMuPDF for the icon's anchor point.
NOTE_ICON_SIZE = 18.0

# The popup window a markup annotation's note opens into. Its /Rect is the standard
# place to record where that note sits, so it is what a dragged marker writes to;
# the size is the conventional small note window other readers draw.
POPUP_WIDTH = 160.0
POPUP_HEIGHT = 80.0

# Annotation text long enough to be a pasted document rather than a note is
# rejected instead of silently truncated.
MAX_CONTENT_CHARS = 10000


class PdfAnnotationError(Exception):
    """A PDF cannot be annotated, and the caller needs to know exactly why.

    Raised instead of degrading to some other storage: silently diverting
    annotations to a sidecar when the file refuses them would leave the user
    believing the PDF carries marks it does not have.
    """


def _import_pymupdf():
    try:
        import pymupdf  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise PdfAnnotationError(
            "PyMuPDF is required to read or write PDF annotations. "
            "Install it with: pip install pymupdf"
        ) from exc
    return pymupdf


def _hex_to_rgb(value: str) -> tuple[float, float, float]:
    """Convert ``#rrggbb`` to the 0..1 float triple PDF colors use."""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6:
        raise PdfAnnotationError(f"Invalid color '{value}': expected #rrggbb.")
    try:
        return tuple(int(text[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise PdfAnnotationError(f"Invalid color '{value}': expected #rrggbb.") from exc


def _rgb_to_hex(rgb: Any) -> str:
    if not rgb:
        return DEFAULT_COLOR
    try:
        r, g, b = (max(0.0, min(1.0, float(c))) for c in tuple(rgb)[:3])
    except (TypeError, ValueError):
        return DEFAULT_COLOR
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))


def _open_document(pdf_path: str, *, for_write: bool):
    """Open ``pdf_path``, failing fast with a specific reason when it cannot be used.

    Every rejection here is a condition the user can act on -- a missing file, a
    file that is not a PDF, a password, a permission flag -- so each gets its own
    message rather than a generic failure.
    """
    pymupdf = _import_pymupdf()

    if not pdf_path:
        raise PdfAnnotationError("No PDF path was given.")
    if not os.path.isfile(pdf_path):
        raise PdfAnnotationError(f"PDF not found: {pdf_path}")

    try:
        doc = pymupdf.open(pdf_path)
    except Exception as exc:
        raise PdfAnnotationError(f"Could not open '{os.path.basename(pdf_path)}' as a PDF: {exc}") from exc

    if not doc.is_pdf:
        doc.close()
        raise PdfAnnotationError(f"'{os.path.basename(pdf_path)}' is not a PDF file.")

    if doc.needs_pass:
        doc.close()
        raise PdfAnnotationError(
            f"'{os.path.basename(pdf_path)}' is password-protected and cannot be annotated."
        )

    if for_write:
        if not doc.permissions & pymupdf.PDF_PERM_ANNOTATE:
            doc.close()
            raise PdfAnnotationError(
                f"'{os.path.basename(pdf_path)}' does not allow annotations "
                "(the document's permissions forbid it)."
            )
        if not os.access(pdf_path, os.W_OK):
            doc.close()
            raise PdfAnnotationError(f"'{os.path.basename(pdf_path)}' is read-only on disk.")

    return doc


def _save(doc) -> None:
    """Persist changes, appending to the file rather than rewriting it.

    An incremental save only appends the new objects, which keeps a large PDF cheap
    to annotate and leaves the original bytes -- including any signature -- intact.
    A PDF that cannot take one (a linearized or damaged file) is rewritten in full
    instead of failing.
    """
    pymupdf = _import_pymupdf()
    try:
        doc.saveIncr()
    except Exception:
        doc.save(doc.name, incremental=False, encryption=pymupdf.PDF_ENCRYPT_KEEP, garbage=0)


def _page_rect(page):
    return page.rect


def _to_unrotated(rect, page):
    """Map a visual-space rect into the unrotated space PyMuPDF writes annotations in."""
    return rect * page.derotation_matrix


def _to_visual(rect, page):
    """Map a stored unrotated rect back into the space the viewer lays out."""
    return rect * page.rotation_matrix


def _normalize_rect(rect, box) -> list[float]:
    return [
        (rect.x0 - box.x0) / box.width,
        (rect.y0 - box.y0) / box.height,
        (rect.x1 - box.x0) / box.width,
        (rect.y1 - box.y0) / box.height,
    ]


def _rect_center(rect: list[float]) -> list[float]:
    return [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2]


def _denormalize_rect(values: Any, box):
    pymupdf = _import_pymupdf()
    try:
        x0, y0, x1, y1 = (float(v) for v in tuple(values)[:4])
    except (TypeError, ValueError) as exc:
        raise PdfAnnotationError("Each rect must be [x0, y0, x1, y1] in 0..1 page coordinates.") from exc
    # Clamp rather than reject: a selection dragged past the page edge is a normal
    # gesture, and the intended mark is unambiguous.
    x0, x1 = sorted((max(0.0, min(1.0, x0)), max(0.0, min(1.0, x1))))
    y0, y1 = sorted((max(0.0, min(1.0, y0)), max(0.0, min(1.0, y1))))
    return pymupdf.Rect(
        box.x0 + x0 * box.width,
        box.y0 + y0 * box.height,
        box.x0 + x1 * box.width,
        box.y0 + y1 * box.height,
    )


def _describe(annot, page_number: int, page) -> dict[str, Any]:
    """Render one PyMuPDF annotation as the viewer's JSON shape."""
    box = _page_rect(page)
    info = annot.info or {}
    subtype = annot.type[1] if isinstance(annot.type, (tuple, list)) and len(annot.type) > 1 else ""
    kind = _SUBTYPE_TO_KIND.get(subtype, "")

    rects: list[list[float]] = []
    vertices = annot.vertices if kind in QUAD_KINDS else None
    if vertices:
        # Quad points arrive as four corners per marked span: upper-left,
        # upper-right, lower-left, lower-right. Collapse each quad to its
        # bounding rect, which is all the overlay needs to draw.
        pymupdf = _import_pymupdf()
        for i in range(0, len(vertices) - 3, 4):
            corners = vertices[i:i + 4]
            xs = [c[0] for c in corners]
            ys = [c[1] for c in corners]
            stored = pymupdf.Rect(min(xs), min(ys), max(xs), max(ys))
            rects.append(_normalize_rect(_to_visual(stored, page), box))
    if not rects:
        rects.append(_normalize_rect(_to_visual(annot.rect, page), box))

    # Where the viewer's note marker sits, when it has been placed explicitly.
    # A sticky note *is* its icon, so its own rect is the position; for a markup
    # mark the balloon stands for the annotation's popup window, and PDF already
    # has a field for where that sits — /Popup. Using it keeps a dragged marker in
    # the file rather than in browser storage, and other readers honor it.
    # Reported as the box's *center*, not its corner: rotating a rect maps its
    # top-left onto a different corner, so a corner does not survive the round trip
    # through a rotated page, while the center does.
    marker = None
    if kind == "note":
        marker = _rect_center(_normalize_rect(_to_visual(annot.rect, page), box))
    elif annot.has_popup:
        marker = _rect_center(_normalize_rect(_to_visual(annot.popup_rect, page), box))

    return {
        "id": annot.xref,
        "page": page_number,
        "kind": kind or subtype.lower(),
        "subtype": subtype,
        "marker": marker,
        "color": _rgb_to_hex((annot.colors or {}).get("stroke")),
        "content": info.get("content", "") or "",
        "author": info.get("title", "") or "",
        "modified": info.get("modDate", "") or "",
        "rects": rects,
        # Annotations written by other software may use subtypes this viewer
        # cannot recreate; it can still show them, but must not offer to edit them.
        "editable": bool(kind),
    }


def list_annotations(pdf_path: str) -> list[dict[str, Any]]:
    """Return every annotation in the document, in page order.

    Includes annotations written by other PDF software, which is the point of
    storing them natively.
    """
    doc = _open_document(pdf_path, for_write=False)
    try:
        result: list[dict[str, Any]] = []
        for index, page in enumerate(doc):
            for annot in page.annots():
                result.append(_describe(annot, index + 1, page))
        return result
    finally:
        doc.close()


def read_without_annotations(pdf_path: str) -> bytes:
    """Return the document's bytes with every annotation removed.

    Backs the viewer's "hide annotations" toggle. Annotations are painted into the
    page canvas by pdf.js from their appearance streams, and react-pdf hardcodes
    ``annotationMode`` to ``ENABLE``, so there is no client-side switch that can
    unpaint them. Stripping them from the bytes that are served does work, and it
    works for *every* annotation type -- including ink, stamps and polygons written
    by other software, which an overlay-based approach would silently fail to draw.

    The file on disk is never modified: the copy is built in memory and the save
    goes to a buffer.
    """
    doc = _open_document(pdf_path, for_write=False)
    try:
        for page in doc:
            # Deleting shifts the collection, so the annotations are collected
            # first and removed afterwards.
            for annot in list(page.annots()):
                page.delete_annot(annot)
        return doc.tobytes(garbage=0, deflate=True)
    finally:
        doc.close()


def _validate_content(content: Any) -> str:
    text = str(content or "")
    if len(text) > MAX_CONTENT_CHARS:
        raise PdfAnnotationError(
            f"Annotation text is too long ({len(text)} characters; the limit is {MAX_CONTENT_CHARS})."
        )
    return text


def add_annotation(
    pdf_path: str,
    *,
    page: int,
    kind: str,
    rects: Any = None,
    color: str = DEFAULT_COLOR,
    content: str = "",
    author: str = DEFAULT_AUTHOR,
) -> dict[str, Any]:
    """Write one annotation into the PDF and return it in the viewer's JSON shape.

    ``rects`` are normalized 0..1 boxes: one per line of a text selection for the
    quad kinds, and a single box whose upper-left corner anchors the icon for a note.
    """
    kind = str(kind or "").strip().lower()
    if kind not in SUPPORTED_KINDS:
        raise PdfAnnotationError(
            f"Unsupported annotation kind '{kind}'. Expected one of: {', '.join(SUPPORTED_KINDS)}."
        )

    boxes = list(rects or [])
    if not boxes:
        raise PdfAnnotationError("An annotation needs at least one rect.")

    text = _validate_content(content)
    stroke = _hex_to_rgb(color)

    doc = _open_document(pdf_path, for_write=True)
    try:
        if page < 1 or page > doc.page_count:
            raise PdfAnnotationError(
                f"Page {page} is out of range; the document has {doc.page_count} page(s)."
            )
        pdf_page = doc[page - 1]
        box = _page_rect(pdf_page)
        # Normalized -> visual points -> the unrotated space PyMuPDF writes in.
        quads = [_to_unrotated(_denormalize_rect(r, box), pdf_page) for r in boxes]

        if kind == "note":
            anchor = quads[0]
            annot = pdf_page.add_text_annot(
                (anchor.x0, anchor.y0), text, icon="Comment"
            )
        elif kind == "highlight":
            annot = pdf_page.add_highlight_annot(quads)
        elif kind == "underline":
            annot = pdf_page.add_underline_annot(quads)
        elif kind == "strikeout":
            annot = pdf_page.add_strikeout_annot(quads)
        else:  # squiggly
            annot = pdf_page.add_squiggly_annot(quads)

        annot.set_colors(stroke=stroke)
        info_kwargs: dict[str, str] = {
            "title": str(author or DEFAULT_AUTHOR),
            "content": text,
        }
        annot.set_info(**info_kwargs)
        # PyMuPDF only writes the appearance stream on update(); without it other
        # viewers -- pdf.js included -- have nothing to paint.
        annot.update()
        annot.set_flags(annot.flags | 4)  # Print: the mark survives printing/export.

        described = _describe(annot, page, pdf_page)
        _save(doc)
        return described
    finally:
        doc.close()


def _find_annot(doc, annot_id: int):
    for index, page in enumerate(doc):
        for annot in page.annots():
            if annot.xref == annot_id:
                return page, annot, index + 1
    return None, None, 0


def update_annotation(
    pdf_path: str,
    annot_id: int,
    *,
    content: str | None = None,
    color: str | None = None,
) -> dict[str, Any]:
    """Change an existing annotation's note text and/or color."""
    doc = _open_document(pdf_path, for_write=True)
    try:
        page, annot, page_number = _find_annot(doc, int(annot_id))
        if annot is None:
            raise PdfAnnotationError(f"Annotation {annot_id} was not found in this document.")

        if content is not None:
            annot.set_info(content=_validate_content(content))
        if color is not None:
            annot.set_colors(stroke=_hex_to_rgb(color))
        annot.update()

        described = _describe(annot, page_number, page)
        _save(doc)
        return described
    finally:
        doc.close()


def move_annotation_marker(pdf_path: str, annot_id: int, point: Any) -> dict[str, Any]:
    """Move the viewer's note marker for one annotation to ``point`` (0..1 page coords).

    The mark itself never moves: a highlight's quads describe which words are
    highlighted, so dragging them would silently re-target the annotation to
    different text. What moves is where the note lives — for a sticky note that is
    the annotation's own icon rect, and for a markup annotation it is the popup
    rect, which is what /Popup means in the PDF format.
    """
    pymupdf = _import_pymupdf()
    try:
        x, y = (float(v) for v in tuple(point)[:2])
    except (TypeError, ValueError) as exc:
        raise PdfAnnotationError("The marker position must be [x, y] in 0..1 page coordinates.") from exc
    x = max(0.0, min(1.0, x))
    y = max(0.0, min(1.0, y))

    doc = _open_document(pdf_path, for_write=True)
    try:
        page, annot, page_number = _find_annot(doc, int(annot_id))
        if annot is None:
            raise PdfAnnotationError(f"Annotation {annot_id} was not found in this document.")

        box = _page_rect(page)
        subtype = annot.type[1] if isinstance(annot.type, (tuple, list)) and len(annot.type) > 1 else ""
        kind = _SUBTYPE_TO_KIND.get(subtype, "")
        if not kind:
            raise PdfAnnotationError(
                f"A '{subtype}' annotation was made by other software and cannot be moved here."
            )

        # The point is the marker's center, so the box is built around it — which is
        # also what makes the position survive a rotated page unchanged.
        center_x = box.x0 + x * box.width
        center_y = box.y0 + y * box.height

        def centered(width: float, height: float):
            return pymupdf.Rect(
                center_x - width / 2, center_y - height / 2,
                center_x + width / 2, center_y + height / 2,
            )

        # The two setters disagree about coordinate space, which was measured
        # rather than assumed: `set_rect` stores what it is given, so it needs the
        # unrotated rect, while `set_popup` derotates internally and must be handed
        # the visual one. Both readers (`annot.rect`, `annot.popup_rect`) return
        # unrotated values, so `_describe` rotates on the way out either way.
        if kind == "note":
            annot.set_rect(_to_unrotated(centered(NOTE_ICON_SIZE, NOTE_ICON_SIZE), page))
        else:
            annot.set_popup(centered(POPUP_WIDTH, POPUP_HEIGHT))
        annot.update()

        described = _describe(annot, page_number, page)
        _save(doc)
        return described
    finally:
        doc.close()


def delete_annotation(pdf_path: str, annot_id: int) -> dict[str, Any]:
    """Remove one annotation from the PDF."""
    doc = _open_document(pdf_path, for_write=True)
    try:
        page, annot, page_number = _find_annot(doc, int(annot_id))
        if annot is None:
            raise PdfAnnotationError(f"Annotation {annot_id} was not found in this document.")
        page.delete_annot(annot)
        _save(doc)
        return {"id": int(annot_id), "page": page_number}
    finally:
        doc.close()
