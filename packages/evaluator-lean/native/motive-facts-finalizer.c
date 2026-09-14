#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/fs.h>
#include <linux/openat2.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

/*
 * This program has deliberately no path, report, command-id, or shell
 * arguments. A root-owned trusted evaluator launcher invokes it only after it
 * has observed the evaluator supervisor complete and tear down descendants.
 * The marker below is a one-way caller contract; this binary cannot establish
 * that observation by inspecting a file. Its root-authored snapshot must bind
 * the exact facts bytes read after teardown, and it is consumed before output
 * publication so a private evaluator filesystem is single-use.
 */
#define REPORTER_UID 1000
#define REPORTER_GID 1000
#define MAX_FACTS_BYTES (128U * 1024U)

#define SUPERVISOR_DIR_A "run"
#define SUPERVISOR_DIR_B "motive"
#define SUPERVISOR_DIR_C "evaluator"
#define SUPERVISOR_MARKER "supervisor-complete"
#define SUPERVISOR_CONSUMED_MARKER ".supervisor-complete.consumed"

#define SOURCE_DIR_A "work"
#define SOURCE_DIR_B "trusted-reports"
#define SOURCE_FILE "report.json"

#define OUTPUT_DIR_A "var"
#define OUTPUT_DIR_B "lib"
#define OUTPUT_DIR_C "motive"
#define OUTPUT_DIR_D "evaluator"
#define OUTPUT_DIR_E "trusted-reports"
#define OUTPUT_FILE "report.json"
#define OUTPUT_TEMPORARY_FILE ".report.json.finalizing"

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif

static const char supervisor_marker_prefix[] = "motive.evaluator-supervisor-complete/0.2\n";
static const char success_marker[] = "MOTIVE_EVALUATOR_FACTS_FINALIZED_V1\n";

static void require_absent(int directory, const char *name);

static void write_all_or_die(int fd, const char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) _exit(125);
    offset += (size_t)written;
  }
}

static void fail(void) {
  static const char message[] = "MOTIVE_EVALUATOR_FACTS_FINALIZER_FAILED\n";
  write_all_or_die(STDERR_FILENO, message, sizeof(message) - 1U);
  _exit(125);
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

static int same_stat(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
    left->st_mode == right->st_mode && left->st_uid == right->st_uid && left->st_gid == right->st_gid &&
    left->st_nlink == right->st_nlink && left->st_size == right->st_size &&
    left->st_mtim.tv_sec == right->st_mtim.tv_sec && left->st_mtim.tv_nsec == right->st_mtim.tv_nsec &&
    left->st_ctim.tv_sec == right->st_ctim.tv_sec && left->st_ctim.tv_nsec == right->st_ctim.tv_nsec;
}

static int duplicate_for_read(int path_fd) {
  char path[64];
  int length = snprintf(path, sizeof(path), "/proc/self/fd/%d", path_fd);
  if (length <= 0 || (size_t)length >= sizeof(path)) fail();
  int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) fail();
  return fd;
}

static int duplicate_for_directory(int path_fd) {
  char path[64];
  int length = snprintf(path, sizeof(path), "/proc/self/fd/%d", path_fd);
  if (length <= 0 || (size_t)length >= sizeof(path)) fail();
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) fail();
  return fd;
}

