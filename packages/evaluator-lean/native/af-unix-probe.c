#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static int usage(void) {
  fputs("usage: af-unix-probe --require-allowed|--require-denied\n", stderr);
  return 64;
}

int main(int argc, char **argv) {
  if (argc != 2) {
    return usage();
  }

  const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (strcmp(argv[1], "--require-allowed") == 0) {
    if (fd < 0) {
      fprintf(stderr, "AF_UNIX positive control failed at socket(): errno=%d\n", errno);
      return 1;
    }
    close(fd);
    puts("AF_UNIX positive control: allowed");
    return 0;
  }

  if (strcmp(argv[1], "--require-denied") != 0) {
    if (fd >= 0) {
      close(fd);
    }
    return usage();
  }

  if (fd >= 0) {
    close(fd);
    fputs("AF_UNIX restriction probe failed: socket() was allowed\n", stderr);
    return 2;
  }
  if (errno != EAFNOSUPPORT && errno != EPERM && errno != EACCES) {
    fprintf(stderr, "AF_UNIX restriction probe failed with unexpected errno=%d\n", errno);
    return 3;
  }
  printf("AF_UNIX restriction probe: socket() denied errno=%d\n", errno);
  return 0;
}
