"""Project file endpoints: contracts kept from GilzaBots, every path confined to its project."""

import aiohttp
import pytest


def P(project):
    return str(project)


async def test_the_tree_lists_directories_first_and_hides_build_artifacts(client, project):
    data = await (await client.get("/api/files", params={"projectPath": P(project)})).json()
    names = [entry["name"] for entry in data["files"]]
    assert names == ["figs", "main.tex"]
    assert data["files"][0]["children"][0]["path"].replace("\\", "/") == "figs/a.png"

    shown = await (await client.get("/api/files", params={"projectPath": P(project), "showHiddenFiles": "true"})).json()
    assert "main.aux" in [entry["name"] for entry in shown["files"]]


async def test_read_and_write_preserve_line_endings(client, project):
    read = await (await client.get("/api/file/read", params={"projectPath": P(project), "filePath": "main.tex"})).json()
    assert read["content"] == "\\documentclass{article}\r\n"
    response = await client.post("/api/file/write", json={
        "projectPath": P(project), "filePath": "sub/new.md", "content": "a\r\nb\n"})
    assert (await response.json()) == {"success": True}
    assert (project / "sub" / "new.md").read_bytes() == b"a\r\nb\n"


async def test_exclusive_write_refuses_an_existing_file(client, project):
    response = await client.post("/api/file/write", json={
        "projectPath": P(project), "filePath": "main.tex", "content": "x", "exclusive": True})
    assert response.status == 409
    assert (await response.json())["code"] == "exists"
    assert "documentclass" in (project / "main.tex").read_text(encoding="utf-8")


@pytest.mark.parametrize("endpoint,payload", [
    ("/api/file/write", {"filePath": "../outside.txt", "content": "x"}),
    ("/api/file/mkdir", {"dirPath": "../outside"}),
    ("/api/file/delete", {"filePath": "../proj"}),
    ("/api/file/delete", {"filePath": "."}),
    ("/api/file/rename", {"oldPath": ".", "newPath": "x"}),
    ("/api/file/rename", {"oldPath": "main.tex", "newPath": "../main.tex"}),
    ("/api/file/copy", {"sourcePath": ".", "targetPath": "copy"}),
])
async def test_paths_outside_the_project_or_its_root_are_refused(client, project, endpoint, payload):
    response = await client.post(endpoint, json={"projectPath": P(project), **payload})
    assert response.status == 403
    assert project.exists() and (project / "main.tex").exists()
    assert not (project.parent / "outside.txt").exists()


async def test_read_refuses_traversal(client, project, tmp_path):
    (tmp_path / "secret.txt").write_text("s", encoding="utf-8")
    response = await client.get("/api/file/read", params={"projectPath": P(project), "filePath": "../secret.txt"})
    assert response.status == 403


async def test_a_sibling_folder_sharing_the_prefix_is_outside(client, project, tmp_path):
    sibling = tmp_path / "proj-other"
    sibling.mkdir()
    (sibling / "x.txt").write_text("x", encoding="utf-8")
    response = await client.get("/api/file/read", params={"projectPath": P(project), "filePath": "../proj-other/x.txt"})
    assert response.status == 403


async def test_raw_serves_bytes_with_ranges(client, project):
    response = await client.get("/api/file/raw", params={"projectPath": P(project), "filePath": "figs/a.png"})
    assert response.status == 200
    assert response.headers["Content-Type"] == "image/png"
    assert await response.read() == b"\x89PNG fake"
    partial = await client.get("/api/file/raw", params={"projectPath": P(project), "filePath": "figs/a.png"},
                               headers={"Range": "bytes=1-3"})
    assert partial.status == 206
    assert await partial.read() == b"PNG"


async def test_raw_resolves_dotdot_from_the_including_tex_file(client, project):
    (project / "chapters").mkdir()
    (project / "chapters" / "one.tex").write_text("\\includegraphics{../figs/a.png}", encoding="utf-8")
    response = await client.get("/api/file/raw", params={
        "projectPath": P(project), "filePath": "../figs/a.png", "sourceTex": "chapters/one.tex"})
    assert response.status == 200
    escaping = await client.get("/api/file/raw", params={
        "projectPath": P(project), "filePath": "../../secret", "sourceTex": "chapters/one.tex"})
    assert escaping.status == 403


async def test_mkdir_copy_rename_delete(client, project):
    assert (await client.post("/api/file/mkdir", json={"projectPath": P(project), "dirPath": "d/e"})).status == 200
    again = await client.post("/api/file/mkdir", json={"projectPath": P(project), "dirPath": "d/e", "exclusive": True})
    assert again.status == 409

    first = await (await client.post("/api/file/copy", json={
        "projectPath": P(project), "sourcePath": "main.tex", "targetPath": "main.tex"})).json()
    assert first["targetPath"] == "main_copy.tex"
    second = await (await client.post("/api/file/copy", json={
        "projectPath": P(project), "sourcePath": "main.tex", "targetPath": "main.tex"})).json()
    assert second["targetPath"] == "main_copy2.tex"
    folder = await client.post("/api/file/copy", json={"projectPath": P(project), "sourcePath": "figs", "targetPath": "figs2"})
    assert folder.status == 200 and (project / "figs2" / "a.png").exists()

    renamed = await client.post("/api/file/rename", json={
        "projectPath": P(project), "oldPath": "main_copy.tex", "newPath": "old/renamed.tex"})
    assert renamed.status == 200 and (project / "old" / "renamed.tex").exists()

    assert (await client.post("/api/file/delete", json={"projectPath": P(project), "filePath": "figs2"})).status == 200
    assert not (project / "figs2").exists()
    missing = await client.post("/api/file/delete", json={"projectPath": P(project), "filePath": "nope"})
    assert missing.status == 404


def _browser_multipart(fields: dict, filename: str, content: bytes) -> tuple[bytes, str]:
    """The body Chromium (WebView2) sends: the filename as raw UTF-8, per the HTML spec.

    aiohttp's own client percent-encodes filenames instead, which no browser does.
    """
    boundary = "----WebKitFormBoundaryGilzaCode"
    parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode()
             for k, v in fields.items()]
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
                 f"Content-Type: application/pdf\r\n\r\n".encode() + content + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


async def test_import_streams_the_upload_into_the_target_folder(client, project):
    body, content_type = _browser_multipart(
        {"projectPath": P(project), "targetDir": "figs"}, "relatório final.pdf", b"%PDF-1.7 data")
    data = await (await client.post("/api/file/import", data=body, headers={"Content-Type": content_type})).json()
    assert data == {"success": True, "filePath": "figs/relatório final.pdf"}
    assert (project / "figs" / "relatório final.pdf").read_bytes() == b"%PDF-1.7 data"


async def test_import_refuses_a_target_outside_the_project(client, project):
    form = aiohttp.FormData()
    form.add_field("projectPath", P(project))
    form.add_field("targetDir", "..")
    form.add_field("file", b"x", filename="x.txt")
    assert (await client.post("/api/file/import", data=form)).status == 403


async def test_import_requires_multipart(client, project):
    assert (await client.post("/api/file/import", json={"projectPath": P(project)})).status == 400


async def test_missing_parameters_are_400(client):
    assert (await client.get("/api/files")).status == 400
    assert (await client.get("/api/file/read", params={"projectPath": "x"})).status == 400
    assert (await client.post("/api/file/write", json={})).status == 400
