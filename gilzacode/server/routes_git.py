"""The Git view: status, diff, log, stage, discard, commit, file at HEAD.

GilzaBots' restore and archive endpoints served its agent checkpoint history
only (the user-repository view never offers them), so they are not ported.

Contracts are GilzaBots'. Every Git command runs in a worker thread under the
ordering lock (`EXCLUSIVE_WORK_PATHS`): ``git status`` is polled and can take
seconds on Windows, and Git operations must not interleave with saves.
"""

from __future__ import annotations

import asyncio
import os

from aiohttp import web

from gilzacode import git_repo
from gilzacode.git_repo import GitContextError
from gilzacode.server.app import EXCLUSIVE_WORK_PATHS, error, read_json

routes = web.RouteTableDef()

EXCLUSIVE_WORK_PATHS.update({f"/api/git/{name}" for name in (
    "status", "diff", "log", "stage", "discard", "commit", "file-at-head")})


def _truthy(value) -> bool:
    return str(value).lower() == "true" or value is True


def _context(params) -> git_repo.GitContext:
    return git_repo.resolve(params.get("projectPath") or "", params.get("gitRootPath") or None,
                            shadow=_truthy(params.get("shadow", False)))


async def _in_thread(work) -> web.Response:
    try:
        return await asyncio.to_thread(work)
    except GitContextError as exc:
        return error(400, str(exc))
    except Exception as exc:  # Git and filesystem failures of every kind
        return error(500, str(exc))


@routes.get("/api/git/status")
async def status(request: web.Request) -> web.Response:
    query = request.query
    if not query.get("projectPath") or not os.path.exists(query["projectPath"]):
        return error(400, "Invalid project path")
    try:
        files = await asyncio.to_thread(lambda: git_repo.status(_context(query)))
    except GitContextError as exc:
        # No repository is a state of the project, not a failure.
        return web.json_response({"files": [], "git_available": False, "error": str(exc)})
    except Exception as exc:
        return error(500, str(exc))
    return web.json_response({"files": files, "git_available": True})


@routes.get("/api/git/file-at-head")
async def file_at_head(request: web.Request) -> web.Response:
    query = request.query
    if not query.get("projectPath") or not query.get("filePath"):
        return error(400, "projectPath and filePath are required")

    def work():
        try:
            ctx = _context(query)
        except GitContextError as exc:
            return web.json_response({"content": "", "source": "none", "git_available": False, "error": str(exc)})
        shown = ctx.run("show", f"HEAD:{git_repo.to_repo_path(query['filePath'], ctx)}")
        if shown.returncode != 0:
            return web.json_response({"error": "Not found in git"})
        return web.json_response({"content": shown.stdout, "source": "git"})

    return await _in_thread(work)


@routes.get("/api/git/diff")
async def diff(request: web.Request) -> web.Response:
    """The working diff (one file or all), a commit's diff, or a range ``commit..endCommit``."""
    query = request.query
    project_path, file_path = query.get("projectPath"), query.get("filePath")
    commit, end_commit = query.get("commit"), query.get("endCommit")
    if not project_path or not os.path.exists(project_path):
        return error(400, "Invalid project path")

    def work():
        ctx = _context(query)
        pathspec = ["--", git_repo.to_repo_path(file_path, ctx)] if file_path else []
        if commit:
            if not git_repo.verify_commit(ctx, commit):
                return error(400, "Invalid commit")
            if end_commit:
                if not git_repo.verify_commit(ctx, end_commit):
                    return error(400, "Invalid endCommit")
                result = ctx.run("diff", commit, end_commit, *pathspec)
            elif ctx.run("rev-parse", "--verify", f"{commit}^").returncode == 0:
                result = ctx.run("diff", f"{commit}^", commit, *pathspec)
            else:  # the root commit has no parent
                result = ctx.run("show", "--format=", "--find-renames", commit, *pathspec)
            return web.json_response({"diff": result.stdout})
        if file_path:
            repo_path = pathspec[1]
            tracked = ctx.run("ls-files", "--", repo_path).stdout.strip()
            full = os.path.join(project_path, file_path)
            if not tracked and os.path.isfile(full):
                return web.json_response({"diff": ctx.run("diff", "--no-index", "/dev/null", repo_path).stdout})
            if not tracked and os.path.isdir(full):
                return web.json_response({"diff": f"(untracked folder: {file_path})"})
        return web.json_response({"diff": ctx.run("diff", *pathspec).stdout + ctx.run("diff", "--cached", *pathspec).stdout})

    return await _in_thread(work)


@routes.get("/api/git/log")
async def log(request: web.Request) -> web.Response:
    query = request.query
    try:
        limit = max(1, min(200, int(query.get("limit", "20"))))
        offset = max(0, int(query.get("offset", "0")))
    except ValueError:
        return error(400, "Invalid pagination parameters")
    if not query.get("projectPath") or not os.path.exists(query["projectPath"]):
        return error(400, "Invalid project path")

    def work():
        ctx = _context(query)
        result = ctx.run("log", f"--max-count={limit + 1}", f"--skip={offset}", "--pretty=format:%H|%h|%an|%ar|%s")
        commits = []
        for line in result.stdout.splitlines():
            parts = line.split("|", 4)
            if len(parts) == 5:
                commits.append(dict(zip(("hash", "short", "author", "date", "message"), parts)))
        return web.json_response({"commits": commits[:limit], "limit": limit, "offset": offset,
                                  "has_more": len(commits) > limit})

    return await _in_thread(work)


@routes.post("/api/git/stage")
async def stage(request: web.Request) -> web.Response:
    """Stage or unstage one path, or every change with ``filePath: "__all__"``."""
    data = await read_json(request)
    file_path, action = data.get("filePath"), data.get("action", "stage")
    if not data.get("projectPath") or not file_path:
        return error(400, "projectPath and filePath required")
    if action not in ("stage", "unstage"):
        return error(400, "action must be stage or unstage")

    def work():
        ctx = _context(data)
        target = "." if file_path == "__all__" else git_repo.to_repo_path(file_path, ctx)
        if action == "stage":
            args = ("add", "--all", "--", target) if file_path == "__all__" else ("add", "--", target)
        else:
            args = ("restore", "--staged", "--", target)
        result = ctx.run(*args)
        if result.returncode != 0:
            raise RuntimeError(result.stderr or result.stdout or f"git {args[0]} failed")
        return web.json_response({"success": True})

    return await _in_thread(work)


@routes.post("/api/git/discard")
async def discard(request: web.Request) -> web.Response:
    data = await read_json(request)
    if not data.get("projectPath") or not data.get("filePath"):
        return error(400, "projectPath and filePath required")

    def work():
        ctx = _context(data)
        git_repo.discard(ctx, git_repo.to_repo_path(data["filePath"], ctx))
        return web.json_response({"success": True})

    return await _in_thread(work)


@routes.post("/api/git/commit")
async def commit(request: web.Request) -> web.Response:
    """Commit what is staged; nothing is added implicitly."""
    data = await read_json(request)
    message = data.get("message", "update")
    if not data.get("projectPath"):
        return error(400, "projectPath is required")
    if not isinstance(message, str) or not message.strip():
        return error(400, "A commit message is required.")

    def work():
        result = _context(data).run("commit", "-m", message)
        if result.returncode == 0:
            return web.json_response({"success": True})
        if "nothing to commit" in result.stdout or "nothing added to commit" in result.stdout:
            return error(400, "Nothing to commit: stage the changes first.")
        raise RuntimeError(result.stderr or result.stdout or "Git commit failed")

    return await _in_thread(work)
