"""Atomic writes of the cloud sync survive a short-lived lock on Windows."""

import os

import pytest

from gilzacode.cloud import atomic
from gilzacode.cloud.scanner import ExclusionPolicy
from gilzacode.cloud.state import CloudSettings


class _SharingViolation(PermissionError):
    """What Windows raises while another process holds the file open."""

    @property
    def winerror(self):
        return 32


@pytest.fixture
def no_sleep(monkeypatch):
    delays = []
    monkeypatch.setattr(atomic.time, "sleep", delays.append)
    return delays


def _failing_then(real, failures, exc_factory):
    calls = {"count": 0}

    def operation(*args):
        calls["count"] += 1
        if calls["count"] <= failures:
            raise exc_factory()
        return real(*args)

    return operation, calls


def test_a_transient_lock_is_retried_until_the_replace_succeeds(tmp_path, monkeypatch, no_sleep):
    source = tmp_path / "new.tmp"
    source.write_text("fresh", encoding="utf-8")
    target = tmp_path / "target.json"
    operation, calls = _failing_then(os.replace, 2, lambda: _SharingViolation(13, "in use"))
    monkeypatch.setattr(os, "replace", operation)

    atomic.replace_file(str(source), str(target))

    assert target.read_text(encoding="utf-8") == "fresh"
    assert calls["count"] == 3
    assert len(no_sleep) == 2


def test_a_lock_that_does_not_clear_raises_after_a_bounded_number_of_attempts(tmp_path, monkeypatch, no_sleep):
    operation, calls = _failing_then(os.replace, 10**6, lambda: _SharingViolation(13, "in use"))
    monkeypatch.setattr(os, "replace", operation)

    with pytest.raises(PermissionError):
        atomic.replace_file(str(tmp_path / "a"), str(tmp_path / "b"))

    assert calls["count"] == len(atomic.RETRY_DELAYS_SECONDS) + 1


def test_other_errors_are_not_retried(tmp_path, monkeypatch, no_sleep):
    operation, calls = _failing_then(os.replace, 10**6, lambda: PermissionError(13, "denied"))
    monkeypatch.setattr(os, "replace", operation)

    with pytest.raises(PermissionError):
        atomic.replace_file(str(tmp_path / "a"), str(tmp_path / "b"))

    assert calls["count"] == 1
    assert no_sleep == []


def test_discarding_a_missing_file_is_not_an_error(tmp_path):
    atomic.discard_file(str(tmp_path / "gone.tmp"))


@pytest.mark.parametrize("rel_path", [
    ".sync-abc123.tmp",
    "chapters/.sync-abc123.tmp",
])
def test_sync_temp_files_are_never_mirrored(rel_path):
    assert ExclusionPolicy(CloudSettings(enabled=True)).reason_to_skip(rel_path) == "excluded"
