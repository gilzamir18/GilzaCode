import os
import sys
import subprocess
import tempfile
import shutil
import base64
import time
import hashlib
import json

def get_tectonic_path():
    """Find tectonic in the user tools dir, the project bin directory, or PATH."""
    from .external_tools import find_tool

    return find_tool("tectonic", [os.path.join(os.path.dirname(os.path.dirname(__file__)), "bin")])

import re

from .subprocess_utils import host_environment


LATEX_ERROR_LOCATION_RE = re.compile(
    r'(?im)^error:\s+(.+?\.tex):(\d+):\s+(.+?)\s*$'
)


def _read_source_line_for_latex_error(error_file: str, line_number: int, project_dir: str) -> tuple[str, str]:
    """Return the resolved path and source line for a compiler error location."""
    if not error_file or line_number < 1:
        return "", ""

    candidates = []
    if os.path.isabs(error_file):
        candidates.append(error_file)
    if project_dir:
        candidates.append(os.path.join(project_dir, error_file))
    candidates.append(error_file)

    for candidate in candidates:
        try:
            path = os.path.abspath(candidate)
            with open(path, "r", encoding="utf-8", errors="replace") as source:
                for current_line, text in enumerate(source, start=1):
                    if current_line == line_number:
                        return path, text.rstrip("\r\n")
        except OSError:
            continue

    return "", ""


def _find_suspicious_control_sequence(source_line: str) -> tuple[str, int]:
    """Pick the most likely undefined command from a source line."""
    commands = list(re.finditer(r'\\[A-Za-z]+|\\.', source_line or ""))
    if not commands:
        return "", -1

    mid_word = [
        match for match in commands
        if match.start() > 0 and source_line[match.start() - 1].isalnum()
    ]
    if mid_word:
        match = mid_word[0]
        return match.group(0), match.start()

    preferred = [match for match in commands if len(match.group(0)) > 2]
    match = preferred[0] if preferred else commands[0]
    return match.group(0), match.start()


def enrich_latex_error_log(log: str, project_dir: str = "") -> str:
    """Add source context to terse Tectonic LaTeX error messages."""
    if not log or "Undefined control sequence" not in log:
        return log

    additions = []
    seen = set()
    for match in LATEX_ERROR_LOCATION_RE.finditer(log):
        error_file, line_text, message = match.groups()
        if "Undefined control sequence" not in message:
            continue

        line_number = int(line_text)
        key = (error_file, line_number)
        if key in seen:
            continue
        seen.add(key)

        resolved_path, source_line = _read_source_line_for_latex_error(error_file, line_number, project_dir)
        if not source_line:
            continue

        command, column = _find_suspicious_control_sequence(source_line)
        pointer = ""
        if column >= 0:
            pointer = "\n" + (" " * column) + ("^" * max(1, len(command)))

        location = error_file
        if resolved_path and project_dir:
            try:
                location = os.path.relpath(resolved_path, project_dir).replace("\\", "/")
            except ValueError:
                location = resolved_path

        additions.append(
            "GilzaCode source context:\n"
            f"{location}:{line_number}: {source_line}{pointer}\n"
            f"Likely undefined LaTeX command: {command or '(unknown)'}"
        )

    if not additions:
        return log

    return log.rstrip() + "\n\n" + "\n\n".join(additions) + "\n"

def is_independent(content: str) -> bool:
    """Check if content is a compilable root document rather than a fragment."""
    if not content: return False
    content_no_comments = re.sub(r'%.*', '', content)
    return "\\documentclass" in content_no_comments or "\\begin{document}" in content_no_comments

def get_includes(content: str) -> set:
    """Extract all included/inputted filenames from the content."""
    if not content: return set()
    content_no_comments = re.sub(r'%.*', '', content)
    matches = re.findall(r'\\(?:input|include|subfile)\s*\{([^}]+)\}', content_no_comments)
    return set(matches)

