"""Cloud sync endpoints (``/api/cloud/*``), ported from GilzaBots' IDE server.

The engine and its scheduling live in :mod:`gilzacode.cloud`; these handlers
only translate requests. Provider I/O (Drive round-trips, a whole pass, the
browser leg of an authorization) blocks, so it always runs in a worker thread:
the editor, the compiler and the Claude Code panel must stay responsive while a
pass or an authorization is under way.

GilzaBots also synced the project's conversations; GilzaCode has none (Claude
Code keeps its sessions outside the project), so nothing here mentions them.
"""

from __future__ import annotations

import asyncio
import os

from aiohttp import web

from gilzacode import projects
from gilzacode.cloud import oauth as cloud_oauth
from gilzacode.cloud.base import CloudError
from gilzacode.cloud.engine import PULL, PUSH, TWO_WAY
from gilzacode.cloud.registry import get_cloud_provider, list_providers
from gilzacode.cloud.service import (
    MANAGER,
    clone_project,
    cloud_link,
    file_states,
    list_remote_projects,
    prepare_destination,
    request_cancel,
    resolve_conflict,
    status_for,
    update_settings,
)
from gilzacode.cloud.state import load_state, reset_baseline
from gilzacode.server.app import error, read_json

routes = web.RouteTableDef()


def notify_change(project_path: str | None) -> None:
    """Tell the sync manager that an endpoint wrote into this project.

    Cheap and never raises: it only sets an event, and a project without cloud
    sync enabled is not even registered. Mirroring must never be able to break
    an editor save. Writes no endpoint sees (Claude Code's) are caught by the
    manager's local watch instead.
    """
    if not project_path:
        return
    try:
        MANAGER.notify_local_change(project_path)
    except Exception:
        pass


def _auth_payload(auth) -> dict:
    return {"connected": auth.connected, "account": auth.account, "error": auth.error}


# -- project status and settings ------------------------------------------------

@routes.get("/api/cloud/status")
async def status(request: web.Request) -> web.Response:
    """Providers, connection and last pass for one project.

    Opening a project is what starts (or stops) its background sync: the
    front-end asks for this when a project becomes active, so no separate
    lifecycle hook is needed.
    """
    project_path = request.query.get("projectPath")
    project_name = request.query.get("project", "")
    if not project_path:
        return error(400, "projectPath parameter is required")
    try:
        payload = await asyncio.to_thread(status_for, project_path, project_name)
        if project_name:
            MANAGER.activate(project_name, project_path)
        payload["syncing"] = MANAGER.is_running(project_path)
        last = MANAGER.last_outcome(project_path)
        payload["last_outcome"] = last.to_dict() if last else None
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response(payload)


@routes.get("/api/cloud/link")
async def link(request: web.Request) -> web.Response:
    """Whether the project has a cloud copy; local state only, never the network."""
    project_path = request.query.get("projectPath")
    if not project_path:
        return error(400, "projectPath parameter is required")
    try:
        return web.json_response(await asyncio.to_thread(cloud_link, project_path))
    except Exception as exc:
        return error(500, str(exc))


@routes.get("/api/cloud/file-states")
async def file_states_endpoint(request: web.Request) -> web.Response:
    """Per-file state for the explorer's badges."""
    project_path = request.query.get("projectPath")
    if not project_path:
        return error(400, "projectPath parameter is required")
    try:
        last = MANAGER.last_outcome(project_path)
        conflicts = [c.rel_path for c in ((last.report.conflicts if last and last.report else []) or [])]
        return web.json_response(await asyncio.to_thread(file_states, project_path, conflicts))
    except Exception as exc:
        return error(500, str(exc))


