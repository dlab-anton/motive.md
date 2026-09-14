#define _GNU_SOURCE

/*
 * Local fixed-command evaluator composition.
 *
 * This is deliberately a fixture-only QEMU rehearsal command. It has no
 * arguments and does not accept candidate source, command lines, paths, or
 * preflight booleans from its environment. Root validates the read-only
 * control disk and stages its sealed source before any candidate execution.
 */

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/mount.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define REPORTER_UID 1000
#define REPORTER_GID 1000
#define MAX_FACTS_BYTES (128U * 1024U)
#define MAX_CREATE_BINDING_B64 1024U
#define MAX_STAGED_SOURCE_BYTES (48U * 1024U)
#define MAX_STAGED_RECEIPT_BYTES (8U * 1024U)

#define CONTROL_DEVICE "/dev/vdb"
#define CONTROL_VOLUME "/run/motive/evaluator/control-volume"
#define CONTROL_ROOT "/run/motive/evaluator/control"
#define NODE_PATH "/usr/local/bin/node"
#define STAGER_PATH "/opt/motive/bin/motive-stage-sealed-source"
#define FINALIZER_PATH "/opt/motive/bin/motive-facts-finalizer"
#define PREPARER_PATH "/opt/evaluator/bin/prepare-fixtures"
#define SYSTEMD_RUN_PATH "/usr/bin/systemd-run"
#define LAKE_PATH "/opt/lean/bin/lake"
#define ENV_PATH "/usr/bin/env"
#define REPORTER_PATH "/opt/evaluator/bin/motive-comparator-reporter"
#define FRAME_DEVICE "/dev/ttyS0"
#define PRIVATE_ROOT "/var/lib/motive/evaluator"
#define PRIVATE_LOG_RELATIVE "private/command.log"
#define STAGED_SOURCE_ROOT "/var/lib/motive/evaluator/staged-source"
#define STAGED_SOURCE_NAME "Solution.lean"

#define SOURCE_WORK "work"
#define SOURCE_REPORTS "trusted-reports"
#define SOURCE_REPORT "report.json"
#define OUTPUT_VAR "var"
#define OUTPUT_LIB "lib"
#define OUTPUT_MOTIVE "motive"
#define OUTPUT_EVALUATOR "evaluator"
#define OUTPUT_REPORTS "trusted-reports"
#define OUTPUT_REPORT "report.json"
#define MARKER_RUN "run"
#define MARKER_MOTIVE "motive"
#define MARKER_EVALUATOR "evaluator"
#define MARKER_NAME "supervisor-complete"

#define FIXED_PATH "/opt/evaluator/bin:/opt/lean/bin:/usr/local/bin:/usr/bin:/bin"
#define USER_BUS "/run/user/1000/bus"
#define FIXTURE_ROOT "/work/prepared"
#define FIXTURE_WORKSPACE "/work/prepared/valid-proof"
#define UNIT_NAME "motive-evaluator-once"
#define UNIT_CGROUP "/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/motive-evaluator-once.service"

static const char marker_prefix[] = "motive.evaluator-supervisor-complete/0.2\n";
static const char frame_header[] = "MOTIVE_TRUSTED_EVALUATOR_FRAME_V1\n";
static const char stager_success[] = "MOTIVE_EVALUATOR_SOURCE_STAGED_V1\n";

extern char **environ;

struct create_binding {
  char environment_id[129];
  char attempt_id[129];
  char evaluator_profile_digest[72];
  char artifact_manifest_digest[72];
};

struct sha256_context {
  uint32_t state[8];
  uint64_t bits;
  unsigned char block[64];
  size_t used;
};

static void fail(void) {
  _exit(125);
}

static void write_all(int fd, const void *buffer, size_t length) {
  const unsigned char *bytes = buffer;
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) fail();
    offset += (size_t)written;
  }
}

static void require_call(int result) {
  if (result != 0) fail();
}

static int open_beneath(int parent, const char *name, uint64_t flags) {
  struct open_how how;
  memset(&how, 0, sizeof(how));
  how.flags = flags;
  how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;
  return (int)syscall(SYS_openat2, parent, name, &how, sizeof(how));
}

static int open_root(void) {
  int fd = open("/", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail();
  return fd;
}

static int open_directory(int parent, const char *name) {
  int fd = open_beneath(parent, name, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail();
  return fd;
}

static int open_file_path(int parent, const char *name) {
  int fd = open_beneath(parent, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) fail();
  return fd;
}

static void require_root_directory(int fd, mode_t exact_mode) {
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 0022) != 0 || (exact_mode != 0 && (st.st_mode & 07777) != exact_mode)) fail();
}

static void require_reporter_directory(int fd) {
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != REPORTER_UID || st.st_gid != REPORTER_GID ||
      (st.st_mode & 07777) != 0700) fail();
}

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino && left->st_mode == right->st_mode &&
    left->st_uid == right->st_uid && left->st_gid == right->st_gid && left->st_nlink == right->st_nlink &&
    left->st_size == right->st_size && left->st_mtim.tv_sec == right->st_mtim.tv_sec &&
    left->st_mtim.tv_nsec == right->st_mtim.tv_nsec && left->st_ctim.tv_sec == right->st_ctim.tv_sec &&
    left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static int duplicate_for_read(int path_fd) {
  char proc_path[64];
  int length = snprintf(proc_path, sizeof(proc_path), "/proc/self/fd/%d", path_fd);
  if (length <= 0 || (size_t)length >= sizeof(proc_path)) fail();
  int fd = open(proc_path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) fail();
  return fd;
}

