"""Tests for PDF-native annotations used by the standalone PDF viewer.

Covers the coordinate contract (normalized 0..1 round-trip), the create/read/
update/delete cycle, appearance-stream generation -- without it no other viewer
paints the mark -- and the fail-fast rejections that keep an unannotatable PDF
from silently appearing to work.
"""

import os

import pytest

pymupdf = pytest.importorskip("pymupdf")

from gilzacode.pdf_annotations import (  # noqa: E402
    DEFAULT_COLOR,
    MAX_CONTENT_CHARS,
    PdfAnnotationError,
    add_annotation,
    delete_annotation,
    list_annotations,
    move_annotation_marker,
    read_without_annotations,
    update_annotation,
)

PHRASE = "target phrase here"


@pytest.fixture
def sample_pdf(tmp_path):
    """A two-page PDF with a known phrase on page 1."""
    path = tmp_path / "sample.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), PHRASE, fontsize=14)
    doc.new_page()
    doc.save(str(path))
    doc.close()
    return str(path)


def _phrase_rect_normalized(pdf_path):
    """The known phrase's box, in the normalized coordinates the viewer sends."""
    doc = pymupdf.open(pdf_path)
    page = doc[0]
    box = page.rect
    hit = page.search_for(PHRASE)[0]
    norm = [
        (hit.x0 - box.x0) / box.width,
        (hit.y0 - box.y0) / box.height,
        (hit.x1 - box.x0) / box.width,
        (hit.y1 - box.y0) / box.height,
    ]
    doc.close()
    return norm, hit


# ── Coordinate contract ────────────────────────────────────────────────────

def test_normalized_rect_lands_on_the_selected_text(sample_pdf):
    """A normalized rect must come back as the same PDF box it was derived from."""
    norm, expected = _phrase_rect_normalized(sample_pdf)

    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])

    doc = pymupdf.open(sample_pdf)
    # The page must stay referenced: an Annot borrows its Page, and letting a
    # temporary doc[0] be collected leaves the annotation pointing at freed memory.
    page = doc[0]
    annot = next(a for a in page.annots() if a.xref == created["id"])
    placed = annot.rect
    doc.close()

    # MuPDF rounds the ends of a markup quad, so the stored box is the text box
    # plus a little padding. What matters is that it covers the text and has not
    # drifted somewhere else on the page.
    assert placed.x0 <= expected.x0 and placed.y0 <= expected.y0
    assert placed.x1 >= expected.x1 and placed.y1 >= expected.y1
    assert placed.x0 == pytest.approx(expected.x0, abs=8.0)
    assert placed.y0 == pytest.approx(expected.y0, abs=8.0)


def test_rects_round_trip_through_list(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])

    [listed] = list_annotations(sample_pdf)

    assert listed["rects"], "a highlight must report the box it covers"
    for got, want in zip(listed["rects"][0], norm):
        assert got == pytest.approx(want, abs=0.01)


def test_out_of_range_rect_is_clamped_not_rejected(sample_pdf):
    """Dragging a selection past the page edge is a normal gesture."""
    created = add_annotation(
        sample_pdf, page=1, kind="highlight", rects=[[-0.5, -0.2, 1.4, 1.9]]
    )
    assert created["id"]


def _painted_bbox(page, dpi=72):
    """Bounding box, in rendered pixels, of the highlight color on a page.

    The stored rect of a misplaced annotation still looks plausible, so placement
    is checked against the pixels a viewer actually paints -- which is the same
    thing pdf.js will draw from the appearance stream.
    """
    pix = page.get_pixmap(dpi=dpi)
    xs, ys = [], []
    for y in range(pix.height):
        for x in range(pix.width):
            r, g, b = pix.pixel(x, y)
            if r > 200 and g > 170 and b < 120:
                xs.append(x)
                ys.append(y)
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_mark_is_painted_in_the_requested_quadrant_on_a_rotated_page(tmp_path, rotation):
    """A rotated page is laid out rotated by the viewer, so 0..1 must follow it.

    PyMuPDF writes annotations in the page's *unrotated* space while ``page.rect``
    is rotated; without the derotation step the mark lands in the wrong quadrant.
    """
    path = tmp_path / f"rot{rotation}.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.set_rotation(rotation)
    doc.save(str(path))
    doc.close()

    # Upper-left quadrant of what the reader sees, whatever the rotation.
    add_annotation(str(path), page=1, kind="highlight", rects=[[0.0, 0.0, 0.5, 0.5]])

    doc = pymupdf.open(str(path))
    page = doc[0]
    box = page.rect
    painted = _painted_bbox(page)
    doc.close()

    assert painted is not None, "the highlight must actually paint something"
    x0, y0, x1, y1 = painted
    assert x0 <= 2 and y0 <= 2, f"mark should start at the page's upper-left, got {painted}"

    # MuPDF rounds the ends of a markup quad, and on a half-page quad that padding
    # is large, so the extent is not a sharp test. The center is: placed correctly
    # it sits near a quarter of each axis, and in any other quadrant near
    # three quarters.
    cx = (x0 + x1) / 2 / box.width
    cy = (y0 + y1) / 2 / box.height
    assert cx < 0.5, f"mark should be centered in the left half, got {cx:.2f} ({painted})"
    assert cy < 0.5, f"mark should be centered in the top half, got {cy:.2f} ({painted})"


