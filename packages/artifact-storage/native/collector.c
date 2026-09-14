/* Trusted Linux single-file collector. Never compile or load this from a worker
 * workspace. See docs/NATIVE-ARTIFACT-COLLECTOR.md for the host trust boundary. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/openat2.h>
#include <linux/capability.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#define MAX_BYTES (64U * 1024U * 1024U)
#define MAX_VERCEL_ASCII_BYTES (8U * 1024U * 1024U)
#define RESOLUTION (RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV)
#define VERCEL_WORKSPACE_ROOT "/vercel/sandbox/workspace"
#define VERCEL_BOOTSTRAP_RECORD "/var/lib/motive/control/worker-bootstrap.json"
#define VERCEL_BOOTSTRAP_PREFIX "{\"format\":\"motive.native-worker-bootstrap/0.1\",\"nativePolicy\":\"motive.native-worker/0.1\",\"workerUid\":2000,\"workerGid\":2000,\"workspaceIdentity\":\""

extern char **environ;

static int fail(const char *code) { fprintf(stderr, "%s\n", code); return 1; }
static int beneath(int root, const char *path, uint64_t flags, uint64_t resolution) {
  struct open_how how = { .flags = flags, .resolve = resolution };
  return (int)syscall(SYS_openat2, root, path, &how, sizeof(how));
}
static int safe_relative(const char *path) {
  size_t len = strlen(path), segment = 0;
  if (!len || len > 1024 || path[0] == '/') return 0;
  const char *start = path;
  for (size_t i = 0; i <= len; ++i) {
    unsigned char c = (unsigned char)path[i];
    if (c && (c < 32 || c == 127 || c == '\\' || c == ':')) return 0;
    if (!c || c == '/') {
      if (!segment || segment > 255 || (segment == 1 && start[0] == '.') ||
          (segment == 2 && start[0] == '.' && start[1] == '.')) return 0;
      segment = 0; start = path + i + 1;
    } else ++segment;
  }
  return strcmp(path, "manifest.json") != 0;
}
static int unchanged(const struct stat *a, const struct stat *b) {
  return S_ISREG(b->st_mode) && b->st_nlink == 1 && a->st_dev == b->st_dev &&
    a->st_ino == b->st_ino && a->st_size == b->st_size && a->st_mode == b->st_mode &&
    a->st_uid == b->st_uid && a->st_gid == b->st_gid &&
    a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int write_all(const void *bytes, size_t length) {
  const unsigned char *p = bytes;
  while (length) {
    ssize_t n = write(STDOUT_FILENO, p, length);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) return 0;
    p += n; length -= (size_t)n;
  }
  return 1;
}
static int open_workspace(const char *path) {
  int slash = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  int root = slash < 0 ? -1 : beneath(slash, path + 1,
    O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW,
    RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS);
  if (slash >= 0) close(slash);
  return root;
}
static int root_identity(int root, char *output, size_t maximum) {
  struct stat statbuf;
  struct statx extended;
  if (fstat(root, &statbuf) || statx(root, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW,
      STATX_MNT_ID, &extended) || !(extended.stx_mask & STATX_MNT_ID)) return 0;
  int length = snprintf(output, maximum, "%ju:%ju:%ju", (uintmax_t)statbuf.st_dev,
    (uintmax_t)statbuf.st_ino, (uintmax_t)extended.stx_mnt_id);
  return length > 0 && (size_t)length < maximum;
}

/* The Vercel command-log mode has no byte stream: its SDK exposes UTF-8
 * strings. Keep this format deliberately boring ASCII and self-delimiting.
 * It is emitted by this helper directly; a shell or base64 utility never sits
 * between the captured descriptor and the controller. */
static int write_base64(const unsigned char *input, size_t length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  char output[4096];
  size_t in = 0, out = 0;
  while (in < length) {
    size_t remaining = length - in;
    unsigned value = (unsigned)input[in++] << 16;
    if (remaining > 1) value |= (unsigned)input[in++] << 8;
    if (remaining > 2) value |= (unsigned)input[in++];
    output[out++] = alphabet[(value >> 18) & 63U];
    output[out++] = alphabet[(value >> 12) & 63U];
    output[out++] = remaining > 1 ? alphabet[(value >> 6) & 63U] : '=';
    output[out++] = remaining > 2 ? alphabet[value & 63U] : '=';
    if (out + 4 > sizeof(output)) {
      if (!write_all(output, out)) return 0;
      out = 0;
    }
  }
  return out == 0 || write_all(output, out);
}

