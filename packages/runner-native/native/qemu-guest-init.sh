#!/bin/busybox sh

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
/bin/busybox mount -t proc proc /proc 2>/dev/null || true
/bin/busybox mount -t sysfs sysfs /sys 2>/dev/null || true
/bin/busybox mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
/bin/busybox mkdir -p /dev/pts
/bin/busybox mount -t devpts devpts /dev/pts 2>/dev/null || true
/bin/busybox mkdir -p /run/motive/channels
printf 'trusted-controller-channel\n' > /run/motive/channels/controller
/bin/busybox chown -R 0:0 /run/motive
/bin/busybox chmod 0555 /run/motive/channels
/bin/busybox chmod 0444 /run/motive/channels/controller
/bin/busybox mount -t tmpfs -o mode=1777,nosuid,nodev,noexec,size=64m tmpfs /tmp
/bin/busybox mount -t tmpfs -o mode=0700,uid=2000,gid=2000,nosuid,nodev,noexec,size=64m tmpfs /var/lib/motive/worker
/bin/busybox mkdir -p /var/lib/motive/worker/tmp
/bin/busybox chown 2000:2000 /var/lib/motive/worker/tmp
/bin/busybox chmod 0700 /var/lib/motive/worker/tmp
/bin/busybox mount -t tmpfs -o mode=0700,uid=2000,gid=2000,nosuid,nodev,noexec,size=32m tmpfs /var/lib/motive/worker/tmp
/bin/busybox mount -t tmpfs -o mode=0755,uid=0,gid=0,nosuid,nodev,noexec,size=1m tmpfs /var/lib/motive/control
/bin/busybox mount -t tmpfs -o mode=0755,uid=2000,gid=2000,nosuid,nodev,size=64m tmpfs /vercel/sandbox/workspace
/bin/busybox ifconfig lo 127.0.0.1 up

mode=""
for argument in $(cat /proc/cmdline); do
  case "$argument" in
    motive.mode=adversarial) mode=adversarial ;;
    motive.mode=codex) mode=codex ;;
  esac
done

if [ -z "$mode" ]; then
  echo "MOTIVE_GUEST_ERROR=invalid-mode"
  code=123
else
  /opt/motive/bin/capability-envelope /usr/bin/python3 /opt/motive/test/test_launcher.py "$mode"
  code=$?
fi
echo "MOTIVE_GUEST_EXIT=$code"
/bin/busybox sync
/bin/busybox poweroff -f
/bin/busybox sleep 10
exit "$code"
