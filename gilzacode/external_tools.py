"""Locate and install the external command-line tools GilzaCode drives.

Tectonic and pandoc can come from three places, searched in this order:

1. ``<gilzacode home>/bin`` — what the user installed from inside the app. It is
   searched first so that reinstalling a tool actually replaces the one in use.
2. A directory shipped with the application (a source checkout's ``bin/``, a
   PyInstaller bundle).
3. ``PATH``.

Downloads are installed into (1) and never next to the package: the package
directory is read-only in system-wide installs, which is how "Install Pandoc" used to fail with ``[Errno 30]
Read-only file system`` on ``.../site-packages/bin``.
"""

import os
import shutil
import sys
import tarfile
import tempfile
import zipfile


def executable_name(tool: str) -> str:
    return f"{tool}.exe" if sys.platform == "win32" else tool


def user_tools_bin_dir() -> str:
    """Writable per-user directory that in-app tool installs go to."""
    from .paths import gilzacode_home

    return os.path.join(str(gilzacode_home()), "bin")


def find_executable_in_dir(directory: str, exe_name: str) -> str:
    if not directory or not os.path.isdir(directory):
        return ""
    direct = os.path.join(directory, exe_name)
    if os.path.isfile(direct):
        return direct
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d not in {".git", "__pycache__"}]
        if exe_name in files:
            return os.path.join(root, exe_name)
    return ""


def find_tool(tool: str, bundled_dirs: list[str] = ()) -> str | None:
    """Find ``tool`` in the user tools dir, then ``bundled_dirs``, then PATH."""
    exe_name = executable_name(tool)
    direct = os.path.join(user_tools_bin_dir(), exe_name)
    if os.path.isfile(direct):
        return direct
    for directory in bundled_dirs:
        found = find_executable_in_dir(directory, exe_name)
        if found:
            return found
    return shutil.which(tool)


def _open_archive_member(archive_path: str, exe_name: str):
    """Yield a readable stream for the first file in the archive named exe_name."""
    if archive_path.lower().endswith(".zip"):
        with zipfile.ZipFile(archive_path, "r") as zip_ref:
            for member in zip_ref.infolist():
                if member.is_dir() or os.path.basename(member.filename.replace("\\", "/")) != exe_name:
                    continue
                with zip_ref.open(member, "r") as source:
                    yield source
                return
    else:
        with tarfile.open(archive_path, "r:*") as tar_ref:
            for member in tar_ref.getmembers():
                if not member.isfile() or os.path.basename(member.name) != exe_name:
                    continue
                source = tar_ref.extractfile(member)
                if source is None:
                    continue
                with source:
                    yield source
                return
    raise FileNotFoundError(f"{exe_name} was not found inside {os.path.basename(archive_path)}")


def install_executable_from_archive(archive_path: str, exe_name: str, bin_dir: str | None = None) -> str:
    """Copy one executable out of a downloaded archive into ``bin_dir``.

    Only the named file is extracted, flattened into ``bin_dir``, so an archive
    cannot write anywhere else. The copy goes through a temporary file and
    ``os.replace``, which also works while the previous binary is running
    (writing over it in place fails with "Text file busy").
    """
    bin_dir = bin_dir or user_tools_bin_dir()
    os.makedirs(bin_dir, exist_ok=True)
    target = os.path.join(bin_dir, exe_name)
    for source in _open_archive_member(archive_path, exe_name):
        fd, tmp_path = tempfile.mkstemp(prefix=f".{exe_name}.", dir=bin_dir)
        try:
            with os.fdopen(fd, "wb") as dest:
                shutil.copyfileobj(source, dest)
            if sys.platform != "win32":
                # mkstemp creates the file 0600; an installed tool is 0755.
                os.chmod(tmp_path, 0o755)
            os.replace(tmp_path, target)
        except BaseException:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise
    return target


def managed_tool_paths() -> list[str]:
    """The executables GilzaCode itself resolves, by the lookup above.

    Taken from the same getters the compiler and the exporter call, so a shell
    started with :func:`environment_with_managed_tools` finds exactly the binary
    the IDE would run.
    """
    from .document_exporter import get_pandoc_path
    from .latex_compiler import get_tectonic_path

    return [path for path in (get_tectonic_path(), get_pandoc_path()) if path]


def environment_with_managed_tools(env=None) -> dict:
    """A copy of ``env`` whose ``PATH`` also reaches the tools GilzaCode manages.

    The in-app installs (``<gilzacode home>/bin``) and the bundled ``bin/`` are
    searched by :func:`find_tool` but are normally not on ``PATH``, so a shell
    the app starts — an agent's ``run_command``, the integrated terminal —
    could not run ``tectonic`` although the IDE compiles with it. Their
    directories are prepended, matching :func:`find_tool`'s order; entries
    already on ``PATH`` are left where they are. It is also the user's own
    environment, not a packaged build's (``subprocess_utils.host_environment``).
    """
    from .subprocess_utils import host_environment

    result = host_environment(env)
    entries = [entry for entry in result.get("PATH", "").split(os.pathsep) if entry]
    present = {os.path.normcase(os.path.abspath(entry)) for entry in entries}
    extra = []
    for path in managed_tool_paths():
        directory = os.path.dirname(os.path.abspath(path))
        key = os.path.normcase(directory)
        if key not in present:
            present.add(key)
            extra.append(directory)
    if extra:
        result["PATH"] = os.pathsep.join(extra + entries)
    return result
