#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int write_file(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return -1;
  const char value[] = "observed\n";
  ssize_t written = write(fd, value, sizeof(value) - 1);
  int saved = errno;
  if (close(fd) != 0 && written == (ssize_t)(sizeof(value) - 1)) return -1;
  errno = saved;
  return written == (ssize_t)(sizeof(value) - 1) ? 0 : -1;
}

static void path_join(char *out, size_t size, const char *dir, const char *name) {
  int n = snprintf(out, size, "%s/%s", dir, name);
  if (n < 0 || (size_t)n >= size) {
    fputs("descendant probe path too long\n", stderr);
    exit(64);
  }
}

int main(int argc, char **argv) {
  if (argc != 2) {
    fputs("usage: descendant-probe DIRECTORY\n", stderr);
    return 64;
  }
  char started[4096], release[4096], survived[4096], alive_lock[4096];
  path_join(started, sizeof(started), argv[1], "started");
  path_join(release, sizeof(release), argv[1], "release");
  path_join(survived, sizeof(survived), argv[1], "survived");
  path_join(alive_lock, sizeof(alive_lock), argv[1], "alive.lock");

  pid_t child = fork();
  if (child < 0) {
    perror("fork");
    return 70;
  }
  if (child == 0) {
    if (setsid() < 0) _exit(71);
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
    int lock_fd = open(alive_lock,
                       O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW,
                       0600);
    if (lock_fd < 0 || flock(lock_fd, LOCK_EX) != 0) _exit(76);
    if (write_file(started) != 0) _exit(72);
    for (unsigned i = 0; i < 3000; i++) {
      if (access(release, F_OK) == 0) {
        _exit(write_file(survived) == 0 ? 0 : 73);
      }
      usleep(10000);
    }
    _exit(74);
  }

  for (unsigned i = 0; i < 500; i++) {
    if (access(started, F_OK) == 0) return 0;
    usleep(10000);
  }
  fputs("detached descendant did not start\n", stderr);
  return 75;
}
