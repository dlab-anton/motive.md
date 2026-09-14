"""Local-only regression suite for the root-to-UID-1000 collector launcher.

It creates the root-owned bootstrap marker exactly as the protected worker
launcher contract specifies. This is an interface test, not evidence that a
Vercel image has been reviewed or that a live provider preserves these paths.
"""
import base64
import ctypes
import json
import os
import subprocess
import unittest


LAUNCHER = "/opt/motive/bin/artifact-collector-launcher"
BOOTSTRAP = "/var/lib/motive/control/worker-bootstrap.json"
WORKSPACE = "/vercel/sandbox/workspace"


class StatxTimestamp(ctypes.Structure):
    _fields_ = [("tv_sec", ctypes.c_longlong), ("tv_nsec", ctypes.c_uint), ("reserved", ctypes.c_int)]


class Statx(ctypes.Structure):
    _fields_ = [
        ("mask", ctypes.c_uint), ("blksize", ctypes.c_uint), ("attributes", ctypes.c_ulonglong),
        ("nlink", ctypes.c_uint), ("uid", ctypes.c_uint), ("gid", ctypes.c_uint),
        ("mode", ctypes.c_ushort), ("spare0", ctypes.c_ushort), ("ino", ctypes.c_ulonglong),
        ("size", ctypes.c_ulonglong), ("blocks", ctypes.c_ulonglong), ("attributes_mask", ctypes.c_ulonglong),
        ("atime", StatxTimestamp), ("btime", StatxTimestamp), ("ctime", StatxTimestamp), ("mtime", StatxTimestamp),
        ("rdev_major", ctypes.c_uint), ("rdev_minor", ctypes.c_uint), ("dev_major", ctypes.c_uint), ("dev_minor", ctypes.c_uint),
        ("mnt_id", ctypes.c_ulonglong), ("dio_mem_align", ctypes.c_uint), ("dio_offset_align", ctypes.c_uint),
        ("spare3", ctypes.c_ulonglong * 12),
    ]


def workspace_identity():
    info = Statx()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.statx.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Statx)]
    libc.statx.restype = ctypes.c_int
    # AT_FDCWD, AT_SYMLINK_NOFOLLOW, STATX_MNT_ID
    if libc.statx(-100, WORKSPACE.encode(), 0x100, 0x1000, ctypes.byref(info)) != 0:
        raise OSError(ctypes.get_errno(), "statx workspace")
    stat = os.stat(WORKSPACE, follow_symlinks=False)
    return f"{stat.st_dev}:{stat.st_ino}:{info.mnt_id}"


def write_bootstrap(identity):
    record = (
        '{"format":"motive.native-worker-bootstrap/0.1",'
        '"nativePolicy":"motive.native-worker/0.1",'
        '"workerUid":2000,"workerGid":2000,'
        f'"workspaceIdentity":"{identity}"}}\n'
    ).encode("ascii")
    descriptor = os.open(BOOTSTRAP, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o444)
    try:
        os.write(descriptor, record)
        os.fchmod(descriptor, 0o444)
        os.fchown(descriptor, 0, 0)
    finally:
        os.close(descriptor)


def launch(*arguments, demote=False, leak_fd=False):
    leaked = None
    pass_fds = ()
    if leak_fd:
        leaked = os.open("/etc/passwd", os.O_RDONLY)
        pass_fds = (leaked,)

    def drop_to_worker():
        os.setgroups([])
        os.setresgid(2000, 2000, 2000)
        os.setresuid(2000, 2000, 2000)

    try:
        return subprocess.run(
            [LAUNCHER, *arguments], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=15, env={"LEAKED_PROVIDER_CREDENTIAL": "must-not-reach-helper"}, pass_fds=pass_fds,
            preexec_fn=drop_to_worker if demote else None,
        )
    finally:
        if leaked is not None:
            os.close(leaked)


class VercelCollectorLauncherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identity = workspace_identity()
        write_bootstrap(cls.identity)

    def test_bootstrap_and_capture_are_direct_ascii_stdout_after_drop(self):
        bootstrap = launch("--bootstrap", leak_fd=True)
        self.assertEqual(bootstrap.returncode, 0, bootstrap.stderr)
        self.assertEqual(bootstrap.stderr, b"")
        self.assertEqual(bootstrap.stdout, f"MOTIVE_COLLECTOR_BOOTSTRAP_V1\n{self.identity}\n".encode("ascii"))

        capture = launch("--capture-ascii", "Solution.bin", "1024", self.identity, leak_fd=True)
        self.assertEqual(capture.returncode, 0, capture.stderr)
        self.assertEqual(capture.stderr, b"")
        magic, metadata, encoded, empty = capture.stdout.split(b"\n", 3)
        self.assertEqual(magic, b"MOTIVE_ARTIFACT_ASCII_V1")
        device, inode, size, encoded_size = metadata.split(b":")
        self.assertTrue(device.isdigit() and inode.isdigit())
        self.assertEqual(int(size), 18)
        self.assertEqual(int(encoded_size), len(encoded))
        self.assertEqual(base64.b64decode(encoded, validate=True), b"\x00\xffnative-artifact\n")
        self.assertEqual(empty, b"")

    def test_wrong_identity_and_hostile_arguments_cannot_capture(self):
        for arguments in [
            ("--capture-ascii", "Solution.bin", "1024", "0:0:0"),
            ("--capture-ascii", "../etc/passwd", "1024", self.identity),
            ("--capture-ascii", "Solution.bin", "8388609", self.identity),
        ]:
            with self.subTest(arguments=arguments):
                result = launch(*arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")

    def test_worker_identity_cannot_use_provider_sudo_entrypoint(self):
        result = launch("--bootstrap", demote=True)
        self.assertEqual(result.returncode, 125)
        self.assertEqual(result.stdout, b"")

    def test_bootstrap_has_the_root_protected_contract(self):
        marker = os.stat(BOOTSTRAP, follow_symlinks=False)
        parent = os.stat("/var/lib/motive/control", follow_symlinks=False)
        self.assertEqual((marker.st_uid, marker.st_gid, marker.st_mode & 0o7777, marker.st_nlink), (0, 0, 0o444, 1))
        self.assertEqual((parent.st_uid, parent.st_gid, parent.st_mode & 0o7777), (0, 0, 0o755))


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(VercelCollectorLauncherTests))
    print(json.dumps({
        "format": "motive.vercel-native-artifact-transport-local-test/0.1",
        "tests": result.testsRun,
        "failures": len(result.failures),
        "errors": len(result.errors),
        "passed": result.wasSuccessful(),
    }))
    raise SystemExit(0 if result.wasSuccessful() else 1)