def is_recursively_included(main_file_path: str, target_file_path: str, project_dir: str, visited=None) -> bool:
    """Check if target_file_path is included in main_file_path directly or indirectly."""
    if visited is None:
        visited = set()
    
    if main_file_path in visited:
        return False
    visited.add(main_file_path)

    if not os.path.exists(main_file_path):
        return False

    try:
        with open(main_file_path, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        return False

    includes = get_includes(content)
    target_basename = os.path.basename(target_file_path)
    target_no_ext = os.path.splitext(target_basename)[0]

    for inc in includes:
        inc_basename = os.path.basename(inc)
        inc_no_ext = os.path.splitext(inc_basename)[0]
        
        # Direct match
        if inc_basename == target_basename or inc_no_ext == target_no_ext:
            return True
            
        # Recursive match
        possible_paths = [
            os.path.join(project_dir, inc),
            os.path.join(project_dir, inc + '.tex'),
            os.path.join(os.path.dirname(main_file_path), inc),
            os.path.join(os.path.dirname(main_file_path), inc + '.tex')
        ]
        
        for p in possible_paths:
            if os.path.exists(p) and os.path.isfile(p):
                if is_recursively_included(p, target_file_path, project_dir, visited):
                    return True

    return False

def determine_main_file_for_compilation(file_path: str, file_content: str, project_dir: str, project_main_file: str) -> str:
    """
    Determine which file should be compiled based on whether it is dependent/independent
    and whether it is included in a main file.
    Returns a path relative to project_dir.
    """
    if not file_path:
        return project_main_file

    # Use relative path from project_dir so subdirectory files are found correctly
    try:
        file_rel_path = os.path.relpath(file_path, project_dir).replace('\\', '/')
    except ValueError:
        # On Windows, relpath fails when paths are on different drives
        file_rel_path = os.path.basename(file_path)
    
    # 1. Independent files compile themselves (have \documentclass)
    if is_independent(file_content):
        return file_rel_path

    # 2. If it's dependent, check if it's included in the project's designated main file
    if project_main_file and project_dir:
        main_full_path = os.path.join(project_dir, project_main_file)
        if os.path.exists(main_full_path):
            if file_rel_path == project_main_file:
                return project_main_file
            if is_recursively_included(main_full_path, file_path, project_dir):
                return project_main_file

    # 3. If not in project_main_file, check other independent files in the project
    if project_dir and os.path.isdir(project_dir):
        try:
            for f_path in _iter_tex_files(project_dir):
                rel = os.path.relpath(f_path, project_dir).replace("\\", "/")
                if rel == project_main_file:
                    continue
                try:
                    with open(f_path, "r", encoding="utf-8", errors="ignore") as file:
                        content = file.read()
                except Exception:
                    continue
                if is_independent(content) and is_recursively_included(f_path, file_path, project_dir):
                    return rel
        except Exception:
            pass

    # 4. A dependent file must not be compiled as a standalone document. When
    # inclusion is dynamic (for example, generated by a loop/macro), the static
    # include scan above cannot prove the relationship. Prefer an available
    # project root document over compiling a chapter without its preamble.
    if project_main_file:
        return project_main_file
    guessed_main = guess_main_file(project_dir)
    return guessed_main if guessed_main else file_rel_path


def _iter_tex_files(project_dir: str):
    ignored_dirs = {".git", ".gilzacode", "node_modules", "__pycache__", ".venv"}
    for root, dirs, files in os.walk(project_dir):
        dirs[:] = [d for d in dirs if d not in ignored_dirs]
        for name in sorted(files):
            if name.lower().endswith(".tex"):
                yield os.path.join(root, name)


def guess_main_file(project_dir: str) -> str:
    """Guess the main LaTeX file by looking for a root document marker."""
    if not project_dir or not os.path.isdir(project_dir):
        return ""
    try:
        root_candidates = []
        for path in _iter_tex_files(project_dir):
            with open(path, "r", encoding="utf-8", errors="ignore") as file:
                if is_independent(file.read()):
                    rel = os.path.relpath(path, project_dir).replace("\\", "/")
                    root_candidates.append((rel.count("/"), rel.lower(), rel))
        if root_candidates:
            root_candidates.sort()
            return root_candidates[0][2]
    except Exception:
        pass
    return ""


def find_pdf_source_tex(project_dir: str, pdf_path: str) -> str:
    """Return the project-relative .tex file that compiles to ``pdf_path``.

    Compilation writes ``name.pdf`` next to ``name.tex``, so the source of a PDF
    is the root document with the same stem in the same directory. Returns ""
    when there is no such file, when it is a fragment that cannot be compiled on
    its own, or when either path falls outside the project.
    """
    if not project_dir or not pdf_path or not os.path.isdir(project_dir):
        return ""
    project_root = os.path.abspath(project_dir)
    abs_pdf = os.path.abspath(os.path.join(project_root, pdf_path))
    stem, ext = os.path.splitext(abs_pdf)
    if ext.lower() != ".pdf":
        return ""
    abs_tex = stem + ".tex"
    try:
        if os.path.commonpath([abs_tex, project_root]) != project_root:
            return ""
    except ValueError:
        return ""
    if not os.path.isfile(abs_tex):
        return ""
    try:
        with open(abs_tex, "r", encoding="utf-8", errors="ignore") as file:
            if not is_independent(file.read()):
                return ""
    except OSError:
        return ""
    return os.path.relpath(abs_tex, project_root).replace("\\", "/")


LATEX_ARTIFACT_EXTENSIONS = {
    ".aux", ".bbl", ".bcf", ".blg", ".dvi", ".fdb_latexmk", ".fls",
    ".idx", ".ilg", ".ind", ".lof", ".log", ".lot", ".nav", ".out",
    ".snm", ".toc", ".vrb", ".xdv",
}

LATEX_ARTIFACT_SUFFIXES = {
    ".synctex.gz",
    ".run.xml",
    ".fdb_latexmk",
}


def clean_latex_artifacts(project_dir: str) -> dict:
    """Remove generated LaTeX artifacts inside the project tree."""
    if not project_dir or not os.path.isdir(project_dir):
        return {"success": False, "removed": [], "errors": ["project_dir is not a directory"]}

    project_abs = os.path.abspath(project_dir)
    ignored_dirs = {".git", ".gilzacode", "node_modules", "__pycache__"}
    removed = []
    errors = []

    for root, dirs, files in os.walk(project_abs):
        dirs[:] = [d for d in dirs if d not in ignored_dirs]
        for name in files:
            lower_name = name.lower()
            _, ext = os.path.splitext(lower_name)
            is_artifact = (
                ext in LATEX_ARTIFACT_EXTENSIONS
                or any(lower_name.endswith(suffix) for suffix in LATEX_ARTIFACT_SUFFIXES)
                or lower_name.startswith("gilzacode_partial_")
            )
            if not is_artifact:
                continue

            full_path = os.path.abspath(os.path.join(root, name))
            if full_path != project_abs and not full_path.startswith(project_abs + os.sep):
                continue
            try:
                os.remove(full_path)
                removed.append(os.path.relpath(full_path, project_abs).replace("\\", "/"))
            except OSError as e:
                errors.append(f"{os.path.relpath(full_path, project_abs)}: {e}")

    return {"success": len(errors) == 0, "removed": removed, "errors": errors}


def _strip_tex_extension(path: str) -> str:
    normalized = (path or "").replace("\\", "/").strip()
    if normalized.lower().endswith(".tex"):
        normalized = normalized[:-4]
    return normalized.strip("/")


def _same_tex_target(left: str, right: str) -> bool:
    return _strip_tex_extension(left).lower() == _strip_tex_extension(right).lower()


def _find_include_command_for_file(main_content: str, target_rel_from_main: str):
    source = _strip_latex_comments(main_content)
    for command in ("include", "input"):
        pattern = re.compile(r'\\' + command + r'\s*\{([^}]+)\}')
        for match in pattern.finditer(source):
            arg = match.group(1).strip()
            if _same_tex_target(arg, target_rel_from_main):
                return command, arg
    return "", ""


def _copy_partial_shared_artifacts(main_dir: str, main_file: str, preview_stem: str) -> list:
    """Copy main-job auxiliary files so partial previews can resolve refs/citations."""
    main_stem = os.path.splitext(os.path.basename(main_file))[0]
    copied = []
    for suffix in (".aux", ".bbl", ".bcf", ".run.xml", ".toc", ".lof", ".lot", ".out"):
        source = os.path.join(main_dir, main_stem + suffix)
        target = os.path.join(main_dir, preview_stem + suffix)
        if not os.path.exists(source):
            continue
        try:
            shutil.copy2(source, target)
            copied.append(os.path.basename(target))
        except OSError:
            pass
    return copied


def _has_bibliography_markers(content: str) -> bool:
    source = _strip_latex_comments(content)
    return bool(re.search(r'\\(?:cite\w*|bibliography|addbibresource|printbibliography)\b', source))


def _run_bibliography_tool_if_needed(main_dir: str, preview_stem: str, preview_content: str,
                                     copied_artifacts: list) -> dict:
    """Run biber/bibtex for a partial preview when inherited .bbl data is absent."""
    preview_bbl = os.path.join(main_dir, preview_stem + ".bbl")
    if os.path.exists(preview_bbl) or f"{preview_stem}.bbl" in copied_artifacts:
        return {"ran": False, "log": ""}
    if not _has_bibliography_markers(preview_content):
        return {"ran": False, "log": ""}

    preview_bcf = os.path.join(main_dir, preview_stem + ".bcf")
    preview_aux = os.path.join(main_dir, preview_stem + ".aux")
    if os.path.exists(preview_bcf):
        tool = shutil.which("biber")
    elif os.path.exists(preview_aux):
        tool = shutil.which("bibtex")
    else:
        tool = None

    if not tool:
        return {
            "ran": False,
            "log": "\nWarning: citations detected, but neither biber nor bibtex is available for partial bibliography generation.",
        }

    result = subprocess.run(
        [tool, preview_stem],
        cwd=main_dir,
        capture_output=True,
        env=host_environment(),
        encoding="utf-8",
        errors="replace",
    )
    return {
        "ran": result.returncode == 0,
        "log": "\n" + result.stdout + "\n" + result.stderr,
    }


def _resolve_tex_include_path(base_dir: str, arg: str) -> str:
    normalized = (arg or "").replace("\\", os.sep)
    candidates = [
        os.path.join(base_dir, normalized),
        os.path.join(base_dir, normalized + ".tex"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return ""


def _count_numbered_chapters(source: str) -> int:
    text = _strip_latex_comments(source)
    return len(re.findall(r'\\chapter\s*(?!\*)', text))


def _count_chapters_before_target(main_content: str, main_dir: str, target_command: str, target_arg: str) -> int:
    pattern = re.compile(r'\\(include|input)\s*\{([^}]+)\}')
    begin_doc = main_content.find("\\begin{document}")
    if begin_doc < 0:
        return 0

    body = main_content[begin_doc:]
    count = 0
    cursor = 0
    for match in pattern.finditer(body):
        count += _count_numbered_chapters(body[cursor:match.start()])
        command = match.group(1)
        arg = match.group(2).strip()
        if command == target_command and _same_tex_target(arg, target_arg):
            return count

        included_path = _resolve_tex_include_path(main_dir, arg)
        if included_path:
            try:
                with open(included_path, "r", encoding="utf-8", errors="ignore") as f:
                    count += _count_numbered_chapters(f.read())
            except OSError:
                pass
        cursor = match.end()
    return 0


def _disable_non_target_direct_includes(main_content: str, main_dir: str, target_command: str, target_arg: str) -> str:
    """Keep the main document shell while skipping direct siblings of an input target."""
    pattern = re.compile(r'\\(include|input)\s*\{([^}]+)\}')
    begin_doc = main_content.find("\\begin{document}")
    if begin_doc < 0:
        return main_content
    chapter_count = _count_chapters_before_target(main_content, main_dir, target_command, target_arg)

    def replace(match):
        command = match.group(1)
        arg = match.group(2).strip()
        if command == target_command and _same_tex_target(arg, target_arg):
            if chapter_count > 0:
                return f"\\setcounter{{chapter}}{{{chapter_count}}}\n" + match.group(0)
            return match.group(0)
        return f"% GilzaCode partial compile skipped \\{command}{{{arg}}}"

    return main_content[:begin_doc] + pattern.sub(replace, main_content[begin_doc:])


def compile_latex_partial(tex_content: str, file_path: str, main_file: str, project_dir: str,
                          include_pdf_base64: bool = True, draft: bool = False,
                          synctex: bool | None = None) -> dict:
    """
    Compile only the current included/input file while preserving SyncTeX.

    This is an editing-time preview path. If the current file is the main file
    or cannot be matched as an \\include/\\input target, it returns a clear
    failure so callers can fall back to full compilation.
    """
    synctex_enabled = (not draft) if synctex is None else bool(synctex)
    if not file_path or not main_file or not project_dir:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": "Partial compile requires file_path, main_file, and project_dir.",
            "partial": True,
        }

    project_abs = os.path.abspath(project_dir)
    abs_file = os.path.abspath(file_path)
    abs_main = os.path.abspath(os.path.join(project_abs, main_file))
    main_dir = os.path.dirname(abs_main)

    if os.path.normcase(abs_file) == os.path.normcase(abs_main):
        result = compile_latex(tex_content, file_path, main_file, project_dir, include_pdf_base64, draft=draft, synctex=synctex_enabled)
        result["partial"] = False
        result["partial_mode"] = "main"
        return result

    try:
        os.makedirs(os.path.dirname(abs_file), exist_ok=True)
        with open(abs_file, "w", encoding="utf-8", newline="") as f:
            f.write(tex_content)
    except Exception:
        pass

    try:
        with open(abs_main, "r", encoding="utf-8", errors="ignore") as f:
            main_content = f.read()
    except OSError as e:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": f"Could not read main file for partial compile: {e}",
            "partial": True,
        }

    target_rel_from_main = os.path.relpath(abs_file, main_dir).replace("\\", "/")
    command, include_arg = _find_include_command_for_file(main_content, target_rel_from_main)
    if not command:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": "Current file was not found as a direct \\include or \\input in the main file.",
            "partial": True,
        }

    begin_doc = main_content.find("\\begin{document}")
    if begin_doc < 0:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": "Main file has no \\begin{document}; partial compile cannot build a wrapper.",
            "partial": True,
        }

    if command == "include":
        preview_content = (
            main_content[:begin_doc]
            + f"\n\\includeonly{{{_strip_tex_extension(include_arg)}}}\n"
            + main_content[begin_doc:]
        )
        partial_mode = "includeonly"
    else:
        preview_content = _disable_non_target_direct_includes(main_content, main_dir, command, include_arg)
        partial_mode = "input-wrapper"

    tectonic_cmd = get_tectonic_path()
    preview_stem = f"gilzacode_partial_{os.path.splitext(os.path.basename(abs_file))[0]}"
    preview_tex = os.path.join(main_dir, preview_stem + ".tex")
    preview_pdf = os.path.join(main_dir, preview_stem + ".pdf")
    preview_synctex = os.path.join(main_dir, preview_stem + ".synctex.gz")

    try:
        with open(preview_tex, "w", encoding="utf-8", newline="") as f:
            f.write(preview_content)

        copied_artifacts = _copy_partial_shared_artifacts(main_dir, main_file, preview_stem)

        if draft:
            tectonic_args = [
                tectonic_cmd,
                "-X",
                "compile",
                "--keep-intermediates",
                "--keep-logs",
                "-r",
                "0",
                preview_tex,
            ]
        else:
            tectonic_args = [
                tectonic_cmd,
                "--keep-intermediates",
                "--keep-logs",
                "-c",
                "minimal",
                preview_tex,
            ]
        if synctex_enabled:
            tectonic_args.insert(3 if draft else 1, "--synctex")

        def run_tectonic():
            return subprocess.run(
                tectonic_args,
                cwd=main_dir,
                capture_output=True,
                env=host_environment(),
                encoding="utf-8",
                errors="replace",
            )

        compile_started = time.perf_counter()
        result = run_tectonic()
        log = result.stdout + "\n" + result.stderr
        bib_result = _run_bibliography_tool_if_needed(main_dir, preview_stem, preview_content, copied_artifacts)
        if bib_result["log"]:
            log += bib_result["log"]
        if bib_result["ran"]:
            rerun = run_tectonic()
            result = rerun
            log += "\n" + rerun.stdout + "\n" + rerun.stderr
        compile_seconds = time.perf_counter() - compile_started
        success = result.returncode == 0 and os.path.exists(preview_pdf)
        if copied_artifacts:
            log += "\nPartial compile reused auxiliary artifacts: " + ", ".join(copied_artifacts)
        if result.returncode == 0 and not os.path.exists(preview_pdf):
            log += "\nError: PDF file was not generated despite 0 exit code."
        if not success:
            log = enrich_latex_error_log(log, main_dir)

        pdf_base64 = None
        pdf_read_seconds = 0.0
        if success and include_pdf_base64:
            pdf_read_started = time.perf_counter()
            with open(preview_pdf, "rb") as pdf_file:
                pdf_base64 = base64.b64encode(pdf_file.read()).decode("utf-8")
            pdf_read_seconds = time.perf_counter() - pdf_read_started

        return {
            "success": success,
            "pdf_base64": pdf_base64,
            "pdf_path": preview_pdf if success else "",
            "synctex_path": preview_synctex if success and os.path.exists(preview_synctex) else "",
            "timing": {
                "compile_seconds": round(compile_seconds, 3),
                "pdf_read_seconds": round(pdf_read_seconds, 3),
            },
            "log": log,
            "partial": True,
            "partial_mode": partial_mode,
            "compiler_debug": {
                "engine": "tectonic",
                "command": tectonic_args,
                "draft": draft,
                "synctex_enabled": synctex_enabled,
                "cwd": main_dir,
                "input_tex": preview_tex,
                "main_file": main_file,
                "source_file": abs_file,
                "preview_pdf": preview_pdf,
                "returncode": result.returncode,
            },
        }
    except FileNotFoundError:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.",
            "partial": True,
        }
    except Exception as e:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": f"Partial compile failed: {e}",
            "partial": True,
        }


