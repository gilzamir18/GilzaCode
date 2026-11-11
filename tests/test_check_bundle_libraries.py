"""Tests for the build gate that refuses a Linux bundle missing libraries.

Copied from GilzaBots, where a release shipped without the nine X11 client
libraries Qt's xcb platform plugin links: the build runner did not have them and
PyInstaller only warns about a dependency it cannot find. On a stock desktop the
application then aborted with "no Qt platform plugin could be initialized".
These tests hold the gate to telling a bundled library from one that only the
build machine had, and hold the build to installing and checking them.
"""

import importlib.util
import os
import platform
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location(
    "check_bundle_libraries", ROOT / "scripts" / "check_bundle_libraries.py"
)
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)

XCB_PLUGIN = "PyQt6/Qt6/plugins/platforms/libqxcb.so"
XCB_LIBRARIES = (
    "libxcb-cursor0",
    "libxcb-icccm4",
    "libxcb-image0",
    "libxcb-keysyms1",
    "libxcb-render-util0",
    "libxcb-shape0",
    "libxcb-util1",
    "libxcb-xkb1",
    "libxkbcommon-x11-0",
)


def _host_stack(soname):
    return soname.startswith(("libc.so", "libm.so", "libGL.so", "libxcb.so"))


def _bundle(tmp_path, *files):
    bundle = tmp_path / "GilzaCode"
    internal = bundle / "_internal"
    for relative in files:
        target = internal / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"\x7fELF")
    return bundle, internal


def test_parse_ldd_reads_resolved_and_missing_libraries():
    output = (
        "\tlinux-vdso.so.1 (0x00007ffc)\n"
        "\tlibxcb-cursor.so.0 => /lib/x86_64-linux-gnu/libxcb-cursor.so.0 (0x00007d51)\n"
        "\tlibxcb-icccm.so.4 => not found\n"
        "\t/lib64/ld-linux-x86-64.so.2 (0x00007d52)\n"
    )

    assert gate.parse_ldd(output) == [
        ("libxcb-cursor.so.0", "/lib/x86_64-linux-gnu/libxcb-cursor.so.0"),
        ("libxcb-icccm.so.4", None),
    ]


def test_a_library_only_the_build_machine_has_is_refused(tmp_path):
    bundle, internal = _bundle(tmp_path, XCB_PLUGIN, "libxcb-randr.so.0")
    ldd_output = (
        f"\tlibxcb-randr.so.0 => {internal}/libxcb-randr.so.0 (0x1)\n"
        "\tlibxcb-cursor.so.0 => /lib/x86_64-linux-gnu/libxcb-cursor.so.0 (0x2)\n"
        "\tlibxcb-icccm.so.4 => not found\n"
    )

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output, leaves_to_host=_host_stack
    )

    assert len(problems) == 2
    assert "libxcb-cursor.so.0" in problems[0] and XCB_PLUGIN in problems[0]
    assert "/lib/x86_64-linux-gnu/libxcb-cursor.so.0" in problems[0]
    assert "libxcb-icccm.so.4" in problems[1] and "not installed on the build machine" in problems[1]


def test_libraries_pyinstaller_leaves_to_the_host_are_allowed(tmp_path):
    """glibc, the GL driver stack and libxcb.so.1 must come from the user's system."""
    bundle, _ = _bundle(tmp_path, XCB_PLUGIN)
    ldd_output = (
        "\tlibGL.so.1 => /lib/x86_64-linux-gnu/libGL.so.1 (0x1)\n"
        "\tlibxcb.so.1 => /lib/x86_64-linux-gnu/libxcb.so.1 (0x2)\n"
        "\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x3)\n"
    )

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output, leaves_to_host=_host_stack
    )

    assert problems == []


@pytest.mark.skipif(os.name == "nt", reason="creating a symlink needs a privilege on Windows; the gate runs on Linux")
def test_a_library_reached_through_a_bundled_symlink_counts_as_bundled(tmp_path):
    bundle, internal = _bundle(tmp_path, XCB_PLUGIN, "PyQt6/Qt6/lib/libQt6XcbQpa.so.6")
    (internal / "libQt6XcbQpa.so.6").symlink_to(internal / "PyQt6/Qt6/lib/libQt6XcbQpa.so.6")
    ldd_output = f"\tlibQt6XcbQpa.so.6 => {internal}/libQt6XcbQpa.so.6 (0x1)\n"

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output, leaves_to_host=_host_stack
    )

    assert problems == []