@routes.post("/api/cloud/settings")
async def settings(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path = data.get("projectPath")
    project_name = data.get("project", "")
    if not project_path:
        return error(400, "projectPath is required")
    try:
        update_settings(project_path, data.get("settings") or {})
        if project_name:
            MANAGER.activate(project_name, project_path)
        else:
            MANAGER.deactivate(project_path)
        return web.json_response(await asyncio.to_thread(status_for, project_path, project_name))
    except Exception as exc:
        return error(500, str(exc))


# -- providers and authorization ---------------------------------------------------

@routes.get("/api/cloud/providers")
async def providers(_request: web.Request) -> web.Response:
    payload = [
        {
            "id": info.id,
            "display_name": info.display_name,
            "requires_authorization": info.requires_authorization,
            "available": info.available,
            "unavailable_reason": info.unavailable_reason,
        }
        for info in list_providers()
    ]
    return web.json_response({"providers": payload})


@routes.get("/api/cloud/google-client")
async def google_client(_request: web.Request) -> web.Response:
    """Which Google OAuth client this installation connects with.

    Normally the one shipped with the build, so the user only presses Connect;
    the custom fields are the advanced override. No secret is ever returned:
    they are write-only from the UI's point of view.
    """
    from gilzacode.cloud.providers.google_drive import (
        describe_client_config,
        load_bundled_client_config,
        load_user_client_config,
    )

    effective = describe_client_config()
    custom = load_user_client_config()
    return web.json_response({
        "client_id": effective.get("client_id", ""),
        "has_client_secret": bool(effective.get("client_secret")),
        "source": effective.get("source", "none"),
        "configured": bool(effective.get("client_id")),
        "bundled_available": bool(load_bundled_client_config().get("client_id")),
        "custom_client_id": custom.get("client_id", ""),
        "has_custom_client_secret": bool(custom.get("client_secret")),
    })


@routes.post("/api/cloud/google-client")
async def save_google_client(request: web.Request) -> web.Response:
    from gilzacode.cloud.providers.google_drive import load_user_client_config, save_client_config

    data = await read_json(request)
    client_id = str(data.get("client_id", "") or "").strip()
    if not client_id:
        return error(400, "client_id is required. Use DELETE to go back to the client shipped with GilzaCode.")
    # An empty secret keeps the stored one, so the user can correct the client
    # id without re-entering a secret they cannot read back.
    client_secret = str(data.get("client_secret", "") or "")
    if not client_secret:
        client_secret = load_user_client_config().get("client_secret", "")
    try:
        save_client_config(client_id, client_secret)
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"success": True})


@routes.delete("/api/cloud/google-client")
async def clear_google_client(_request: web.Request) -> web.Response:
    """Drop the override and go back to the client the build ships with."""
    from gilzacode.cloud.providers.google_drive import clear_client_config

    try:
        clear_client_config()
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"success": True})


@routes.post("/api/cloud/connect")
async def connect(request: web.Request) -> web.Response:
    """Start an authorization; the page opens the returned URL in the browser."""
    data = await read_json(request)
    provider_id = str(data.get("provider", "") or "")
    if not provider_id:
        return error(400, "provider is required")
    try:
        provider = get_cloud_provider(provider_id, data.get("config") or {})
        challenge = await asyncio.to_thread(provider.begin_authorization)
    except CloudError as exc:
        return error(400, str(exc))
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({
        "authorization_url": challenge.authorization_url,
        "session": challenge.session,
        "instructions": challenge.instructions,
    })


@routes.post("/api/cloud/connect/complete")
async def connect_complete(request: web.Request) -> web.Response:
    """Wait for the redirect and exchange the code (blocks until the browser is done)."""
    data = await read_json(request)
    provider_id = str(data.get("provider", "") or "")
    session = data.get("session") or {}
    if not provider_id or not session:
        return error(400, "provider and session are required")
    try:
        provider = get_cloud_provider(provider_id, data.get("config") or {})
        auth = await asyncio.to_thread(provider.complete_authorization, session, data.get("response") or None)
    except CloudError as exc:
        return error(400, str(exc))
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response(_auth_payload(auth))


@routes.post("/api/cloud/connect/cancel")
async def connect_cancel(request: web.Request) -> web.Response:
    data = await read_json(request)
    try:
        cloud_oauth.cancel_authorization(data.get("session") or {})
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"success": True})


@routes.post("/api/cloud/disconnect")
async def disconnect(request: web.Request) -> web.Response:
    """Forget the stored credentials."""
    data = await read_json(request)
    provider_id = str(data.get("provider", "") or "")
    if not provider_id:
        return error(400, "provider is required")
    try:
        provider = get_cloud_provider(provider_id, data.get("config") or {})
        await asyncio.to_thread(provider.revoke)
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"success": True})


