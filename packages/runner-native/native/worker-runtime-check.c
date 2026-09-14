#define _GNU_SOURCE
#include <linux/capability.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

static void fail(const char *message) {
  fprintf(stderr, "worker-runtime-check: %s\n", message);
  exit(1);
}

int main(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) || getresgid(&real_gid, &effective_gid, &saved_gid)) fail("identity query failed");
  if (real_uid != 2000 || effective_uid != 2000 || saved_uid != 2000 ||
      real_gid != 2000 || effective_gid != 2000 || saved_gid != 2000 || getgroups(0, NULL) != 0) fail("identity is not sealed");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}};
  if (syscall(SYS_capget, &header, data)) fail("capability query failed");
  for (size_t i = 0; i < 2; i++) {
    if (data[i].effective || data[i].permitted || data[i].inheritable) fail("capability set is not empty");
  }
  if (prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) {
    fail("process protections are not active");
  }
  puts("MOTIVE_RUNTIME_CHECK_OK");
  return 0;
}
