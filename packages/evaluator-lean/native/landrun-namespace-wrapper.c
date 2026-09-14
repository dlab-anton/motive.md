#define _GNU_SOURCE

#include <errno.h>
#include <linux/capability.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef LANDRUN_PATH
#define LANDRUN_PATH "/opt/evaluator/bin/landrun"
#endif

#ifndef UNSHARE_PATH
#define UNSHARE_PATH "/usr/bin/unshare"
#endif

#define SELF_PATH "/opt/evaluator/bin/landrun-namespace-wrapper"
#define SETPRIV_PATH "/usr/bin/setpriv"

extern char **environ;

static int probe_child(void) {
  struct __user_cap_header_struct header = {
      .version = _LINUX_CAPABILITY_VERSION_3,
      .pid = 0,
  };
  struct __user_cap_data_struct data[2] = {{0}};

  if (getpid() != 1) {
    fprintf(stderr, "namespace probe PID is %ld, expected 1\n", (long)getpid());
    return 30;
  }
  if (getuid() != 1000 || geteuid() != 1000) {
    fprintf(stderr, "namespace probe uid/euid is %ld/%ld, expected 1000/1000\n",
            (long)getuid(), (long)geteuid());
    return 31;
  }
  if (syscall(SYS_capget, &header, &data) != 0) {
    perror("capget");
    return 32;
  }
  for (size_t i = 0; i < 2; i++) {
    if (data[i].effective != 0 || data[i].permitted != 0 ||
        data[i].inheritable != 0) {
      fputs("namespace probe retained capabilities\n", stderr);
      return 33;
    }
  }
  puts("motive-namespace-probe-ok");
  return 0;
}

static void exec_supervisor(const char *command, char *const command_args[]) {
  size_t command_count = 0;
  while (command_args[command_count] != NULL) {
    command_count++;
  }
  if (command_count > SIZE_MAX / sizeof(char *) - 14) {
    fputs("namespace wrapper argument count overflow\n", stderr);
    exit(64);
  }

  char **args = calloc(command_count + 14, sizeof(char *));
  if (args == NULL) {
    perror("calloc");
    exit(70);
  }
  size_t i = 0;
  args[i++] = (char *)SETPRIV_PATH;
  args[i++] = "--pdeathsig";
  args[i++] = "SIGKILL";
  args[i++] = (char *)UNSHARE_PATH;
  args[i++] = "--user";
  args[i++] = "--map-current-user";
  args[i++] = "--pid";
  args[i++] = "--fork";
  args[i++] = "--kill-child=SIGKILL";
  args[i++] = "--mount-proc";
  args[i++] = "--";
  args[i++] = (char *)command;
  for (size_t j = 0; j < command_count; j++) {
    args[i++] = command_args[j];
  }
  args[i] = NULL;

  execve(SETPRIV_PATH, args, environ);
  perror("execve fixed namespace supervisor");
  free(args);
  exit(errno == ENOENT ? 127 : 126);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe-child") == 0) {
    return probe_child();
  }
  if (argc == 2 && strcmp(argv[1], "--preflight") == 0) {
    char *const probe_args[] = {"--probe-child", NULL};
    exec_supervisor(SELF_PATH, probe_args);
  }
  if (argc < 2) {
    fputs("landrun namespace wrapper requires Landrun arguments\n", stderr);
    return 64;
  }
  exec_supervisor(LANDRUN_PATH, &argv[1]);
}