static int protected_root_path(const char *path, int directory, mode_t exact_mode) {
  struct stat st;
  if (lstat(path, &st) || S_ISLNK(st.st_mode) || (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) ||
      st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 0022) != 0 ||
      (exact_mode && (st.st_mode & 07777) != exact_mode)) return 0;
  return 1;
}

static int valid_identity(const char *value) {
  size_t length = strlen(value), segments = 0, digits = 0;
  if (!length || length >= 128) return 0;
  for (size_t i = 0; i <= length; ++i) {
    unsigned char c = (unsigned char)value[i];
    if (c >= '0' && c <= '9') { ++digits; continue; }
    if ((c == ':' || c == 0) && digits) {
      ++segments; digits = 0;
      if (c == 0) return segments == 3;
      continue;
    }
    return 0;
  }
  return 0;
}

/* The launcher is the sole root transition. Vercel-specific modes assert the
 * post-drop envelope too, so a changed launcher cannot quietly pass an
 * inherited token or file descriptor to a trusted helper. */
static int clean_vercel_execution_context(void) {
  if (getuid() != 1000 || geteuid() != 1000 || getgid() != 1000 || getegid() != 1000) return 0;
  int path = 0, lang = 0, locale = 0;
  for (char **entry = environ; entry && *entry; ++entry) {
    if (!strcmp(*entry, "PATH=/usr/bin:/bin")) ++path;
    else if (!strcmp(*entry, "LANG=C")) ++lang;
    else if (!strcmp(*entry, "LC_ALL=C")) ++locale;
    else return 0;
  }
  if (path != 1 || lang != 1 || locale != 1) return 0;
  for (int descriptor = 3; descriptor < 32; ++descriptor) {
    errno = 0;
    if (fcntl(descriptor, F_GETFD) != -1 || errno != EBADF) return 0;
  }
  return 1;
}

/* The worker launcher makes this 0444 under a root:root 0755 parent before
 * worker exec. UID 1000 deliberately reads and validates it itself: root does
 * not pass a worker-selectable workspace or identity through the launcher. */
