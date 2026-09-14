import hashlib
import ctypes
import json
import os
import pathlib
import shutil
import subprocess
import sys

LAUNCHER = "/opt/motive/bin/worker-launcher"
CAPABILITY = "A" * 48
WORKSPACE = pathlib.Path("/vercel/sandbox/workspace")
EXPECTED_ROOT_CAPABILITIES = 0x1C0  # SETGID, SETUID, SETPCAP


def host_platform():
    status = {}
    with open("/proc/self/status", encoding="utf-8") as source:
        for line in source:
            if ":" in line:
                key, value = line.split(":", 1)
                status[key] = value.strip()
    assert int(status["CapInh"], 16) == 0
    assert int(status["CapPrm"], 16) == EXPECTED_ROOT_CAPABILITIES
    assert int(status["CapEff"], 16) == EXPECTED_ROOT_CAPABILITIES
    assert int(status["CapBnd"], 16) == EXPECTED_ROOT_CAPABILITIES
    assert int(status["CapAmb"], 16) == 0
    assert status["NoNewPrivs"] == "1"
    libc = ctypes.CDLL(None, use_errno=True)
    landlock_abi = libc.syscall(444, None, 0, 1)  # landlock_create_ruleset VERSION, x86_64
    assert landlock_abi >= 1
    return {
        "kernelRelease": os.uname().release,
        "landlockAbi": landlock_abi,
        "initialCapabilityMask": f"0x{EXPECTED_ROOT_CAPABILITIES:x}",
        "initialNoNewPrivileges": True,
    }


def prepare_runtime():
    assert os.stat("/var/lib/motive/worker").st_uid == 2000
    assert os.stat(WORKSPACE).st_uid == 2000
    os.setegid(2000)
    os.seteuid(2000)
    try:
        assert os.stat("/var/lib/motive/worker/tmp").st_uid == 2000
        for name, content in (("motive-turn-1.input.txt", "turn-one\n"), ("motive-turn-2.input.txt", "turn-two\n")):
            path = WORKSPACE / name
            path.write_text(content, encoding="utf-8")
            os.chmod(path, 0o644)
        candidate = WORKSPACE / "worker-controlled-candidate"
        candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        os.chmod(candidate, 0o755)
        (WORKSPACE / "escape").symlink_to("/etc")
    finally:
        os.seteuid(0)
        os.setegid(0)


def launch(candidate, *args, cwd=".", extra_env=None, leak_fd=False, demote=False):
    environment = {"MOTIVE_RUN_CAPABILITY": CAPABILITY, "EVIL_INHERITED": "must-be-cleared"}
    if extra_env:
        environment.update(extra_env)
    command = [LAUNCHER, "--cwd-relative", cwd, "--", candidate, *args]
    leaked = None
    pass_fds = ()
    if leak_fd:
        leaked = os.open("/etc/passwd", os.O_RDONLY)
        os.dup2(leaked, 9)
        pass_fds = (9,)

    def demote_identity():
        os.setgroups([])
        os.setresgid(2000, 2000, 2000)
        os.setresuid(2000, 2000, 2000)

    try:
        return subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=60, env=environment, pass_fds=pass_fds,
            preexec_fn=demote_identity if demote else None)
    finally:
        if leaked is not None:
            os.close(leaked)
        try:
            os.close(9)
        except OSError:
            pass


def parsed_line(output, expected_format):
    for line in output.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if value.get("format") == expected_format:
            return value
    raise AssertionError(f"missing {expected_format}: {output[:1000]}")


