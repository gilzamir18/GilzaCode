"""Inverse search (PDF click -> source line) inside a beamer ``fragile`` frame.

Beamer writes the body of every fragile frame -- the frames that hold an
``lstlisting`` or ``verbatim`` -- to ``\\jobname.vrb`` and ``\\input``s it back,
so SyncTeX records that material against the .vrb, not the .tex. Tectonic keeps
the file in memory and names it with an empty string; the endpoint joined that
empty name to the project path and Ctrl+click opened an empty editor tab.

The line layouts below are the ones Tectonic's beamer actually wrote, checked
line by line against ``--keep-intermediates`` output for each header shape.
"""

import gzip
import json
from unittest.mock import AsyncMock

import pytest

from legacy_api import LegacyServer, legacy_client  # noqa: F401
from gilzacode.synctex_parser import GeneratedSourceError, find_source_line

PREAMBLE = [
    "\\documentclass{beamer}",       # 1
    "\\usepackage{listings}",         # 2
    "\\begin{document}",              # 3
    "\\begin{frame}{Plain}",          # 4
    "hello",                          # 5
    "\\end{frame}",                   # 6
    "",                               # 7
]
BODY = [
    "\\begin{lstlisting}",
    "alpha_line",
    "  beta_line",
    "",
    "gamma_line",
    "\\end{lstlisting}",
]


def build(tmp_path, header_lines):
    """A deck whose second frame is fragile, opening with `header_lines`.

    Returns the source path, its lines and the frame's ``\\end{frame}`` line.
    """
    lines = PREAMBLE + header_lines + BODY + ["\\end{frame}", "\\end{document}"]
    source = tmp_path / "main.tex"
    source.write_text("\n".join(lines) + "\n", encoding="utf-8")
    end_line = lines.index("\\end{frame}", len(PREAMBLE)) + 1
    return source, lines, end_line


def write_synctex(tmp_path, source, end_line, vrb_records, vrb_name=""):
    """SyncTeX for `build`'s deck, its fragile frame read from a .vrb.

    `vrb_records` maps a .vrb line to the y (pt) its box is drawn at. The
    frame's ``\\end{frame}`` record sits on the same page, as in real output.
    """
    out = [
        "SyncTeX Version:1",
        f"Input:1:{source}",
        "Content:",
        "{1",
        f"h1,6:{72 * 65536},{20 * 65536}:{300 * 65536},{10 * 65536},0",
        "}1",
        f"Input:2:{vrb_name}",
        "{2",
        f"h1,{end_line}:{10 * 65536},{5 * 65536}:{0},{0},0",
    ]
    for vrb_line, y in vrb_records.items():
        out.append(f"h2,{vrb_line}:{72 * 65536},{y * 65536}:{300 * 65536},{8 * 65536},0")
    out += ["}2", "Postamble:"]
    path = tmp_path / "main.synctex.gz"
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(out) + "\n")
    return path


def resolve(synctex, y):
    return find_source_line(str(synctex), 2, 80, y)


# (header lines, .vrb line of "alpha_line") -- line 1 of the .vrb is the
# synthetic \frametitle whenever there is a title alone.
SHAPES = {
    "title_only": (["\\begin{frame}[fragile]{My Title}"], 3),
    "title_and_subtitle": (["\\begin{frame}[fragile]{My Title}{Sub}"], 3),
    "no_title": (["\\begin{frame}[fragile]", "\\frametitle{Inner}"], 3),
    "title_then_text": (["\\begin{frame}[fragile]{My Title} lead text"], 4),
    "no_title_then_text": (["\\begin{frame}[fragile] lead text"], 3),
    "title_on_next_line": (["\\begin{frame}[fragile]", "  {My Title}"], 3),
    # TeX's look-ahead after the title skips a comment line; it never reaches the .vrb.
    "comment_after_title": (["\\begin{frame}[fragile]{My Title}", "% a comment"], 3),
    "blank_after_title": (["\\begin{frame}[fragile]{My Title}", ""], 4),
    "overlay_and_options": (["\\begin{frame}<1>[fragile,t]{My Title}"], 3),
}


