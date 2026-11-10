"""In-app installs of tectonic and pandoc go to a writable per-user directory.

They used to be written next to the package (``<site-packages>/bin``), which is
read-only in system-wide installs, so "Install Pandoc" and reinstalling Tectonic
failed with ``[Errno 30] Read-only file system``.
"""

import io
import os
import tarfile

import pytest

from gilzacode import document_exporter, external_tools, latex_compiler


@pytest.fixture
def home(monkeypatch, tmp_path):
    home = tmp_path / "gilzabots-home"
    monkeypatch.setenv("GILZACODE_HOME", str(home))
    monkeypatch.setattr(external_tools.sys, "platform", "linux")
    return home


def _tar_with(tmp_path, member_name, payload):
    archive = tmp_path / "tool.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo(member_name)
        info.size = len(payload)
        tar.addfile(info, io.BytesIO(payload))
    return archive


def test_install_goes_to_the_user_tools_dir_not_the_package(home, tmp_path):
    archive = _tar_with(tmp_path, "pandoc-3.10/bin/pandoc", b"#!/bin/sh\n")

    installed = document_exporter.install_pandoc_from_archive(str(archive))

    assert installed == str(home / "bin" / "pandoc")
    assert open(installed, "rb").read() == b"#!/bin/sh\n"
    assert os.access(installed, os.X_OK)


def test_reinstall_replaces_the_existing_binary(home, tmp_path):
    first = _tar_with(tmp_path, "tectonic", b"old")
    external_tools.install_executable_from_archive(str(first), "tectonic")
    second = _tar_with(tmp_path, "tectonic", b"new")

    installed = external_tools.install_executable_from_archive(str(second), "tectonic")

    assert open(installed, "rb").read() == b"new"
    assert sorted(os.listdir(home / "bin")) == ["tectonic"]


def test_archive_without_the_executable_is_reported(home, tmp_path):
    archive = _tar_with(tmp_path, "README", b"text")

    with pytest.raises(FileNotFoundError, match="tectonic"):
        external_tools.install_executable_from_archive(str(archive), "tectonic")
    assert not (home / "bin" / "tectonic").exists()


def test_user_installed_tool_takes_precedence(home, tmp_path, monkeypatch):
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    (bundled / "tectonic").write_text("bundled")
    (home / "bin").mkdir(parents=True)
    (home / "bin" / "tectonic").write_text("user")

    assert external_tools.find_tool("tectonic", [str(bundled)]) == str(home / "bin" / "tectonic")


def test_bundled_then_path_are_still_searched(home, tmp_path, monkeypatch):
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    (bundled / "tectonic").write_text("bundled")
    assert external_tools.find_tool("tectonic", [str(bundled)]) == str(bundled / "tectonic")

    monkeypatch.setattr(external_tools.shutil, "which", lambda name: f"/usr/bin/{name}")
    assert external_tools.find_tool("pandoc", [str(tmp_path / "missing")]) == "/usr/bin/pandoc"


def test_tectonic_and_pandoc_lookups_see_user_installs(home):
    (home / "bin").mkdir(parents=True)
    (home / "bin" / "tectonic").write_text("")
    (home / "bin" / "pandoc").write_text("")

    assert latex_compiler.get_tectonic_path() == str(home / "bin" / "tectonic")
    assert document_exporter.get_pandoc_path() == str(home / "bin" / "pandoc")