static int read_vercel_bootstrap_identity(char *identity, size_t maximum) {
  static const char suffix[] = "\"}\n";
  char record[512];
  if (!protected_root_path("/", 1, 0) || !protected_root_path("/var", 1, 0) ||
      !protected_root_path("/var/lib", 1, 0) || !protected_root_path("/var/lib/motive", 1, 0) ||
      !protected_root_path("/var/lib/motive/control", 1, 0755) ||
      !protected_root_path(VERCEL_BOOTSTRAP_RECORD, 0, 0444)) return 0;
  struct stat marker;
  if (lstat(VERCEL_BOOTSTRAP_RECORD, &marker) || marker.st_nlink != 1 || marker.st_size <= 0 ||
      (size_t)marker.st_size >= sizeof(record)) return 0;
  int fd = open(VERCEL_BOOTSTRAP_RECORD, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  size_t got = 0;
  while (got < sizeof(record) - 1) {
    ssize_t count = read(fd, record + got, sizeof(record) - 1 - got);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { close(fd); return 0; }
    if (count == 0) break;
    got += (size_t)count;
  }
  char extra;
  ssize_t tail;
  do { tail = read(fd, &extra, 1); } while (tail < 0 && errno == EINTR);
  close(fd);
  if (tail != 0) return 0;
  record[got] = 0;
  size_t prefix = sizeof(VERCEL_BOOTSTRAP_PREFIX) - 1, suffix_length = sizeof(suffix) - 1;
  if (got <= prefix + suffix_length || memcmp(record, VERCEL_BOOTSTRAP_PREFIX, prefix) ||
      memcmp(record + got - suffix_length, suffix, suffix_length)) return 0;
  size_t identity_length = got - prefix - suffix_length;
  if (identity_length >= maximum) return 0;
  memcpy(identity, record + prefix, identity_length);
  identity[identity_length] = 0;
  return valid_identity(identity);
}

static int capture(const char *workspace_path, const char *relative_path, unsigned long maximum,
                   const char *expected_identity, int ascii) {
  int root = open_workspace(workspace_path);
  if (root < 0) return fail("WORKSPACE_UNAVAILABLE");
  char identity[128];
  if (!root_identity(root, identity, sizeof(identity)) || strcmp(identity, expected_identity) != 0) {
    close(root); return fail("WORKSPACE_IDENTITY_CHANGED");
  }
  /* O_PATH inspects type before opening for read: devices/FIFOs must never be
   * activated. /proc/self/fd then reopens that exact regular inode; the worker
   * cannot substitute another pathname between validation and reading. */
  int pathfd = beneath(root, relative_path, O_PATH | O_CLOEXEC | O_NOFOLLOW, RESOLUTION);
  int open_error = errno;
  close(root);
  if (pathfd < 0) return open_error == ENOENT ? 3 : fail("PATH_REJECTED");
  struct stat before, after;
  if (fstat(pathfd, &before) || !S_ISREG(before.st_mode) || before.st_nlink != 1) {
    close(pathfd); return fail("TYPE_REJECTED");
  }
  if (before.st_size < 0 || (uint64_t)before.st_size > maximum) { close(pathfd); return fail("SIZE_REJECTED"); }
  char fdpath[64];
  int fdlength = snprintf(fdpath, sizeof(fdpath), "/proc/self/fd/%d", pathfd);
  if (fdlength <= 0 || (size_t)fdlength >= sizeof(fdpath)) { close(pathfd); return fail("READ_FAILED"); }
  int fd = open(fdpath, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &after) || !unchanged(&before, &after)) {
    if (fd >= 0) close(fd);
    close(pathfd);
    return fail("FILE_CHANGED");
  }
  close(pathfd);
  size_t size = (size_t)before.st_size, got = 0;
  unsigned char *buffer = malloc(size ? size : 1);
  if (!buffer) { close(fd); return fail("MEMORY_LIMIT"); }
  while (got < size) {
    size_t remaining = size - got;
    ssize_t count = read(fd, buffer + got, remaining > 65536 ? 65536 : remaining);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { close(fd); free(buffer); return fail("FILE_CHANGED"); }
    got += (size_t)count;
  }
  unsigned char extra;
  ssize_t tail;
  do { tail = read(fd, &extra, 1); } while (tail < 0 && errno == EINTR);
  if (tail != 0 || fstat(fd, &after) || !unchanged(&before, &after)) {
    close(fd); free(buffer); return fail("FILE_CHANGED");
  }
  close(fd);
  char header[192];
  int length;
  if (ascii) {
    size_t encoded = ((size + 2U) / 3U) * 4U;
    length = snprintf(header, sizeof(header), "MOTIVE_ARTIFACT_ASCII_V1\n%ju:%ju:%zu:%zu\n",
      (uintmax_t)before.st_dev, (uintmax_t)before.st_ino, size, encoded);
    if (length <= 0 || (size_t)length >= sizeof(header) || !write_all(header, (size_t)length) ||
        !write_base64(buffer, size) || !write_all("\n", 1)) { free(buffer); return fail("OUTPUT_FAILED"); }
  } else {
    length = snprintf(header, sizeof(header), "MOTIVE_ARTIFACT_V1\n%ju:%ju:%zu\n",
      (uintmax_t)before.st_dev, (uintmax_t)before.st_ino, size);
    if (length <= 0 || (size_t)length >= sizeof(header) ||
        !write_all(header, (size_t)length) || !write_all(buffer, size)) { free(buffer); return fail("OUTPUT_FAILED"); }
  }
  free(buffer);
  return 0;
}
int main(int argc, char **argv) {
  /* Bounds are independent of caller cancellation. No fallback for old kernels. */
  struct rlimit memory = {256U * 1024U * 1024U, 256U * 1024U * 1024U};
  struct rlimit cpu = {5, 5}, files = {32, 32}, core = {0, 0};
  struct __user_cap_header_struct cap_header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct cap_data[2];
  if (getuid() == 0 || geteuid() == 0 || syscall(SYS_capget, &cap_header, cap_data) ||
      cap_data[0].effective || cap_data[1].effective || cap_data[0].permitted || cap_data[1].permitted ||
      cap_data[0].inheritable || cap_data[1].inheritable ||
      prctl(PR_SET_DUMPABLE, 0) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      setrlimit(RLIMIT_AS, &memory) || setrlimit(RLIMIT_CPU, &cpu) ||
      setrlimit(RLIMIT_NOFILE, &files) || setrlimit(RLIMIT_CORE, &core)) return fail("ISOLATION_UNAVAILABLE");
  alarm(10);
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    int root = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
    int probe = root < 0 ? -1 : beneath(root, ".", O_PATH | O_DIRECTORY | O_CLOEXEC, RESOLUTION);
    if (probe < 0) return fail("OPENAT2_UNAVAILABLE");
    close(probe); close(root);
    return write_all("MOTIVE_COLLECTOR_V1_READY\n", 26) ? 0 : 1;
  }
  if (argc == 3 && strcmp(argv[1], "--identity") == 0 && argv[2][0] == '/') {
    int root = open_workspace(argv[2]);
    char identity[128];
    if (root < 0 || !root_identity(root, identity, sizeof(identity))) return fail("WORKSPACE_UNAVAILABLE");
    close(root);
    return write_all(identity, strlen(identity)) && write_all("\n", 1) ? 0 : 1;
  }
  if (argc == 2 && strcmp(argv[1], "--vercel-bootstrap") == 0) {
    char expected[128], actual[128];
    if (!clean_vercel_execution_context() || !read_vercel_bootstrap_identity(expected, sizeof(expected))) return fail("BOOTSTRAP_REJECTED");
    int root = open_workspace(VERCEL_WORKSPACE_ROOT);
    if (root < 0 || !root_identity(root, actual, sizeof(actual)) || strcmp(expected, actual) != 0) {
      if (root >= 0) close(root);
      return fail("WORKSPACE_IDENTITY_CHANGED");
    }
    close(root);
    return write_all("MOTIVE_COLLECTOR_BOOTSTRAP_V1\n", sizeof("MOTIVE_COLLECTOR_BOOTSTRAP_V1\n") - 1) && write_all(expected, strlen(expected)) &&
      write_all("\n", 1) ? 0 : 1;
  }
  int vercel_ascii = argc == 5 && strcmp(argv[1], "--vercel-ascii") == 0;
  int local_ascii = argc == 6 && strcmp(argv[1], "--ascii") == 0;
  const char *relative = vercel_ascii ? argv[2] : local_ascii ? argv[3] : argv[2];
  const char *limit = vercel_ascii ? argv[3] : local_ascii ? argv[4] : argv[3];
  if ((!vercel_ascii && !local_ascii && argc != 5) || !safe_relative(relative) ||
      (local_ascii && argv[2][0] != '/') ||
      (!vercel_ascii && !local_ascii && argv[1][0] != '/')) return fail("INVALID_ARGUMENT");
  char *end = NULL;
  errno = 0;
  unsigned long maximum = strtoul(limit, &end, 10);
  if (errno || !end || !limit[0] || *end || limit[0] < '1' || limit[0] > '9' ||
      !maximum || maximum > MAX_BYTES || (vercel_ascii && maximum > MAX_VERCEL_ASCII_BYTES)) return fail("INVALID_LIMIT");
  if (vercel_ascii) {
    char marker_identity[128];
    if (!clean_vercel_execution_context() || !valid_identity(argv[4]) || !read_vercel_bootstrap_identity(marker_identity, sizeof(marker_identity)) ||
        strcmp(marker_identity, argv[4]) != 0) return fail("BOOTSTRAP_IDENTITY_CHANGED");
    return capture(VERCEL_WORKSPACE_ROOT, argv[2], maximum, argv[4], 1);
  }
  if (local_ascii) return capture(argv[2], argv[3], maximum, argv[5], 1);
  return capture(argv[1], argv[2], maximum, argv[4], 0);
}
