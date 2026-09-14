#define _GNU_SOURCE

/*
 * Fixed outer command for the local QEMU rehearsal image.
 *
 * The provider invokes this program with no arguments.  It starts the fixed
 * guest command, retains every serial byte privately, and only copies a
 * single framed report to its own stdout after QEMU has stopped.  In
 * particular, candidate, reporter and finalizer diagnostics never become a
 * controller-visible report channel.
 *
 * Per-run bindings and sealed source arrive in three bounded environment
 * values. This launcher copies only those values into a private directory,
 * seals that directory into an ext4 image, and exposes its control subdirectory
 * as a read-only disk mount in the guest. They never enter QEMU's
 * kernel command line.
 */

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define QEMU_PATH "/usr/bin/qemu-system-x86_64"
#define GUEST_KERNEL "/guest/vmlinuz"
#define GUEST_INITRD "/guest/initrd.img"
#define GUEST_ROOTFS "/guest/rootfs.ext4"
#define CONTROL_IMAGE_ROOT "/dev/shm/motive-evaluator-control-root"
#define CONTROL_DIRECTORY CONTROL_IMAGE_ROOT "/control"
#define CONTROL_IMAGE "/dev/shm/motive-evaluator-control.ext4"
#define MKE2FS_PATH "/opt/motive/controlfs/mke2fs"
#define MKE2FS_CONFIG "/opt/motive/controlfs/mke2fs.conf"
#define MKE2FS_LIBRARY_PATH "/opt/motive/controlfs/lib"
#define CONTROL_IMAGE_BYTES (8U * 1024U * 1024U)
#define CREATE_BINDING_ENV "MOTIVE_EVALUATOR_CREATE_BINDING_B64"
#define PROFILE_ENV "MOTIVE_EVALUATOR_PROFILE_B64"
#define SOLUTION_ENV "MOTIVE_EVALUATOR_SOLUTION_B64"
#define MAX_CREATE_BINDING_B64 (4U * ((2U * 1024U + 2U) / 3U))
#define MAX_PROFILE_B64 (4U * ((16U * 1024U + 2U) / 3U))
#define MAX_SOLUTION_B64 (4U * ((80U * 1024U + 2U) / 3U))
#define MAX_SERIAL_BYTES (512U * 1024U)
#define MAX_QEMU_STDERR_BYTES (64U * 1024U)
#define MAX_FRAME_JSON_BYTES (192U * 1024U)

static const char frame_header[] = "MOTIVE_TRUSTED_EVALUATOR_FRAME_V1";
static const char failure[] = "MOTIVE_EVALUATOR_FRAME_LAUNCHER_FAILED\n";
static volatile sig_atomic_t qemu_child = -1;

static void fail(void) {
  if (qemu_child > 0) (void)kill((pid_t)qemu_child, SIGKILL);
  size_t offset = 0;
  while (offset < sizeof(failure) - 1U) {
    ssize_t wrote = write(STDERR_FILENO, failure + offset, sizeof(failure) - 1U - offset);
    if (wrote < 0 && errno == EINTR) continue;
    if (wrote <= 0) break;
    offset += (size_t)wrote;
  }
  _exit(125);
}

static void alarm_expired(int signal_number) {
  (void)signal_number;
  fail();
}

static void write_all(int fd, const char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t wrote = write(fd, bytes + offset, length - offset);
    if (wrote < 0 && errno == EINTR) continue;
    if (wrote <= 0) fail();
    offset += (size_t)wrote;
  }
}

static void require_root_identity(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 ||
      getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      real_uid != 0 || effective_uid != 0 || saved_uid != 0 ||
      real_gid != 0 || effective_gid != 0 || saved_gid != 0) fail();
  int count = getgroups(0, NULL);
  if (count < 0 || count > 16) fail();
  gid_t groups[16];
  if (count > 0 && getgroups(count, groups) != count) fail();
  for (int index = 0; index < count; ++index) if (groups[index] != 0) fail();
}

static void set_bounds(void) {
  /* QEMU reserves more virtual address space than its 3 GiB guest RAM.  The
   * local command's resident-memory bound is therefore the required outer
   * container cgroup (4 GiB in the rehearsal), while the guest evaluator's
   * unit also has a 1 GiB MemoryMax. */
  struct rlimit cpu = {600, 600};
  struct rlimit files = {64, 64};
  struct rlimit core = {0, 0};
  if (prctl(PR_SET_DUMPABLE, 0) != 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      setrlimit(RLIMIT_CPU, &cpu) != 0 ||
      setrlimit(RLIMIT_NOFILE, &files) != 0 || setrlimit(RLIMIT_CORE, &core) != 0) fail();
  if (signal(SIGALRM, alarm_expired) == SIG_ERR) fail();
  alarm(660);
}

