#define _GNU_SOURCE
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(const char *message) {
  perror(message);
  _exit(124);
}

int main(int argc, char **argv) {
  if (argc < 2 || getuid() != 0 || geteuid() != 0) {
    fprintf(stderr, "capability-envelope: requires root and a command\n");
    return 124;
  }
  int last_cap = 63;
  FILE *source = fopen("/proc/sys/kernel/cap_last_cap", "r");
  if (source == NULL || fscanf(source, "%d", &last_cap) != 1 || fclose(source) != 0 || last_cap < 8 || last_cap > 1024) {
    fail("capability-envelope: cannot read capability bound");
  }
  for (int capability = 0; capability <= last_cap; capability++) {
    if (capability == CAP_SETGID || capability == CAP_SETUID || capability == CAP_SETPCAP) continue;
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0) fail("capability-envelope: bounding drop failed");
  }
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}};
  const unsigned long long retained = (1ULL << CAP_SETGID) | (1ULL << CAP_SETUID) | (1ULL << CAP_SETPCAP);
  data[0].effective = data[0].permitted = (unsigned int)retained;
  data[1].effective = data[1].permitted = (unsigned int)(retained >> 32);
  if (syscall(SYS_capset, &header, data) != 0) fail("capability-envelope: capset failed");
#ifdef PR_CAP_AMBIENT
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0) fail("capability-envelope: ambient clear failed");
#endif
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("capability-envelope: no_new_privs failed");
  execv(argv[1], &argv[1]);
  fail("capability-envelope: exec failed");
}