static unsigned char *read_stable_regular_file(int path_fd, const struct stat *expected, size_t maximum, size_t *length) {
  if (!S_ISREG(expected->st_mode) || expected->st_nlink != 1 || expected->st_size < 0 ||
      (uintmax_t)expected->st_size > maximum) fail();
  int fd = duplicate_for_read(path_fd);
  struct stat current;
  if (fstat(fd, &current) != 0 || !same_stat(expected, &current)) {
    close(fd);
    fail();
  }
  size_t size = (size_t)expected->st_size;
  unsigned char *bytes = malloc(size == 0 ? 1U : size);
  if (bytes == NULL) {
    close(fd);
    fail();
  }
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = read(fd, bytes + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      free(bytes);
      close(fd);
      fail();
    }
    offset += (size_t)count;
  }
  unsigned char extra;
  ssize_t tail;
  do { tail = read(fd, &extra, 1); } while (tail < 0 && errno == EINTR);
  if (tail != 0 || fstat(fd, &current) != 0 || !same_stat(expected, &current) || close(fd) != 0) {
    free(bytes);
    fail();
  }
  *length = size;
  return bytes;
}

static void require_root_identity(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      real_uid != 0 || effective_uid != 0 || saved_uid != 0 || real_gid != 0 || effective_gid != 0 || saved_gid != 0) fail();
  int group_count = getgroups(0, NULL);
  if (group_count < 0 || group_count > 16) fail();
  gid_t groups[16];
  if (group_count > 0 && getgroups(group_count, groups) != group_count) fail();
  for (int index = 0; index < group_count; ++index) if (groups[index] != 0) fail();
}

static void mount_control_disk(void) {
  struct stat device;
  int observed = 0;
  for (unsigned int attempt = 0; attempt < 600U; ++attempt) {
    if (lstat(CONTROL_DEVICE, &device) == 0) {
      if (!S_ISBLK(device.st_mode) || device.st_uid != 0) fail();
      observed = 1;
      break;
    }
    if (errno != ENOENT) fail();
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000L };
    nanosleep(&pause, NULL);
  }
  if (!observed) fail();
  int root = open_root();
  require_root_directory(root, 0);
  int run = open_directory(root, "run");
  require_root_directory(run, 0);
  int motive = open_directory(run, "motive");
  require_root_directory(motive, 0755);
  int evaluator = open_directory(motive, "evaluator");
  require_root_directory(evaluator, 0700);
  int volume = open_directory(evaluator, "control-volume");
  require_root_directory(volume, 0700);
  int control = open_directory(evaluator, "control");
  require_root_directory(control, 0700);
  if (close(control) != 0 || close(volume) != 0 || close(evaluator) != 0 || close(motive) != 0 ||
      close(run) != 0 || close(root) != 0) fail();
  unsigned long flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC;
  if (mount(CONTROL_DEVICE, CONTROL_VOLUME, "ext4", flags, "noload") != 0 ||
      mount(CONTROL_VOLUME "/control", CONTROL_ROOT, NULL, MS_BIND | flags, NULL) != 0 ||
      mount(NULL, CONTROL_ROOT, NULL, MS_BIND | MS_REMOUNT | flags, NULL) != 0) fail();
  struct statvfs mounted;
  if (statvfs(CONTROL_ROOT, &mounted) != 0 ||
      (mounted.f_flag & (ST_RDONLY | ST_NOSUID | ST_NODEV | ST_NOEXEC)) !=
        (ST_RDONLY | ST_NOSUID | ST_NODEV | ST_NOEXEC)) fail();
  root = open_root();
  run = open_directory(root, "run");
  motive = open_directory(run, "motive");
  evaluator = open_directory(motive, "evaluator");
  control = open_directory(evaluator, "control");
  require_root_directory(control, 0700);
  if (close(control) != 0 || close(evaluator) != 0 || close(motive) != 0 || close(run) != 0 || close(root) != 0) fail();
}

static void set_bounds(void) {
  /* These limits also reach systemd-run and the bounded Node source stager.
   * V8 and QEMU reserve virtual address space beyond their resident use, so
   * the guest's 3 GiB RAM and the evaluator unit's 1 GiB MemoryMax provide
   * the meaningful physical limits rather than an inherited RLIMIT_AS. */
  struct rlimit cpu = {240, 240};
  struct rlimit files = {256, 256};
  struct rlimit fsize = {8U * 1024U * 1024U, 8U * 1024U * 1024U};
  struct rlimit core = {0, 0};
  require_call(prctl(PR_SET_DUMPABLE, 0));
  require_call(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  require_call(setrlimit(RLIMIT_CPU, &cpu));
  require_call(setrlimit(RLIMIT_NOFILE, &files));
  require_call(setrlimit(RLIMIT_FSIZE, &fsize));
  require_call(setrlimit(RLIMIT_CORE, &core));
  umask(0077);
  alarm(240);
}

static int base64_value(unsigned char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '+') return 62;
  if (value == '/') return 63;
  return -1;
}

