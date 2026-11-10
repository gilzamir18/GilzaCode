import os

import pytest

from gilzacode import latex_compiler


# Resolved at import, from the real data folder: every test then runs with an
# isolated GILZACODE_HOME (conftest), where an in-app install is not visible.
TECTONIC = latex_compiler.get_tectonic_path()


@pytest.mark.skipif(not TECTONIC, reason="Tectonic is not installed")
def test_real_tectonic_total_and_partial_from_input_chapter(tmp_path, monkeypatch):
    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: TECTONIC)
    source_dir = tmp_path / "sources"
    source_dir.mkdir()
    main = source_dir / "root_document.tex"
    section_intro = source_dir / "section_intro.tex"
    section_alpha = source_dir / "section_alpha.tex"

    main.write_text(
        "\\documentclass{book}\n"
        "\\begin{document}\n"
        "\\input{section_intro}\n"
        "\\input{section_alpha}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    section_intro.write_text("\\chapter{First}\nFirst chapter.\n", encoding="utf-8")
    section_alpha.write_text("\\chapter{Selected}\nOriginal content.\n", encoding="utf-8")

    total = latex_compiler.compile_latex(
        "\\chapter{Selected}\nUpdated content.\n",
        str(section_alpha),
        "sources/root_document.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )
    assert total["success"], total["log"]
    assert os.path.basename(total["pdf_path"]) == "root_document.pdf"
    assert not (source_dir / "section_alpha.pdf").exists()

    partial = latex_compiler.compile_latex_partial(
        section_alpha.read_text(encoding="utf-8"),
        str(section_alpha),
        "sources/root_document.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )
    assert partial["success"], partial["log"]
    assert partial["partial_mode"] == "input-wrapper"
    assert os.path.basename(partial["pdf_path"]) == "gilzacode_partial_section_alpha.pdf"
    assert not (source_dir / "section_alpha.pdf").exists()

    wrapper = (source_dir / "gilzacode_partial_section_alpha.tex").read_text(encoding="utf-8")
    assert "% GilzaCode partial compile skipped \\input{section_intro}" in wrapper
    assert "\\input{section_alpha}" in wrapper
