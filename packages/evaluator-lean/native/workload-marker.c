#define _GNU_SOURCE

#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  int fd = open(argv[1], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0) return 65;
  if (write(fd, "started\n", 8) != 8) return 66;
  return close(fd) == 0 ? 0 : 67;
}