static unsigned char *decode_base64(const char *input, size_t input_length, size_t *decoded_length) {
  if (input_length == 0 || input_length > MAX_CREATE_BINDING_B64 || input_length % 4U != 0) fail();
  size_t padding = input[input_length - 1] == '=' ? 1U : 0U;
  if (input[input_length - 2] == '=') padding++;
  if (padding > 2U) fail();
  size_t output_length = (input_length / 4U) * 3U - padding;
  if (output_length == 0 || output_length > 768U) fail();
  unsigned char *output = malloc(output_length + 1U);
  if (output == NULL) fail();
  size_t out = 0;
  for (size_t index = 0; index < input_length; index += 4U) {
    int values[4];
    for (size_t part = 0; part < 4U; ++part) {
      unsigned char character = (unsigned char)input[index + part];
      if (character == '=') {
        if (index + 4U != input_length || part < 2U || (part == 2U && input[index + 3U] != '=')) {
          free(output);
          fail();
        }
        values[part] = 0;
      } else {
        values[part] = base64_value(character);
        if (values[part] < 0 || (index + 4U == input_length && padding != 0 && part >= 4U - padding)) {
          free(output);
          fail();
        }
      }
    }
    uint32_t triple = ((uint32_t)values[0] << 18) | ((uint32_t)values[1] << 12) |
      ((uint32_t)values[2] << 6) | (uint32_t)values[3];
    if (out < output_length) output[out++] = (unsigned char)(triple >> 16);
    if (out < output_length) output[out++] = (unsigned char)(triple >> 8);
    if (out < output_length) output[out++] = (unsigned char)triple;
  }
  if (out != output_length) {
    free(output);
    fail();
  }
  output[output_length] = 0;
  *decoded_length = output_length;
  return output;
}