static void require_readonly_regular(const char *path) {
  struct stat st;
  if (lstat(path, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
      st.st_nlink != 1 || (st.st_mode & 0022) != 0) fail();
}

static size_t require_bounded_base64(const char *value, size_t maximum) {
  if (value == NULL) fail();
  size_t length = strnlen(value, maximum + 1U);
  if (length == 0 || length > maximum || length % 4U != 0) fail();
  size_t padding = 0;
  if (length > 0 && value[length - 1U] == '=') padding++;
  if (length > 1 && value[length - 2U] == '=') padding++;
  for (size_t index = 0; index < length - padding; ++index) {
    unsigned char c = (unsigned char)value[index];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '+' || c == '/')) fail();
  }
  for (size_t index = length - padding; index < length; ++index) if (value[index] != '=') fail();
  return length;
}

static void write_control_file(int directory, const char *name, const char *value, size_t length) {
  int file = openat(directory, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0444);
  if (file < 0) fail();
  write_all(file, value, length);
  if (fsync(file) != 0 || fchown(file, 0, 0) != 0 || fchmod(file, 0444) != 0 || close(file) != 0) fail();
}

static void prepare_control_directory(void) {
  const char *binding = getenv(CREATE_BINDING_ENV);
  const char *profile = getenv(PROFILE_ENV);
  const char *solution = getenv(SOLUTION_ENV);
  size_t binding_length = require_bounded_base64(binding, MAX_CREATE_BINDING_B64);
  size_t profile_length = require_bounded_base64(profile, MAX_PROFILE_B64);
  size_t solution_length = require_bounded_base64(solution, MAX_SOLUTION_B64);
  if (mkdir(CONTROL_IMAGE_ROOT, 0700) != 0 || mkdir(CONTROL_DIRECTORY, 0700) != 0) fail();
  int directory = open(CONTROL_DIRECTORY, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat st;
  if (directory < 0 || fstat(directory, &st) != 0 || !S_ISDIR(st.st_mode) || st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 07777) != 0700 || st.st_nlink != 2) fail();
  write_control_file(directory, "create-binding.b64", binding, binding_length);
  write_control_file(directory, "evaluator-profile.b64", profile, profile_length);
  write_control_file(directory, "solution-pack.b64", solution, solution_length);
  if (fsync(directory) != 0 || close(directory) != 0 || unsetenv(CREATE_BINDING_ENV) != 0 ||
      unsetenv(PROFILE_ENV) != 0 || unsetenv(SOLUTION_ENV) != 0) fail();
}

static void make_control_image(void) {
  int image = open(CONTROL_IMAGE, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (image < 0 || ftruncate(image, CONTROL_IMAGE_BYTES) != 0 || fsync(image) != 0 || close(image) != 0) fail();
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 || dup2(null_fd, STDOUT_FILENO) < 0 ||
        dup2(null_fd, STDERR_FILENO) < 0) _exit(125);
    if (null_fd > STDERR_FILENO) close(null_fd);
    char *const argv[] = {
      (char *)MKE2FS_PATH, "-q", "-F", "-t", "ext4", "-m", "0",
      "-E", "root_owner=0:0,lazy_itable_init=0,lazy_journal_init=0",
      "-d", (char *)CONTROL_IMAGE_ROOT, (char *)CONTROL_IMAGE, NULL,
    };
    char library_environment[256];
    char config_environment[256];
    int library_length = snprintf(library_environment, sizeof(library_environment),
      "LD_LIBRARY_PATH=%s", MKE2FS_LIBRARY_PATH);
    int config_length = snprintf(config_environment, sizeof(config_environment),
      "MKE2FS_CONFIG=%s", MKE2FS_CONFIG);
    if (library_length <= 0 || (size_t)library_length >= sizeof(library_environment) || config_length <= 0 ||
        (size_t)config_length >= sizeof(config_environment)) _exit(125);
    char *const environment[] = { library_environment, config_environment, "LC_ALL=C", NULL };
    execve(MKE2FS_PATH, argv, environment);
    _exit(126);
  }
  int status;
  pid_t waited;
  do { waited = waitpid(child, &status, 0); } while (waited < 0 && errno == EINTR);
  if (waited != child || !WIFEXITED(status) || WEXITSTATUS(status) != 0) fail();
  require_readonly_regular(CONTROL_IMAGE);
}