@pytest.mark.parametrize("vrb_name", ["", "main.vrb"], ids=["tectonic", "pdftex"])
@pytest.mark.parametrize("shape", sorted(SHAPES))
def test_a_click_in_a_fragile_frame_opens_the_listing_line(tmp_path, shape, vrb_name):
    header, alpha_vrb = SHAPES[shape]
    source, lines, end_line = build(tmp_path, header)
    synctex = write_synctex(
        tmp_path, source, end_line,
        {alpha_vrb: 40, alpha_vrb + 1: 50, alpha_vrb + 3: 60},
        vrb_name=vrb_name,
    )

    for y, text in ((40, "alpha_line"), (50, "  beta_line"), (60, "gamma_line")):
        result = resolve(synctex, y)
        assert result["file"] == str(source)
        assert lines[result["line"] - 1] == text


def test_the_synthetic_title_line_maps_to_the_frame_header(tmp_path):
    source, lines, end_line = build(tmp_path, ["\\begin{frame}[fragile]{My Title}"])
    synctex = write_synctex(tmp_path, source, end_line, {1: 30})

    assert lines[resolve(synctex, 30)["line"] - 1] == "\\begin{frame}[fragile]{My Title}"


def test_an_unnamed_input_outside_any_fragile_frame_is_reported(tmp_path):
    source, _lines, _end = build(tmp_path, ["\\begin{frame}[fragile]{My Title}"])
    # No record on the page points at the fragile frame's \end{frame}.
    synctex = write_synctex(tmp_path, source, 5, {3: 40})

    with pytest.raises(GeneratedSourceError):
        resolve(synctex, 40)


def test_fragile_singleslide_does_not_count_as_a_vrb_frame(tmp_path):
    source, _lines, end_line = build(tmp_path, ["\\begin{frame}[fragile=singleslide]{My Title}"])
    synctex = write_synctex(tmp_path, source, end_line, {3: 40})

    with pytest.raises(GeneratedSourceError):
        resolve(synctex, 40)


def _server():
    server = LegacyServer(with_type=False)
    return server, server.responses


async def _pdf2tex(server, project_path, file_path, y):
    query = {
        "action": ["pdf2tex"],
        "page": ["2"],
        "x": ["80"],
        "y": [str(y)],
        "filePath": [file_path],
        "projectPath": [str(project_path)],
    }
    await server.route_api("GET", "/api/latex/synctex", query, {}, b"", AsyncMock())


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_endpoint_navigates_into_the_frame_source(tmp_path):
    source, lines, end_line = build(tmp_path, ["\\begin{frame}[fragile]{My Title}"])
    write_synctex(tmp_path, source, end_line, {3: 40})
    server, responses = _server()
    server.last_synctex_path = ""

    await _pdf2tex(server, tmp_path, "main.tex", 40)

    status, body = responses[-1]
    assert status == 200
    assert body["result"]["relFile"] == "main.tex"
    assert lines[body["result"]["line"] - 1] == "alpha_line"


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_endpoint_reports_generated_material_it_cannot_trace(tmp_path):
    source, _lines, _end = build(tmp_path, ["\\begin{frame}[fragile]{My Title}"])
    write_synctex(tmp_path, source, 5, {3: 40})
    server, responses = _server()
    server.last_synctex_path = ""

    await _pdf2tex(server, tmp_path, "main.tex", 40)

    status, body = responses[-1]
    assert status == 404
    assert "result" not in body


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_endpoint_never_returns_a_file_that_does_not_exist(tmp_path):
    (tmp_path / "main.tex").write_text("\\documentclass{article}\n", encoding="utf-8")
    with gzip.open(tmp_path / "main.synctex.gz", "wt", encoding="utf-8") as handle:
        handle.write("\n".join([
            "SyncTeX Version:1",
            f"Input:1:{tmp_path / 'gone.tex'}",
            "Content:",
            "{2",
            f"h1,3:{72 * 65536},{40 * 65536}:{300 * 65536},{8 * 65536},0",
            "}2",
            "Postamble:",
        ]) + "\n")
    server, responses = _server()
    server.last_synctex_path = ""

    await _pdf2tex(server, tmp_path, "main.tex", 40)

    status, body = responses[-1]
    assert status == 404
    assert "gone.tex" in body["error"]