static int safe_id_character(unsigned char character) {
  return (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') ||
    (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-';
}

static int hex_character(unsigned char character) {
  return (character >= '0' && character <= '9') || (character >= 'a' && character <= 'f');
}

static void copy_exact_field(char *destination, size_t destination_size, const unsigned char *value,
                             size_t value_length, int digest) {
  if (value_length == 0 || value_length >= destination_size) fail();
  if (digest) {
    if (value_length != 71U || memcmp(value, "sha256:", 7U) != 0) fail();
    for (size_t index = 7U; index < value_length; ++index) if (!hex_character(value[index])) fail();
  } else {
    for (size_t index = 0; index < value_length; ++index) if (!safe_id_character(value[index])) fail();
  }
  memcpy(destination, value, value_length);
  destination[value_length] = 0;
}

static const unsigned char *consume_line(const unsigned char *cursor, const unsigned char *end,
                                         const char *prefix, char *destination, size_t destination_size, int digest) {
  size_t prefix_length = strlen(prefix);
  if ((size_t)(end - cursor) <= prefix_length || memcmp(cursor, prefix, prefix_length) != 0) fail();
  const unsigned char *value = cursor + prefix_length;
  const unsigned char *newline = memchr(value, '\n', (size_t)(end - value));
  if (newline == NULL) fail();
  copy_exact_field(destination, destination_size, value, (size_t)(newline - value), digest);
  return newline + 1;
}

static struct create_binding read_create_binding(void) {
  int root = open_root();
  require_root_directory(root, 0);
  int run = open_directory(root, "run");
  require_root_directory(run, 0);
  int motive = open_directory(run, "motive");
  require_root_directory(motive, 0755);
  int evaluator = open_directory(motive, "evaluator");
  require_root_directory(evaluator, 0700);
  int control = open_directory(evaluator, "control");
  require_root_directory(control, 0700);
  int binding = open_file_path(control, "create-binding.b64");
  struct stat st;
  if (fstat(binding, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 || st.st_nlink != 1 ||
      (st.st_mode & 07777) != 0444 || st.st_size < 4 || (uintmax_t)st.st_size > MAX_CREATE_BINDING_B64) fail();
  size_t encoded_length = 0;
  unsigned char *encoded = read_stable_regular_file(binding, &st, MAX_CREATE_BINDING_B64, &encoded_length);
  if (close(binding) != 0 || close(control) != 0 || close(evaluator) != 0 || close(motive) != 0 ||
      close(run) != 0 || close(root) != 0) {
    free(encoded);
    fail();
  }
  size_t decoded_length = 0;
  unsigned char *decoded = decode_base64((const char *)encoded, encoded_length, &decoded_length);
  free(encoded);
  static const char format[] = "motive.trusted-evaluator-create/0.1\n";
  const unsigned char *cursor = decoded;
  const unsigned char *end = decoded + decoded_length;
  if ((size_t)(end - cursor) < sizeof(format) - 1U || memcmp(cursor, format, sizeof(format) - 1U) != 0) {
    free(decoded);
    fail();
  }
  cursor += sizeof(format) - 1U;
  struct create_binding result;
  memset(&result, 0, sizeof(result));
  cursor = consume_line(cursor, end, "environment_id=", result.environment_id, sizeof(result.environment_id), 0);
  cursor = consume_line(cursor, end, "attempt_id=", result.attempt_id, sizeof(result.attempt_id), 0);
  cursor = consume_line(cursor, end, "evaluator_profile_digest=", result.evaluator_profile_digest,
    sizeof(result.evaluator_profile_digest), 1);
  cursor = consume_line(cursor, end, "artifact_manifest_digest=", result.artifact_manifest_digest,
    sizeof(result.artifact_manifest_digest), 1);
  if (cursor != end) {
    free(decoded);
    fail();
  }
  free(decoded);
  return result;
}

static int ensure_root_directory(int parent, const char *name, mode_t mode) {
  int created = 0;
  if (mkdirat(parent, name, mode) == 0) {
    created = 1;
  } else if (errno != EEXIST) {
    fail();
  }
  /* set_bounds() deliberately sets umask 0077.  Restore the exact requested
   * mode only on the directory we just created under a pinned root-owned
   * parent; an existing directory is only accepted after the check below. */
  if (created && fchmodat(parent, name, mode, AT_SYMLINK_NOFOLLOW) != 0) fail();
  int fd = open_directory(parent, name);
  require_root_directory(fd, mode);
  return fd;
}

static int open_private_log(void) {
  int root = open_root();
  require_root_directory(root, 0);
  int var = open_directory(root, OUTPUT_VAR);
  require_root_directory(var, 0);
  int lib = open_directory(var, OUTPUT_LIB);
  require_root_directory(lib, 0);
  int motive = open_directory(lib, OUTPUT_MOTIVE);
  require_root_directory(motive, 0);
  int evaluator = ensure_root_directory(motive, OUTPUT_EVALUATOR, 0700);
  int private_dir = ensure_root_directory(evaluator, "private", 0700);
  int log = openat(private_dir, "command.log", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (log < 0) fail();
  if (close(private_dir) != 0 || close(evaluator) != 0 || close(motive) != 0 || close(lib) != 0 ||
      close(var) != 0 || close(root) != 0) {
    close(log);
    fail();
  }
  return log;
}

static void clear_and_set_node_environment(void) {
  if (clearenv() != 0 || setenv("PATH", FIXED_PATH, 1) != 0 || setenv("HOME", "/home/node", 1) != 0 ||
      setenv("XDG_RUNTIME_DIR", "/run/user/1000", 1) != 0 ||
      setenv("DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/user/1000/bus", 1) != 0 ||
      setenv("LEAN_ABORT_ON_PANIC", "1", 1) != 0 || setenv("LC_ALL", "C", 1) != 0) fail();
}

static void drop_to_reporter_identity(void) {
  if (setgroups(0, NULL) != 0 || setresgid(REPORTER_GID, REPORTER_GID, REPORTER_GID) != 0 ||
      setresuid(REPORTER_UID, REPORTER_UID, REPORTER_UID) != 0) fail();
}

static int wait_child(pid_t child) {
  int status = 0;
  while (waitpid(child, &status, 0) < 0) {
    if (errno == EINTR) continue;
    fail();
  }
  if (!WIFEXITED(status)) fail();
  return WEXITSTATUS(status);
}

static pid_t start_node_command(char *const argv[], int log_fd) {
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 || dup2(log_fd, STDOUT_FILENO) < 0 ||
        dup2(log_fd, STDERR_FILENO) < 0) _exit(125);
    if (null_fd > STDERR_FILENO) close(null_fd);
    clear_and_set_node_environment();
    drop_to_reporter_identity();
    execve(argv[0], argv, environ);
    _exit(126);
  }
  return child;
}

static int run_node_command(char *const argv[], int log_fd) {
  return wait_child(start_node_command(argv, log_fd));
}

static void run_root_stager(int log_fd) {
  int output[2];
  if (pipe2(output, O_CLOEXEC) != 0) fail();
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 || dup2(output[1], STDOUT_FILENO) < 0 ||
        dup2(log_fd, STDERR_FILENO) < 0) _exit(125);
    if (null_fd > STDERR_FILENO) close(null_fd);
    close(output[0]);
    if (output[1] > STDERR_FILENO) close(output[1]);
    char *const argv[] = { (char *)NODE_PATH, (char *)STAGER_PATH, NULL };
    char *const environment[] = { "PATH=" FIXED_PATH, "HOME=/root", "LC_ALL=C", NULL };
    execve(NODE_PATH, argv, environment);
    _exit(126);
  }
  if (close(output[1]) != 0) fail();
  char observed[sizeof(stager_success)];
  size_t used = 0;
  while (used < sizeof(stager_success) - 1U) {
    ssize_t count = read(output[0], observed + used, sizeof(stager_success) - 1U - used);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail();
    used += (size_t)count;
  }
  unsigned char extra;
  ssize_t tail;
  do { tail = read(output[0], &extra, 1); } while (tail < 0 && errno == EINTR);
  if (tail != 0 || close(output[0]) != 0 || wait_child(child) != 0 ||
      memcmp(observed, stager_success, sizeof(stager_success) - 1U) != 0) fail();
}

static void wait_for_user_bus(void) {
  for (unsigned int attempt = 0; attempt < 600U; ++attempt) {
    struct stat st;
    if (lstat(USER_BUS, &st) == 0 && S_ISSOCK(st.st_mode) && st.st_uid == REPORTER_UID) return;
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000L };
    nanosleep(&pause, NULL);
  }
  fail();
}