def main():
    platform = host_platform()
    prepare_runtime()
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("adversarial", "codex", "codex-joined"):
        raise SystemExit("test_launcher.py requires adversarial, codex, or codex-joined")
    launcher_digest = hashlib.sha256(pathlib.Path(LAUNCHER).read_bytes()).hexdigest()
    checker_digest = hashlib.sha256(pathlib.Path("/opt/motive/bin/worker-runtime-check").read_bytes()).hexdigest()

    if mode in ("codex", "codex-joined"):
        node = shutil.which("node")
        assert node is not None and os.path.isabs(node)
        if mode == "codex-joined":
            capability = pathlib.Path("/exchange/capability").read_text(encoding="utf-8").strip()
            assert len(capability) >= 32
            codex = launch(node, "/opt/motive/test/joined-codex-probe.mjs",
                extra_env={"MOTIVE_RUN_CAPABILITY": capability})
        else:
            codex = launch(node, "/opt/motive/test/codex-probe.mjs")
        codex_format = "motive.protected-worker-joined-codex/0.1" if mode == "codex-joined" else "motive.protected-worker-codex/0.1"
        try:
            codex_evidence = parsed_line(codex.stdout, codex_format)
        except AssertionError:
            codex_evidence = None
        passed = codex.returncode == 0 and codex_evidence is not None and codex_evidence["passed"] is True
        session_format = "motive.protected-worker-joined-codex-session/0.1" if mode == "codex-joined" else "motive.protected-worker-codex-session/0.1"
        print(json.dumps({"format": session_format, "passed": passed,
            "launcherDigest": f"sha256:{launcher_digest}", "checkerDigest": f"sha256:{checker_digest}",
            "platform": platform,
            "launcherReturnCode": codex.returncode,
            "launcherStdoutDigest": f"sha256:{hashlib.sha256(codex.stdout.encode()).hexdigest()}",
            "launcherStderrDigest": f"sha256:{hashlib.sha256(codex.stderr.encode()).hexdigest()}",
            "codex": codex_evidence}))
        if not passed:
            raise SystemExit(1)
        return

    rejected = {}
    cases = {
        "parent-traversal": {"cwd": "../etc"},
        "symlink-traversal": {"cwd": "escape"},
        "non-root-launch": {"demote": True},
        "missing-capability": {"extra_env": {"MOTIVE_RUN_CAPABILITY": "short"}},
        "worker-controlled-candidate": {"candidate": str(WORKSPACE / "worker-controlled-candidate")},
    }
    for name, options in cases.items():
        candidate = options.pop("candidate", "/usr/bin/true")
        result = launch(candidate, **options)
        rejected[name] = result.returncode == 125
        assert rejected[name], (name, result.returncode, result.stderr)

    hostile = launch(sys.executable, "/opt/motive/test/hostile-probe.py", leak_fd=True)
    assert hostile.returncode == 0, hostile.stderr
    hostile_evidence = parsed_line(hostile.stdout, "motive.protected-worker-adversarial/0.1")
    assert hostile_evidence["passed"] is True
    bootstrap = json.loads(pathlib.Path("/var/lib/motive/control/worker-bootstrap.json").read_text(encoding="utf-8"))
    workspace = os.stat(WORKSPACE)
    identity = bootstrap["workspaceIdentity"].split(":")
    assert bootstrap == {
        "format": "motive.native-worker-bootstrap/0.1",
        "nativePolicy": "motive.native-worker/0.1",
        "workerUid": 2000,
        "workerGid": 2000,
        "workspaceIdentity": bootstrap["workspaceIdentity"],
    }
    assert identity[0:2] == [str(workspace.st_dev), str(workspace.st_ino)] and int(identity[2]) > 0
    marker = os.stat("/var/lib/motive/control/worker-bootstrap.json")
    assert marker.st_uid == 0 and marker.st_gid == 0 and (marker.st_mode & 0o7777) == 0o444
    second = launch("/usr/bin/true")
    assert second.returncode == 125 and "already exists" in second.stderr
    rejected["second-launch-same-session"] = True
    print(json.dumps({
        "format": "motive.protected-worker-adversarial-session/0.1",
        "passed": True,
        "launcherDigest": f"sha256:{launcher_digest}",
        "checkerDigest": f"sha256:{checker_digest}",
        "workerUid": 2000,
        "workerGid": 2000,
        "platform": platform,
        "rejectedLaunches": rejected,
        "bootstrap": bootstrap,
        "adversarial": hostile_evidence,
    }))


if __name__ == "__main__":
    main()
