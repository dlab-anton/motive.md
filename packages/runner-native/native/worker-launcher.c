#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/openat2.h>
#include <linux/seccomp.h>
#include <linux/securebits.h>
#include <limits.h>
#include <sched.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif

#define WORKER_UID 2000
#define WORKER_GID 2000
#define WORKSPACE_ROOT "/vercel/sandbox/workspace"
#define WORKER_HOME "/var/lib/motive/worker"
#define WORKER_TMP "/var/lib/motive/worker/tmp"
#define CODEX_HOME_PATH "/opt/motive/codex-config"
#define LAUNCHER_PATH "/opt/motive/bin/worker-launcher"
#define CHECKER_PATH "/opt/motive/bin/worker-runtime-check"
#define CHANNEL_PATH "/run/motive/channels/controller"
#define CONTROL_ROOT "/var/lib/motive/control"
#define BOOTSTRAP_RECORD CONTROL_ROOT "/worker-bootstrap.json"
#define INSTALLATION_ID_LINK CODEX_HOME_PATH "/installation_id"
#define INSTALLATION_ID_TARGET WORKER_HOME "/installation_id"

extern char **environ;

static void die(const char *message) {
  fprintf(stderr, "worker-launcher: %s\n", message);
  _exit(125);
}

static void require_call(int result, const char *message) {
  if (result == -1) {
    fprintf(stderr, "worker-launcher: %s: %s\n", message, strerror(errno));
    _exit(125);
  }
}

static void validate_identity_path(const char *path, int directory, mode_t exact_mode) {
  struct stat st;
  if (lstat(path, &st) != 0) die("trusted runtime path is missing");
  if (S_ISLNK(st.st_mode)) die("trusted runtime path is a symlink");
  if (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) die("trusted runtime path has the wrong type");
  if (st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 0022) != 0) die("trusted runtime path is not root-protected");
  if (exact_mode != 0 && (st.st_mode & 07777) != exact_mode) die("trusted runtime path mode is incorrect");
}

static void validate_worker_directory(const char *path, mode_t mode) {
  struct stat st;
  if (lstat(path, &st) != 0 || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode)) die("worker directory is invalid");
  if (st.st_uid != WORKER_UID || st.st_gid != WORKER_GID || (st.st_mode & 07777) != mode) {
    die("worker directory ownership or mode is invalid");
  }
}

static void validate_trusted_symlink(const char *path, const char *expected_target) {
  struct stat st;
  char target[PATH_MAX];
  if (lstat(path, &st) != 0 || !S_ISLNK(st.st_mode) || st.st_uid != 0 || st.st_gid != 0) {
    die("trusted runtime symlink is invalid");
  }
  ssize_t length = readlink(path, target, sizeof(target) - 1);
  if (length <= 0 || (size_t)length >= sizeof(target)) die("trusted runtime symlink target is invalid");
  target[length] = '\0';
  if (strcmp(target, expected_target) != 0) die("trusted runtime symlink target is unexpected");
}

static void validate_trusted_layout(void) {
  validate_identity_path("/", 1, 0);
  validate_identity_path("/opt", 1, 0);
  validate_identity_path("/opt/motive", 1, 0);
  validate_identity_path("/opt/motive/bin", 1, 0555);
  validate_identity_path(LAUNCHER_PATH, 0, 0555);
  validate_identity_path(CHECKER_PATH, 0, 0555);
  validate_identity_path(CODEX_HOME_PATH, 1, 0555);
  validate_identity_path(CODEX_HOME_PATH "/config.toml", 0, 0444);
  validate_identity_path(CODEX_HOME_PATH "/model-catalog.json", 0, 0444);
  validate_trusted_symlink(INSTALLATION_ID_LINK, INSTALLATION_ID_TARGET);
  validate_identity_path("/run", 1, 0);
  validate_identity_path("/run/motive", 1, 0);
  validate_identity_path("/run/motive/channels", 1, 0555);
  validate_identity_path(CHANNEL_PATH, 0, 0444);
  validate_identity_path("/var", 1, 0);
  validate_identity_path("/var/lib", 1, 0);
  validate_identity_path("/var/lib/motive", 1, 0);
  validate_identity_path(CONTROL_ROOT, 1, 0755);
  validate_identity_path("/vercel", 1, 0);
  validate_identity_path("/vercel/sandbox", 1, 0);
  validate_worker_directory(WORKSPACE_ROOT, 0755);
  validate_worker_directory(WORKER_HOME, 0700);
  if (setfsuid(WORKER_UID) != 0) die("cannot adopt worker filesystem identity for nested-path validation");
  validate_worker_directory(WORKER_TMP, 0700);
  if (setfsuid(0) != WORKER_UID || setfsuid((uid_t)-1) != 0) die("cannot restore trusted filesystem identity");
}