static void prepare_fixed_fixture(int log_fd) {
  char *const argv[] = { (char *)PREPARER_PATH, (char *)FIXTURE_ROOT, NULL };
  if (run_node_command(argv, log_fd) != 0) fail();
}

static void create_report_directory(void) {
  int root = open_root();
  require_root_directory(root, 0);
  int work = open_directory(root, SOURCE_WORK);
  require_reporter_directory(work);
  if (mkdirat(work, SOURCE_REPORTS, 0700) != 0) fail();
  int reports = open_directory(work, SOURCE_REPORTS);
  if (fchownat(work, SOURCE_REPORTS, REPORTER_UID, REPORTER_GID, AT_SYMLINK_NOFOLLOW) != 0) fail();
  require_reporter_directory(reports);
  if (close(reports) != 0 || close(work) != 0 || close(root) != 0) fail();
}

static void require_cgroup_absent(void) {
  struct stat st;
  if (lstat(UNIT_CGROUP, &st) == 0 || errno != ENOENT) fail();
}

static void require_collected_cgroup(int observed) {
  if (!observed) fail();
  for (unsigned int attempt = 0; attempt < 100U; ++attempt) {
    struct stat st;
    if (lstat(UNIT_CGROUP, &st) != 0 && errno == ENOENT) return;
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 100000000L };
    nanosleep(&pause, NULL);
  }
  fail();
}

static int run_fixed_supervisor(int log_fd) {
  char *const argv[] = {
    (char *)SYSTEMD_RUN_PATH,
    "--user", "--quiet", "--wait", "--pipe", "--collect", "--unit=" UNIT_NAME,
    "--slice=app.slice",
    "--property=RestrictAddressFamilies=~AF_UNIX", "--property=NoNewPrivileges=yes",
    "--property=RuntimeMaxSec=120s", "--property=MemoryMax=1G", "--property=TasksMax=128",
    "--property=KillMode=control-group", "--property=TimeoutStopSec=5s",
    "--setenv=PATH=" FIXED_PATH, "--setenv=HOME=/home/node", "--setenv=LEAN_ABORT_ON_PANIC=1",
    "--setenv=COMPARATOR_LANDRUN=/opt/evaluator/bin/landrun-namespace-wrapper",
    "--setenv=COMPARATOR_LEAN4EXPORT=/opt/evaluator/bin/lean4export",
    "--working-directory=" FIXTURE_WORKSPACE,
    (char *)LAKE_PATH, "env", (char *)ENV_PATH, "PATH=" FIXED_PATH,
    (char *)REPORTER_PATH, "comparator.json", NULL,
  };
  require_cgroup_absent();
  pid_t child = start_node_command(argv, log_fd);
  int observed = 0;
  int status = 0;
  for (;;) {
    struct stat st;
    if (lstat(UNIT_CGROUP, &st) == 0) {
      if (!S_ISDIR(st.st_mode)) fail();
      observed = 1;
    } else if (errno != ENOENT) {
      fail();
    }
    pid_t waited;
    do { waited = waitpid(child, &status, WNOHANG); } while (waited < 0 && errno == EINTR);
    if (waited == child) break;
    if (waited < 0) fail();
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000L };
    nanosleep(&pause, NULL);
  }
  if (!WIFEXITED(status)) fail();
  int result = WEXITSTATUS(status);
  if (result != 0 && result != 1) fail();
  require_collected_cgroup(observed);
  return result;
}

static unsigned char *read_reporter_facts(size_t *length) {
  int root = open_root();
  require_root_directory(root, 0);
  int work = open_directory(root, SOURCE_WORK);
  require_reporter_directory(work);
  int reports = open_directory(work, SOURCE_REPORTS);
  require_reporter_directory(reports);
  int report = open_file_path(reports, SOURCE_REPORT);
  struct stat st;
  if (fstat(report, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != REPORTER_UID || st.st_gid != REPORTER_GID ||
      st.st_nlink != 1 || st.st_size < 1 || (uintmax_t)st.st_size > MAX_FACTS_BYTES ||
      (st.st_mode & 0022) != 0 || (st.st_mode & 07000) != 0) fail();
  unsigned char *facts = read_stable_regular_file(report, &st, MAX_FACTS_BYTES, length);
  if (close(report) != 0 || close(reports) != 0 || close(work) != 0 || close(root) != 0) {
    free(facts);
    fail();
  }
  return facts;
}

static int ensure_marker_directory(int parent, const char *name, mode_t mode) {
  return ensure_root_directory(parent, name, mode);
}

static void write_completion_marker(const unsigned char *facts, size_t length) {
  int root = open_root();
  require_root_directory(root, 0);
  int run = open_directory(root, MARKER_RUN);
  require_root_directory(run, 0);
  int motive = ensure_marker_directory(run, MARKER_MOTIVE, 0755);
  int evaluator = ensure_marker_directory(motive, MARKER_EVALUATOR, 0700);
  int marker = openat(evaluator, MARKER_NAME, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0400);
  if (marker < 0) fail();
  write_all(marker, marker_prefix, sizeof(marker_prefix) - 1U);
  write_all(marker, facts, length);
  require_call(fsync(marker));
  require_call(fchown(marker, 0, 0));
  require_call(fchmod(marker, 0400));
  require_call(close(marker));
  if (close(evaluator) != 0 || close(motive) != 0 || close(run) != 0 || close(root) != 0) fail();
}

static void run_finalizer(int log_fd) {
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 || dup2(log_fd, STDOUT_FILENO) < 0 ||
        dup2(log_fd, STDERR_FILENO) < 0 || clearenv() != 0) _exit(125);
    if (null_fd > STDERR_FILENO) close(null_fd);
    char *const argv[] = { (char *)FINALIZER_PATH, NULL };
    execve(FINALIZER_PATH, argv, environ);
    _exit(126);
  }
  if (wait_child(child) != 0) fail();
}