@routes.post("/api/cloud/auth-status")
async def auth_status(request: web.Request) -> web.Response:
    """Is this backend usable now? Needs no project: downloading one is the case without one."""
    data = await read_json(request)
    provider_id = str(data.get("provider", "") or "")
    if not provider_id:
        return error(400, "provider is required")
    try:
        backend = get_cloud_provider(provider_id, data.get("config") or {})
        auth = await asyncio.to_thread(backend.auth_status)
    except CloudError as exc:
        return web.json_response({"connected": False, "account": "", "error": str(exc)})
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response(_auth_payload(auth))


# -- passes ----------------------------------------------------------------------

@routes.post("/api/cloud/sync")
async def sync(request: web.Request) -> web.Response:
    data = await read_json(request)
    project_path = data.get("projectPath")
    project_name = data.get("project", "")
    if not project_path or not project_name:
        return error(400, "projectPath and project are required")
    direction = str(data.get("direction", TWO_WAY) or TWO_WAY)
    if direction not in (TWO_WAY, PUSH, PULL):
        return error(400, f"Unknown direction {direction!r}. Use one of: {TWO_WAY}, {PUSH}, {PULL}.")
    try:
        outcome = await MANAGER.sync_now(
            project_name,
            project_path,
            direction=direction,
            dry_run=bool(data.get("dryRun")),
            # Deleting a large share of the working copy needs the user's
            # explicit confirmation, relayed here.
            allow_bulk_delete=bool(data.get("allowBulkDelete")),
        )
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response(outcome.to_dict())


@routes.post("/api/cloud/cancel")
async def cancel(request: web.Request) -> web.Response:
    """Stop the pass for a path: a sync, a preview and a download alike."""
    data = await read_json(request)
    project_path = data.get("projectPath")
    if not project_path:
        return error(400, "projectPath is required")
    return web.json_response({"cancel_requested": request_cancel(project_path)})


@routes.post("/api/cloud/reset")
async def reset(request: web.Request) -> web.Response:
    """Drop the baseline so the next pass reconciles from scratch."""
    data = await read_json(request)
    project_path = data.get("projectPath")
    if not project_path:
        return error(400, "projectPath is required")
    try:
        reset_baseline(project_path)
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"success": True})


@routes.post("/api/cloud/resolve-conflict")
async def resolve(request: web.Request) -> web.Response:
    """Settle one conflicted file the way the user chose."""
    data = await read_json(request)
    project_path = data.get("projectPath")
    project_name = data.get("project", "")
    rel_path = str(data.get("path", "") or "")
    resolution = str(data.get("resolution", "") or "")
    if not project_path or not rel_path:
        return error(400, "projectPath and path are required")
    try:
        result = await asyncio.to_thread(
            resolve_conflict, project_path, rel_path, resolution,
            conflict_copy=str(data.get("conflict_copy", "") or ""),
        )
        payload = await asyncio.to_thread(status_for, project_path, project_name)
    except (CloudError, OSError) as exc:
        return error(400, str(exc))
    except Exception as exc:
        return error(500, str(exc))
    payload["syncing"] = MANAGER.is_running(project_path)
    return web.json_response({"success": True, "resolved": result, "status": payload})


# -- another machine's projects ------------------------------------------------------

def _mirrored_here(provider_id: str) -> dict[str, dict]:
    """Remote folder -> local project, for the projects this machine already mirrors.

    Such a project must not be offered as a download: a second clone would give
    one remote folder two local working copies fighting over it.
    """
    mirrored = {}
    for project in projects.list_projects():
        if not project.project_path or not os.path.isdir(project.project_path):
            continue
        cloud = load_state(project.project_path).settings
        if cloud.provider != provider_id or not cloud.remote_folder:
            continue
        mirrored[cloud.remote_folder] = {
            "name": project.name,
            "project_name": project.project_name,
            "project_path": project.project_path,
        }
    return mirrored


