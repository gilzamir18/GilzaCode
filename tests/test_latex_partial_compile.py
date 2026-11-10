import subprocess

from gilzacode import latex_compiler


def test_dependent_file_uses_guessed_root_document_for_dynamic_include(tmp_path):
    root = tmp_path / "driver_document.tex"
    fragment = tmp_path / "selected_fragment.tex"
    root.write_text(
        "\\documentclass{book}\n"
        "\\begin{document}\n"
        "\\foreach \\fragment in {intro_fragment,selected_fragment}{\\input{\\fragment}}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    fragment.write_text("\\chapter{Final chapter}\n", encoding="utf-8")

    selected = latex_compiler.determine_main_file_for_compilation(
        str(fragment),
        fragment.read_text(encoding="utf-8"),
        str(tmp_path),
        "",
    )

    assert selected == "driver_document.tex"


def test_root_document_can_receive_documentclass_from_preamble(tmp_path):
    root = tmp_path / "driver_document.tex"
    fragment = tmp_path / "selected_fragment.tex"
    root.write_text(
        "\\input{preamble}\n"
        "\\begin{document}\n"
        "\\input{selected_fragment}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    fragment.write_text("\\chapter{Tool Use}\n", encoding="utf-8")

    selected = latex_compiler.determine_main_file_for_compilation(
        str(fragment),
        fragment.read_text(encoding="utf-8"),
        str(tmp_path),
        "",
    )

    assert selected == "driver_document.tex"


def test_dependent_file_uses_nested_root_that_includes_it_when_project_main_is_missing(tmp_path):
    source_dir = tmp_path / "sources"
    source_dir.mkdir()
    main = source_dir / "root_document.tex"
    section = source_dir / "section_alpha.tex"
    main.write_text(
        "\\documentclass{book}\n"
        "\\begin{document}\n"
        "\\input{section_intro}\n"
        "\\input{section_alpha}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    (source_dir / "section_intro.tex").write_text("\\chapter{First}\n", encoding="utf-8")
    section.write_text("\\chapter{Selected}\n", encoding="utf-8")

    selected = latex_compiler.determine_main_file_for_compilation(
        str(section),
        section.read_text(encoding="utf-8"),
        str(tmp_path),
        "",
    )

    assert selected == "sources/root_document.tex"


def test_partial_compile_injects_includeonly(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapters" / "one.tex"
    chapter.parent.mkdir()
    main.write_text(
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "\\include{chapters/one}\n"
        "\\include{chapters/two}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("old", encoding="utf-8")

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        preview = tmp_path / "gilzacode_partial_one.tex"
        source = preview.read_text(encoding="utf-8")
        assert "\\includeonly{chapters/one}" in source
        (tmp_path / "gilzacode_partial_one.pdf").write_bytes(b"%PDF")
        (tmp_path / "gilzacode_partial_one.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "new content",
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert result["partial"] is True
    assert result["partial_mode"] == "includeonly"
    assert chapter.read_text(encoding="utf-8") == "new content"


def test_full_compile_preserves_crlf_without_inserting_blank_lines(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    content = "\\documentclass{article}\r\n\\begin{document}\r\nHello\r\n\\end{document}\r\n"
    main.write_bytes(content.encode("utf-8"))

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        (tmp_path / "main.pdf").write_bytes(b"%PDF")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex(
        content,
        str(main),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert main.read_bytes() == content.encode("utf-8")
    assert b"\r\r\n" not in main.read_bytes()


def test_latex_error_log_includes_undefined_command_source_context(tmp_path):
    main = tmp_path / "artigo_gomes_2025.tex"
    source = (
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "We validate the model in two 3D environments (foraging and confr\\ontation).\n"
        "\\end{document}\n"
    )
    main.write_text(source, encoding="utf-8")

    log = (
        "error: artigo_gomes_2025.tex:3: Undefined control sequence\n"
        "error: halted on potentially-recoverable error as specified\n"
    )

    enriched = latex_compiler.enrich_latex_error_log(log, str(tmp_path))

    assert "GilzaCode source context:" in enriched
    assert "confr\\ontation" in enriched
    assert "Likely undefined LaTeX command: \\ontation" in enriched


def test_full_compile_enriches_undefined_control_sequence_log(monkeypatch, tmp_path):
    main = tmp_path / "artigo_gomes_2025.tex"
    content = (
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "We validate the model in two 3D environments (foraging and confr\\ontation).\n"
        "\\end{document}\n"
    )
    main.write_text(content, encoding="utf-8")
    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        return subprocess.CompletedProcess(
            cmd,
            1,
            stdout="",
            stderr="error: artigo_gomes_2025.tex:3: Undefined control sequence\n",
        )

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex(
        content,
        str(main),
        "artigo_gomes_2025.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is False
    assert "confr\\ontation" in result["log"]
    assert "Likely undefined LaTeX command: \\ontation" in result["log"]


def test_partial_compile_reuses_main_bibliography_artifacts(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapters" / "one.tex"
    chapter.parent.mkdir()
    main.write_text(
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "\\include{chapters/one}\n"
        "\\bibliography{refs}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("\\cite{doe2020}", encoding="utf-8")
    (tmp_path / "main.aux").write_text("\\bibdata{refs}\n", encoding="utf-8")
    (tmp_path / "main.bbl").write_text("\\begin{thebibliography}{1}\\bibitem{doe2020} Doe\\end{thebibliography}", encoding="utf-8")

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        assert (tmp_path / "gilzacode_partial_one.aux").read_text(encoding="utf-8") == "\\bibdata{refs}\n"
        assert "doe2020" in (tmp_path / "gilzacode_partial_one.bbl").read_text(encoding="utf-8")
        (tmp_path / "gilzacode_partial_one.pdf").write_bytes(b"%PDF")
        (tmp_path / "gilzacode_partial_one.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "\\cite{doe2020}",
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert "gilzacode_partial_one.bbl" in result["log"]


def test_partial_compile_runs_bibtex_when_no_bbl_exists(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapters" / "one.tex"
    chapter.parent.mkdir()
    main.write_text(
        "\\documentclass{article}\n"
        "\\input{preamble/packages}\n"
        "\\begin{document}\n"
        "\\input{chapters/one}\n"
        "\\input{chapters/two}\n"
        "\\bibliography{refs}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("\\cite{doe2020}", encoding="utf-8")
    (tmp_path / "refs.bib").write_text("@article{doe2020,title={T}}\n", encoding="utf-8")

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")
    monkeypatch.setattr(latex_compiler.shutil, "which", lambda name: "bibtex" if name == "bibtex" else None)
    calls = []

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        calls.append(cmd[0])
        if cmd[0] == "tectonic":
            preview_source = (tmp_path / "gilzacode_partial_one.tex").read_text(encoding="utf-8")
            assert "\\input{preamble/packages}" in preview_source
            assert "\\input{chapters/one}" in preview_source
            assert "skipped \\input{chapters/two}" in preview_source
            (tmp_path / "gilzacode_partial_one.aux").write_text("\\bibdata{refs}\n\\citation{doe2020}\n", encoding="utf-8")
            (tmp_path / "gilzacode_partial_one.pdf").write_bytes(b"%PDF")
            (tmp_path / "gilzacode_partial_one.synctex.gz").write_bytes(b"synctex")
        elif cmd[0] == "bibtex":
            (tmp_path / "gilzacode_partial_one.bbl").write_text("\\bibitem{doe2020} Doe", encoding="utf-8")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "\\cite{doe2020}",
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert calls == ["tectonic", "bibtex", "tectonic"]


def test_partial_compile_preserves_chapter_number_for_input_chapter(monkeypatch, tmp_path):
    root = tmp_path / "driver_document.tex"
    fragment_names = ["frontmatter", "methods", "results", "discussion"]
    for index, name in enumerate(fragment_names, start=1):
        (tmp_path / f"{name}.tex").write_text(
            f"\\chapter{{Chapter {index}}}\nContent {index}\n",
            encoding="utf-8",
        )
    root.write_text(
        "\\documentclass{book}\n"
        "\\begin{document}\n"
        "\\input{frontmatter}\n"
        "\\input{methods}\n"
        "\\input{results}\n"
        "\\input{discussion}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        preview_source = (tmp_path / "gilzacode_partial_discussion.tex").read_text(encoding="utf-8")
        assert "\\setcounter{chapter}{3}\n\\input{discussion}" in preview_source
        assert "skipped \\input{frontmatter}" in preview_source
        assert "skipped \\input{methods}" in preview_source
        assert "skipped \\input{results}" in preview_source
        (tmp_path / "gilzacode_partial_discussion.pdf").write_bytes(b"%PDF")
        (tmp_path / "gilzacode_partial_discussion.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        "\\chapter{Chapter 4}\nUpdated content\n",
        str(tmp_path / "discussion.tex"),
        "driver_document.tex",
        str(tmp_path),
        include_pdf_base64=False,
    )

    assert result["success"] is True
    assert result["partial_mode"] == "input-wrapper"


def test_compile_latex_draft_mode_uses_v2_cli_flags_without_synctex_by_default(monkeypatch, tmp_path):
    root = tmp_path / "document.tex"
    root.write_text(
        "\\documentclass{article}\n\\begin{document}\nHello Draft\n\\end{document}\n",
        encoding="utf-8",
    )

    captured_cmd = []

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        nonlocal captured_cmd
        captured_cmd = cmd
        (tmp_path / "document.pdf").write_bytes(b"%PDF")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex(
        root.read_text(encoding="utf-8"),
        str(root),
        "document.tex",
        str(tmp_path),
        include_pdf_base64=False,
        draft=True,
    )

    assert result["success"] is True
    assert captured_cmd[1:3] == ["-X", "compile"]
    assert "--synctex" not in captured_cmd
    assert "-r" in captured_cmd and captured_cmd[captured_cmd.index("-r") + 1] == "0"
    assert result["compiler_debug"]["draft"] is True
    assert result["compiler_debug"]["synctex_enabled"] is False


def test_compile_latex_draft_mode_can_enable_synctex(monkeypatch, tmp_path):
    root = tmp_path / "document.tex"
    root.write_text(
        "\\documentclass{article}\n\\begin{document}\nHello Draft\n\\end{document}\n",
        encoding="utf-8",
    )

    captured_cmd = []

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        nonlocal captured_cmd
        captured_cmd = cmd
        (tmp_path / "document.pdf").write_bytes(b"%PDF")
        (tmp_path / "document.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex(
        root.read_text(encoding="utf-8"),
        str(root),
        "document.tex",
        str(tmp_path),
        include_pdf_base64=False,
        draft=True,
        synctex=True,
    )

    assert result["success"] is True
    assert captured_cmd[1:4] == ["-X", "compile", "--synctex"]
    assert result["synctex_path"].endswith("document.synctex.gz")
    assert result["compiler_debug"]["synctex_enabled"] is True


def test_compile_latex_partial_draft_mode_uses_v2_cli_flags_without_synctex_by_default(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapter1.tex"
    main.write_text(
        "\\documentclass{article}\n\\begin{document}\n\\input{chapter1}\n\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("Chapter 1 text", encoding="utf-8")

    captured_cmd = []

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        nonlocal captured_cmd
        captured_cmd = cmd
        (tmp_path / "gilzacode_partial_chapter1.pdf").write_bytes(b"%PDF")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        chapter.read_text(encoding="utf-8"),
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
        draft=True,
    )

    assert result["success"] is True
    assert captured_cmd[1:3] == ["-X", "compile"]
    assert "--synctex" not in captured_cmd
    assert "-r" in captured_cmd and captured_cmd[captured_cmd.index("-r") + 1] == "0"
    assert result["compiler_debug"]["draft"] is True
    assert result["compiler_debug"]["synctex_enabled"] is False


def test_compile_latex_partial_draft_mode_can_enable_synctex(monkeypatch, tmp_path):
    main = tmp_path / "main.tex"
    chapter = tmp_path / "chapter1.tex"
    main.write_text(
        "\\documentclass{article}\n\\begin{document}\n\\input{chapter1}\n\\end{document}\n",
        encoding="utf-8",
    )
    chapter.write_text("Chapter 1 text", encoding="utf-8")

    captured_cmd = []

    monkeypatch.setattr(latex_compiler, "get_tectonic_path", lambda: "tectonic")

    def fake_run(cmd, cwd, capture_output, encoding, errors):
        nonlocal captured_cmd
        captured_cmd = cmd
        (tmp_path / "gilzacode_partial_chapter1.pdf").write_bytes(b"%PDF")
        (tmp_path / "gilzacode_partial_chapter1.synctex.gz").write_bytes(b"synctex")
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(latex_compiler.subprocess, "run", fake_run)

    result = latex_compiler.compile_latex_partial(
        chapter.read_text(encoding="utf-8"),
        str(chapter),
        "main.tex",
        str(tmp_path),
        include_pdf_base64=False,
        draft=True,
        synctex=True,
    )

    assert result["success"] is True
    assert captured_cmd[1:4] == ["-X", "compile", "--synctex"]
    assert result["synctex_path"].endswith("gilzacode_partial_chapter1.synctex.gz")
    assert result["compiler_debug"]["synctex_enabled"] is True