# ── Create / read / update / delete ────────────────────────────────────────

@pytest.mark.parametrize("kind", ["highlight", "underline", "strikeout", "squiggly"])
def test_each_markup_kind_is_created_and_listed(sample_pdf, kind):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind=kind, rects=[norm])

    [listed] = list_annotations(sample_pdf)

    assert created["kind"] == kind
    assert listed["kind"] == kind
    assert listed["id"] == created["id"]
    assert listed["editable"] is True


def test_note_carries_its_text(sample_pdf):
    created = add_annotation(
        sample_pdf, page=1, kind="note", rects=[[0.5, 0.1, 0.6, 0.2]],
        content="a remark", author="gil",
    )

    [listed] = list_annotations(sample_pdf)

    assert created["kind"] == "note"
    assert listed["content"] == "a remark"
    assert listed["author"] == "gil"


def test_annotation_gets_an_appearance_stream(sample_pdf):
    """Without /AP, pdf.js and every other viewer have nothing to paint."""
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])

    doc = pymupdf.open(sample_pdf)
    kind, _value = doc.xref_get_key(created["id"], "AP")
    doc.close()

    assert kind == "dict"


def test_color_round_trips_as_hex(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], color="#3b82f6")

    [listed] = list_annotations(sample_pdf)

    assert created["color"] == "#3b82f6"
    assert listed["color"] == "#3b82f6"


def test_annotations_report_their_page(sample_pdf):
    add_annotation(sample_pdf, page=2, kind="highlight", rects=[[0.1, 0.1, 0.4, 0.2]])

    [listed] = list_annotations(sample_pdf)

    assert listed["page"] == 2


def test_update_changes_text_and_color(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])

    updated = update_annotation(sample_pdf, created["id"], content="second thought", color="#22c55e")

    [listed] = list_annotations(sample_pdf)
    assert updated["content"] == "second thought"
    assert listed["content"] == "second thought"
    assert listed["color"] == "#22c55e"


def test_delete_removes_only_the_named_annotation(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    first = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])
    second = add_annotation(sample_pdf, page=1, kind="note", rects=[[0.5, 0.5, 0.6, 0.6]])

    delete_annotation(sample_pdf, first["id"])

    remaining = list_annotations(sample_pdf)
    assert [a["id"] for a in remaining] == [second["id"]]


def test_ids_stay_valid_after_other_annotations_change(sample_pdf):
    """Incremental saves append, so an id must survive later edits."""
    norm, _ = _phrase_rect_normalized(sample_pdf)
    first = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])
    second = add_annotation(sample_pdf, page=1, kind="note", rects=[[0.5, 0.5, 0.6, 0.6]])
    delete_annotation(sample_pdf, second["id"])
    add_annotation(sample_pdf, page=1, kind="underline", rects=[norm])

    updated = update_annotation(sample_pdf, first["id"], content="still me")

    assert updated["id"] == first["id"]
    assert updated["content"] == "still me"


def test_saving_is_incremental(sample_pdf):
    """An incremental save appends, leaving the original bytes in place."""
    original = open(sample_pdf, "rb").read()
    add_annotation(sample_pdf, page=1, kind="highlight", rects=[[0.1, 0.1, 0.4, 0.2]])
    after = open(sample_pdf, "rb").read()

    assert len(after) > len(original)
    assert after.startswith(original)


