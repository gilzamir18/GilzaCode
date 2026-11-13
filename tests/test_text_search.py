"""Searching a project's text files: `/api/files/search` and `gilzacode.text_search`."""

import pytest

from gilzacode.text_search import InvalidQuery, compile_query, search_project


@pytest.fixture
def notes(tmp_path):
    folder = tmp_path / "notes"
    folder.mkdir()
    (folder / "README.md").write_text("# Title\n\nSome **Gilza** notes.\r\nmore gilza here\n",
                                      encoding="utf-8", newline="")
    (folder / "docs").mkdir()
    (folder / "docs" / "chapter.tex").write_text("\\section{Gilzacode}\n", encoding="utf-8")
    (folder / "image.png").write_bytes(b"\x89PNG\0\0gilza")
    (folder / "latin1.txt").write_bytes("gilza caf\xe9".encode("latin-1"))
    (folder / "main.aux").write_text("gilza aux", encoding="utf-8")
    (folder / "node_modules").mkdir()
    (folder / "node_modules" / "dep.md").write_text("gilza", encoding="utf-8")
    return folder


def _hits(result):
    return {(f["path"].replace("\\", "/"), m["line"], m["column"]) for f in result.files for m in f["matches"]}


def test_markdown_and_other_text_files_are_searched_case_insensitively(notes):
    result = search_project(str(notes), compile_query("gilza"), hidden_extensions=[".aux"])
    assert _hits(result) == {("README.md", 3, 8), ("README.md", 4, 6), ("docs/chapter.tex", 1, 10)}
    assert result.match_count == 3 and not result.truncated


def test_binary_non_utf8_hidden_and_skipped_folders_are_left_out(notes):
    paths = {f["path"].replace("\\", "/") for f in
             search_project(str(notes), compile_query("gilza"), hidden_extensions=[".aux"]).files}
    assert not paths & {"image.png", "latin1.txt", "main.aux", "node_modules/dep.md"}
    shown = search_project(str(notes), compile_query("gilza"), show_hidden=True, hidden_extensions=[".aux"])
    assert "main.aux" in {f["path"] for f in shown.files}


def test_case_whole_word_and_regex_options(notes):
    assert _hits(search_project(str(notes), compile_query("Gilza", case_sensitive=True))) == {
        ("README.md", 3, 8), ("docs/chapter.tex", 1, 10)}
    assert _hits(search_project(str(notes), compile_query("gilza", whole_word=True),
                                hidden_extensions=[".aux"])) == {
        ("README.md", 3, 8), ("README.md", 4, 6)}
    assert _hits(search_project(str(notes), compile_query(r"^#\s", regex=True))) == {("README.md", 1, 1)}


def test_the_query_is_literal_unless_regex_is_asked(notes):
    (notes / "a.md").write_text("cost (a+b) here\n", encoding="utf-8")
    assert _hits(search_project(str(notes), compile_query("(a+b)"))) == {("a.md", 1, 6)}


def test_preview_and_utf16_columns(notes):
    (notes / "emoji.md").write_text("\U0001F600 x gilza tail\n", encoding="utf-8")
    result = search_project(str(notes), compile_query("gilza tail"))
    match = next(f for f in result.files if f["path"] == "emoji.md")["matches"][0]
    # The emoji is two UTF-16 units, as Monaco counts columns.
    assert (match["column"], match["length"]) == (6, 10)
    assert (match["before"], match["match"], match["after"]) == ("\U0001F600 x ", "gilza tail", "")


def test_the_match_limit_truncates(notes):
    result = search_project(str(notes), compile_query("gilza"), max_matches=2)
    assert result.match_count == 2 and result.truncated


def test_large_files_are_skipped_and_counted(notes):
    result = search_project(str(notes), compile_query("gilza"), max_file_bytes=20)
    assert result.skipped_large >= 1
    assert "README.md" not in {f["path"] for f in result.files}


@pytest.mark.parametrize("query,regex", [("", False), ("(", True)])
def test_empty_or_invalid_queries_are_refused(query, regex):
    with pytest.raises(InvalidQuery):
        compile_query(query, regex=regex)


async def test_the_endpoint_searches_and_refuses_bad_queries(client, notes):
    response = await client.get("/api/files/search", params={"projectPath": str(notes), "query": "GILZA",
                                                             "wholeWord": "true"})
    assert response.status == 200
    data = await response.json()
    assert data["matchCount"] == 2 and data["truncated"] is False
    assert data["results"][0]["matches"][0]["match"] == "Gilza"

    bad = await client.get("/api/files/search", params={"projectPath": str(notes), "query": "(", "regex": "1"})
    assert bad.status == 400 and (await bad.json())["code"] == "invalid_query"
    missing = await client.get("/api/files/search", params={"projectPath": str(notes / "nope"), "query": "x"})
    assert missing.status == 404