static void write_all(int fd, const char *value, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, value + offset, length - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      die("cannot write bootstrap record");
    }
    if (written == 0) die("bootstrap record write made no progress");
    offset += (size_t)written;
  }
}

static void create_bootstrap_record(int workspace_fd) {
  struct stat workspace;
  struct statx extended;
  memset(&extended, 0, sizeof(extended));
  if (fstat(workspace_fd, &workspace) != 0 || syscall(SYS_statx, workspace_fd, "", AT_EMPTY_PATH | AT_STATX_SYNC_AS_STAT,
      STATX_INO | STATX_MNT_ID, &extended) != 0 || !(extended.stx_mask & STATX_INO) || !(extended.stx_mask & STATX_MNT_ID)) {
    die("cannot bind bootstrap record to the opened workspace");
  }
  char record[512];
  int length = snprintf(record, sizeof(record),
    "{\"format\":\"motive.native-worker-bootstrap/0.1\",\"nativePolicy\":\"motive.native-worker/0.1\","
    "\"workerUid\":2000,\"workerGid\":2000,\"workspaceIdentity\":\"%llu:%llu:%llu\"}\n",
    (unsigned long long)workspace.st_dev, (unsigned long long)workspace.st_ino,
    (unsigned long long)extended.stx_mnt_id);
  if (length <= 0 || (size_t)length >= sizeof(record)) die("bootstrap record is too large");
  int directory_fd = open(CONTROL_ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (directory_fd < 0) die("cannot open protected control directory");
  int record_fd = openat(directory_fd, "worker-bootstrap.json",
    O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0400);
  if (record_fd < 0) die("bootstrap record already exists or cannot be created");
  write_all(record_fd, record, (size_t)length);
  require_call(fsync(record_fd), "cannot fsync bootstrap record");
  require_call(fchmod(record_fd, 0444), "cannot seal bootstrap record mode");
  require_call(fsync(record_fd), "cannot fsync sealed bootstrap record");
  require_call(close(record_fd), "cannot close bootstrap record");
  require_call(fsync(directory_fd), "cannot fsync protected control directory");
  require_call(close(directory_fd), "cannot close protected control directory");
}

static void validate_standard_fds(void) {
  struct stat input;
  struct stat null_device;
  struct stat output;
  struct stat error_output;
  if (fstat(STDIN_FILENO, &input) != 0 || stat("/dev/null", &null_device) != 0 ||
      !S_ISCHR(input.st_mode) || input.st_rdev != null_device.st_rdev) {
    die("stdin must be /dev/null");
  }
  if (fstat(STDOUT_FILENO, &output) != 0 || (!S_ISFIFO(output.st_mode) && !S_ISSOCK(output.st_mode))) {
    die("stdout must be a protected pipe or socket");
  }
  if (fstat(STDERR_FILENO, &error_output) != 0 || (!S_ISFIFO(error_output.st_mode) && !S_ISSOCK(error_output.st_mode))) {
    die("stderr must be a protected pipe or socket");
  }
}

static int valid_capability(const char *value) {
  if (value == NULL) return 0;
  size_t length = strnlen(value, 513);
  if (length < 32 || length > 512) return 0;
  for (size_t i = 0; i < length; i++) {
    char c = value[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0;
  }
  return 1;
}

static void set_limit(int resource, rlim_t value, const char *message) {
  struct rlimit limit = { .rlim_cur = value, .rlim_max = value };
  require_call(setrlimit(resource, &limit), message);
}

static void set_resource_limits(void) {
  set_limit(RLIMIT_CORE, 0, "cannot disable core files");
  set_limit(RLIMIT_FSIZE, 64U * 1024U * 1024U, "cannot limit file size");
  set_limit(RLIMIT_NOFILE, 128, "cannot limit descriptors");
  set_limit(RLIMIT_NPROC, 64, "cannot limit processes");
  set_limit(RLIMIT_CPU, 90, "cannot limit CPU time");
  set_limit(RLIMIT_STACK, 16U * 1024U * 1024U, "cannot limit stack");
  /* V8 reserves a multi-GiB pointer-compression cage without committing it.
   * Physical memory remains independently capped by the outer cgroup. */
  set_limit(RLIMIT_AS, 8ULL * 1024ULL * 1024ULL * 1024ULL, "cannot limit address space");
  set_limit(RLIMIT_MEMLOCK, 0, "cannot disable memory locking");
#ifdef RLIMIT_MSGQUEUE
  set_limit(RLIMIT_MSGQUEUE, 0, "cannot disable message queues");
#endif
#ifdef RLIMIT_RTPRIO
  set_limit(RLIMIT_RTPRIO, 0, "cannot disable realtime priority");
#endif
}

static int read_last_capability(void) {
  char value[32] = {0};
  int fd = open("/proc/sys/kernel/cap_last_cap", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) die("cannot read the kernel capability bound");
  ssize_t count = read(fd, value, sizeof(value) - 1);
  close(fd);
  if (count <= 0) die("cannot parse the kernel capability bound");
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (end == value || parsed < 0 || parsed > 1024) die("kernel capability bound is unsupported");
  return (int)parsed;
}

static void zero_capabilities(void) {
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}};
  require_call((int)syscall(SYS_capset, &header, data), "cannot clear capability sets");
}

