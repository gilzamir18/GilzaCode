"""Search the text files of a project (``/api/files/search``).

Every file the tree lists is a candidate (the same skipped folders and, unless
hidden files are shown, the same hidden extensions). A file is searched only if
it is UTF-8 text, as ``/api/file/read`` requires to open it: a NUL byte or an
undecodable byte makes it binary and it is left out, never decoded some other way.

Lines are split on ``\\r\\n``, ``\\r`` and ``\\n`` only, as the editor (Monaco)
splits them, so line numbers match the editor's. Columns are 1-based UTF-16 code
units, Monaco's unit, so a match after an astral character still lands on it.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field

from gilzacode.files import SKIPPED_DIRS

#: Matches returned in one search; the rest are counted as truncated.
MAX_MATCHES = 2000
#: Larger files are skipped (reported in ``skippedLarge``).
MAX_FILE_BYTES = 5 * 1024 * 1024
#: Characters of context kept on each side of a match in its preview.
PREVIEW_CONTEXT = 60

_LINE_BREAK = re.compile(r"\r\n|\r|\n")


class InvalidQuery(ValueError):
    """The query is empty or is not a valid regular expression."""


@dataclass
class SearchResult:
    files: list[dict] = field(default_factory=list)
    match_count: int = 0
    files_searched: int = 0
    skipped_large: int = 0
    truncated: bool = False

    def to_json(self) -> dict:
        return {
            "results": self.files,
            "matchCount": self.match_count,
            "filesSearched": self.files_searched,
            "skippedLarge": self.skipped_large,
            "truncated": self.truncated,
        }


def compile_query(query: str, *, case_sensitive: bool = False, whole_word: bool = False,
                  regex: bool = False) -> re.Pattern:
    if not query:
        raise InvalidQuery("The search text is empty.")
    source = query if regex else re.escape(query)
    if whole_word:
        source = rf"(?<!\w)(?:{source})(?!\w)"
    try:
        return re.compile(source, 0 if case_sensitive else re.IGNORECASE)
    except re.error as exc:
        raise InvalidQuery(f"Invalid regular expression: {exc}") from exc


def _utf16_len(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def _read_text(path: str) -> str | None:
    """The file's text, or None when it is not UTF-8 text."""
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError:
        return None
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def _candidate_files(project_path: str, *, show_hidden: bool, hidden_extensions) -> list[str]:
    hidden = tuple(ext.lower() for ext in hidden_extensions)
    found = []
    for dirpath, dirnames, filenames in os.walk(project_path):
        dirnames[:] = sorted((d for d in dirnames if d not in SKIPPED_DIRS), key=str.lower)
        for name in sorted(filenames, key=str.lower):
            if name in SKIPPED_DIRS:
                continue
            if not show_hidden and hidden and name.lower().endswith(hidden):
                continue
            found.append(os.path.join(dirpath, name))
    return found


def _preview(line: str, start: int, end: int) -> dict:
    before_start = max(0, start - PREVIEW_CONTEXT)
    after_end = min(len(line), end + PREVIEW_CONTEXT)
    return {
        "before": ("…" if before_start > 0 else "") + line[before_start:start].lstrip(),
        "match": line[start:end],
        "after": line[end:after_end] + ("…" if after_end < len(line) else ""),
    }


def search_project(project_path: str, pattern: re.Pattern, *, show_hidden: bool = False,
                   hidden_extensions=(), max_matches: int = MAX_MATCHES,
                   max_file_bytes: int = MAX_FILE_BYTES) -> SearchResult:
    """Every match of `pattern` in the project's text files, grouped by file."""
    result = SearchResult()
    for full in _candidate_files(project_path, show_hidden=show_hidden,
                                 hidden_extensions=hidden_extensions):
        try:
            size = os.path.getsize(full)
        except OSError:
            continue
        if size > max_file_bytes:
            result.skipped_large += 1
            continue
        text = _read_text(full)
        if text is None:
            continue
        result.files_searched += 1
        matches = []
        for line_number, line in enumerate(_LINE_BREAK.split(text), start=1):
            for found in pattern.finditer(line):
                start, end = found.span()
                if start == end:
                    continue
                if result.match_count >= max_matches:
                    result.truncated = True
                    break
                result.match_count += 1
                matches.append({
                    "line": line_number,
                    "column": _utf16_len(line[:start]) + 1,
                    "length": _utf16_len(line[start:end]),
                    **_preview(line, start, end),
                })
            if result.truncated:
                break
        if matches:
            result.files.append({"path": os.path.relpath(full, project_path), "matches": matches})
        if result.truncated:
            break
    return result
