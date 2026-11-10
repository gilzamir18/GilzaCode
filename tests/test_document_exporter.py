import os
from types import SimpleNamespace
from zipfile import ZipFile

from gilzacode import document_exporter


def test_export_tex_to_docx_invokes_pandoc_and_creates_output(monkeypatch, tmp_path):
    project = tmp_path
    tex = project / "main.tex"
    tex.write_text("\\documentclass{article}\\begin{document}Hello\\end{document}", encoding="utf-8")
    calls = []

    monkeypatch.setattr(document_exporter, "get_pandoc_path", lambda: "pandoc")

    def fake_run(cmd, cwd, capture_output, timeout, **kwargs):
        calls.append({"cmd": cmd, "cwd": cwd, "timeout": timeout, "kwargs": kwargs})
        output = cmd[cmd.index("--output") + 1]
        with open(output, "wb") as f:
            f.write(b"DOCX")
        return SimpleNamespace(returncode=0, stdout="ok", stderr="")

    monkeypatch.setattr(document_exporter.subprocess, "run", fake_run)

    result = document_exporter.export_tex_to_docx(str(project), "main.tex")

    assert result["success"] is True
    assert result["relative_output_path"] == "main.docx"
    assert os.path.exists(result["output_path"])
    assert calls[0]["cmd"][:4] == ["pandoc", str(tex), "--from=latex", "--to=docx"]
    assert calls[0]["cwd"] == str(project)


def test_export_tex_to_docx_reports_missing_pandoc(monkeypatch, tmp_path):
    (tmp_path / "main.tex").write_text("hello", encoding="utf-8")
    monkeypatch.setattr(document_exporter, "get_pandoc_path", lambda: None)

    result = document_exporter.export_tex_to_docx(str(tmp_path), "main.tex")

    assert result["success"] is False
    assert result["pandoc_found"] is False
    assert "Pandoc" in result["log"]


def test_install_pandoc_from_zip_copies_executable(monkeypatch, tmp_path):
    archive = tmp_path / "pandoc.zip"
    with ZipFile(archive, "w") as zip_file:
        zip_file.writestr("pandoc-3.10/pandoc.exe", b"fake exe")
    monkeypatch.setattr(document_exporter.sys, "platform", "win32")

    installed = document_exporter.install_pandoc_from_archive(str(archive), str(tmp_path / "bin"))

    assert os.path.basename(installed) == "pandoc.exe"
    assert os.path.exists(installed)
    assert open(installed, "rb").read() == b"fake exe"