static unsigned char *read_stable_regular_file(int path_fd, const struct stat *expected, size_t maximum, size_t *length) {
  if (!S_ISREG(expected->st_mode) || expected->st_nlink != 1 || expected->st_size < 1 ||
      (uintmax_t)expected->st_size > maximum) fail();
  int fd = duplicate_for_read(path_fd);
  struct stat current;
  if (fstat(fd, &current) != 0 || !same_stat(expected, &current)) {
    close(fd);
    fail();
  }
  size_t size = (size_t)expected->st_size;
  unsigned char *bytes = malloc(size);
  if (bytes == NULL) {
    close(fd);
    fail();
  }
  size_t offset = 0;
  while (offset < size) {
    ssize_t read_count = read(fd, bytes + offset, size - offset);
    if (read_count < 0 && errno == EINTR) continue;
    if (read_count <= 0) {
      close(fd);
      free(bytes);
      fail();
    }
    offset += (size_t)read_count;
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

struct completion_marker {
  int evaluator_directory;
  int marker_file;
  struct stat marker_stat;
  unsigned char *bytes;
  size_t length;
};

static struct completion_marker read_supervisor_completion(void) {
  int root = open_root();
  require_root_directory(root, 0);
  int run = open_directory(root, SUPERVISOR_DIR_A);
  require_root_directory(run, 0);
  int motive = open_directory(run, SUPERVISOR_DIR_B);
  require_root_directory(motive, 0755);
  int evaluator = open_directory(motive, SUPERVISOR_DIR_C);
  require_root_directory(evaluator, 0700);
  int marker = open_file_path(evaluator, SUPERVISOR_MARKER);
  struct stat marker_stat;
  if (fstat(marker, &marker_stat) != 0 || !S_ISREG(marker_stat.st_mode) || marker_stat.st_uid != 0 ||
      marker_stat.st_gid != 0 || marker_stat.st_nlink != 1 || (marker_stat.st_mode & 07777) != 0400 ||
      marker_stat.st_size <= (off_t)(sizeof(supervisor_marker_prefix) - 1U) ||
      (uintmax_t)marker_stat.st_size > (sizeof(supervisor_marker_prefix) - 1U) + MAX_FACTS_BYTES) fail();
  struct completion_marker completion;
  memset(&completion, 0, sizeof(completion));
  completion.evaluator_directory = evaluator;
  completion.marker_file = marker;
  completion.marker_stat = marker_stat;
  completion.bytes = read_stable_regular_file(marker, &marker_stat,
    (sizeof(supervisor_marker_prefix) - 1U) + MAX_FACTS_BYTES, &completion.length);
  if (completion.length <= sizeof(supervisor_marker_prefix) - 1U ||
      memcmp(completion.bytes, supervisor_marker_prefix, sizeof(supervisor_marker_prefix) - 1U) != 0) {
    free(completion.bytes);
    fail();
  }
  if (close(motive) != 0 || close(run) != 0 || close(root) != 0) {
    free(completion.bytes);
    fail();
  }
  return completion;
}

static void consume_supervisor_completion(struct completion_marker *completion,
                                          const unsigned char *facts, size_t facts_length) {
  if (completion->length != (sizeof(supervisor_marker_prefix) - 1U) + facts_length ||
      memcmp(completion->bytes + sizeof(supervisor_marker_prefix) - 1U, facts, facts_length) != 0) {
    free(completion->bytes);
    fail();
  }
  struct stat current;
  if (fstatat(completion->evaluator_directory, SUPERVISOR_MARKER, &current, AT_SYMLINK_NOFOLLOW) != 0 ||
      !same_stat(&completion->marker_stat, &current)) {
    free(completion->bytes);
    fail();
  }
  require_absent(completion->evaluator_directory, SUPERVISOR_CONSUMED_MARKER);
  if (syscall(SYS_renameat2, completion->evaluator_directory, SUPERVISOR_MARKER,
      completion->evaluator_directory, SUPERVISOR_CONSUMED_MARKER, RENAME_NOREPLACE) != 0) {
    free(completion->bytes);
    fail();
  }
  free(completion->bytes);
  if (close(completion->marker_file) != 0 || close(completion->evaluator_directory) != 0) fail();
}

static unsigned char *read_reporter_facts(size_t *length) {
  int root = open_root();
  require_root_directory(root, 0);
  int work = open_directory(root, SOURCE_DIR_A);
  require_reporter_directory(work);
  int reports = open_directory(work, SOURCE_DIR_B);
  require_reporter_directory(reports);
  int report = open_file_path(reports, SOURCE_FILE);
  struct stat report_stat;
  if (fstat(report, &report_stat) != 0 || !S_ISREG(report_stat.st_mode) || report_stat.st_uid != REPORTER_UID ||
      report_stat.st_gid != REPORTER_GID || report_stat.st_nlink != 1 || report_stat.st_size < 1 ||
      (uintmax_t)report_stat.st_size > MAX_FACTS_BYTES || (report_stat.st_mode & 0022) != 0 ||
      (report_stat.st_mode & 07000) != 0) fail();
  unsigned char *bytes = read_stable_regular_file(report, &report_stat, MAX_FACTS_BYTES, length);
  if (close(report) != 0 || close(reports) != 0 || close(work) != 0 || close(root) != 0) {
    free(bytes);
    fail();
  }
  return bytes;
}

static int ensure_root_directory(int parent, const char *name, mode_t create_mode, mode_t exact_mode) {
  if (mkdirat(parent, name, create_mode) != 0 && errno != EEXIST) fail();
  int fd = open_directory(parent, name);
  require_root_directory(fd, exact_mode);
  return fd;
}

static int open_output_directory(void) {
  int root = open_root();
  require_root_directory(root, 0);
  int var = open_directory(root, OUTPUT_DIR_A);
  require_root_directory(var, 0);
  int lib = open_directory(var, OUTPUT_DIR_B);
  require_root_directory(lib, 0);
  int motive = ensure_root_directory(lib, OUTPUT_DIR_C, 0700, 0);
  int evaluator = ensure_root_directory(motive, OUTPUT_DIR_D, 0700, 0700);
  int reports = ensure_root_directory(evaluator, OUTPUT_DIR_E, 0700, 0700);
  if (close(evaluator) != 0 || close(motive) != 0 || close(lib) != 0 || close(var) != 0 || close(root) != 0) {
    close(reports);
    fail();
  }
  return reports;
}

static void require_absent(int directory, const char *name) {
  struct stat st;
  if (fstatat(directory, name, &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) fail();
}

static void write_immutable_report(const unsigned char *bytes, size_t length) {
  int reports = open_output_directory();
  require_absent(reports, OUTPUT_FILE);
  require_absent(reports, OUTPUT_TEMPORARY_FILE);
  int temporary = openat(reports, OUTPUT_TEMPORARY_FILE, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (temporary < 0) {
    close(reports);
    fail();
  }
  struct stat temporary_stat;
  if (fstat(temporary, &temporary_stat) != 0 || !S_ISREG(temporary_stat.st_mode) || temporary_stat.st_uid != 0 ||
      temporary_stat.st_gid != 0 || temporary_stat.st_nlink != 1 || (temporary_stat.st_mode & 07777) != 0600) fail();
  write_all_or_die(temporary, (const char *)bytes, length);
  require_call(fsync(temporary));
  require_call(fchown(temporary, 0, 0));
  require_call(fchmod(temporary, 0400));
  require_call(fsync(temporary));
  require_call(close(temporary));
  if (syscall(SYS_renameat2, reports, OUTPUT_TEMPORARY_FILE, reports, OUTPUT_FILE, RENAME_NOREPLACE) != 0) {
    close(reports);
    fail();
  }
  int sync_directory = duplicate_for_directory(reports);
  require_call(fsync(sync_directory));
  require_call(close(sync_directory));
  int final = open_file_path(reports, OUTPUT_FILE);
  struct stat final_stat;
  if (fstat(final, &final_stat) != 0 || !S_ISREG(final_stat.st_mode) || final_stat.st_uid != 0 || final_stat.st_gid != 0 ||
      final_stat.st_nlink != 1 || (final_stat.st_mode & 07777) != 0400 || final_stat.st_size != (off_t)length ||
      close(final) != 0 || close(reports) != 0) fail();
}

static void require_root_identity(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) != 0 || getresgid(&real_gid, &effective_gid, &saved_gid) != 0 ||
      real_uid != 0 || effective_uid != 0 || saved_uid != 0 || real_gid != 0 || effective_gid != 0 || saved_gid != 0) fail();
  int count = getgroups(0, NULL);
  if (count < 0 || count > 16) fail();
  gid_t groups[16];
  if (count > 0 && getgroups(count, groups) != count) fail();
  for (int index = 0; index < count; ++index) if (groups[index] != 0) fail();
}

static void set_process_bounds(void) {
  struct rlimit memory = {16U * 1024U * 1024U, 16U * 1024U * 1024U};
  struct rlimit cpu = {5, 5};
  struct rlimit files = {32, 32};
  struct rlimit fsize = {MAX_FACTS_BYTES, MAX_FACTS_BYTES};
  struct rlimit core = {0, 0};
  require_call(prctl(PR_SET_DUMPABLE, 0));
  require_call(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));
  require_call(setrlimit(RLIMIT_AS, &memory));
  require_call(setrlimit(RLIMIT_CPU, &cpu));
  require_call(setrlimit(RLIMIT_NOFILE, &files));
  require_call(setrlimit(RLIMIT_FSIZE, &fsize));
  require_call(setrlimit(RLIMIT_CORE, &core));
  if (syscall(SYS_close_range, 3U, ~0U, 0U) != 0) fail();
  umask(0077);
  alarm(5);
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) fail();
  require_root_identity();
  set_process_bounds();
  struct completion_marker completion = read_supervisor_completion();
  size_t length = 0;
  unsigned char *facts = read_reporter_facts(&length);
  consume_supervisor_completion(&completion, facts, length);
  write_immutable_report(facts, length);
  free(facts);
  write_all_or_die(STDOUT_FILENO, success_marker, sizeof(success_marker) - 1U);
  return 0;
}