static void remove_control_directory(void) {
  int directory = open(CONTROL_DIRECTORY, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory < 0 || unlinkat(directory, "create-binding.b64", 0) != 0 ||
      unlinkat(directory, "evaluator-profile.b64", 0) != 0 || unlinkat(directory, "solution-pack.b64", 0) != 0 ||
      close(directory) != 0 || rmdir(CONTROL_DIRECTORY) != 0 || rmdir(CONTROL_IMAGE_ROOT) != 0 ||
      unlink(CONTROL_IMAGE) != 0) fail();
}

static int make_pipe(int fds[2]) {
  if (pipe2(fds, O_CLOEXEC) != 0) fail();
  return 0;
}

static void make_nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) fail();
}

static pid_t start_qemu(int serial_write, int error_write) {
  pid_t expected_parent = getpid();
  pid_t child = fork();
  if (child < 0) fail();
  if (child == 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0 || getppid() != expected_parent) _exit(125);
    int null_fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (null_fd < 0 || dup2(null_fd, STDIN_FILENO) < 0 || dup2(serial_write, STDOUT_FILENO) < 0 ||
        dup2(error_write, STDERR_FILENO) < 0) _exit(125);
    if (null_fd > STDERR_FILENO) close(null_fd);
    if (serial_write > STDERR_FILENO) close(serial_write);
    if (error_write > STDERR_FILENO) close(error_write);
    char *const argv[] = {
      (char *)QEMU_PATH,
      "-accel", "tcg,thread=single",
      "-machine", "q35",
      "-cpu", "max",
      "-smp", "1",
      "-m", "3072",
      "-display", "none",
      "-monitor", "none",
      "-serial", "stdio",
      "-nic", "none",
      "-no-reboot",
      "-kernel", (char *)GUEST_KERNEL,
      "-initrd", (char *)GUEST_INITRD,
      "-blockdev", "driver=file,node-name=root-file,filename=" GUEST_ROOTFS ",read-only=on",
      "-blockdev", "driver=raw,node-name=root,file=root-file,read-only=on",
      "-device", "virtio-blk-pci,drive=root,serial=motive-root,addr=0x5",
      "-blockdev", "driver=file,node-name=control-file,filename=" CONTROL_IMAGE ",read-only=on",
      "-blockdev", "driver=raw,node-name=control,file=control-file,read-only=on",
      "-device", "virtio-blk-pci,drive=control,serial=motive-control,addr=0x6",
      "-object", "rng-random,filename=/dev/urandom,id=rng0",
      "-device", "virtio-rng-pci,rng=rng0",
      "-append", "root=/dev/vda ro rootfstype=ext4 console=ttyS0 quiet loglevel=3 panic=-1 oops=panic noresume systemd.show_status=no",
      NULL,
    };
    char *const environment[] = { "PATH=/usr/bin:/bin", "LC_ALL=C", NULL };
    execve(QEMU_PATH, argv, environment);
    _exit(126);
  }
  return child;
}

static void append_bytes(char *destination, size_t *used, size_t maximum, const char *source, size_t length) {
  if (length > maximum - *used) fail();
  memcpy(destination + *used, source, length);
  *used += length;
}

static void drain_pipe(int fd, char *destination, size_t *used, size_t maximum, int *open_flag) {
  char buffer[8192];
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count > 0) {
      append_bytes(destination, used, maximum, buffer, (size_t)count);
      continue;
    }
    if (count == 0) {
      if (close(fd) != 0) fail();
      *open_flag = 0;
      return;
    }
    if (errno == EINTR) continue;
    if (errno == EAGAIN || errno == EWOULDBLOCK) return;
    fail();
  }
}