def compile_latex(tex_content: str, file_path: str = None, main_file: str = "", project_dir: str = "",
                  include_pdf_base64: bool = True, draft: bool = False,
                  synctex: bool | None = None) -> dict:
    """
    Compiles LaTeX content using Tectonic.
    Returns a dictionary with:
    - success (bool): True if compilation succeeded
    - pdf_base64 (str): Base64 encoded PDF string if success and include_pdf_base64 is True
    - pdf_path (str): Absolute path to the generated PDF if success
    - synctex_path (str): Absolute path to the generated SyncTeX file if success
    - timing (dict): Compile and post-processing timings in seconds
    - log (str): Output log from the compiler
    """
    synctex_enabled = (not draft) if synctex is None else bool(synctex)
    tectonic_cmd = get_tectonic_path()
    
    # Auto-resolve project_dir and main_file when project_dir or main_file is empty but we have file_path
    if not project_dir and file_path and os.path.isabs(file_path):
        project_dir = os.path.dirname(file_path)
        
    if project_dir and not main_file and file_path:
        guessed = guess_main_file(project_dir)
        main_file = guessed if guessed else os.path.basename(file_path)
            
    if main_file and project_dir:
        # Save the current file's content first to ensure the compiler sees the latest changes
        if file_path:
            try:
                os.makedirs(os.path.dirname(file_path), exist_ok=True)
                with open(file_path, "w", encoding="utf-8", newline="") as f:
                    f.write(tex_content)
            except Exception as e:
                pass # Ignore write errors here, might be read-only or not needed
                
        abs_main_file = os.path.abspath(os.path.join(project_dir, main_file))
        base_no_ext = os.path.splitext(os.path.basename(main_file))[0]
        # Tectonic writes the PDF next to the input file, not necessarily at project root
        pdf_path = os.path.join(os.path.dirname(abs_main_file), f"{base_no_ext}.pdf")
        synctex_path = os.path.join(os.path.dirname(abs_main_file), f"{base_no_ext}.synctex.gz")
        
        try:
            compile_started = time.perf_counter()
            if draft:
                tectonic_args = [
                    tectonic_cmd,
                    "-X",
                    "compile",
                    "--keep-intermediates",
                    "--keep-logs",
                    "-r",
                    "0",
                    abs_main_file,
                ]
            else:
                tectonic_args = [
                    tectonic_cmd,
                    "--keep-intermediates",
                    "--keep-logs",
                    "-c",
                    "minimal",
                    abs_main_file,
                ]
            if synctex_enabled:
                tectonic_args.insert(3 if draft else 1, "--synctex")
            result = subprocess.run(
                tectonic_args,
                cwd=project_dir,
                capture_output=True,
                env=host_environment(),
                encoding="utf-8",
                errors="replace"
            )
            compile_seconds = time.perf_counter() - compile_started
            success = result.returncode == 0
            log = result.stdout + "\n" + result.stderr
            pdf_base64 = None
            pdf_read_seconds = 0.0
            if success and os.path.exists(pdf_path):
                if include_pdf_base64:
                    pdf_read_started = time.perf_counter()
                    with open(pdf_path, "rb") as pdf_file:
                        pdf_base64 = base64.b64encode(pdf_file.read()).decode('utf-8')
                    pdf_read_seconds = time.perf_counter() - pdf_read_started
            else:
                success = False
                if result.returncode == 0:
                    log += "\nError: PDF file was not generated despite 0 exit code."
            if not success:
                log = enrich_latex_error_log(log, project_dir)
            
            return {
                "success": success,
                "pdf_base64": pdf_base64,
                "pdf_path": pdf_path if success else "",
                "synctex_path": synctex_path if success and os.path.exists(synctex_path) else "",
                "timing": {
                    "compile_seconds": round(compile_seconds, 3),
                    "pdf_read_seconds": round(pdf_read_seconds, 3),
                },
                "log": log,
                "compiler_debug": {
                    "engine": "tectonic",
                    "command": tectonic_args,
                    "draft": draft,
                    "synctex_enabled": synctex_enabled,
                    "cwd": project_dir,
                    "input_tex": abs_main_file,
                    "main_file": main_file,
                    "source_file": file_path or "",
                    "expected_pdf": pdf_path,
                    "returncode": result.returncode,
                },
            }
        except FileNotFoundError:
            return {
                "success": False,
                "pdf_base64": None,
                "pdf_path": "",
                "synctex_path": "",
                "timing": {},
                "log": "Error: 'tectonic' compiler is not installed or not found in PATH.\nPlease install it from https://tectonic-typesetting.github.io/"
            }
        except Exception as e:
            return {
                "success": False,
                "pdf_base64": None,
                "pdf_path": "",
                "synctex_path": "",
                "timing": {},
                "log": f"An unexpected error occurred: {str(e)}"
            }

    # Fallback: single file compilation in temp directory
    temp_dir = tempfile.mkdtemp()
    
    base_name = os.path.basename(file_path) if file_path else "document.tex"
    base_no_ext = os.path.splitext(base_name)[0]
    tex_file_path = os.path.join(temp_dir, base_name)
    
    try:
        with open(tex_file_path, "w", encoding="utf-8", newline="") as f:
            f.write(tex_content)
            
        # Run tectonic
        compile_started = time.perf_counter()
        if draft:
            tectonic_args = [
                tectonic_cmd,
                "-X",
                "compile",
                "--keep-intermediates",
                "--keep-logs",
                "-r",
                "0",
                tex_file_path,
            ]
        else:
            tectonic_args = [
                tectonic_cmd,
                "--keep-intermediates",
                "--keep-logs",
                "-c",
                "minimal",
                tex_file_path,
            ]
        if synctex_enabled:
            tectonic_args.insert(3 if draft else 1, "--synctex")
        result = subprocess.run(
            tectonic_args,
            cwd=temp_dir,
            capture_output=True,
            env=host_environment(),
            encoding="utf-8",
            errors="replace"
        )
        compile_seconds = time.perf_counter() - compile_started
        
        success = result.returncode == 0
        pdf_base64 = None
        log = result.stdout + "\n" + result.stderr
        final_pdf_path = ""
        final_synctex_path = ""
        pdf_read_seconds = 0.0
        
        if success:
            pdf_path = os.path.join(temp_dir, f"{base_no_ext}.pdf")
            if os.path.exists(pdf_path):
                # If a real file_path was provided, copy the PDF there
                if file_path:
                    try:
                        target_pdf = os.path.splitext(file_path)[0] + ".pdf"
                        shutil.copy2(pdf_path, target_pdf)
                        final_pdf_path = target_pdf
                        
                        # Copy synctex file if it exists
                        synctex_path = os.path.join(temp_dir, f"{base_no_ext}.synctex.gz")
                        if os.path.exists(synctex_path):
                            target_synctex = os.path.splitext(file_path)[0] + ".synctex.gz"
                            shutil.copy2(synctex_path, target_synctex)
                            final_synctex_path = target_synctex
                    except Exception as copy_err:
                        log += f"\nWarning: could not save PDF to {file_path}'s directory: {copy_err}"
                        
                if not final_pdf_path:
                    final_pdf_path = pdf_path
                if not final_synctex_path:
                    synctex_path = os.path.join(temp_dir, f"{base_no_ext}.synctex.gz")
                    final_synctex_path = synctex_path if os.path.exists(synctex_path) else ""
                if include_pdf_base64:
                    pdf_read_started = time.perf_counter()
                    with open(pdf_path, "rb") as pdf_file:
                        pdf_base64 = base64.b64encode(pdf_file.read()).decode('utf-8')
                    pdf_read_seconds = time.perf_counter() - pdf_read_started
            else:
                success = False
                if result.returncode == 0:
                    log += "\nError: PDF file was not generated despite 0 exit code."
        if not success:
            log = enrich_latex_error_log(log, temp_dir)
                
        return {
            "success": success,
            "pdf_base64": pdf_base64,
            "pdf_path": final_pdf_path if success else "",
            "synctex_path": final_synctex_path if success else "",
            "timing": {
                "compile_seconds": round(compile_seconds, 3),
                "pdf_read_seconds": round(pdf_read_seconds, 3),
            },
            "log": log
        }
        
    except FileNotFoundError:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.\nPlease install it from https://tectonic-typesetting.github.io/"
        }
    except Exception as e:
        return {
            "success": False,
            "pdf_base64": None,
            "pdf_path": "",
            "synctex_path": "",
            "timing": {},
            "log": f"An unexpected error occurred: {str(e)}"
        }
    finally:
        # Cleanup temp directory
        try:
            shutil.rmtree(temp_dir)
        except Exception:
            pass


