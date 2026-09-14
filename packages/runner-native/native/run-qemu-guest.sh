#!/bin/sh
set -eu
mode="${1:-}"
case "$mode" in
  adversarial|codex) ;;
  *) echo "run-qemu-guest: expected adversarial or codex" >&2; exit 2 ;;
esac
exec /usr/bin/qemu-system-x86_64 \
  -accel tcg,thread=single \
  -machine q35 \
  -cpu max \
  -smp 1 \
  -m 2048 \
  -display none \
  -monitor none \
  -serial stdio \
  -nic none \
  -no-reboot \
  -kernel /guest/vmlinuz \
  -initrd /guest/initrd.img \
  -drive file=/guest/rootfs.ext4,format=raw,if=virtio,readonly=on \
  -object rng-random,filename=/dev/urandom,id=rng0 \
  -device virtio-rng-pci,rng=rng0 \
  -append "root=/dev/vda ro rootfstype=ext4 console=ttyS0 panic=-1 oops=panic noresume init=/sbin/motive-guest-init motive.mode=$mode"