def test_a_missing_startup_binary_is_reported_rather_than_skipped(tmp_path):
    """A gate that checks nothing must not pass: a moved plugin means ROOTS is stale."""
    bundle, _ = _bundle(tmp_path)

    problems = gate.bundle_problems(
        bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: "", leaves_to_host=_host_stack
    )

    assert len(problems) == 1
    assert XCB_PLUGIN in problems[0] and "update ROOTS" in problems[0]


def test_the_gate_covers_the_xcb_platform_plugin():
    assert XCB_PLUGIN in gate.ROOTS


@pytest.mark.skipif(platform.system() != "Linux" or not shutil.which("ldd"), reason="needs Linux ldd")
def test_real_ldd_tells_a_bundled_copy_from_the_system_one(tmp_path):
    """Against the real loader: the same library is refused from /lib, accepted from the bundle."""
    system_lib = Path("/lib/x86_64-linux-gnu/libxcb-cursor.so.0")
    if not system_lib.exists():
        pytest.skip("libxcb-cursor0 is not installed here")
    bundle, internal = _bundle(tmp_path)
    plugin = internal / XCB_PLUGIN
    plugin.parent.mkdir(parents=True, exist_ok=True)
    # Any ELF that links libxcb-cursor stands in for the plugin.
    shutil.copy(system_lib, plugin)
    linked = subprocess.run(["ldd", str(plugin)], capture_output=True, text=True, check=True).stdout
    dependency = next(name for name, _ in gate.parse_ldd(linked) if not _host_stack(name))

    refused = gate.bundle_problems(bundle, patterns=[XCB_PLUGIN], leaves_to_host=_host_stack)
    assert any(dependency in problem for problem in refused)

    resolved = dict(gate.parse_ldd(linked))[dependency]
    shutil.copy(resolved, internal / dependency)
    remaining = gate.bundle_problems(bundle, patterns=[XCB_PLUGIN], leaves_to_host=_host_stack)
    assert not any(dependency in problem for problem in remaining)



def test_the_release_build_installs_the_xcb_libraries_before_building():
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    install_step = workflow.index("Install the build tools and the libraries the Linux bundle must carry")
    build_step = workflow.index("- name: Build the Linux package")

    assert install_step < build_step
    step = workflow[install_step:build_step]
    for package in XCB_LIBRARIES:
        assert package in step


def test_the_linux_build_runs_the_gate_after_pyinstaller():
    script = (ROOT / "build_exe.sh").read_text(encoding="utf-8")

    assert script.index("PyInstaller packaging/GilzaCode-linux.spec") < script.index(
        'scripts/check_bundle_libraries.py "$BUNDLE"'
    )
    for package in XCB_LIBRARIES:
        assert package in script  # the build documents what the build machine needs


def test_the_spec_and_the_gate_leave_the_same_libraries_to_the_host():
    """The build machine's libgbm and libstdc++ broke the window on newer Ubuntus; both sides must agree."""
    import re
    spec = (ROOT / "packaging" / "GilzaCode-linux.spec").read_text(encoding="utf-8")
    declared = re.search(r"^HOST_LIBRARIES = (\(.*\))$", spec, re.MULTILINE).group(1)
    assert eval(declared) == gate.HOST_LIBRARIES  # noqa: S307 - a literal tuple from our own spec
    assert {"libgbm.so", "libstdc++.so"} <= set(gate.HOST_LIBRARIES)


def test_mesas_gbm_from_the_system_is_accepted(tmp_path):
    bundle, _ = _bundle(tmp_path, XCB_PLUGIN)
    ldd_output = "\tlibgbm.so.1 => /lib/x86_64-linux-gnu/libgbm.so.1 (0x1)\n"
    problems = gate.bundle_problems(bundle, patterns=[XCB_PLUGIN], ldd=lambda *_: ldd_output,
                                    leaves_to_host=lambda name: name.startswith(gate.HOST_LIBRARIES))
    assert problems == []
