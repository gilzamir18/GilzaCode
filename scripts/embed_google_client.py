#!/usr/bin/env python
"""Inject the Google OAuth client that a build of GilzaCode ships with.

Without this file the Cloud sync panel can still connect, but only after the
user registers their own OAuth client and pastes it in. Running this before
PyInstaller is what turns the normal path into a single "Connect with Google"
click: the credentials land in
``gilzacode/cloud/providers/bundled_google_client.json``, which the packaged app
reads as package data.

The file is git-ignored on purpose. A desktop OAuth client is a *public* client
— its secret ships to every user and Google treats it as non-confidential,
protected by PKCE — but it still identifies one Google Cloud project, so it
belongs in the release pipeline's secret store, not in the repository.

    python scripts/embed_google_client.py --from-env
    python scripts/embed_google_client.py --client-id ... --client-secret ...
    python scripts/embed_google_client.py --from-file client_secret_xxx.json
    python scripts/embed_google_client.py --clear

Exit codes: 0 on success, 1 when the credentials are missing or unreadable.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

TARGET = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "gilzacode", "cloud", "providers", "bundled_google_client.json",
)


def read_console_file(path: str) -> tuple[str, str]:
    """Read a credentials file downloaded from the Google Cloud console."""
    with open(path, "r", encoding="utf-8") as handle:
        raw = json.load(handle)
    if not isinstance(raw, dict):
        raise ValueError("the credentials file must contain a JSON object")
    nested = raw.get("installed") or raw.get("web")
    if isinstance(nested, dict):
        raw = nested
    return str(raw.get("client_id", "") or "").strip(), str(raw.get("client_secret", "") or "").strip()


# Every Google OAuth client id ends with this domain; desktop client secrets
# start with the prefix below. A build that embeds anything else ships a client
# Google answers with "401 invalid_client — The OAuth client was not found",
# which the user only discovers when they press Connect.
CLIENT_ID_SUFFIX = ".apps.googleusercontent.com"
CLIENT_SECRET_PREFIX = "GOCSPX-"


def client_id_problem(client_id: str, client_secret: str) -> str:
    """Say why ``client_id`` cannot be a Google OAuth client id, or "" when it can."""
    if client_id.startswith(CLIENT_SECRET_PREFIX):
        return (
            f"the client id starts with {CLIENT_SECRET_PREFIX!r}, which is the shape of a "
            "client secret. GILZACODE_GDRIVE_CLIENT_ID (or --client-id) must hold the "
            f"client id, the value ending with {CLIENT_ID_SUFFIX!r}."
        )
    if not client_id.endswith(CLIENT_ID_SUFFIX):
        return f"the client id does not end with {CLIENT_ID_SUFFIX!r}."
    if client_secret and client_secret == client_id:
        return "the client secret is the same value as the client id."
    return ""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--client-id", default="")
    parser.add_argument("--client-secret", default="")
    parser.add_argument("--from-file", default="", help="credentials JSON from the Google Cloud console")
    parser.add_argument(
        "--from-env",
        action="store_true",
        help="read GILZACODE_GDRIVE_CLIENT_ID and GILZACODE_GDRIVE_CLIENT_SECRET",
    )
    parser.add_argument("--clear", action="store_true", help="remove the bundled client")
    args = parser.parse_args(argv)

    if args.clear:
        try:
            os.unlink(TARGET)
            print(f"Removed {TARGET}")
        except FileNotFoundError:
            print("No bundled client to remove.")
        return 0

    client_id, client_secret = args.client_id.strip(), args.client_secret.strip()
    if args.from_file:
        try:
            client_id, client_secret = read_console_file(args.from_file)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            print(f"Could not read {args.from_file}: {exc}", file=sys.stderr)
            return 1
    elif args.from_env:
        client_id = os.environ.get("GILZACODE_GDRIVE_CLIENT_ID", "").strip()
        client_secret = os.environ.get("GILZACODE_GDRIVE_CLIENT_SECRET", "").strip()

    if not client_id:
        print(
            "No client id given. Pass --client-id, --from-file or --from-env "
            "(GILZACODE_GDRIVE_CLIENT_ID).",
            file=sys.stderr,
        )
        return 1

    problem = client_id_problem(client_id, client_secret)
    if problem:
        # The id is never echoed here: when it is wrong it may well be the secret.
        print(f"Refusing to embed the Google OAuth client: {problem}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    with open(TARGET, "w", encoding="utf-8") as handle:
        json.dump({"client_id": client_id, "client_secret": client_secret}, handle, indent=2)
        handle.write("\n")
    # The id is not secret; the secret is never printed, so a CI log stays clean.
    print(f"Wrote {TARGET} for client {client_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
