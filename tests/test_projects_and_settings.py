"""Projects registry, folder picker, interface settings."""

import json
import os

from gilzacode import projects, settings


async def test_create_import_list_rename_delete(client, tmp_path, project):
    created = await (await client.post("/api/projects/create", json={
        "project_name": "My Thesis", "project_path": str(tmp_path / "thesis")})).json()
    assert created["name"] == "my_thesis" and created["exists"] is True
    assert (tmp_path / "thesis").is_dir()

    imported = await (await client.post("/api/projects/import", json={"project_path": str(project)})).json()
    assert imported["project_name"] == "proj"

    listing = await (await client.get("/api/projects/list")).json()
    assert [p["name"] for p in listing["projects"]] == ["my_thesis", "proj"]
    assert listing["last_active_project"] == ""

    await client.post("/api/settings/last-project", json={"project_name": "proj"})
    renamed = await (await client.post("/api/projects/update", json={
        "name": "proj", "changes": {"project_name": "Paper", "main_file": "main.tex"}})).json()
    assert renamed["project_name"] == "Paper" and renamed["main_file"] == "main.tex"

    assert (await client.post("/api/projects/delete", json={"name": "proj"})).status == 200
    assert project.exists()  # unregistering never deletes the folder by default
    listing = await (await client.get("/api/projects/list")).json()
    assert [p["name"] for p in listing["projects"]] == ["my_thesis"]
    assert listing["last_active_project"] == ""

    await client.post("/api/projects/delete", json={"name": "my_thesis", "delete_dir": True})
    assert not (tmp_path / "thesis").exists()


async def test_the_same_folder_cannot_be_two_projects(client, project):
    await client.post("/api/projects/import", json={"project_path": str(project)})
    again = await client.post("/api/projects/import", json={"project_path": str(project).upper()})
    assert again.status == 400
    assert "already the project" in (await again.json())["error"]


async def test_import_requires_an_existing_folder(client, tmp_path):
    response = await client.post("/api/projects/import", json={"project_path": str(tmp_path / "nope")})
    assert response.status == 400
    assert not (tmp_path / "nope").exists()


async def test_a_file_is_not_a_project_folder(client, project):
    response = await client.post("/api/projects/create", json={"project_path": str(project / "main.tex")})
    assert response.status == 400


async def test_names_get_unique_keys(client, tmp_path):
    for i in range(2):
        await client.post("/api/projects/create", json={"project_name": "Notes", "project_path": str(tmp_path / f"n{i}")})
    assert [p.name for p in projects.list_projects()] == ["notes", "notes_1"]


async def test_a_corrupt_registry_is_reported_not_overwritten(client, isolated_home, tmp_path):
    isolated_home.mkdir(parents=True, exist_ok=True)
    (isolated_home / "projects.json").write_text("{broken", encoding="utf-8")
    assert (await client.get("/api/projects/list")).status == 500
    response = await client.post("/api/projects/create", json={"project_path": str(tmp_path / "x")})
    assert response.status == 400
    assert (isolated_home / "projects.json").read_text(encoding="utf-8") == "{broken"


async def test_folder_picker_keeps_navigation_when_listing_fails(client, tmp_path, monkeypatch):
    (tmp_path / "a").mkdir()
    (tmp_path / ".hidden").mkdir()
    data = await (await client.post("/api/fs/dirs", json={"path": str(tmp_path)})).json()
    names = [d["name"] for d in data["dirs"]]
    assert names[0] == ".." and "a" in names and ".hidden" not in names

    def denied(_path):
        raise PermissionError("denied")

    monkeypatch.setattr(os, "listdir", denied)
    response = await client.post("/api/fs/dirs", json={"path": str(tmp_path)})
    assert response.status == 403
    assert [d["name"] for d in (await response.json())["dirs"]] == [".."]


async def test_client_prefs_round_trip_and_validation(client, isolated_home):
    await client.post("/api/settings/client-prefs", json={"set": {"theme": "dark", "zoom": "1.2"}})
    await client.post("/api/settings/client-prefs", json={"remove": ["zoom"]})
    assert (await (await client.get("/api/settings/client-prefs")).json()) == {"prefs": {"theme": "dark"}, "imported": False}
    bad = await client.post("/api/settings/client-prefs", json={"set": {"n": 1}})
    assert bad.status == 400
    stored = json.loads((isolated_home / "settings.json").read_text(encoding="utf-8"))
    assert stored["client_prefs"] == {"theme": "dark"}


async def test_appearance_is_clamped(client):
    data = await (await client.post("/api/settings/appearance", json={"ui_scale": 9})).json()
    assert data["ui_scale"] == settings.UI_SCALE_MAX
    data = await (await client.post("/api/settings/appearance", json={"ui_scale": "nan"})).json()
    assert data["ui_scale"] == 1.0


async def test_language_and_workspace(client):
    await client.post("/api/settings/language", json={"lang": "pt-BR"})
    assert (await (await client.get("/api/settings/language")).json()) == {"lang": "pt-BR"}
    data = await (await client.post("/api/settings/workspace", json={"show_hidden_workspace_files": True})).json()
    assert data["show_hidden_workspace_files"] is True and ".aux" in data["hidden_file_extensions"]


def test_a_corrupt_settings_file_reads_as_defaults(isolated_home):
    isolated_home.mkdir(parents=True, exist_ok=True)
    (isolated_home / "settings.json").write_text("not json", encoding="utf-8")
    assert settings.load()["ui_scale"] == 1.0


async def test_update_refuses_unknown_or_mistyped_fields_and_outside_main_files(client, project):
    await client.post("/api/projects/import", json={"project_path": str(project)})
    for changes in ({"model": "x"}, {"compile_on_save_full": "yes"}, {"main_file": "../x.tex"}, {"project_name": " "}):
        response = await client.post("/api/projects/update", json={"name": "proj", "changes": changes})
        assert response.status == 400, changes
    data = await (await client.post("/api/projects/update", json={"name": "proj", "changes": {
        "compile_on_save_partial": True}})).json()
    assert data["compile_on_save_partial"] is True
    data = await (await client.post("/api/projects/update", json={"name": "proj", "changes": {
        "compile_on_save_full": True}})).json()
    assert data["compile_on_save_full"] is True and data["compile_on_save_partial"] is False


def test_a_registry_written_before_a_field_existed_still_loads(isolated_home):
    import json as _json
    isolated_home.mkdir(parents=True, exist_ok=True)
    (isolated_home / "projects.json").write_text(_json.dumps({"projects": [
        {"name": "a", "project_name": "A", "project_path": "C:/x", "created_at": 1.0}]}), encoding="utf-8")
    assert projects.list_projects()[0].main_file == ""


async def test_the_legacy_localstorage_import_runs_once_and_never_overwrites(client):
    await client.post("/api/settings/client-prefs", json={"set": {"theme": "light"}})
    first = await (await client.post("/api/settings/client-prefs", json={
        "set": {"theme": "dark", "zoom": "2", "lastActiveProject": "p"}, "legacy_import": True})).json()
    assert first["applied"] is True
    second = await (await client.post("/api/settings/client-prefs", json={
        "set": {"zoom": "9"}, "legacy_import": True})).json()
    assert second["applied"] is False
    data = await (await client.get("/api/settings/client-prefs")).json()
    assert data == {"prefs": {"theme": "light", "zoom": "2"}, "imported": True}
    assert settings.load()["last_active_project"] == "p"
