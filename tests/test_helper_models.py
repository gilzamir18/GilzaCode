"""The model each helper task (Translate, Look up, Change .tex, inline edits) runs on."""

import pytest

from gilzacode import helper_models, settings


def test_defaults_and_tasks_that_follow_look_up():
    assert helper_models.model_for("translate_model") == "haiku"
    assert helper_models.model_for("lookup_model") == "sonnet"
    assert helper_models.model_for("tex_change_model") == "sonnet"
    assert helper_models.model_for("inline_edit_model") == "sonnet"
    helper_models.save({"lookup_model": "opus"})
    assert helper_models.model_for("tex_change_model") == "opus"
    assert helper_models.model_for("inline_edit_model") == "opus"
    assert helper_models.model_for("translate_model") == "haiku"  # does not follow Look up


def test_a_task_of_its_own_and_a_request_override():
    helper_models.save({"lookup_model": "opus", "inline_edit_model": "haiku"})
    assert helper_models.model_for("inline_edit_model") == "haiku"
    assert helper_models.model_for("tex_change_model") == "opus"
    assert helper_models.model_for("inline_edit_model", "fable") == "fable"


def test_empty_goes_back_to_the_default_and_other_settings_are_kept():
    settings.save({"lang": "pt-BR"})
    helper_models.save({"translate_model": "sonnet"})
    helper_models.save({"translate_model": ""})
    assert helper_models.model_for("translate_model") == "haiku"
    assert settings.load()["lang"] == "pt-BR"


@pytest.mark.parametrize("changes", [
    {"translate_model": "gpt-4"},
    {"translate_model": "opus "},
    {"chat_model": "opus"},
    ["opus"],
])
def test_unknown_tasks_and_models_are_refused(changes):
    with pytest.raises(ValueError):
        helper_models.save(changes)
    assert helper_models.stored() == dict.fromkeys(helper_models.TASKS, "")


async def test_the_settings_endpoints(client):
    data = await (await client.get("/api/settings/helper-models")).json()
    assert data["models"] == dict.fromkeys(helper_models.TASKS, "")
    assert data["aliases"] == ["haiku", "sonnet", "opus", "fable"]
    assert data["tasks"]["tex_change_model"] == {"follows": "lookup_model"}

    saved = await client.post("/api/settings/helper-models", json={"models": {"lookup_model": "fable"}})
    assert saved.status == 200 and (await saved.json())["models"]["lookup_model"] == "fable"
    assert helper_models.model_for("inline_edit_model") == "fable"

    refused = await client.post("/api/settings/helper-models", json={"models": {"lookup_model": "gpt"}})
    assert refused.status == 400 and "lookup_model must be one of" in (await refused.json())["error"]
