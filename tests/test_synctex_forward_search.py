"""Forward search (editor line -> PDF page) over a SyncTeX file.

The cases below encode what a beamer deck actually produces: the whole body of a
frame is shipped out at ``\\end{frame}``, so a frame contributes exactly one
recorded source line no matter how many lines its body spans.
"""

import gzip

import pytest

from gilzacode.synctex_parser import find_pdf_position, select_record_line


def write_synctex(tmp_path, source_name, records):
    """Build a minimal .synctex.gz.

    `records` maps a PDF page number to the source lines recorded on it; each
    line gets one horizontal box wide enough to survive the structural-box
    filter in find_pdf_position.
    """
    lines = [
        "SyncTeX Version:1",
        f"Input:1:{tmp_path / source_name}",
        "Content:",
    ]
    for page in sorted(records):
        lines.append("{%d" % page)
        for offset, source_line in enumerate(records[page]):
            y = (100 + offset * 12) * 65536
            lines.append(f"h1,{source_line}:{72 * 65536},{y}:{400 * 65536},{10 * 65536},0")
        lines.append("}%d" % page)
    lines.append("Postamble:")

    path = tmp_path / "main.synctex.gz"
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")
    return path


@pytest.fixture
def beamer_deck(tmp_path):
    """A four-slide deck: title page, then three frames.

    Frame bodies span lines 9-15, 17-23 and 25-31, but each is recorded only
    under its ``\\end{frame}`` line.
    """
    source = tmp_path / "main.tex"
    source.write_text("% deck\n", encoding="utf-8")
    synctex = write_synctex(
        tmp_path,
        "main.tex",
        {1: [7] * 4, 2: [15] * 4, 3: [23] * 4, 4: [31] * 4},
    )
    return synctex, source


@pytest.mark.parametrize(
    "line, expected_page",
    [
        (7, 1),   # \frame{\titlepage}
        (9, 2),   # \begin{frame} of the first frame
        (10, 2),  # its first body line — used to land on the title page
        (14, 2),
        (15, 2),  # \end{frame}
        (17, 3),  # \begin{frame} of the second frame
        (18, 3),  # used to land on the first frame
        (23, 3),
        (25, 4),
        (31, 4),
    ],
)
def test_frame_body_maps_to_its_own_slide(beamer_deck, line, expected_page):
    synctex, source = beamer_deck
    result = find_pdf_position(str(synctex), str(source), line)
    assert result is not None
    assert result["page"] == expected_page


def test_line_past_the_last_record_falls_back_to_the_last_page(beamer_deck):
    synctex, source = beamer_deck
    result = find_pdf_position(str(synctex), str(source), 40)
    assert result is not None
    assert result["page"] == 4


def test_preamble_line_maps_to_the_first_recorded_page(beamer_deck):
    synctex, source = beamer_deck
    result = find_pdf_position(str(synctex), str(source), 2)
    assert result is not None
    assert result["page"] == 1


def test_overlays_resolve_to_the_first_slide_of_the_frame(tmp_path):
    """\\pause splits one frame across several pages, all recorded under the same
    line; forward search should open the first of them, not an arbitrary one."""
    source = tmp_path / "main.tex"
    source.write_text("% deck\n", encoding="utf-8")
    synctex = write_synctex(
        tmp_path,
        "main.tex",
        # Beamer ships every box on every overlay and only hides the ones not yet
        # revealed, so the overlay pages carry the same node count and tie.
        {1: [10] * 4, 2: [10] * 4, 3: [10] * 4, 4: [17] * 4},
    )

    first_frame = find_pdf_position(str(synctex), str(source), 4)
    second_frame = find_pdf_position(str(synctex), str(source), 12)

    assert first_frame["page"] == 1
    assert second_frame["page"] == 4


def test_per_line_records_still_match_exactly(tmp_path):
    """A plain article records nearly every line, so the exact match must win and
    the forward preference must never fire."""
    source = tmp_path / "main.tex"
    source.write_text("% article\n", encoding="utf-8")
    synctex = write_synctex(
        tmp_path,
        "main.tex",
        {1: [4, 5, 6, 7], 2: [11, 12, 13], 3: [16, 17, 18]},
    )

    for line, expected_page in [(4, 1), (7, 1), (11, 2), (13, 2), (16, 3), (18, 3)]:
        result = find_pdf_position(str(synctex), str(source), line)
        assert result["page"] == expected_page, line


def test_unknown_source_file_returns_none(tmp_path):
    source = tmp_path / "main.tex"
    source.write_text("% deck\n", encoding="utf-8")
    synctex = write_synctex(tmp_path, "main.tex", {1: [7]})
    assert find_pdf_position(str(synctex), str(tmp_path / "other.tex"), 7) is None


class TestSelectRecordLine:
    def test_exact_match_wins(self):
        assert select_record_line({7, 15, 23}, 15) == 15

    def test_gap_resolves_forward_not_to_the_nearest(self):
        # 10 is nearer to 7, but the material on line 10 was shipped at line 15.
        assert select_record_line({7, 15, 23}, 10) == 15

    def test_beyond_the_last_record_falls_back_to_it(self):
        assert select_record_line({7, 15, 23}, 40) == 23

    def test_before_the_first_record_uses_it(self):
        assert select_record_line({7, 15, 23}, 1) == 7

    def test_no_records_gives_none(self):
        assert select_record_line(set(), 10) is None