static void verify_credentials(int last_cap) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0) {
    die("cannot verify worker credentials");
  }
  if (real_uid != WORKER_UID || effective_uid != WORKER_UID || saved_uid != WORKER_UID ||
      real_gid != WORKER_GID || effective_gid != WORKER_GID || saved_gid != WORKER_GID ||
      setfsuid((uid_t)-1) != WORKER_UID || setfsgid((gid_t)-1) != WORKER_GID || getgroups(0, NULL) != 0) {
    die("worker credentials were not irreversibly dropped");
  }
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}};
  require_call((int)syscall(SYS_capget, &header, data), "cannot verify capability sets");
  for (size_t i = 0; i < 2; i++) {
    if (data[i].effective || data[i].permitted || data[i].inheritable) die("worker retained a capability");
  }
  for (int capability = 0; capability <= last_cap; capability++) {
    if (prctl(PR_CAPBSET_READ, capability, 0, 0, 0) != 0) die("worker retained a bounding capability");
#ifdef PR_CAP_AMBIENT
    if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0, 0) != 0) die("worker retained an ambient capability");
#endif
  }
}

static uint64_t landlock_write_access(int abi) {
  uint64_t access = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
    LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
  if (abi >= 2) access |= LANDLOCK_ACCESS_FS_REFER;
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
  if (abi >= 3) access |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif
#ifdef LANDLOCK_ACCESS_FS_IOCTL_DEV
  if (abi >= 5) access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
#endif
  return access;
}

static void add_landlock_path(int ruleset_fd, int parent_fd, uint64_t access) {
  struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = parent_fd };
  require_call((int)syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &rule, 0),
    "cannot add filesystem confinement rule");
}

