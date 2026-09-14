/*
 * Root-only entry point for the Vercel command-log collector path.
 *
 * The provider may start this executable with sudo, but it never accepts a
 * caller-selected executable, workspace, environment, or descriptor. It
 * verifies the fixed root-owned layout, drops irrevocably to the trusted
 * collection service UID, and fexecves the already-opened collector helper.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif

#define COLLECTOR_UID 1000
#define COLLECTOR_GID 1000
#define COLLECTOR_PATH "/opt/motive/bin/artifact-collector"
#define LAUNCHER_PATH "/opt/motive/bin/artifact-collector-launcher"
#define CONTROL_ROOT "/var/lib/motive/control"
#define BOOTSTRAP_RECORD CONTROL_ROOT "/worker-bootstrap.json"
#define MAX_BYTES (64U * 1024U * 1024U)

static void die(const char *message) {
  fprintf(stderr, "artifact-collector-launcher: %s\n", message);
  _exit(125);
}

static void require_call(int result, const char *message) {
  if (result == -1) die(message);
}

static void validate_root_path(const char *path, int directory, mode_t exact_mode) {
  struct stat st;
  if (lstat(path, &st) != 0 || S_ISLNK(st.st_mode) ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) ||
      st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 0022) != 0 ||
      (exact_mode != 0 && (st.st_mode & 07777) != exact_mode)) {
    die("trusted path is not root-protected");
  }
}

static void validate_layout(void) {
  validate_root_path("/", 1, 0);
  validate_root_path("/opt", 1, 0);
  validate_root_path("/opt/motive", 1, 0);
  validate_root_path("/opt/motive/bin", 1, 0555);
  validate_root_path(LAUNCHER_PATH, 0, 0555);
  validate_root_path(COLLECTOR_PATH, 0, 0555);
  validate_root_path("/var", 1, 0);
  validate_root_path("/var/lib", 1, 0);
  validate_root_path("/var/lib/motive", 1, 0);
  validate_root_path(CONTROL_ROOT, 1, 0755);
  validate_root_path(BOOTSTRAP_RECORD, 0, 0444);
  struct stat marker;
  if (lstat(BOOTSTRAP_RECORD, &marker) != 0 || marker.st_nlink != 1) {
    die("bootstrap record is not immutable");
  }
}

static void validate_standard_fds(void) {
  struct stat input, null_device, output, error_output;
  if (fstat(STDIN_FILENO, &input) != 0 || stat("/dev/null", &null_device) != 0 ||
      !S_ISCHR(input.st_mode) || input.st_rdev != null_device.st_rdev) {
    die("stdin must be /dev/null");
  }
  if (fstat(STDOUT_FILENO, &output) != 0 || (!S_ISFIFO(output.st_mode) && !S_ISSOCK(output.st_mode)) ||
      fstat(STDERR_FILENO, &error_output) != 0 || (!S_ISFIFO(error_output.st_mode) && !S_ISSOCK(error_output.st_mode))) {
    die("stdout and stderr must be provider pipes or sockets");
  }
}

static int last_capability(void) {
  char value[32] = {0};
  int fd = open("/proc/sys/kernel/cap_last_cap", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) die("cannot read capability bound");
  ssize_t count = read(fd, value, sizeof(value) - 1);
  close(fd);
  if (count <= 0) die("cannot parse capability bound");
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (end == value || parsed < 0 || parsed > 1024) die("unsupported capability bound");
  return (int)parsed;
}

static void drop_capability_bounding_set(int last_cap) {
  for (int capability = 0; capability <= last_cap; ++capability) {
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0) die("cannot drop capability bound");
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) {
    die("cannot clear ambient capabilities");
  }
}

static void verify_no_capabilities(int last_cap) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}};
  require_call((int)syscall(SYS_capget, &header, data), "cannot inspect capability sets");
  if (data[0].effective || data[1].effective || data[0].permitted || data[1].permitted ||
      data[0].inheritable || data[1].inheritable) die("capability set remains after drop");
  for (int capability = 0; capability <= last_cap; ++capability) {
    int allowed = prctl(PR_CAPBSET_READ, capability, 0, 0, 0);
    if (allowed != 0) die("capability bound remains after drop");
    int ambient = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0);
    if (ambient != 0) die("ambient capability remains after drop");
  }
}

static void drop_identity(int last_cap) {
  require_call(setgroups(0, NULL), "cannot clear supplementary groups");
  drop_capability_bounding_set(last_cap);
  require_call(prctl(PR_SET_KEEPCAPS, 0, 0, 0, 0), "cannot disable retained capabilities");
  require_call(setresgid(COLLECTOR_GID, COLLECTOR_GID, COLLECTOR_GID), "cannot drop group identity");
  require_call(setresuid(COLLECTOR_UID, COLLECTOR_UID, COLLECTOR_UID), "cannot drop user identity");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct none[2] = {{0}};
  require_call((int)syscall(SYS_capset, &header, none), "cannot clear capability sets");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    die("cannot install irreversible privilege controls");
  }
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      real_uid != COLLECTOR_UID || effective_uid != COLLECTOR_UID || saved_uid != COLLECTOR_UID ||
      real_gid != COLLECTOR_GID || effective_gid != COLLECTOR_GID || saved_gid != COLLECTOR_GID ||
      setfsuid((uid_t)-1) != COLLECTOR_UID || setfsgid((gid_t)-1) != COLLECTOR_GID || getgroups(0, NULL) != 0) {
    die("collector identity was not irreversibly dropped");
  }
  verify_no_capabilities(last_cap);
}

static int valid_relative_path(const char *path) {
  size_t length = strnlen(path, 1025), segment = 0;
  const char *start = path;
  if (!length || length > 1024 || path[0] == '/') return 0;
  for (size_t index = 0; index <= length; ++index) {
    unsigned char value = (unsigned char)path[index];
    if (value && (value < 32 || value == 127 || value == '\\' || value == ':')) return 0;
    if (!value || value == '/') {
      if (!segment || segment > 255 || (segment == 1 && start[0] == '.') ||
          (segment == 2 && start[0] == '.' && start[1] == '.')) return 0;
      segment = 0; start = path + index + 1;
    } else ++segment;
  }
  return strcmp(path, "manifest.json") != 0;
}

static int valid_limit(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  return !errno && end && value[0] >= '1' && value[0] <= '9' && *end == 0 && parsed > 0 && parsed <= MAX_BYTES;
}

static int valid_identity(const char *value) {
  size_t length = strnlen(value, 128), components = 0, digits = 0;
  if (!length || length >= 128) return 0;
  for (size_t index = 0; index <= length; ++index) {
    unsigned char character = (unsigned char)value[index];
    if (character >= '0' && character <= '9') { ++digits; continue; }
    if ((character == ':' || character == 0) && digits != 0) {
      ++components;
      digits = 0;
      if (character == 0) return components == 3;
      continue;
    }
    return 0;
  }
  return 0;
}

static int open_verified_collector(void) {
  int fd = open(COLLECTOR_PATH, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  struct stat st;
  if (fd < 0 || fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_nlink != 1 ||
      st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 07777) != 0555) {
    if (fd >= 0) close(fd);
    die("collector helper changed or is not protected");
  }
  return fd;
}

int main(int argc, char **argv) {
  if (getuid() != 0 || geteuid() != 0) die("provider sudo is required");
  int bootstrap = argc == 2 && strcmp(argv[1], "--bootstrap") == 0;
  int capture = argc == 5 && strcmp(argv[1], "--capture-ascii") == 0 &&
    valid_relative_path(argv[2]) && valid_limit(argv[3]) && valid_identity(argv[4]);
  if (!bootstrap && !capture) die("invalid fixed collector request");
  validate_layout();
  validate_standard_fds();
  if (syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_UNSHARE) != 0) die("cannot close inherited descriptors");
  int collector = open_verified_collector();
  int last_cap = last_capability();
  drop_identity(last_cap);
  if (clearenv() != 0) die("cannot clear inherited environment");
  char *const clean_environment[] = { "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL };
  char *const bootstrap_argv[] = { (char *)COLLECTOR_PATH, "--vercel-bootstrap", NULL };
  char *const capture_argv[] = { (char *)COLLECTOR_PATH, "--vercel-ascii", argv[2], argv[3], argv[4], NULL };
  fexecve(collector, bootstrap ? bootstrap_argv : capture_argv, clean_environment);
  die("cannot execute verified collector helper");
}
