#define _GNU_SOURCE
#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>

int main(void) {
  uid_t real_uid, effective_uid, saved_uid;
  gid_t real_gid, effective_gid, saved_gid;
  if (getresuid(&real_uid, &effective_uid, &saved_uid) || getresgid(&real_gid, &effective_gid, &saved_gid)) return 2;
  printf("uid=%u,euid=%u,suid=%u,gid=%u,egid=%u,sgid=%u\n",
    (unsigned)real_uid, (unsigned)effective_uid, (unsigned)saved_uid,
    (unsigned)real_gid, (unsigned)effective_gid, (unsigned)saved_gid);
  return 0;
}