static void install_landlock(int workspace_fd, int home_fd) {
  int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 3) {
    fprintf(stderr, "worker-launcher: Landlock ABI 3 or newer is required (host reports ABI %d)\n", abi);
    _exit(125);
  }
  uint64_t access = landlock_write_access(abi);
  struct landlock_ruleset_attr ruleset = { .handled_access_fs = access };
  int ruleset_fd = (int)syscall(SYS_landlock_create_ruleset, &ruleset, sizeof(ruleset), 0);
  if (ruleset_fd < 0) die("cannot create filesystem confinement ruleset");
  add_landlock_path(ruleset_fd, workspace_fd, access);
  add_landlock_path(ruleset_fd, home_fd, access);
  require_call((int)syscall(SYS_landlock_restrict_self, ruleset_fd, 0), "cannot enforce filesystem confinement");
  close(ruleset_fd);
}

#define DENY_SYSCALL(number, error_number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ((error_number) & SECCOMP_RET_DATA))
#define DENY_PRCTL_ERROR(option, error_number) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 3), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (option), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | ((error_number) & SECCOMP_RET_DATA)), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))
#define DENY_PRCTL(option) DENY_PRCTL_ERROR((option), EPERM)
#define ALLOW_PRCTL_ARG(option, argument) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_prctl, 0, 5), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (option), 0, 3), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])), \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (argument), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW), \
  BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr))

static void install_seccomp(void) {
#if !defined(__x86_64__)
  die("worker syscall policy currently requires x86_64");
#else
  const uint32_t namespace_flags = CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET | CLONE_NEWNS |
    CLONE_NEWPID | CLONE_NEWTIME | CLONE_NEWUSER | CLONE_NEWUTS;
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#ifdef SYS_clone
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, namespace_flags),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#endif
#ifdef SYS_clone3
    DENY_SYSCALL(SYS_clone3, ENOSYS),
#endif
    /* Codex gives each tool child a SIGTERM parent-death signal. TERM and KILL
       add lifecycle containment; clearing or selecting another signal is denied. */
    ALLOW_PRCTL_ARG(PR_SET_PDEATHSIG, SIGTERM),
    ALLOW_PRCTL_ARG(PR_SET_PDEATHSIG, SIGKILL),
    DENY_PRCTL(PR_SET_DUMPABLE),
    DENY_PRCTL(PR_SET_KEEPCAPS),
    DENY_PRCTL(PR_SET_SECUREBITS),
    DENY_PRCTL(PR_SET_PDEATHSIG),
#ifdef PR_CAP_AMBIENT
    DENY_PRCTL(PR_CAP_AMBIENT),
#endif
    DENY_SYSCALL(SYS_setuid, EPERM),
    DENY_SYSCALL(SYS_setgid, EPERM),
    DENY_SYSCALL(SYS_setreuid, EPERM),
    DENY_SYSCALL(SYS_setregid, EPERM),
    DENY_SYSCALL(SYS_setresuid, EPERM),
    DENY_SYSCALL(SYS_setresgid, EPERM),
    DENY_SYSCALL(SYS_setfsuid, EPERM),
    DENY_SYSCALL(SYS_setfsgid, EPERM),
    DENY_SYSCALL(SYS_setgroups, EPERM),
    DENY_SYSCALL(SYS_capset, EPERM),
    DENY_SYSCALL(SYS_unshare, EPERM),
    DENY_SYSCALL(SYS_setns, EPERM),
    DENY_SYSCALL(SYS_mount, EPERM),
    DENY_SYSCALL(SYS_umount2, EPERM),
    DENY_SYSCALL(SYS_pivot_root, EPERM),
    DENY_SYSCALL(SYS_chroot, EPERM),
#ifdef SYS_fsopen
    DENY_SYSCALL(SYS_fsopen, EPERM),
    DENY_SYSCALL(SYS_fsconfig, EPERM),
    DENY_SYSCALL(SYS_fsmount, EPERM),
    DENY_SYSCALL(SYS_move_mount, EPERM),
    DENY_SYSCALL(SYS_open_tree, EPERM),
    DENY_SYSCALL(SYS_mount_setattr, EPERM),
