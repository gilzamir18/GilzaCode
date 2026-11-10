from gilzacode.latex_compiler import clean_latex_artifacts


def test_clean_latex_artifacts_removes_generated_files_only(tmp_path):
    keep_files = [
        "main.tex",
        "refs.bib",
        "figure.png",
        ".gilzacode/state.aux",
    ]
    remove_files = [
        "main.aux",
        "main.toc",
        "main.log",
        "main.synctex.gz",
        "chapters/one.out",
        "chapters/one.run.xml",
    ]

    for rel_path in keep_files + remove_files:
        path = tmp_path / rel_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("content", encoding="utf-8")

    result = clean_latex_artifacts(str(tmp_path))

    assert result["success"] is True
    assert sorted(result["removed"]) == sorted(remove_files)
    for rel_path in keep_files:
        assert (tmp_path / rel_path).exists()
    for rel_path in remove_files:
        assert not (tmp_path / rel_path).exists()


def test_clean_latex_artifacts_removes_partial_preview_files(tmp_path):
    partial_files = [
        "gilzacode_partial_ch1.tex",
        "gilzacode_partial_ch1.pdf",
        "gilzacode_partial_ch1.aux",
        "gilzacode_partial_ch1.bbl",
        "gilzacode_partial_ch1.synctex.gz",
    ]
    for rel_path in partial_files:
        (tmp_path / rel_path).write_text("generated", encoding="utf-8")

    result = clean_latex_artifacts(str(tmp_path))

    assert result["success"] is True
    assert sorted(result["removed"]) == sorted(partial_files)