static void collect_qemu(pid_t child, int serial_fd, int error_fd, char *serial, size_t *serial_length,
                         char *errors, size_t *error_length) {
  int serial_open = 1, error_open = 1, child_done = 0, status = 0;
  while (serial_open || error_open || !child_done) {
    struct pollfd fds[2];
    nfds_t count = 0;
    if (serial_open) fds[count++] = (struct pollfd){ .fd = serial_fd, .events = POLLIN | POLLHUP };
    if (error_open) fds[count++] = (struct pollfd){ .fd = error_fd, .events = POLLIN | POLLHUP };
    int polled;
    do { polled = poll(fds, count, 100); } while (polled < 0 && errno == EINTR);
    if (polled < 0) fail();
    nfds_t index = 0;
    if (serial_open) {
      if (fds[index].revents & (POLLIN | POLLHUP | POLLERR)) drain_pipe(serial_fd, serial, serial_length,
          MAX_SERIAL_BYTES, &serial_open);
      index++;
    }
    if (error_open && (fds[index].revents & (POLLIN | POLLHUP | POLLERR))) {
      drain_pipe(error_fd, errors, error_length, MAX_QEMU_STDERR_BYTES, &error_open);
    }
    if (!child_done) {
      pid_t waited;
      do { waited = waitpid(child, &status, WNOHANG); } while (waited < 0 && errno == EINTR);
      if (waited == child) {
        child_done = 1;
        qemu_child = -1;
      }
      else if (waited < 0) fail();
    }
  }
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) fail();
}

static int next_line(const char *bytes, size_t length, size_t *cursor, const char **start, size_t *line_length) {
  if (*cursor >= length) return 0;
  size_t begin = *cursor;
  size_t end = begin;
  while (end < length && bytes[end] != '\n') end++;
  *cursor = end < length ? end + 1U : end;
  if (end > begin && bytes[end - 1U] == '\r') end--;
  *start = bytes + begin;
  *line_length = end - begin;
  return 1;
}

static void emit_one_frame(const char *serial, size_t serial_length) {
  size_t cursor = 0, header_count = 0, json_count = 0;
  const char *frame_json = NULL;
  size_t frame_json_length = 0;
  const char *line;
  size_t line_length;
  while (next_line(serial, serial_length, &cursor, &line, &line_length)) {
    if (line_length == sizeof(frame_header) - 1U && memcmp(line, frame_header, line_length) == 0) {
      header_count++;
      if (!next_line(serial, serial_length, &cursor, &line, &line_length) || line_length < 2U ||
          line_length > MAX_FRAME_JSON_BYTES || line[0] != '{' || line[line_length - 1U] != '}') fail();
      frame_json = line;
      frame_json_length = line_length;
      json_count++;
    }
  }
  if (header_count != 1U || json_count != 1U || frame_json == NULL) fail();
  write_all(STDOUT_FILENO, frame_header, sizeof(frame_header) - 1U);
  write_all(STDOUT_FILENO, "\n", 1U);
  write_all(STDOUT_FILENO, frame_json, frame_json_length);
  write_all(STDOUT_FILENO, "\n", 1U);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) fail();
  signal(SIGPIPE, SIG_IGN);
  require_root_identity();
  set_bounds();
  require_readonly_regular(QEMU_PATH);
  require_readonly_regular(GUEST_KERNEL);
  require_readonly_regular(GUEST_INITRD);
  require_readonly_regular(GUEST_ROOTFS);
  require_readonly_regular(MKE2FS_PATH);
  require_readonly_regular(MKE2FS_CONFIG);
  prepare_control_directory();
  make_control_image();

  int serial_pipe[2], error_pipe[2];
  make_pipe(serial_pipe);
  make_pipe(error_pipe);
  pid_t child = start_qemu(serial_pipe[1], error_pipe[1]);
  qemu_child = (sig_atomic_t)child;
  if (close(serial_pipe[1]) != 0 || close(error_pipe[1]) != 0) fail();
  make_nonblocking(serial_pipe[0]);
  make_nonblocking(error_pipe[0]);
  char *serial = malloc(MAX_SERIAL_BYTES);
  char *errors = malloc(MAX_QEMU_STDERR_BYTES);
  if (serial == NULL || errors == NULL) fail();
  size_t serial_length = 0, error_length = 0;
  collect_qemu(child, serial_pipe[0], error_pipe[0], serial, &serial_length, errors, &error_length);
  remove_control_directory();
  /* Retain QEMU stderr only as bounded local failure diagnostics.  A valid
   * outer command deliberately emits no stderr, even if QEMU was chatty. */
  (void)errors;
  (void)error_length;
  emit_one_frame(serial, serial_length);
  free(errors);
  free(serial);
  return 0;
}
