"""Inline edits: Refine, Generate content and Create illustration through headless Claude Code."""

import json
import sys

import pytest

from gilzacode import claude_cli, inline_edit, settings

FAKE = r'''
import json, sys
prompt = sys.stdin.read()
with open(sys.argv[0] + ".calls", "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": sys.argv[1:], "prompt": prompt}) + "\n")
answer = json.loads(open(sys.argv[0] + ".answer", encoding="utf-8").read())
print(json.dumps({"type": "result", "is_error": False, "result": json.dumps(answer), "structured_output": answer}))
'''

SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 100 50">'
       '<rect width="100" height="50" fill="#336"/></svg>')


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


@pytest.fixture
def doc(tmp_path):
    folder = tmp_path / "doc"
    (folder / "chapters").mkdir(parents=True)
    (folder / "chapters" / "intro.tex").write_text("x", encoding="utf-8")
    (folder / "notes.md").write_text("x", encoding="utf-8")
    return folder


def body(doc, **overrides):
    return {"projectPath": str(doc), "file": "chapters/intro.tex", "action": "replace",
            "instruction": "Make it formal", "before": "Intro. ", "selection": "It's good.",
            "after": " End.", "line": 3, "column": 7, **overrides}


async def test_refine_returns_the_replacement_from_a_call_with_no_tools(client, fake_claude, doc):
    fake_claude({"text": "It is adequate."})
    response = await client.post("/api/inline-edit", json=body(doc))
    data = await response.json()
    assert response.status == 200, data
    assert data["text"] == "It is adequate."

    call = fake_claude.calls()[-1]
    argv = call["argv"]
    assert argv[argv.index("--tools") + 1] == "" and "--allowedTools" not in argv
    assert json.loads(argv[argv.index("--json-schema") + 1]) == inline_edit.TEXT_SCHEMA
    prompt = call["prompt"]
    assert prompt.startswith("Task: Make it formal")
    assert "Intro. It's good. End." in prompt and "Target selection to replace (line 3):\n```\nIt's good.\n```" in prompt


async def test_generate_sends_the_text_around_the_cursor(client, fake_claude, doc):
    fake_claude({"text": "\\section{Methods}"})
    data = await (await client.post("/api/inline-edit", json=body(
        doc, action="insert", instruction="Add a methods section", selection=""))).json()
    assert data["text"] == "\\section{Methods}"
    prompt = fake_claude.calls()[-1]["prompt"]
    assert "<before_cursor>\nIntro. \n</before_cursor>" in prompt
    assert '<cursor line="3" column="7" />' in prompt and "<after_cursor>\n End.\n</after_cursor>" in prompt


def test_a_fence_in_the_file_gets_a_longer_fence_around_it():
    req = inline_edit.Request.from_payload(body_for_unit(selection="```py\nx\n```"))
    assert "````\n```py\nx\n```\n````" in inline_edit.build_prompt(req)


def body_for_unit(**overrides):
    import tempfile
    return {"projectPath": tempfile.gettempdir(), "file": "a.md", "action": "replace", "instruction": "x",
            "before": "", "selection": "s", "after": "", **overrides}


@pytest.mark.parametrize("overrides,code", [
    ({"action": "explode"}, "invalid"),
    ({"instruction": "  "}, "invalid"),
    ({"selection": "  "}, "invalid"),                      # Refine needs a selection
    ({"action": "insert", "selection": "x"}, "invalid"),   # an insertion has none
    ({"file": "../outside.tex"}, "invalid"),
    ({"before": "x" * inline_edit.MAX_CONTEXT_CHARS}, "too_large"),
])
async def test_bad_requests_are_refused_before_any_model_call(client, fake_claude, doc, overrides, code):
    response = await client.post("/api/inline-edit", json=body(doc, **overrides))
    data = await response.json()
    assert response.status in (400, 413) and data["code"] == code, data
    assert fake_claude.calls() == []


async def test_an_empty_answer_is_reported(client, fake_claude, doc):
    fake_claude({"text": "  "})
    response = await client.post("/api/inline-edit", json=body(doc))
    assert response.status == 502 and (await response.json())["code"] == "invalid_answer"


async def test_an_illustration_for_a_tex_is_saved_with_a_pdf_copy(client, fake_claude, doc):
    fake_claude({"svg": SVG})
    response = await client.post("/api/inline-edit", json=body(doc, action="illustrate", instruction="A diagram"))
    data = await response.json()
    assert response.status == 200, data
    assert data["svg_path"].startswith("illustrations/illustration_") and data["svg_path"].endswith(".svg")
    assert (doc / data["svg_path"]).read_text(encoding="utf-8") == SVG
    assert (doc / data["pdf_path"]).read_bytes().startswith(b"%PDF")
    argv = fake_claude.calls()[-1]["argv"]
    assert json.loads(argv[argv.index("--json-schema") + 1]) == inline_edit.SVG_SCHEMA

    again = await (await client.post("/api/inline-edit", json=body(doc, action="illustrate",
                                                                    instruction="A diagram"))).json()
    assert again["svg_path"] != data["svg_path"]  # never overwrites an earlier illustration


async def test_an_illustration_for_markdown_needs_no_pdf(client, fake_claude, doc):
    fake_claude({"svg": '<?xml version="1.0"?>\n' + SVG})
    data = await (await client.post("/api/inline-edit", json=body(doc, file="notes.md", action="illustrate"))).json()
    assert data["pdf_path"] is None and (doc / data["svg_path"]).read_text(encoding="utf-8") == SVG


async def test_an_answer_that_is_not_svg_saves_nothing(client, fake_claude, doc):
    fake_claude({"svg": "Here is your SVG: <svg></svg>"})
    response = await client.post("/api/inline-edit", json=body(doc, action="illustrate"))
    assert response.status == 502 and (await response.json())["code"] == "invalid_answer"
    assert not (doc / "illustrations").exists()


def test_the_model_is_its_own_setting_defaulting_to_look_ups():
    assert inline_edit.resolve_model() == "sonnet"
    settings.save({"lookup_model": "opus"})
    assert inline_edit.resolve_model() == "opus"
    settings.save({"inline_edit_model": "haiku"})
    assert inline_edit.resolve_model() == "haiku"