#endif
    DENY_SYSCALL(SYS_ptrace, EPERM),
    DENY_SYSCALL(SYS_process_vm_readv, EPERM),
    DENY_SYSCALL(SYS_process_vm_writev, EPERM),
    DENY_SYSCALL(SYS_kcmp, EPERM),
    DENY_SYSCALL(SYS_bpf, EPERM),
    DENY_SYSCALL(SYS_perf_event_open, EPERM),
    DENY_SYSCALL(SYS_userfaultfd, EPERM),
    DENY_SYSCALL(SYS_open_by_handle_at, EPERM),
    DENY_SYSCALL(SYS_name_to_handle_at, EPERM),
    DENY_SYSCALL(SYS_init_module, EPERM),
    DENY_SYSCALL(SYS_finit_module, EPERM),
    DENY_SYSCALL(SYS_delete_module, EPERM),
    DENY_SYSCALL(SYS_kexec_load, EPERM),
#ifdef SYS_kexec_file_load
    DENY_SYSCALL(SYS_kexec_file_load, EPERM),
#endif
    DENY_SYSCALL(SYS_reboot, EPERM),
    DENY_SYSCALL(SYS_swapon, EPERM),
    DENY_SYSCALL(SYS_swapoff, EPERM),
    DENY_SYSCALL(SYS_acct, EPERM),
    DENY_SYSCALL(SYS_iopl, EPERM),
    DENY_SYSCALL(SYS_ioperm, EPERM),
    DENY_SYSCALL(SYS_add_key, EPERM),
    DENY_SYSCALL(SYS_request_key, EPERM),
    DENY_SYSCALL(SYS_keyctl, EPERM),
    DENY_SYSCALL(SYS_fanotify_init, EPERM),
#ifdef SYS_io_uring_setup
    DENY_SYSCALL(SYS_io_uring_setup, EPERM),
#endif
    DENY_SYSCALL(SYS_personality, EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter };
  require_call((int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, 0, &program), "cannot install worker syscall filter");
#endif
}

static int open_relative_cwd(int workspace_fd, const char *relative_path) {
  if (relative_path == NULL || relative_path[0] == '\0' || relative_path[0] == '/') die("cwd must be a relative path");
  if (strcmp(relative_path, ".") != 0) {
    const char *cursor = relative_path;
    while (*cursor) {
      const char *slash = strchr(cursor, '/');
      size_t length = slash ? (size_t)(slash - cursor) : strlen(cursor);
      if (length == 0 || (length == 1 && cursor[0] == '.') || (length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
        die("cwd contains an unsafe segment");
      }
      cursor = slash ? slash + 1 : cursor + length;
    }
  }
  struct open_how how = {
    .flags = O_PATH | O_DIRECTORY | O_CLOEXEC,
    .resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
  };
  int fd = (int)syscall(SYS_openat2, workspace_fd, relative_path, &how, sizeof(how));
  if (fd < 0) die("cwd is not a safe directory beneath the workspace");
  return fd;
}

static void validate_candidate(const char *path, char resolved[PATH_MAX]) {
  if (path == NULL || path[0] != '/' || realpath(path, resolved) == NULL) die("candidate executable must resolve from an absolute path");
  struct stat st;
  if (lstat(resolved, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 0022) != 0 || (st.st_mode & 0111) == 0) {
    die("candidate executable is not root-protected and executable");
  }
  /* A protected leaf beneath a worker-writable directory is replaceable after
   * validation. Require every resolved ancestor to remain in the trusted root
   * namespace so path-based exec has no untrusted rename component. */
  char ancestor[PATH_MAX];
  if (snprintf(ancestor, sizeof(ancestor), "%s", resolved) >= (int)sizeof(ancestor)) {
    die("candidate executable path is too long");
  }
  for (;;) {
    char *slash = strrchr(ancestor, '/');
    if (slash == NULL) die("candidate executable ancestry is invalid");
    if (slash == ancestor) ancestor[1] = '\0';
    else *slash = '\0';
    if (lstat(ancestor, &st) != 0 || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode) ||
        st.st_uid != 0 || st.st_gid != 0 || (st.st_mode & 0022) != 0) {
      die("candidate executable ancestry is not root-protected");
    }
    if (strcmp(ancestor, "/") == 0) break;
  }
}

