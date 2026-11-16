"""Change .tex: locating the excerpt through SyncTeX, Claude Code's answer, and applying it."""

import gzip
import json
import sys

import pytest

from gilzacode import claude_cli, settings, tex_change

FAKE = r'''
import json, sys
prompt = sys.stdin.read()
with open(sys.argv[0] + ".calls", "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "prompt": prompt}) + "\n")
answer = json.loads(open(sys.argv[0] + ".answer", encoding="utf-8").read())
print(json.dumps({"type": "result", "is_error": False, "result": json.dumps(answer), "structured_output": answer}))
'''

MAIN = ("\\documentclass{article}\r\n\\begin{document}\r\n\\input{chapter}\r\n"
        "The method reduces the error.\r\nIt is fast.\r\n\\end{document}\r\n")
CHAPTER = "Chapter text.\n"


def write_synctex(path, records):
    """``records`` is [(input_tag, source, line, x, y)] on page 1, in points."""
    inputs = {}
    for tag, source, *_ in records:
        inputs[tag] = source
    lines = ["SyncTeX Version:1", *(f"Input:{tag}:{source}" for tag, source in inputs.items()), "Content:", "{1"]
    for tag, _source, line, x, y in records:
        lines.append(f"h{tag},{line}:{x * 65536},{y * 65536}:{300 * 65536},{10 * 65536},0")
    lines += ["}1", "Postamble:"]
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


@pytest.fixture
def paper(tmp_path):
    folder = tmp_path / "paper"
    folder.mkdir()
    (folder / "main.tex").write_text(MAIN, encoding="utf-8", newline="")
    (folder / "chapter.tex").write_text(CHAPTER, encoding="utf-8", newline="")
    (folder / "main.pdf").write_bytes(b"%PDF-1.4\n")
    write_synctex(folder / "main.synctex.gz", [
        (1, folder / "main.tex", 4, 72, 100),
        (1, folder / "main.tex", 5, 72, 200),
        (2, folder / "chapter.tex", 1, 72, 400),
    ])
    (folder / "loose.pdf").write_bytes(b"%PDF-1.4\n")
    return folder


@pytest.fixture
def fake_claude(tmp_path, monkeypatch):
    script = tmp_path / "fake_claude.py"
    script.write_text(FAKE, encoding="utf-8")

    def configure(answer):
        (tmp_path / "fake_claude.py.answer").write_text(json.dumps(answer), encoding="utf-8")

    real_argv = claude_cli.headless_argv
    monkeypatch.setattr(claude_cli, "find_claude", lambda: sys.executable)
    monkeypatch.setattr(claude_cli, "headless_argv",
                        lambda exe, **kw: [sys.executable, str(script), *real_argv(exe, **kw)[1:]])

    def calls():
        path = tmp_path / "fake_claude.py.calls"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.exists() else []

    configure.calls = calls
    return configure


def anchors(*points):
    return [tex_change.Anchor(1, x, y) for x, y in points]


def test_the_excerpt_is_located_in_the_lines_it_was_typeset_from(paper):
    source, span = tex_change.locate(str(paper), "main.pdf", anchors((72, 100), (72, 200)))
    assert source == "main.tex"
    assert span == tex_change.SourceSpan("main.tex", 4, 5)


def test_an_included_file_is_the_file_to_edit(paper):
    source, span = tex_change.locate(str(paper), "main.pdf", anchors((72, 400)))
    assert (source, span.file, span.first_line) == ("main.tex", "chapter.tex", 1)


def test_an_excerpt_across_two_files_is_refused(paper):
    with pytest.raises(tex_change.TexChangeError) as exc:
        tex_change.locate(str(paper), "main.pdf", anchors((72, 100), (72, 400)))
    assert exc.value.code == "two_files" and "single source file" in str(exc.value)


def test_a_pdf_without_a_source_or_synctex_is_refused_with_the_reason(paper):
    with pytest.raises(tex_change.TexChangeError) as exc:
        tex_change.locate(str(paper), "loose.pdf", anchors((72, 100)))
    assert exc.value.code == "no_source"
    (paper / "main.synctex.gz").unlink()
    with pytest.raises(tex_change.TexChangeError) as exc:
        tex_change.locate(str(paper), "main.pdf", anchors((72, 100)))
    assert exc.value.code == "no_synctex" and "Recompile" in str(exc.value)


def test_applying_replaces_each_before_once_and_refuses_a_stale_file():
    content = "a\r\nb\r\nc\r\n"
    assert tex_change.apply_edits(content, [{"before": "b", "after": "B"}, {"before": "c", "after": "C"}]) \
        == "a\r\nB\r\nC\r\n"
    for edits in ([{"before": "x", "after": "y"}],            # gone
                  [{"before": "\r\n", "after": ""}],          # ambiguous
                  [{"before": "a\r\nb", "after": "1"}, {"before": "b\r\nc", "after": "2"}]):  # overlap
        with pytest.raises(tex_change.TexChangeError) as exc:
            tex_change.apply_edits(content, edits)
        assert exc.value.code == "stale"


def test_the_conversation_must_alternate_and_end_with_the_user():
    assert tex_change.parse_turns([{"role": "user", "text": " shorter "}])[0]["text"] == "shorter"
    for turns in ([], [{"role": "assistant", "text": "?"}],
                  [{"role": "user", "text": "a"}, {"role": "assistant", "kind": "question", "text": "b"}],
                  [{"role": "user", "text": "  "}]):
        with pytest.raises(tex_change.TexChangeError):
            tex_change.parse_turns(turns)