@routes.post("/api/cloud/remote-projects")
async def remote_projects(request: web.Request) -> web.Response:
    """The projects already mirrored in an account, so a second machine can find them."""
    data = await read_json(request)
    provider_id = str(data.get("provider", "") or "")
    if not provider_id:
        return error(400, "provider is required")
    try:
        found = await asyncio.to_thread(list_remote_projects, provider_id, data.get("config") or {})
        mirrored = await asyncio.to_thread(_mirrored_here, provider_id)
    except (CloudError, projects.ProjectError) as exc:
        return error(400, str(exc))
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"projects": [
        {"name": p.name, "root": p.root, "modified_at": p.modified_at, "local": mirrored.get(p.name)}
        for p in found
    ]})


def _failed_clone_message(outcome) -> str:
    """Why a download stopped, and where a retry has to go.

    Whatever arrived is left on disk to be inspected rather than deleted, so the
    folder is no longer empty; saying so spares the user a puzzling "not empty"
    on the second attempt.
    """
    report = outcome.report
    message = outcome.error or (report.aborted if report else "")
    if not message and report and report.errors:
        message = report.errors[0][1]
    message = message or "The download did not complete."
    if report is not None and not outcome.cancelled:
        message += (f" A partial copy is in {outcome.project_path}; remove that "
                    f"folder or choose another name before trying again.")
    return message


@routes.post("/api/cloud/clone")
async def clone(request: web.Request) -> web.Response:
    """Download a mirrored project onto this machine and register it."""
    data = await read_json(request)
    provider_id = str(data.get("provider", "") or "")
    remote_name = str(data.get("name", "") or "").strip()
    parent_path = str(data.get("parentPath", "") or "").strip()
    folder_name = str(data.get("folderName", "") or "").strip() or remote_name
    if not provider_id or not remote_name or not parent_path:
        return error(400, "provider, name and parentPath are required")
    if (os.sep in folder_name or (os.altsep and os.altsep in folder_name)
            or folder_name in {".", ".."}):
        return error(400, "folderName must be a single folder name, not a path.")

    destination = os.path.join(os.path.abspath(os.path.expanduser(parent_path)), folder_name)
    # Checked before anything is transferred: a download that lands where it
    # cannot be registered is wasted work.
    try:
        existing = next((p for p in projects.list_projects()
                         if os.path.normcase(os.path.abspath(p.project_path)) == os.path.normcase(destination)), None)
    except projects.ProjectError as exc:
        return error(500, str(exc))
    if existing:
        return error(400, f"This folder is already the project '{existing.project_name}'.")
    # Recorded before validation creates the folder, so a cancelled download
    # removes a folder it created and keeps one the user made.
    destination_is_new = not os.path.exists(destination)
    try:
        prepare_destination(destination)
    except CloudError as exc:
        return error(400, str(exc))

    try:
        outcome = await asyncio.to_thread(
            clone_project,
            provider_id,
            remote_name,
            destination,
            provider_config=data.get("config") or {},
            remote_root=str(data.get("root", "") or ""),
            settings_overrides=data.get("settings") or {},
            destination_is_new=destination_is_new,
        )
    except Exception as exc:
        return error(500, str(exc))

    if outcome.cancelled and not outcome.error:
        # The user stopped it; the partial copy is already gone, so this is not
        # an error and there is nothing to register.
        return web.json_response({
            "cancelled": True,
            "project_path": outcome.project_path,
            "partial_copy_removed": outcome.partial_copy_removed,
        })
    if not outcome.ok:
        return error(400, _failed_clone_message(outcome), project_path=outcome.project_path,
                     report=outcome.report.to_dict() if outcome.report else None)

    try:
        project = projects.add(folder_name, destination, must_exist=True)
    except projects.ProjectError as exc:
        return error(400, f"The project was downloaded to {destination} but could not be registered: {exc}")
    MANAGER.activate(project.name, project.project_path)
    payload = project.to_json()
    payload["report"] = outcome.report.to_dict() if outcome.report else None
    return web.json_response(payload)


def setup(app: web.Application) -> None:
    async def stop_background_sync(_app: web.Application) -> None:
        MANAGER.shutdown()

    app.on_cleanup.append(stop_background_sync)
