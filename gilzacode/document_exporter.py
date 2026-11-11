import os
import subprocess
import sys

from .external_tools import executable_name, find_tool, install_executable_from_archive
from .subprocess_utils import host_environment, utf8_text_kwargs


PANDOC_VERSION = "3.10"


def _app_root() -> str:
    candidates = []
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            candidates.append(meipass)
        candidates.append(os.path.dirname(os.path.dirname(os.path.abspath(sys.executable))))
    candidates.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    for candidate in candidates:
        if candidate and os.path.isdir(candidate):
            return candidate
    return os.getcwd()


def _local_bin_dir() -> str:
    return os.path.join(_app_root(), "bin")


def get_pandoc_path() -> str | None:
    """Find pandoc in the user tools dir, GilzaCode's bundled bin directory, or PATH."""
    return find_tool("pandoc", [_local_bin_dir()])


def get_pandoc_download() -> tuple[str, str]:
    """Return (url, filename) for the current platform."""
    base = f"https://github.com/jgm/pandoc/releases/download/{PANDOC_VERSION}"
    if sys.platform == "win32":
        name = f"pandoc-{PANDOC_VERSION}-windows-x86_64.zip"
    elif sys.platform == "darwin":
        import platform
        arch = "arm64" if platform.machine() == "arm64" else "x86_64"
        name = f"pandoc-{PANDOC_VERSION}-{arch}-macOS.zip"
    else:
        name = f"pandoc-{PANDOC_VERSION}-linux-amd64.tar.gz"
    return f"{base}/{name}", name


def install_pandoc_from_archive(archive_path: str, bin_dir: str | None = None) -> str:
    """Install the pandoc executable from a downloaded archive into the user tools dir."""
    return install_executable_from_archive(archive_path, executable_name("pandoc"), bin_dir)


def _is_path_within(child: str, parent: str) -> bool:
    child_abs = os.path.normcase(os.path.abspath(child))
    parent_abs = os.path.normcase(os.path.abspath(parent))
    return child_abs == parent_abs or child_abs.startswith(parent_abs + os.sep)


def _resolve_project_file(project_path: str, file_path: str) -> str:
    if not project_path:
        raise ValueError("project_path is required")
    project_abs = os.path.abspath(os.path.expanduser(project_path))
    if not os.path.isdir(project_abs):
        raise ValueError("project_path is not a directory")
    full_path = os.path.abspath(file_path if os.path.isabs(file_path) else os.path.join(project_abs, file_path))
    if not _is_path_within(full_path, project_abs):
        raise ValueError("file_path must stay inside the project directory")
    return full_path


def export_tex_to_docx(project_path: str, tex_file_path: str, output_path: str = "") -> dict:
    """Convert a project .tex file to .docx using pandoc."""
    pandoc = get_pandoc_path()
    if not pandoc:
        return {
            "success": False,
            "output_path": "",
            "log": "Pandoc is not installed or not found in PATH.",
            "pandoc_found": False,
        }

    tex_abs = _resolve_project_file(project_path, tex_file_path)
    if not os.path.isfile(tex_abs):
        return {
            "success": False,
            "output_path": "",
            "log": f"TeX file not found: {tex_file_path}",
            "pandoc_found": True,
        }
    if not tex_abs.lower().endswith(".tex"):
        return {
            "success": False,
            "output_path": "",
            "log": "Only .tex files can be exported to DOCX.",
            "pandoc_found": True,
        }

    project_abs = os.path.abspath(os.path.expanduser(project_path))
    if output_path:
        out_abs = _resolve_project_file(project_abs, output_path)
    else:
        stem = os.path.splitext(os.path.basename(tex_abs))[0]
        out_abs = os.path.join(os.path.dirname(tex_abs), stem + ".docx")
    if not out_abs.lower().endswith(".docx"):
        out_abs += ".docx"
    os.makedirs(os.path.dirname(out_abs), exist_ok=True)

    resource_paths = os.pathsep.join(dict.fromkeys([os.path.dirname(tex_abs), project_abs]))
    cmd = [
        pandoc,
        tex_abs,
        "--from=latex",
        "--to=docx",
        "--output",
        out_abs,
        "--resource-path",
        resource_paths,
    ]
    result = subprocess.run(
        cmd,
        cwd=os.path.dirname(tex_abs),
        capture_output=True,
        timeout=120,
        env=host_environment(),
        **utf8_text_kwargs(),
    )
    log = (result.stdout or "") + ("\n" if result.stdout and result.stderr else "") + (result.stderr or "")
    success = result.returncode == 0 and os.path.isfile(out_abs)
    if result.returncode == 0 and not os.path.isfile(out_abs):
        log = (log + "\n" if log else "") + "Pandoc finished but did not create the DOCX file."
    return {
        "success": success,
        "output_path": out_abs if success else "",
        "relative_output_path": os.path.relpath(out_abs, project_abs).replace("\\", "/") if success else "",
        "log": log,
        "pandoc_found": True,
        "returncode": result.returncode,
    }