def test_claude_is_told_which_earlier_proposals_were_applied():
    edit = [{"before": "a", "after": "b"}]
    turns = tex_change.parse_turns([
        {"role": "user", "text": "one"},
        {"role": "assistant", "kind": "proposal", "text": "p1", "edits": edit, "applied": True},
        {"role": "user", "text": "two"},
        {"role": "assistant", "kind": "proposal", "text": "p2", "edits": edit},
        {"role": "user", "text": "three"},
    ])
    prompt = tex_change.build_prompt(pdf_path="main.pdf", page=1, excerpt="x",
                                     span=tex_change.SourceSpan("main.tex", 1, 2), turns=turns)
    assert prompt.index("the file now contains it") < prompt.index("p2") < prompt.index("was not applied")
    assert "<edit 1 before>\na\n</edit 1 before>" in prompt and "lines 1-2" in prompt


def test_the_model_is_its_own_setting_defaulting_to_look_ups():
    assert tex_change.resolve_model() == "sonnet"
    settings.save({"lookup_model": "opus"})
    assert tex_change.resolve_model() == "opus"
    settings.save({"tex_change_model": "haiku"})
    assert tex_change.resolve_model() == "haiku"
    assert tex_change.resolve_model("fable") == "fable"


def propose_body(paper, turns, points=((72, 100),)):
    return {"projectPath": str(paper), "pdfPath": "main.pdf", "excerpt": "The method reduces the error.",
            "page": 1, "anchors": [{"page": 1, "x": x, "y": y} for x, y in points], "turns": turns}


async def test_a_proposal_comes_back_in_the_files_line_endings(client, fake_claude, paper):
    fake_claude({"kind": "proposal", "text": "Shortens the sentence.",
                 "edits": [{"before": "The method reduces the error.\nIt is fast.", "after": "It is fast."}]})
    response = await client.post("/api/tex-change/propose",
                                 json=propose_body(paper, [{"role": "user", "text": "Merge these two"}]))
    data = await response.json()
    assert response.status == 200, data
    assert data["kind"] == "proposal" and data["file"] == "main.tex" and data["lines"] == [4, 4]
    assert data["edits"] == [{"before": "The method reduces the error.\r\nIt is fast.", "after": "It is fast."}]

    call = fake_claude.calls()[-1]
    argv = call["argv"]
    assert argv[argv.index("--tools") + 1] == "Read,Grep,Glob"
    assert json.loads(argv[argv.index("--json-schema") + 1]) == tex_change.ANSWER_SCHEMA
    assert "Source file to edit: main.tex, line 4" in call["prompt"]
    assert "<excerpt>\nThe method reduces the error.\n</excerpt>" in call["prompt"]
    assert "User:\nMerge these two" in call["prompt"]


async def test_a_question_and_its_answer_are_sent_back_as_the_conversation(client, fake_claude, paper):
    fake_claude({"kind": "question", "text": "Which sentence?", "edits": []})
    turns = [{"role": "user", "text": "Shorten it"},
             {"role": "assistant", "kind": "question", "text": "Formal or casual?"},
             {"role": "user", "text": "Formal"}]
    data = await (await client.post("/api/tex-change/propose", json=propose_body(paper, turns))).json()
    assert data["kind"] == "question" and data["edits"] == []
    prompt = fake_claude.calls()[-1]["prompt"]
    assert prompt.index("User:\nShorten it") < prompt.index("You (question):\nFormal or casual?") \
        < prompt.index("User:\nFormal")


async def test_a_proposal_that_does_not_match_the_file_is_reported(client, fake_claude, paper):
    fake_claude({"kind": "proposal", "text": "x", "edits": [{"before": "not in the file", "after": "y"}]})
    response = await client.post("/api/tex-change/propose", json=propose_body(paper, [{"role": "user", "text": "x"}]))
    data = await response.json()
    assert response.status == 502 and data["code"] == "invalid_answer" and "does not match main.tex" in data["error"]


async def test_a_selection_synctex_cannot_place_is_refused_before_any_model_call(client, fake_claude, paper):
    (paper / "main.synctex.gz").unlink()
    response = await client.post("/api/tex-change/propose", json=propose_body(paper, [{"role": "user", "text": "x"}]))
    assert response.status == 409 and (await response.json())["code"] == "no_synctex"
    assert fake_claude.calls() == []


async def test_apply_writes_the_file_and_refuses_when_it_changed(client, paper):
    edits = [{"before": "It is fast.", "after": "It is very fast."}]
    response = await client.post("/api/tex-change/apply",
                                 json={"projectPath": str(paper), "file": "main.tex", "edits": edits})
    data = await response.json()
    assert response.status == 200 and "It is very fast.\r\n" in data["content"]
    assert (paper / "main.tex").read_bytes().decode("utf-8") == data["content"]

    again = await client.post("/api/tex-change/apply",
                              json={"projectPath": str(paper), "file": "main.tex", "edits": edits})
    assert again.status == 409 and (await again.json())["code"] == "stale"
    outside = await client.post("/api/tex-change/apply",
                                json={"projectPath": str(paper), "file": "../x.tex", "edits": edits})
    assert outside.status == 400


async def test_check_pdf_says_whether_the_tex_has_an_associated_pdf(client, paper):
    own = await (await client.get("/api/latex/check-pdf",
                                  params={"filePath": "main.tex", "projectPath": str(paper)})).json()
    assert own["found"] and own["associated"] is True and own["pdf_path"] == "main.pdf"
    included = await (await client.get("/api/latex/check-pdf",
                                       params={"filePath": "chapter.tex", "projectPath": str(paper)})).json()
    assert included["found"] and included["associated"] is False and included["source_tex"] == "main.tex"
