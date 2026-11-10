"""Inverse search (PDF click -> source line) for a PDF opened on its own.

A standalone PDF is linked to LaTeX source only through its own companion
SyncTeX file. It must never be mapped through the project's main document or
the last compile, which is how Ctrl+click on an unrelated PDF used to open an
empty editor tab.
"""

import gzip
import json
from unittest.mock import AsyncMock

import pytest

from legacy_api import LegacyServer, legacy_client  # noqa: F401
from gilzacode.synctex_parser import companion_synctex_path


def write_synctex(path, source_path, source_line=7):
    lines = [
        "SyncTeX Version:1",
        f"Input:1:{source_path}",
        "Content:",
        "{1",
        f"h1,{source_line}:{72 * 65536},{100 * 65536}:{400 * 65536},{10 * 65536},0",
        "}1",
        "Postamble:",
    ]
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def _server_with_capture():
    server = LegacyServer(with_type=False)
    return server, server.responses


async def _pdf2tex(server, project_path, file_path):
    query = {
        "action": ["pdf2tex"],
        "page": ["1"],
        "x": ["72"],
        "y": ["100"],
        "filePath": [file_path],
        "projectPath": [str(project_path)],
    }
    await server.route_api("GET", "/api/latex/synctex", query, {}, b"", AsyncMock())


@pytest.fixture
def project(tmp_path):
    """A compiled main document plus an unrelated PDF with no source."""
    main_tex = tmp_path / "main.tex"
    main_tex.write_text("\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n", encoding="utf-8")
    (tmp_path / "main.pdf").write_bytes(b"%PDF-1.4\n")
    write_synctex(tmp_path / "main.synctex.gz", main_tex)
    (tmp_path / "unrelated.pdf").write_bytes(b"%PDF-1.4\n")
    return tmp_path


def test_companion_synctex_path(project):
    assert companion_synctex_path(str(project / "main.pdf")) == str(project / "main.synctex.gz")
    assert companion_synctex_path(str(project / "unrelated.pdf")) == ""


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_unlinked_pdf_does_not_resolve_through_other_documents(project):
    server, responses = _server_with_capture()
    # Even a remembered compile must not leak into an unrelated PDF.
    server.last_synctex_path = str(project / "main.synctex.gz")

    await _pdf2tex(server, project, "unrelated.pdf")

    status, payload = responses[-1]
    assert status == 404
    assert "result" not in payload


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_linked_pdf_resolves_to_its_source(project):
    server, responses = _server_with_capture()

    await _pdf2tex(server, project, "main.pdf")

    status, payload = responses[-1]
    assert status == 200
    assert payload["result"]["relFile"] == "main.tex"
    assert payload["result"]["line"] == 7


@pytest.mark.usefixtures('legacy_client')
@pytest.mark.asyncio
async def test_linked_pdf_with_missing_source_reports_error(tmp_path):
    # A SyncTeX file written on another machine names sources that do not
    # exist here; opening that path would show an empty editor tab.
    (tmp_path / "deck.pdf").write_bytes(b"%PDF-1.4\n")
    write_synctex(tmp_path / "deck.synctex.gz", "C:\\Users\\someone\\deck.tex")
    server, responses = _server_with_capture()

    await _pdf2tex(server, tmp_path, "deck.pdf")

    status, payload = responses[-1]
    assert status == 404
    assert "source file not found" in payload["error"]