def test_annotations_from_other_software_are_listed(sample_pdf):
    """Marks written elsewhere must show up -- that is the point of native storage."""
    doc = pymupdf.open(sample_pdf)
    page = doc[0]
    annot = page.add_highlight_annot(pymupdf.Rect(72, 90, 200, 106))
    annot.set_info(title="Zotero", content="from another reader")
    annot.update()
    doc.saveIncr()
    doc.close()

    [listed] = list_annotations(sample_pdf)

    assert listed["author"] == "Zotero"
    assert listed["content"] == "from another reader"
    assert listed["kind"] == "highlight"


def test_unknown_subtype_is_listed_but_not_editable(sample_pdf):
    """A subtype the viewer cannot recreate is shown, never offered for editing."""
    doc = pymupdf.open(sample_pdf)
    page = doc[0]
    annot = page.add_circle_annot(pymupdf.Rect(72, 90, 200, 106))
    annot.update()
    doc.saveIncr()
    doc.close()

    [listed] = list_annotations(sample_pdf)

    assert listed["editable"] is False


# ── Fail fast, never substitute ────────────────────────────────────────────

def test_missing_file_is_rejected(tmp_path):
    with pytest.raises(PdfAnnotationError, match="not found"):
        list_annotations(str(tmp_path / "nope.pdf"))


def test_non_pdf_is_rejected(tmp_path):
    path = tmp_path / "notes.txt"
    path.write_text("this is not a pdf", encoding="utf-8")
    with pytest.raises(PdfAnnotationError):
        list_annotations(str(path))


def test_password_protected_pdf_is_rejected(tmp_path):
    path = tmp_path / "locked.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(str(path), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="secret")
    doc.close()

    with pytest.raises(PdfAnnotationError, match="password-protected"):
        add_annotation(str(path), page=1, kind="highlight", rects=[[0.1, 0.1, 0.2, 0.2]])


def test_pdf_forbidding_annotations_is_rejected(tmp_path):
    """The refusal names the reason instead of falling back to another store."""
    path = tmp_path / "no-annot.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(
        str(path),
        encryption=pymupdf.PDF_ENCRYPT_AES_256,
        owner_pw="owner",
        permissions=pymupdf.PDF_PERM_ACCESSIBILITY | pymupdf.PDF_PERM_PRINT,
    )
    doc.close()

    with pytest.raises(PdfAnnotationError, match="does not allow annotations|password-protected"):
        add_annotation(str(path), page=1, kind="highlight", rects=[[0.1, 0.1, 0.2, 0.2]])


@pytest.mark.skipif(getattr(os, "geteuid", lambda: 1)() == 0,
                    reason="root writes read-only files anyway (the Linux release build runs as root in a container)")
def test_read_only_file_is_rejected(sample_pdf):
    os.chmod(sample_pdf, 0o444)
    try:
        with pytest.raises(PdfAnnotationError, match="read-only"):
            add_annotation(sample_pdf, page=1, kind="highlight", rects=[[0.1, 0.1, 0.2, 0.2]])
    finally:
        os.chmod(sample_pdf, 0o644)


def test_unsupported_kind_is_rejected(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="Unsupported annotation kind"):
        add_annotation(sample_pdf, page=1, kind="scribble", rects=[[0.1, 0.1, 0.2, 0.2]])


def test_missing_rects_are_rejected(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="at least one rect"):
        add_annotation(sample_pdf, page=1, kind="highlight", rects=[])


def test_page_out_of_range_is_rejected(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="out of range"):
        add_annotation(sample_pdf, page=99, kind="highlight", rects=[[0.1, 0.1, 0.2, 0.2]])


def test_invalid_color_is_rejected(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="Invalid color"):
        add_annotation(sample_pdf, page=1, kind="highlight", rects=[[0.1, 0.1, 0.2, 0.2]], color="red")


def test_overlong_content_is_rejected_not_truncated(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="too long"):
        add_annotation(
            sample_pdf, page=1, kind="note", rects=[[0.1, 0.1, 0.2, 0.2]],
            content="x" * (MAX_CONTENT_CHARS + 1),
        )


def test_unknown_id_is_rejected(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="not found in this document"):
        delete_annotation(sample_pdf, 99999)


def test_default_color_is_used_when_none_given(sample_pdf):
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[[0.1, 0.1, 0.2, 0.2]])
    assert created["color"] == DEFAULT_COLOR