def _resolve_project_tex_input(project_path: str, input_path: str, source_tex: str = "") -> str:
    """Resolve a LaTeX input file inside the project tree."""
    if not project_path or not input_path:
        return ""
    project_abs = os.path.abspath(project_path)
    anchor_dir = project_abs
    if source_tex:
        candidate = os.path.abspath(os.path.join(project_abs, source_tex))
        anchor_dir = candidate if os.path.isdir(candidate) else os.path.dirname(candidate)

    candidates = []
    base = os.path.abspath(os.path.join(anchor_dir, input_path))
    candidates.append(base)
    if not os.path.splitext(base)[1]:
        candidates.append(base + ".tex")

    for candidate in candidates:
        if (
            (candidate == project_abs or candidate.startswith(project_abs + os.sep))
            and os.path.isfile(candidate)
        ):
            return candidate
    return ""


def _expand_graphic_inputs(graphic_source: str, project_path: str, source_tex: str = "",
                           visited=None, depth: int = 0) -> str:
    """Inline simple \\input{...} files for standalone graphic previews."""
    if not graphic_source or not project_path or depth > 8:
        return graphic_source
    if visited is None:
        visited = set()

    def replace(match):
        input_name = match.group(1).strip()
        resolved = _resolve_project_tex_input(project_path, input_name, source_tex)
        if not resolved:
            return match.group(0)
        resolved_key = os.path.normcase(os.path.abspath(resolved))
        if resolved_key in visited:
            return ""
        visited.add(resolved_key)
        try:
            with open(resolved, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
        except OSError:
            return match.group(0)
        rel_source = os.path.relpath(resolved, os.path.abspath(project_path)).replace("\\", "/")
        return _expand_graphic_inputs(content, project_path, rel_source, visited, depth + 1)

    return re.sub(r'\\input\s*\{([^}]+)\}', replace, graphic_source)


def _strip_latex_comments(source: str) -> str:
    """Remove unescaped LaTeX comments while preserving line boundaries."""
    lines = []
    for line in (source or "").splitlines():
        i = 0
        while i < len(line):
            if line[i] == "%" and not _is_escaped_latex_char(line, i):
                line = line[:i]
                break
            i += 1
        lines.append(line)
    return "\n".join(lines)


def _is_escaped_latex_char(text: str, index: int) -> bool:
    slash_count = 0
    i = index - 1
    while i >= 0 and text[i] == "\\":
        slash_count += 1
        i -= 1
    return slash_count % 2 == 1


def _collect_graphic_preview_setup(project_path: str) -> str:
    """Collect global setup that external TikZ files may use."""
    if not project_path or not os.path.isdir(project_path):
        return ""

    patterns = [
        re.compile(r'\\usetikzlibrary\s*\{[^{}]+\}'),
        re.compile(r'\\definecolor\s*\{[^{}]+\}\s*\{[^{}]+\}\s*\{[^{}]+\}'),
        re.compile(r'\\colorlet\s*\{[^{}]+\}\s*\{[^{}]+\}'),
    ]
    collected = []
    seen = set()
    project_abs = os.path.abspath(project_path)

    for root, dirs, files in os.walk(project_abs):
        dirs[:] = [d for d in dirs if d not in {".git", ".gilzacode", "node_modules", "__pycache__"}]
        for name in sorted(files):
            if not name.lower().endswith(".tex"):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    source = _strip_latex_comments(f.read())
            except OSError:
                continue
            for pattern in patterns:
                for match in pattern.finditer(source):
                    command = match.group(0).strip()
                    if command and command not in seen:
                        seen.add(command)
                        collected.append(command)

    return "\n".join(collected)


# ── Disk cache for graphic previews ────────────────────────────────────────
# SVGs are persisted to <gilzacode home>/graphic_cache/<hash>.svg so previews
# survive across IDE restarts. The cache key incorporates the graphic source,
# the resolved preamble, and the project setup so that editing \definecolor
# or \usepackage in the project main file invalidates stale entries.

def _graphic_cache_dir() -> str:
    """Return the on-disk graphic cache directory, creating it if needed."""
    from gilzacode.paths import gilzacode_home

    cache_dir = os.path.join(str(gilzacode_home()), "graphic_cache")
    try:
        os.makedirs(cache_dir, exist_ok=True)
    except OSError:
        pass
    return cache_dir


def _graphic_disk_cache_key(graphic_source: str, preamble: str, project_setup: str) -> str:
    """Compute a stable SHA-256 hash of everything that affects the SVG output."""
    payload = "\n".join([
        (graphic_source or "").strip(),
        "\n---preamble---\n",
        (preamble or "").strip(),
        "\n---setup---\n",
        (project_setup or "").strip(),
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _graphic_disk_cache_get(key: str):
    """Return cached SVG bytes for *key*, or ``None`` on miss."""
    path = os.path.join(_graphic_cache_dir(), key + ".svg")
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                return f.read()
    except OSError:
        pass
    return None


def _graphic_disk_cache_put(key: str, svg: str) -> None:
    """Persist *svg* to the disk cache. Best-effort — never raises."""
    path = os.path.join(_graphic_cache_dir(), key + ".svg")
    try:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(svg)
    except OSError:
        pass


def render_graphic_to_svg(graphic_source: str, project_path: str = "", preamble: str = "",
                          cache_key: str = "", graphic_engine: str = "",
                          source_tex: str = "") -> dict:
    """
    Render a single LaTeX graphic (tikzpicture / pgfplots / picture / chemfig
    / pstricks / forest) to inline SVG by compiling a minimal standalone
    document with Tectonic and converting the first page to SVG via PyMuPDF.

    This is used by the Rich Text editor (and the LaTeX preview) to display a
    live preview of figures inline, without needing to compile the full
    document.

    Args:
        graphic_source: The raw LaTeX body of the graphic environment, e.g.
            "\\begin{tikzpicture}\\draw ... \\end{tikzpicture}".
        project_path: Optional project directory used to discover a main file
            preamble (\\usepackage{tikz}, \\begin{document}, etc.).
        preamble: Optional explicit LaTeX preamble to inject before the
            graphic. Overrides auto-detection from the project main file.
        cache_key: Optional content-based cache key. When provided, identical
            cache_keys return the previously rendered SVG without re-compiling.
        graphic_engine: Optional hint for which engine the graphic uses
            ("tikz", "picture", "chemfig", "pstricks", "forest"). Only used
            to pick the auto-generated preamble when the caller did not pass
            one.
        source_tex: Optional project-relative .tex path that contains the
            graphic. Used to resolve \\input{...} paths the same way the
            current source file does.

    Returns:
        dict with:
          - success (bool)
          - svg (str): SVG markup (XML) when success=True
          - log (str): compiler log on failure
          - cached (bool): True if result was served from cache
    """
    # ── In-process cache ────────────────────────────────────────────────────
    if not hasattr(render_graphic_to_svg, "_cache"):
        render_graphic_to_svg._cache = {}  # key -> {"svg": str, "ts": float}
    cache = render_graphic_to_svg._cache

    if cache_key and cache_key in cache:
        entry = cache[cache_key]
        return {"success": True, "svg": entry["svg"], "log": "", "cached": True}

    tectonic_cmd = get_tectonic_path()
    if not tectonic_cmd:
        return {
            "success": False,
            "svg": "",
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.",
            "cached": False,
        }

    # ── Build the standalone document ───────────────────────────────────────
    # Minimal article + standalone document class is the safest container
    # for arbitrary graphic snippets. `standalone` ensures the PDF bounding
    # box tightly fits the graphic, which gives a clean SVG.
    body = (graphic_source or "").strip()
    if not body:
        return {"success": False, "svg": "", "log": "Empty graphic source.", "cached": False}
    body = _expand_graphic_inputs(body, project_path, source_tex).strip()

    # Pick a default preamble per engine. Only used when the caller did not
    # supply one (either explicitly or via auto-detect from the project).
    engine = (graphic_engine or "tikz").lower()
    default_tikz_libraries = (
        "\\usetikzlibrary{arrows.meta,backgrounds,calc,fit,positioning,shadows}\n"
    )
    engine_preambles = {
        "tikz": (
            "\\documentclass[tikz,border=4pt]{standalone}\n"
            "\\usepackage{tikz}\n"
            + default_tikz_libraries +
            "\\usepackage{pgfplots}\n"
            "\\pgfplotsset{compat=1.18}\n"
        ),
        "picture": (
            "\\documentclass[border=4pt]{standalone}\n"
        ),
        "chemfig": (
            "\\documentclass[border=4pt]{standalone}\n"
            "\\usepackage{tikz}\n"
            + default_tikz_libraries +
            "\\usepackage{chemfig}\n"
        ),
        "pstricks": (
            "\\documentclass[border=4pt]{standalone}\n"
            "\\usepackage{pstricks}\n"
            "\\usepackage{pst-plot}\n"
        ),
        "forest": (
            "\\documentclass[border=4pt]{standalone}\n"
            "\\usepackage{tikz}\n"
            + default_tikz_libraries +
            "\\usepackage{forest}\n"
        ),
    }
    default_preamble = engine_preambles.get(engine, engine_preambles["tikz"])

    # Auto-derive preamble from the project main file when the caller did not
    # supply one. This lets the user keep \\usepackage{tikz}, color libraries,
    # custom styles, etc. in their project's preamble and have them respected
    # by the inline preview.
    if not preamble and project_path and os.path.isdir(project_path):
        try:
            from gilzacode.latex_compiler import guess_main_file
            main_rel = guess_main_file(project_path)
            if main_rel:
                main_full = os.path.abspath(os.path.join(project_path, main_rel))
                with open(main_full, "r", encoding="utf-8", errors="ignore") as f:
                    src = f.read()
                # Slice from the start to \\begin{document}: that holds the
                # \\documentclass line and all \\usepackage declarations.
                doc_idx = src.find("\\begin{document}")
                if doc_idx > 0:
                    preamble = src[:doc_idx]
        except Exception:
            preamble = preamble or ""

    if not preamble:
        preamble = default_preamble
    elif "\\documentclass" not in preamble:
        # Wrap the user preamble with a standalone class that fits the
        # graphic tight to its bounding box.
        preamble = default_preamble + preamble

    project_setup = _collect_graphic_preview_setup(project_path)
    if engine in {"tikz", "chemfig", "forest"} and default_tikz_libraries.strip() not in preamble:
        project_setup = default_tikz_libraries + project_setup
    if project_setup:
        preamble = preamble.rstrip() + "\n" + project_setup + "\n"

    # ── Disk cache lookup (survives IDE restarts) ───────────────────────────
    # The key incorporates the graphic source, the resolved preamble, and
    # the project setup so that editing \definecolor or \usepackage in the
    # project main file invalidates stale entries automatically.
    disk_key = _graphic_disk_cache_key(body, preamble, project_setup)
    disk_svg = _graphic_disk_cache_get(disk_key)
    if disk_svg is not None:
        # Populate the in-process cache too so subsequent hits are O(1).
        if cache_key:
            cache[cache_key] = {"svg": disk_svg, "ts": time.time()}
        return {"success": True, "svg": disk_svg, "log": "", "cached": True}

    full_doc = (
        preamble
        + "\n\\begin{document}\n"
        + body
        + "\n\\end{document}\n"
    )

    # ── Compile in a fresh temp directory ───────────────────────────────────
    temp_dir = tempfile.mkdtemp(prefix="gilzacode_graphic_")
    tex_path = os.path.join(temp_dir, "graphic.tex")
    pdf_path = os.path.join(temp_dir, "graphic.pdf")

    try:
        with open(tex_path, "w", encoding="utf-8", newline="") as f:
            f.write(full_doc)

        result = subprocess.run(
            [tectonic_cmd, tex_path],
            cwd=temp_dir,
            capture_output=True,
            env=host_environment(),
            encoding="utf-8",
            errors="replace",
            timeout=60,
        )
        if result.returncode != 0 or not os.path.exists(pdf_path):
            return {
                "success": False,
                "svg": "",
                "log": (result.stdout or "") + "\n" + (result.stderr or ""),
                "cached": False,
            }

        # ── Convert first page to SVG via PyMuPDF ───────────────────────────
        try:
            import fitz  # PyMuPDF
        except ImportError:
            return {
                "success": False,
                "svg": "",
                "log": "Error: PyMuPDF (fitz) is not installed; required for SVG conversion.",
                "cached": False,
            }

        doc = fitz.open(pdf_path)
        if not doc or len(doc) == 0:
            return {
                "success": False,
                "svg": "",
                "log": "Error: PDF produced by tectonic has no pages.",
                "cached": False,
            }
        page = doc[0]
        # `get_svg_image(text_as_path=True)` embeds glyphs as <path> for
        # portable rendering in any browser.
        svg = page.get_svg_image(text_as_path=True)
        doc.close()

        # ── Persist to both caches ────────────────────────────────────────
        if cache_key:
            cache[cache_key] = {"svg": svg, "ts": time.time()}
            # Cap in-process cache size to avoid unbounded growth
            if len(cache) > 256:
                oldest = min(cache.items(), key=lambda kv: kv[1]["ts"])
                cache.pop(oldest[0], None)
        _graphic_disk_cache_put(disk_key, svg)

        return {"success": True, "svg": svg, "log": "", "cached": False}
    except FileNotFoundError:
        return {
            "success": False,
            "svg": "",
            "log": "Error: 'tectonic' compiler is not installed or not found in PATH.",
            "cached": False,
        }
    except subprocess.TimeoutExpired:
        return {
            "success": False,
            "svg": "",
            "log": "Error: tectonic compilation timed out after 60 seconds.",
            "cached": False,
        }
    except Exception as e:
        return {
            "success": False,
            "svg": "",
            "log": f"Unexpected error rendering graphic: {e}",
            "cached": False,
        }
    finally:
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass


def _resolve_include_path(project_path: str, file_path: str, source_tex: str) -> str:
    """Resolve a \\includegraphics file path against the project, honouring
    `..` relative to the .tex file that references it (LaTeX semantics).

    Returns the absolute path on disk if it exists, or an empty string when
    the file cannot be found / the project path escapes the project tree.
    """
    if not project_path or not file_path:
        return ""
    project_abs = os.path.abspath(project_path)
    anchor_dir = project_abs
    if source_tex:
        candidate = os.path.abspath(os.path.join(project_abs, source_tex))
        if os.path.isdir(candidate):
            anchor_dir = candidate
        else:
            anchor_dir = os.path.dirname(candidate)
    full_path = os.path.abspath(os.path.join(anchor_dir, file_path))
    # Safety: the resolved path must remain inside the project tree.
    if not full_path.startswith(project_abs + os.sep) and full_path != project_abs:
        return ""
    if not os.path.exists(full_path) or os.path.isdir(full_path):
        return ""
    return full_path


def render_include_to_png(project_path: str, file_path: str, source_tex: str = "",
                          output: str = "auto", page: int = 0, dpi: int = 144) -> dict:
    """
    Render an \\includegraphics target (PDF / PNG / JPG / GIF) to a
    browser-displayable payload so the Rich Text editor can show a preview of
    figures that simply embed a raster/vector image.

    For PDF inputs (and any vector format PyMuPDF can open) the requested
    page (default 0 = first) is rasterized at the given DPI to a PNG
    payload. For raster inputs (PNG / JPG / GIF / WEBP) the file is returned
    as-is when ``output == 'auto'`` so the browser can display it without a
    conversion round-trip.

    Args:
        project_path: project root (used as the security boundary).
        file_path: path of the asset, possibly with `..` segments relative
            to the source .tex file.
        source_tex: project-relative path of the .tex that contains the
            \\includegraphics (used as the anchor for `..`).
        output: "auto" (default) chooses per MIME type; "png" forces
            rasterization (returns a PNG even for raster inputs).
        page: 0-indexed page number for multi-page PDFs.
        dpi: rasterization resolution (default 144).

    Returns:
        dict with:
          - success (bool)
          - mime (str): MIME type of the returned payload
          - data (bytes): the payload bytes (PNG or original image)
          - error (str): error message on failure
    """
    full_path = _resolve_include_path(project_path, file_path, source_tex)
    if not full_path:
        return {
            "success": False,
            "mime": "",
            "data": b"",
            "error": f"File not found: {file_path}",
        }

    ext = os.path.splitext(full_path)[1].lower()
    raster_exts = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}

    # ── Raster inputs: pass through when "auto", force PNG otherwise ───────
    if ext in raster_exts and output == "auto":
        try:
            with open(full_path, "rb") as f:
                content = f.read()
            import mimetypes
            mime = mimetypes.guess_type(full_path)[0] or "application/octet-stream"
            return {"success": True, "mime": mime, "data": content, "error": ""}
        except Exception as e:
            return {"success": False, "mime": "", "data": b"", "error": str(e)}

    # ── Vector / multi-page inputs: rasterize with PyMuPDF ────────────────
    try:
        import fitz
    except ImportError:
        return {
            "success": False,
            "mime": "",
            "data": b"",
            "error": "PyMuPDF (fitz) is not installed; required for image preview.",
        }

    try:
        doc = fitz.open(full_path)
        if not doc or len(doc) == 0:
            return {
                "success": False,
                "mime": "",
                "data": b"",
                "error": f"Empty document: {file_path}",
            }
        idx = max(0, min(page, len(doc) - 1))
        page_obj = doc[idx]
        # Default zoom = dpi/72 (PDF points per inch).
        zoom = max(0.5, dpi / 72.0)
        matrix = fitz.Matrix(zoom, zoom)
        pix = page_obj.get_pixmap(matrix=matrix, alpha=False)
        png_bytes = pix.tobytes("png")
        doc.close()
        return {"success": True, "mime": "image/png", "data": png_bytes, "error": ""}
    except Exception as e:
        return {"success": False, "mime": "", "data": b"", "error": f"Render failed: {e}"}
