import ctypes
import errno
import json
import os
import resource
import shutil
import signal
import stat
import subprocess

EXPECTED_ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "HOME": "/var/lib/motive/worker",
    "TMPDIR": "/var/lib/motive/worker/tmp",
    "CODEX_HOME": "/opt/motive/codex-config",
    "CODEX_SQLITE_HOME": "/var/lib/motive/worker",
    "USER": "motive-worker",
    "LOGNAME": "motive-worker",
    "CI": "1",
    "NO_COLOR": "1",
}


def denied(call, accepted=(errno.EPERM, errno.EACCES, errno.ENOSYS)):
    ctypes.set_errno(0)
    result = call()
    return result == -1 and ctypes.get_errno() in accepted


def write_denied(path):
    try:
        with open(path, "ab") as output:
            output.write(b"hostile")
        return False
    except OSError as error:
        return error.errno in (errno.EPERM, errno.EACCES, errno.EROFS)


def main():
    checks = []
    assert os.getresuid() == (2000, 2000, 2000)
    assert os.getresgid() == (2000, 2000, 2000)
    assert os.getgroups() == []
    checks.extend(["uid-gid-saved", "supplementary-groups-empty"])

    status = {}
    with open("/proc/self/status", encoding="utf-8") as source:
        for line in source:
            if ":" in line:
                key, value = line.split(":", 1)
                status[key] = value.strip()
    for field in ("CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"):
        assert int(status[field], 16) == 0
    assert status["NoNewPrivs"] == "1"
    assert status["Seccomp"] == "2"
    checks.extend(["capability-sets-zero", "bounding-zero", "ambient-zero", "no-new-privs", "seccomp-filter"])

    assert os.environ.get("MOTIVE_RUN_CAPABILITY") is not None
    assert 32 <= len(os.environ["MOTIVE_RUN_CAPABILITY"]) <= 512
    assert {key: value for key, value in os.environ.items() if key != "MOTIVE_RUN_CAPABILITY"} == EXPECTED_ENV
    assert "EVIL_INHERITED" not in os.environ
    checks.append("environment-exact")

    assert not os.path.exists("/proc/self/fd/9")
    checks.append("inherited-fds-closed")

    expected_limits = {
        resource.RLIMIT_CORE: 0,
        resource.RLIMIT_FSIZE: 64 * 1024 * 1024,
        resource.RLIMIT_NOFILE: 128,
        resource.RLIMIT_NPROC: 64,
        resource.RLIMIT_CPU: 90,
        resource.RLIMIT_STACK: 16 * 1024 * 1024,
        resource.RLIMIT_AS: 8 * 1024 * 1024 * 1024,
        resource.RLIMIT_MEMLOCK: 0,
    }
    for kind, expected in expected_limits.items():
        assert resource.getrlimit(kind) == (expected, expected)
    checks.append("finite-hard-limits")

    libc = ctypes.CDLL(None, use_errno=True)
    assert denied(lambda: libc.setuid(0))
    assert denied(lambda: libc.setresuid(0, 0, 0))
    assert denied(lambda: libc.setgid(0))
    assert denied(lambda: libc.setgroups(0, None))
    checks.append("root-regain-denied")

    setuid_result = subprocess.run(["/opt/motive/bin/setuid-probe"], text=True, capture_output=True, check=True)
    assert setuid_result.stdout.strip() == "uid=2000,euid=2000,suid=2000,gid=2000,egid=2000,sgid=2000"
    assert shutil.which("sudo") is None
    checks.extend(["setuid-binary-neutralized", "sudo-unavailable"])

    PR_CAP_AMBIENT = 47
    PR_CAP_AMBIENT_RAISE = 2
    assert denied(lambda: libc.prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, 0, 0, 0))
    assert denied(lambda: libc.prctl(4, 1, 0, 0, 0))  # PR_SET_DUMPABLE
    assert denied(lambda: libc.prctl(1, 0, 0, 0, 0))  # PR_SET_PDEATHSIG cannot be cleared
    assert libc.prctl(1, signal.SIGTERM, 0, 0, 0) == 0
    assert libc.prctl(1, signal.SIGKILL, 0, 0, 0) == 0
    assert denied(lambda: libc.prctl(1, signal.SIGHUP, 0, 0, 0))
    assert denied(lambda: libc.ptrace(0, 0, None, None))
    checks.extend(["ambient-raise-denied", "dumpable-prctl-denied", "parent-death-clear-denied",
        "parent-death-term-kill-allowed", "parent-death-other-denied", "ptrace-denied"])

    CLONE_NEWUSER = 0x10000000
    CLONE_NEWNS = 0x00020000
    assert denied(lambda: libc.unshare(CLONE_NEWUSER | CLONE_NEWNS))
    assert denied(lambda: libc.syscall(308, -1, 0))  # setns on x86_64
    clone_args = (ctypes.c_ubyte * 88)()
    assert denied(lambda: libc.syscall(435, ctypes.byref(clone_args), 88), (errno.ENOSYS,))
    checks.extend(["unshare-denied", "setns-denied", "clone3-disabled"])

    assert denied(lambda: libc.mount(b"none", b"/var/lib/motive/worker/tmp", b"tmpfs", 0, None))
    try:
        os.open("/dev/fuse", os.O_RDWR)
        raise AssertionError("FUSE device unexpectedly opened")
    except OSError as error:
        assert error.errno in (errno.ENOENT, errno.EPERM, errno.EACCES)
    checks.extend(["mount-denied", "fuse-unavailable"])

    for protected in (
        "/opt/motive/bin/worker-launcher",
        "/opt/motive/bin/worker-runtime-check",
        "/opt/motive/codex-config/config.toml",
        "/run/motive/channels/controller",
        "/var/lib/motive/control/worker-bootstrap.json",
        "/var/lib/motive/control/replacement",
        "/tmp/landlock-must-deny",
    ):
        assert write_denied(protected), protected
        try:
            os.chmod(protected, 0o777)
            raise AssertionError(f"chmod unexpectedly succeeded: {protected}")
        except OSError as error:
            assert error.errno in (errno.ENOENT, errno.EPERM, errno.EACCES, errno.EROFS)
    checks.append("trusted-paths-immutable")

    installation_link = "/opt/motive/codex-config/installation_id"
    assert os.readlink(installation_link) == "/var/lib/motive/worker/installation_id"
    with open(installation_link, "w", encoding="utf-8") as installation_id:
        installation_id.write("00000000-0000-4000-8000-000000000000")
    try:
        os.unlink(installation_link)
        raise AssertionError("installation ID trust link unexpectedly removed")
    except OSError as error:
        assert error.errno in (errno.EPERM, errno.EACCES, errno.EROFS)
    assert os.readlink(installation_link) == "/var/lib/motive/worker/installation_id"
    checks.append("installation-id-link-immutable-state-ephemeral")

    assert os.getcwd() == "/vercel/sandbox/workspace"
    with open("artifact.txt", "w", encoding="utf-8") as artifact:
        artifact.write("collector-readable\n")
    assert stat.S_IMODE(os.stat("artifact.txt").st_mode) == 0o644
    with open("/var/lib/motive/worker/state.txt", "w", encoding="utf-8") as state_file:
        state_file.write("worker-home\n")
    with open("/var/lib/motive/worker/tmp/state.txt", "w", encoding="utf-8") as temp_file:
        temp_file.write("worker-temp\n")
    shell = subprocess.run(["/bin/sh", "-c", "cat motive-turn-1.input.txt && printf shell-ok"], text=True, capture_output=True, check=True)
    assert shell.stdout == "turn-one\nshell-ok"
    checker = subprocess.run(["/opt/motive/bin/worker-runtime-check"], text=True, capture_output=True)
    assert checker.returncode == 0, (checker.stdout, checker.stderr)
    assert checker.stdout.strip() == "MOTIVE_RUNTIME_CHECK_OK"
    child = os.fork()
    if child == 0:
        os._exit(0)
    assert os.waitpid(child, 0)[1] == 0
    checks.extend(["workspace-write-readable", "home-tmp-write", "shell-tools", "runtime-checker", "ordinary-fork"])

    print(json.dumps({"format": "motive.protected-worker-adversarial/0.1", "passed": True, "checks": checks}))


if __name__ == "__main__":
    main()