# ── HTTP API ───────────────────────────────────────────────────────────────

import json  # noqa: E402
from unittest.mock import AsyncMock  # noqa: E402

from legacy_api import LegacyServer, legacy_client  # noqa: E402,F401


def _server_with_capture():
    server = LegacyServer(with_type=True)
    return server, server.responses


async def _call(server, method, path, *, query=None, data=None):
    body = json.dumps(data).encode("utf-8") if data is not None else b""
    await server.route_api(method, path, query or {}, {}, body, AsyncMock())


@pytest.fixture
def project(tmp_path):
    """A project directory holding one annotatable PDF."""
    pdf = tmp_path / "paper.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 100), PHRASE, fontsize=14)
    doc.save(str(pdf))
    doc.close()
    return str(tmp_path), "paper.pdf"


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_create_list_update_delete_round_trip(project):
    project_path, file_path = project
    server, responses = _server_with_capture()

    await _call(server, "POST", "/api/pdf/annotations", data={
        "projectPath": project_path, "filePath": file_path,
        "page": 1, "kind": "highlight", "rects": [[0.1, 0.1, 0.5, 0.13]],
        "color": "#3b82f6", "content": "note text", "author": "gil",
    })
    status, payload, _ = responses[-1]
    assert status == 200, payload
    annot_id = payload["annotation"]["id"]

    await _call(server, "GET", "/api/pdf/annotations", query={
        "projectPath": [project_path], "filePath": [file_path],
    })
    status, payload, _ = responses[-1]
    assert status == 200
    assert [a["id"] for a in payload["annotations"]] == [annot_id]
    assert payload["annotations"][0]["content"] == "note text"

    await _call(server, "POST", "/api/pdf/annotations/update", data={
        "projectPath": project_path, "filePath": file_path,
        "id": annot_id, "content": "edited",
    })
    status, payload, _ = responses[-1]
    assert status == 200
    assert payload["annotation"]["content"] == "edited"

    await _call(server, "POST", "/api/pdf/annotations/delete", data={
        "projectPath": project_path, "filePath": file_path, "id": annot_id,
    })
    status, payload, _ = responses[-1]
    assert status == 200

    await _call(server, "GET", "/api/pdf/annotations", query={
        "projectPath": [project_path], "filePath": [file_path],
    })
    _status, payload, _ = responses[-1]
    assert payload["annotations"] == []


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_rejects_path_traversal(project):
    project_path, _ = project
    server, responses = _server_with_capture()

    await _call(server, "GET", "/api/pdf/annotations", query={
        "projectPath": [project_path], "filePath": ["../../etc/passwd"],
    })

    status, payload, _ = responses[-1]
    assert status == 403
    assert "traversal" in payload["error"].lower()


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_requires_project_and_file(project):
    server, responses = _server_with_capture()

    await _call(server, "GET", "/api/pdf/annotations", query={})

    status, payload, _ = responses[-1]
    assert status == 400
    assert "required" in payload["error"]


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_reports_an_unannotatable_pdf_as_409(tmp_path):
    """A refusal the user can act on, not a generic 500 and not a silent fallback."""
    doc = pymupdf.open()
    doc.new_page()
    doc.save(str(tmp_path / "locked.pdf"), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="s")
    doc.close()
    server, responses = _server_with_capture()

    await _call(server, "POST", "/api/pdf/annotations", data={
        "projectPath": str(tmp_path), "filePath": "locked.pdf",
        "page": 1, "kind": "highlight", "rects": [[0.1, 0.1, 0.5, 0.2]],
    })

    status, payload, _ = responses[-1]
    assert status == 409
    assert "password-protected" in payload["error"]


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_reports_a_bad_kind_as_409(project):
    project_path, file_path = project
    server, responses = _server_with_capture()

    await _call(server, "POST", "/api/pdf/annotations", data={
        "projectPath": project_path, "filePath": file_path,
        "page": 1, "kind": "sparkle", "rects": [[0.1, 0.1, 0.5, 0.2]],
    })

    status, payload, _ = responses[-1]
    assert status == 409
    assert "Unsupported annotation kind" in payload["error"]


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_defaults_color_and_author_when_omitted(project):
    project_path, file_path = project
    server, responses = _server_with_capture()

    await _call(server, "POST", "/api/pdf/annotations", data={
        "projectPath": project_path, "filePath": file_path,
        "page": 1, "kind": "highlight", "rects": [[0.1, 0.1, 0.5, 0.13]],
    })

    _status, payload, _ = responses[-1]
    assert payload["annotation"]["color"] == DEFAULT_COLOR
    assert payload["annotation"]["author"]