static unsigned char *read_finalized_facts(size_t *length) {
  int root = open_root();
  require_root_directory(root, 0);
  int var = open_directory(root, OUTPUT_VAR);
  require_root_directory(var, 0);
  int lib = open_directory(var, OUTPUT_LIB);
  require_root_directory(lib, 0);
  int motive = open_directory(lib, OUTPUT_MOTIVE);
  require_root_directory(motive, 0);
  int evaluator = open_directory(motive, OUTPUT_EVALUATOR);
  require_root_directory(evaluator, 0700);
  int reports = open_directory(evaluator, OUTPUT_REPORTS);
  require_root_directory(reports, 0700);
  int report = open_file_path(reports, OUTPUT_REPORT);
  struct stat st;
  if (fstat(report, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 || st.st_nlink != 1 ||
      (st.st_mode & 07777) != 0400 || st.st_size < 1 || (uintmax_t)st.st_size > MAX_FACTS_BYTES) fail();
  unsigned char *facts = read_stable_regular_file(report, &st, MAX_FACTS_BYTES, length);
  if (close(report) != 0 || close(reports) != 0 || close(evaluator) != 0 || close(motive) != 0 ||
      close(lib) != 0 || close(var) != 0 || close(root) != 0) {
    free(facts);
    fail();
  }
  return facts;
}

static uint32_t right_rotate(uint32_t value, unsigned int places) {
  return (value >> places) | (value << (32U - places));
}

static void sha256_transform(struct sha256_context *context, const unsigned char block[64]) {
  static const uint32_t constants[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U, 0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
  };
  uint32_t words[64];
  for (size_t index = 0; index < 16U; ++index) {
    words[index] = ((uint32_t)block[index * 4U] << 24) | ((uint32_t)block[index * 4U + 1U] << 16) |
      ((uint32_t)block[index * 4U + 2U] << 8) | (uint32_t)block[index * 4U + 3U];
  }
  for (size_t index = 16U; index < 64U; ++index) {
    uint32_t sigma0 = right_rotate(words[index - 15U], 7U) ^ right_rotate(words[index - 15U], 18U) ^ (words[index - 15U] >> 3U);
    uint32_t sigma1 = right_rotate(words[index - 2U], 17U) ^ right_rotate(words[index - 2U], 19U) ^ (words[index - 2U] >> 10U);
    words[index] = words[index - 16U] + sigma0 + words[index - 7U] + sigma1;
  }
  uint32_t a = context->state[0], b = context->state[1], c = context->state[2], d = context->state[3];
  uint32_t e = context->state[4], f = context->state[5], g = context->state[6], h = context->state[7];
  for (size_t index = 0; index < 64U; ++index) {
    uint32_t sigma1 = right_rotate(e, 6U) ^ right_rotate(e, 11U) ^ right_rotate(e, 25U);
    uint32_t choose = (e & f) ^ ((~e) & g);
    uint32_t temporary1 = h + sigma1 + choose + constants[index] + words[index];
    uint32_t sigma0 = right_rotate(a, 2U) ^ right_rotate(a, 13U) ^ right_rotate(a, 22U);
    uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
    uint32_t temporary2 = sigma0 + majority;
    h = g; g = f; f = e; e = d + temporary1; d = c; c = b; b = a; a = temporary1 + temporary2;
  }
  context->state[0] += a; context->state[1] += b; context->state[2] += c; context->state[3] += d;
  context->state[4] += e; context->state[5] += f; context->state[6] += g; context->state[7] += h;
}

static void sha256_init(struct sha256_context *context) {
  static const uint32_t initial[8] = { 0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U };
  memcpy(context->state, initial, sizeof(initial));
  context->bits = 0;
  context->used = 0;
}

static void sha256_update(struct sha256_context *context, const unsigned char *bytes, size_t length) {
  if (length > (UINT64_MAX - context->bits) / 8U) fail();
  context->bits += (uint64_t)length * 8U;
  while (length > 0) {
    size_t available = 64U - context->used;
    size_t take = length < available ? length : available;
    memcpy(context->block + context->used, bytes, take);
    context->used += take;
    bytes += take;
    length -= take;
    if (context->used == 64U) {
      sha256_transform(context, context->block);
      context->used = 0;
    }
  }
}

static void sha256_final(struct sha256_context *context, unsigned char output[32]) {
  context->block[context->used++] = 0x80U;
  if (context->used > 56U) {
    while (context->used < 64U) context->block[context->used++] = 0;
    sha256_transform(context, context->block);
    context->used = 0;
  }
  while (context->used < 56U) context->block[context->used++] = 0;
  for (size_t index = 0; index < 8U; ++index) context->block[56U + index] =
    (unsigned char)(context->bits >> (56U - index * 8U));
  sha256_transform(context, context->block);
  for (size_t index = 0; index < 8U; ++index) {
    output[index * 4U] = (unsigned char)(context->state[index] >> 24);
    output[index * 4U + 1U] = (unsigned char)(context->state[index] >> 16);
    output[index * 4U + 2U] = (unsigned char)(context->state[index] >> 8);
    output[index * 4U + 3U] = (unsigned char)context->state[index];
  }
}

static void sha256_hex(const unsigned char *bytes, size_t length, char output[72]) {
  static const char hex[] = "0123456789abcdef";
  unsigned char digest[32];
  struct sha256_context context;
  sha256_init(&context);
  sha256_update(&context, bytes, length);
  sha256_final(&context, digest);
  memcpy(output, "sha256:", 7U);
  for (size_t index = 0; index < sizeof(digest); ++index) {
    output[7U + index * 2U] = hex[digest[index] >> 4U];
    output[8U + index * 2U] = hex[digest[index] & 15U];
  }
  output[71] = 0;
}

static void install_staged_source(const struct create_binding *binding) {
  int root = open_root();
  require_root_directory(root, 0);
  int var = open_directory(root, "var");
  require_root_directory(var, 0);
  int lib = open_directory(var, "lib");
  require_root_directory(lib, 0);
  int motive = open_directory(lib, "motive");
  require_root_directory(motive, 0);
  int evaluator = open_directory(motive, "evaluator");
  require_root_directory(evaluator, 0700);
  int staged = open_directory(evaluator, "staged-source");
  require_root_directory(staged, 0700);
  int files = open_directory(staged, "files");
  require_root_directory(files, 0700);
  int source_path = open_file_path(files, STAGED_SOURCE_NAME);
  struct stat source_stat;
  if (fstat(source_path, &source_stat) != 0 || !S_ISREG(source_stat.st_mode) || source_stat.st_uid != 0 ||
      source_stat.st_gid != 0 || source_stat.st_nlink != 1 || (source_stat.st_mode & 07777) != 0400 ||
      source_stat.st_size < 0 || (uintmax_t)source_stat.st_size > MAX_STAGED_SOURCE_BYTES) fail();
  size_t source_length = 0;
  unsigned char *source = read_stable_regular_file(source_path, &source_stat, MAX_STAGED_SOURCE_BYTES, &source_length);
  char source_digest[72];
  sha256_hex(source, source_length, source_digest);

  int receipt_path = open_file_path(staged, "receipt.json");
  struct stat receipt_stat;
  if (fstat(receipt_path, &receipt_stat) != 0 || !S_ISREG(receipt_stat.st_mode) || receipt_stat.st_uid != 0 ||
      receipt_stat.st_gid != 0 || receipt_stat.st_nlink != 1 || (receipt_stat.st_mode & 07777) != 0400 ||
      receipt_stat.st_size < 1 || (uintmax_t)receipt_stat.st_size > MAX_STAGED_RECEIPT_BYTES) fail();
  size_t receipt_length = 0;
  unsigned char *receipt = read_stable_regular_file(receipt_path, &receipt_stat, MAX_STAGED_RECEIPT_BYTES, &receipt_length);
  char expected_receipt[1024];
  int expected_length = snprintf(expected_receipt, sizeof(expected_receipt),
    "{\"artifact_manifest_digest\":\"%s\",\"evaluator_profile_digest\":\"%s\",\"files\":[{\"bytes\":%zu,"
    "\"digest\":\"%s\",\"relative_path\":\"" STAGED_SOURCE_NAME "\"}],"
    "\"format\":\"motive.evaluator-staged-source/0.1\"}",
    binding->artifact_manifest_digest, binding->evaluator_profile_digest, source_length, source_digest);
  if (expected_length <= 0 || (size_t)expected_length >= sizeof(expected_receipt) ||
      receipt_length != (size_t)expected_length || memcmp(receipt, expected_receipt, receipt_length) != 0) fail();
  free(receipt);
  if (close(receipt_path) != 0 || close(source_path) != 0 || close(files) != 0 || close(staged) != 0 ||
      close(evaluator) != 0 || close(motive) != 0 || close(lib) != 0 || close(var) != 0) fail();

  int work = open_directory(root, SOURCE_WORK);
  require_reporter_directory(work);
  int prepared = open_directory(work, "prepared");
  require_reporter_directory(prepared);
  int workspace = open_directory(prepared, "valid-proof");
  require_reporter_directory(workspace);
  int existing = open_file_path(workspace, STAGED_SOURCE_NAME);
  struct stat existing_stat;
  if (fstat(existing, &existing_stat) != 0 || !S_ISREG(existing_stat.st_mode) || existing_stat.st_uid != REPORTER_UID ||
      existing_stat.st_gid != REPORTER_GID || existing_stat.st_nlink != 1 || (existing_stat.st_mode & 07777) != 0444 ||
      close(existing) != 0 || unlinkat(workspace, STAGED_SOURCE_NAME, 0) != 0) fail();
  int destination = openat(workspace, STAGED_SOURCE_NAME,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0400);
  if (destination < 0) fail();
  write_all(destination, source, source_length);
  free(source);
  if (fsync(destination) != 0 || fchown(destination, REPORTER_UID, REPORTER_GID) != 0 ||
      fchmod(destination, 0444) != 0 || close(destination) != 0 || close(workspace) != 0 ||
      close(prepared) != 0 || close(work) != 0 || close(root) != 0) fail();
}

static char *encode_base64(const unsigned char *input, size_t length, size_t *encoded_length) {
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (length == 0 || length > MAX_FACTS_BYTES) fail();
  size_t output_length = ((length + 2U) / 3U) * 4U;
  char *output = malloc(output_length + 1U);
  if (output == NULL) fail();
  size_t in = 0, out = 0;
  while (in < length) {
    size_t remaining = length - in;
    uint32_t value = (uint32_t)input[in++] << 16;
    if (remaining > 1U) value |= (uint32_t)input[in++] << 8;
    if (remaining > 2U) value |= input[in++];
    output[out++] = alphabet[(value >> 18) & 63U];
    output[out++] = alphabet[(value >> 12) & 63U];
    output[out++] = remaining > 1U ? alphabet[(value >> 6) & 63U] : '=';
    output[out++] = remaining > 2U ? alphabet[value & 63U] : '=';
  }
  output[output_length] = 0;
  *encoded_length = output_length;
  return output;
}

static void emit_frame(const struct create_binding *binding, const unsigned char *facts, size_t facts_length) {
  char digest[72];
  sha256_hex(facts, facts_length, digest);
  size_t encoded_length = 0;
  char *encoded = encode_base64(facts, facts_length, &encoded_length);
  const char *prefix = "{\"format\":\"motive.trusted-evaluator-frame/0.1\",\"environment_id\":\"";
  const char *middle = "\",\"attempt_id\":\"";
  const char *profile = "\",\"evaluator_profile_digest\":\"";
  const char *manifest = "\",\"artifact_manifest_digest\":\"";
  const char *facts_prefix = "\",\"facts_base64\":\"";
  char tail[512];
  int tail_length = snprintf(tail, sizeof(tail),
    "\",\"facts_digest\":\"%s\",\"runtime_preflight\":{"
    "\"af_unix_denied\":false,\"landlock_enforced\":false,\"namespace_identity\":false,"
    "\"descendants_reaped\":true,\"protected_report_capture\":true},\"input_preflight\":{"
    "\"trusted_challenge\":false,\"trusted_dependencies\":false,\"candidate_source_only\":true}}",
    digest);
  if (tail_length <= 0 || (size_t)tail_length >= sizeof(tail)) {
    free(encoded);
    fail();
  }
  size_t total = strlen(prefix) + strlen(binding->environment_id) + strlen(middle) + strlen(binding->attempt_id) +
    strlen(profile) + strlen(binding->evaluator_profile_digest) + strlen(manifest) + strlen(binding->artifact_manifest_digest) +
    strlen(facts_prefix) + encoded_length + (size_t)tail_length;
  if (total == 0 || total > 192U * 1024U) {
    free(encoded);
    fail();
  }
  char *json = malloc(total + 1U);
  if (json == NULL) {
    free(encoded);
    fail();
  }
  int written = snprintf(json, total + 1U, "%s%s%s%s%s%s%s%s%s%s%s", prefix, binding->environment_id,
    middle, binding->attempt_id, profile, binding->evaluator_profile_digest, manifest,
    binding->artifact_manifest_digest, facts_prefix, encoded, tail);
  free(encoded);
  if (written < 0 || (size_t)written != total) {
    free(json);
    fail();
  }
  int frame = open(FRAME_DEVICE, O_WRONLY | O_NOCTTY | O_CLOEXEC);
  if (frame < 0) {
    free(json);
    fail();
  }
  write_all(frame, frame_header, sizeof(frame_header) - 1U);
  write_all(frame, json, total);
  write_all(frame, "\n", 1U);
  free(json);
  if (close(frame) != 0) fail();
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) fail();
  require_root_identity();
  set_bounds();
  mount_control_disk();
  struct create_binding binding = read_create_binding();
  int log_fd = open_private_log();
  run_root_stager(log_fd);
  wait_for_user_bus();
  prepare_fixed_fixture(log_fd);
  install_staged_source(&binding);
  create_report_directory();
  (void)run_fixed_supervisor(log_fd);
  size_t source_length = 0;
  unsigned char *source = read_reporter_facts(&source_length);
  write_completion_marker(source, source_length);
  run_finalizer(log_fd);
  size_t final_length = 0;
  unsigned char *final_facts = read_finalized_facts(&final_length);
  if (source_length != final_length || memcmp(source, final_facts, source_length) != 0) {
    free(final_facts);
    free(source);
    fail();
  }
  free(source);
  if (close(log_fd) != 0) {
    free(final_facts);
    fail();
  }
  emit_frame(&binding, final_facts, final_length);
  free(final_facts);
  return 0;
}
