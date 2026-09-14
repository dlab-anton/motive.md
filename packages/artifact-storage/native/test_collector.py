"""Real Linux syscall regression suite. Runs as a non-root service in Docker.
No candidate program, provider API, database, host mounts, or network is used.
"""
import base64
import json
import os
import socket
import subprocess
import tempfile
import threading
import unittest

COLLECTOR = "/opt/motive/collector"


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="collector-", dir="/tmp")
        self.root = self.temp.name
        with open(self.root + "/Solution.lean", "wb") as output:
            output.write(b"theorem demo : True := True.intro\n")

    def tearDown(self):
        self.temp.cleanup()

    def run_collect(self, path, maximum=1024, root=None):
        workspace = root or self.root
        identity = subprocess.run([COLLECTOR, "--identity", workspace], capture_output=True, timeout=12, env={}).stdout.strip().decode("ascii")
        return subprocess.run([COLLECTOR, workspace, path, str(maximum), identity],
                              capture_output=True, timeout=12, env={})

    def run_collect_ascii(self, path, maximum=1024, root=None):
        workspace = root or self.root
        identity = subprocess.run([COLLECTOR, "--identity", workspace], capture_output=True, timeout=12, env={}).stdout.strip().decode("ascii")
        return subprocess.run([COLLECTOR, "--ascii", workspace, path, str(maximum), identity],
                              capture_output=True, timeout=12, env={})

    def rejected(self, path, **kwargs):
        result = self.run_collect(path, **kwargs)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(result.stdout, b"")

    def test_kernel_probe(self):
        result = subprocess.run([COLLECTOR, "--probe"], capture_output=True, timeout=12, env={})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"MOTIVE_COLLECTOR_V1_READY\n")

    def test_regular_bytes(self):
        result = self.run_collect("Solution.lean")
        self.assertEqual(result.returncode, 0, result.stderr)
        header, identity, content = result.stdout.split(b"\n", 2)
        self.assertEqual(header, b"MOTIVE_ARTIFACT_V1")
        self.assertEqual(int(identity.split(b":")[2]), len(content))
        self.assertEqual(content, b"theorem demo : True := True.intro\n")

    def test_ascii_base64_frame_preserves_arbitrary_bytes(self):
        raw = b"\x00\xff\ncollector\x80\x00"
        with open(self.root + "/binary", "wb") as output:
            output.write(raw)
        result = self.run_collect_ascii("binary")
        self.assertEqual(result.returncode, 0, result.stderr)
        header, identity, encoded, trailing = result.stdout.split(b"\n", 3)
        self.assertEqual(header, b"MOTIVE_ARTIFACT_ASCII_V1")
        fields = identity.split(b":")
        self.assertEqual(len(fields), 4)
        self.assertEqual(int(fields[2]), len(raw))
        self.assertEqual(int(fields[3]), len(encoded))
        self.assertEqual(base64.b64decode(encoded, validate=True), raw)
        self.assertEqual(trailing, b"")

    def test_ascii_mode_keeps_the_binary_mode_path_guards(self):
        for path in ["../etc/passwd", "/etc/passwd", "a//b", "./a", "a/../b", "a\\b", "manifest.json"]:
            with self.subTest(path=path):
                result = self.run_collect_ascii(path)
                self.assertEqual(result.returncode, 1)
                self.assertEqual(result.stdout, b"")

    def test_empty_file(self):
        open(self.root + "/empty", "wb").close()
        result = self.run_collect("empty", 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.endswith(b":0\n"))

    def test_missing_is_distinct(self):
        result = self.run_collect("missing")
        self.assertEqual(result.returncode, 3)
        self.assertEqual(result.stdout, b"")

    def test_wrong_root_identity(self):
        result = subprocess.run([COLLECTOR, self.root, "Solution.lean", "1024", "0:0:0"], capture_output=True, timeout=12, env={})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"WORKSPACE_IDENTITY_CHANGED\n")

    def test_final_symlink(self):
        os.symlink("Solution.lean", self.root + "/link")
        self.rejected("link")

    def test_parent_symlink(self):
        os.symlink("/etc", self.root + "/outside")
        self.rejected("outside/passwd")

    def test_broken_symlink_is_not_missing(self):
        os.symlink("absent", self.root + "/broken")
        self.rejected("broken")

    def test_root_ancestor_symlink(self):
        os.symlink(self.root, self.root + "/alias")
        self.rejected("Solution.lean", root=self.root + "/alias")

    def test_hardlink(self):
        os.link(self.root + "/Solution.lean", self.root + "/hard")
        self.rejected("hard")
        self.rejected("Solution.lean")

    def test_directory(self):
        os.mkdir(self.root + "/dir")
        self.rejected("dir")

    def test_fifo_does_not_block(self):
        os.mkfifo(self.root + "/pipe")
        self.rejected("pipe")

    def test_socket(self):
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(self.root + "/socket")
            self.rejected("socket")

    def test_device_not_opened(self):
        self.rejected("null", root="/dev")

    def test_mount_crossing(self):
        self.rejected("proc/version", root="/dev/..")

    def test_concurrent_symlink_replacement_never_leaks(self):
        stop = threading.Event()
        outside = self.root + "-secret"
        with open(outside, "wb") as output:
            output.write(b"FORBIDDEN_OUTSIDE_BYTES")
        def replace():
            while not stop.is_set():
                os.symlink(outside, self.root + "/next")
                os.replace(self.root + "/next", self.root + "/race")
                with open(self.root + "/next", "wb") as output:
                    output.write(b"SAFE")
                os.replace(self.root + "/next", self.root + "/race")
        thread = threading.Thread(target=replace)
        thread.start()
        try:
            for _ in range(60):
                result = self.run_collect("race")
                self.assertIn(result.returncode, [0, 1, 3])
                if result.returncode == 0:
                    self.assertEqual(result.stdout.split(b"\n", 2)[2], b"SAFE")
                else:
                    self.assertEqual(result.stdout, b"")
        finally:
            stop.set()
            thread.join()
            os.unlink(outside)

    def test_oversize(self):
        self.rejected("Solution.lean", maximum=1)

    def test_paths_and_limits(self):
        for path in ["../etc/passwd", "/etc/passwd", "a//b", "./a", "a/../b", "a\\b", "a\nb", "manifest.json", "a" * 256]:
            with self.subTest(path=path):
                self.rejected(path)
        for maximum in [0, -1, 64 * 1024 * 1024 + 1, "2garbage"]:
            with self.subTest(maximum=maximum):
                self.rejected("Solution.lean", maximum=maximum)


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(CollectorTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({"format": "motive.native-collector-tests/0.1", "platform": os.uname().sysname,
                      "kernel": os.uname().release, "uid": os.getuid(), "tests": result.testsRun,
                      "failures": len(result.failures), "errors": len(result.errors),
                      "passed": result.wasSuccessful()}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
