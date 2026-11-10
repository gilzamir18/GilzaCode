"""The background sync manager survives a pass that fails unexpectedly."""

from gilzacode.cloud import service


def test_an_unexpected_failure_is_reported_and_the_next_pass_can_run(tmp_path, monkeypatch):
    project_path = str(tmp_path)
    manager = service.CloudSyncManager()
    registration = service._Registration(project_name="alpha", project_path=project_path)
    manager._projects[service._key(project_path)] = registration

    def explode(*_args, **_kwargs):
        raise OSError("disk went away")

    monkeypatch.setattr(service, "sync_project", explode)

    outcome = manager._sync_blocking(
        "alpha", project_path, direction=service.TWO_WAY, dry_run=False, allow_bulk_delete=False,
    )

    assert "OSError" in outcome.error
    assert "disk went away" in outcome.error
    assert registration.last_outcome is outcome
    assert registration.running is False

    # The lock was released: a second pass runs rather than reporting that one
    # is already under way.
    second = manager._sync_blocking(
        "alpha", project_path, direction=service.TWO_WAY, dry_run=False, allow_bulk_delete=False,
    )
    assert "already running" not in second.error