int main(int argc, char **argv) {
  if (argc < 5 || strcmp(argv[1], "--cwd-relative") != 0 || strcmp(argv[3], "--") != 0) {
    die("usage: worker-launcher --cwd-relative RELATIVE -- /absolute/executable [args...]");
  }
  if (getuid() != 0 || geteuid() != 0 || getgid() != 0 || getegid() != 0) die("launcher requires the trusted root launch identity");
  validate_trusted_layout();
  validate_standard_fds();

  const char *inherited_capability = getenv("MOTIVE_RUN_CAPABILITY");
  if (!valid_capability(inherited_capability)) die("MOTIVE_RUN_CAPABILITY is missing or invalid");
  char capability[513];
  snprintf(capability, sizeof(capability), "%s", inherited_capability);
  char capability_environment[sizeof("MOTIVE_RUN_CAPABILITY=") + sizeof(capability)];
  snprintf(capability_environment, sizeof(capability_environment), "MOTIVE_RUN_CAPABILITY=%s", capability);

  char candidate[PATH_MAX];
  validate_candidate(argv[4], candidate);
  int workspace_fd = open(WORKSPACE_ROOT, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  int home_fd = open(WORKER_HOME, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  if (workspace_fd < 0 || home_fd < 0) die("cannot open protected worker directories");
  int cwd_fd = open_relative_cwd(workspace_fd, argv[2]);
  create_bootstrap_record(workspace_fd);

  clearenv();
  umask(0022);
  set_resource_limits();
  int last_cap = read_last_capability();
  unsigned int securebits = SECBIT_KEEP_CAPS_LOCKED | SECBIT_NO_SETUID_FIXUP | SECBIT_NO_SETUID_FIXUP_LOCKED |
    SECBIT_NOROOT | SECBIT_NOROOT_LOCKED | SECBIT_NO_CAP_AMBIENT_RAISE | SECBIT_NO_CAP_AMBIENT_RAISE_LOCKED;
  require_call(prctl(PR_SET_SECUREBITS, securebits, 0, 0, 0), "cannot lock securebits");
#ifdef PR_CAP_AMBIENT
  require_call(prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0), "cannot clear ambient capabilities");
#endif
  for (int capability_number = 0; capability_number <= last_cap; capability_number++) {
    require_call(prctl(PR_CAPBSET_DROP, capability_number, 0, 0, 0), "cannot drop capability bounding set");
  }
  require_call(setgroups(0, NULL), "cannot clear supplementary groups");
  require_call(setresgid(WORKER_GID, WORKER_GID, WORKER_GID), "cannot drop group identity");
  require_call(setresuid(WORKER_UID, WORKER_UID, WORKER_UID), "cannot drop user identity");
  zero_capabilities();
  require_call(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), "cannot set no_new_privs");
  require_call(prctl(PR_SET_DUMPABLE, 0, 0, 0, 0), "cannot disable dumpability");
  require_call(prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0), "cannot bind worker lifetime");
  verify_credentials(last_cap);
  install_landlock(workspace_fd, home_fd);
  require_call(fchdir(cwd_fd), "cannot enter pinned workspace directory");
  require_call((int)syscall(SYS_close_range, 3U, ~0U, CLOSE_RANGE_UNSHARE), "cannot close inherited descriptors");
  install_seccomp();

  char *worker_environment[] = {
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "HOME=" WORKER_HOME,
    "TMPDIR=" WORKER_TMP,
    "CODEX_HOME=" CODEX_HOME_PATH,
    "CODEX_SQLITE_HOME=" WORKER_HOME,
    "USER=motive-worker",
    "LOGNAME=motive-worker",
    "CI=1",
    "NO_COLOR=1",
    capability_environment,
    NULL,
  };
  argv[4] = candidate;
  execve(candidate, &argv[4], worker_environment);
  fprintf(stderr, "worker-launcher: candidate exec failed: %s\n", strerror(errno));
  return 126;
}
