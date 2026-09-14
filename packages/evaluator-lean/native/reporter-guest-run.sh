#!/bin/sh
set -eu
# The executable search path is an exact part of the reporter's local profile.
export PATH=/opt/evaluator/bin:/opt/lean/bin:/usr/local/bin:/usr/bin:/bin
export HOME=/home/node
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
echo 'MOTIVE_REPORTER_GUEST_BEGIN'
test "$(cat /proc/1/comm)" = systemd
printf 'kernel=%s\n' "$(uname -srmo)"
for ignored in $(seq 1 60); do
  if [ -S /run/user/1000/bus ]; then break; fi
  sleep 1
done
test -S /run/user/1000/bus
systemctl is-active --quiet user@1000.service
as_node() {
  /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups \
    env PATH="$PATH" HOME="$HOME" XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" \
      DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS" "$@"
}
as_node /opt/evaluator/bin/verify-toolchain
sha256sum /opt/evaluator/bin/motive-comparator-reporter /opt/evaluator/identities/MotiveReporter.lean \
  /opt/evaluator/identities/reporter-source-identity.json
as_node /opt/evaluator/bin/prepare-fixtures /work/prepared
# Repeat the already reviewed isolation probes and stock fixture baseline in
# this exact guest before invoking the new reporter.
as_node /opt/evaluator/bin/run-fixtures /work/prepared /work/results
as_node /usr/local/bin/node /opt/evaluator/bin/reporter-fixtures.mjs