# ── Hiding annotations (server-side strip) ─────────────────────────────────

def test_read_without_annotations_removes_every_mark(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])
    add_annotation(sample_pdf, page=1, kind="note", rects=[[0.5, 0.5, 0.6, 0.6]])

    stripped = read_without_annotations(sample_pdf)

    doc = pymupdf.open(stream=stripped, filetype="pdf")
    assert [a for page in doc for a in page.annots()] == []
    doc.close()


def test_read_without_annotations_leaves_the_file_untouched(sample_pdf):
    """Hiding is a view concern; it must never edit the document."""
    norm, _ = _phrase_rect_normalized(sample_pdf)
    add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])
    before = open(sample_pdf, "rb").read()

    read_without_annotations(sample_pdf)

    assert open(sample_pdf, "rb").read() == before
    assert len(list_annotations(sample_pdf)) == 1


def test_read_without_annotations_keeps_the_page_content(sample_pdf):
    """Only the marks go; the document itself must survive."""
    norm, _ = _phrase_rect_normalized(sample_pdf)
    add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm])

    stripped = read_without_annotations(sample_pdf)

    doc = pymupdf.open(stream=stripped, filetype="pdf")
    assert doc.page_count == 2
    assert PHRASE in doc[0].get_text()
    doc.close()


def test_read_without_annotations_drops_types_the_viewer_cannot_draw(sample_pdf):
    """Ink and stamps from other software must vanish too, or hiding is a lie."""
    doc = pymupdf.open(sample_pdf)
    page = doc[0]
    ink = page.add_ink_annot([[(72, 90), (120, 95), (160, 88)]])
    ink.update()
    doc.saveIncr()
    doc.close()

    stripped = read_without_annotations(sample_pdf)

    doc = pymupdf.open(stream=stripped, filetype="pdf")
    assert [a for page in doc for a in page.annots()] == []
    doc.close()


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_serves_a_stripped_document(project):
    project_path, file_path = project
    server, responses = _server_with_capture()
    await _call(server, "POST", "/api/pdf/annotations", data={
        "projectPath": project_path, "filePath": file_path,
        "page": 1, "kind": "highlight", "rects": [[0.1, 0.1, 0.5, 0.13]],
    })
    assert responses[-1][0] == 200

    await _call(server, "GET", "/api/pdf/annotations/document", query={
        "projectPath": [project_path], "filePath": [file_path],
    })

    status, body, content_type = responses[-1]
    assert status == 200
    assert content_type == "application/pdf"
    doc = pymupdf.open(stream=body, filetype="pdf")
    assert [a for page in doc for a in page.annots()] == []
    doc.close()


# ── Movable note marker ────────────────────────────────────────────────────

def test_markup_marker_defaults_to_unset(sample_pdf):
    """Until it is dragged, the viewer derives the marker from the mark's geometry."""
    norm, _ = _phrase_rect_normalized(sample_pdf)
    add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], content="note")

    [listed] = list_annotations(sample_pdf)

    assert listed["marker"] is None


def test_moving_a_markup_marker_stores_it_in_the_popup_rect(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], content="note")

    moved = move_annotation_marker(sample_pdf, created["id"], [0.6, 0.35])

    assert moved["marker"][0] == pytest.approx(0.6, abs=0.01)
    assert moved["marker"][1] == pytest.approx(0.35, abs=0.01)

    doc = pymupdf.open(sample_pdf)
    page = doc[0]
    annot = next(a for a in page.annots() if a.xref == created["id"])
    assert annot.has_popup, "the position belongs in the annotation's /Popup rect"
    doc.close()


def test_moving_a_marker_does_not_move_the_mark(sample_pdf):
    """A highlight's quads say which words are highlighted; dragging the balloon
    must never silently re-target the annotation to different text."""
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], content="note")
    before = list_annotations(sample_pdf)[0]["rects"]

    move_annotation_marker(sample_pdf, created["id"], [0.8, 0.8])

    after = list_annotations(sample_pdf)[0]["rects"]
    assert after == before


def test_moving_a_note_moves_its_icon(sample_pdf):
    """A sticky note *is* its icon, so the marker and the annotation are the same."""
    created = add_annotation(
        sample_pdf, page=1, kind="note", rects=[[0.1, 0.1, 0.13, 0.12]], content="n",
    )

    moved = move_annotation_marker(sample_pdf, created["id"], [0.7, 0.55])

    assert moved["marker"][0] == pytest.approx(0.7, abs=0.01)
    assert moved["marker"][1] == pytest.approx(0.55, abs=0.01)
    icon = list_annotations(sample_pdf)[0]["rects"][0]
    assert (icon[0] + icon[2]) / 2 == pytest.approx(0.7, abs=0.01)


def test_a_note_reports_its_marker_without_being_moved(sample_pdf):
    created = add_annotation(
        sample_pdf, page=1, kind="note", rects=[[0.25, 0.3, 0.28, 0.32]], content="n",
    )
    # An unmoved note reports the centre of the icon it was anchored at.
    assert created["marker"][0] == pytest.approx(0.25, abs=0.03)
    assert created["marker"][1] == pytest.approx(0.3, abs=0.03)


def test_marker_position_survives_a_reload(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], content="note")
    move_annotation_marker(sample_pdf, created["id"], [0.42, 0.62])

    [listed] = list_annotations(sample_pdf)

    assert listed["marker"][0] == pytest.approx(0.42, abs=0.01)
    assert listed["marker"][1] == pytest.approx(0.62, abs=0.01)


@pytest.mark.parametrize("rotation", [90, 270])
def test_marker_round_trips_on_a_rotated_page(tmp_path, rotation):
    """The marker crosses the wire in the viewer's rotated space, like every rect."""
    path = tmp_path / f"m{rotation}.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.set_rotation(rotation)
    doc.save(str(path))
    doc.close()
    created = add_annotation(
        str(path), page=1, kind="highlight", rects=[[0.1, 0.1, 0.4, 0.15]], content="n",
    )

    moved = move_annotation_marker(str(path), created["id"], [0.75, 0.2])

    assert moved["marker"][0] == pytest.approx(0.75, abs=0.02)
    assert moved["marker"][1] == pytest.approx(0.2, abs=0.02)
    assert list_annotations(str(path))[0]["marker"][0] == pytest.approx(0.75, abs=0.02)


def test_marker_position_is_clamped_to_the_page(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], content="note")

    moved = move_annotation_marker(sample_pdf, created["id"], [3.0, -2.0])

    assert 0.0 <= moved["marker"][0] <= 1.0
    assert 0.0 <= moved["marker"][1] <= 1.0


def test_moving_a_foreign_subtype_is_rejected(sample_pdf):
    doc = pymupdf.open(sample_pdf)
    page = doc[0]
    annot = page.add_circle_annot(pymupdf.Rect(72, 90, 200, 106))
    annot.update()
    xref = annot.xref
    doc.saveIncr()
    doc.close()

    with pytest.raises(PdfAnnotationError, match="cannot be moved here"):
        move_annotation_marker(sample_pdf, xref, [0.5, 0.5])


def test_moving_an_unknown_id_is_rejected(sample_pdf):
    with pytest.raises(PdfAnnotationError, match="not found in this document"):
        move_annotation_marker(sample_pdf, 99999, [0.5, 0.5])


def test_bad_marker_point_is_rejected(sample_pdf):
    norm, _ = _phrase_rect_normalized(sample_pdf)
    created = add_annotation(sample_pdf, page=1, kind="highlight", rects=[norm], content="note")
    with pytest.raises(PdfAnnotationError, match="0..1 page coordinates"):
        move_annotation_marker(sample_pdf, created["id"], ["left", "top"])


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_api_moves_a_marker(project):
    project_path, file_path = project
    server, responses = _server_with_capture()

    await _call(server, "POST", "/api/pdf/annotations", data={
        "projectPath": project_path, "filePath": file_path,
        "page": 1, "kind": "highlight", "rects": [[0.1, 0.1, 0.5, 0.13]], "content": "n",
    })
    annot_id = responses[-1][1]["annotation"]["id"]

    await _call(server, "POST", "/api/pdf/annotations/marker", data={
        "projectPath": project_path, "filePath": file_path,
        "id": annot_id, "point": [0.33, 0.44],
    })

    status, payload, _ = responses[-1]
    assert status == 200
    assert payload["annotation"]["marker"][0] == pytest.approx(0.33, abs=0.01)
