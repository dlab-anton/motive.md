#!/bin/busybox sh
set -eu

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

/bin/busybox mount -t proc proc /proc 2>/dev/null || true
/bin/busybox mount -t sysfs sysfs /sys 2>/dev/null || true
/bin/busybox mount -t devtmpfs devtmpfs /dev 2>/dev/null || true
/bin/busybox mkdir -p /dev/pts
/bin/busybox mount -t devpts devpts /dev/pts 2>/dev/null || true
/bin/busybox mkdir -p /dev/shm
/bin/busybox mount -t tmpfs -o mode=1777,nosuid,nodev,noexec,size=64m tmpfs /dev/shm
/bin/busybox mount -t tmpfs -o mode=1777,nosuid,nodev,noexec,size=128m tmpfs /tmp

# These are the same protected worker mounts used by the standalone native proof.
/bin/busybox mkdir -p /run/motive/channels /var/lib/motive/control /var/lib/motive/worker/tmp /vercel/sandbox/workspace
printf 'trusted-controller-channel\n' > /run/motive/channels/controller
/bin/busybox chown -R 0:0 /run/motive
/bin/busybox chmod 0555 /run/motive/channels
/bin/busybox chmod 0444 /run/motive/channels/controller
/bin/busybox mount -t tmpfs -o mode=0700,uid=2000,gid=2000,nosuid,nodev,noexec,size=96m tmpfs /var/lib/motive/worker
/bin/busybox mkdir -p /var/lib/motive/worker/tmp
/bin/busybox chown 2000:2000 /var/lib/motive/worker/tmp
/bin/busybox chmod 0700 /var/lib/motive/worker/tmp
/bin/busybox mount -t tmpfs -o mode=0700,uid=2000,gid=2000,nosuid,nodev,noexec,size=32m tmpfs /var/lib/motive/worker/tmp
/bin/busybox mount -t tmpfs -o mode=0755,uid=0,gid=0,nosuid,nodev,noexec,size=1m tmpfs /var/lib/motive/control
/bin/busybox mount -t tmpfs -o mode=0755,uid=2000,gid=2000,nosuid,nodev,size=64m tmpfs /vercel/sandbox/workspace
/bin/busybox mount -t tmpfs -o mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec,size=16m tmpfs /var/lib/motive/controller

# The controller owns the one-way capability exchange. UID 2000 cannot traverse it.
/bin/busybox mkdir -p /exchange
/bin/busybox mount -t tmpfs -o mode=0700,uid=1000,gid=1000,nosuid,nodev,noexec,size=1m tmpfs /exchange

# PostgreSQL data and its only listening endpoint stay outside every worker-writable tree.
/bin/busybox mkdir -p /var/lib/motive/postgres /run/motive/postgres
/bin/busybox mount -t tmpfs -o mode=0700,nosuid,nodev,noexec,size=384m tmpfs /var/lib/motive/postgres
/bin/busybox mount -t tmpfs -o mode=0770,nosuid,nodev,noexec,size=1m tmpfs /run/motive/postgres
/bin/busybox chown postgres:postgres /var/lib/motive/postgres /run/motive/postgres
/bin/busybox ifconfig lo 127.0.0.1 up

gateway_pid=""
postgres_started=0
gateway_stopped=0
postgres_stopped=0
postgres_tcp_listening=true
postgres_tcp_probe_succeeded=false
exchange_sealed_to_root=false

stop_services() {
  if [ -n "$gateway_pid" ] && /bin/busybox kill -0 "$gateway_pid" 2>/dev/null; then
    /bin/busybox kill -TERM "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  gateway_stopped=1
  if [ "$postgres_started" -eq 1 ]; then
    /sbin/runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl \
      -D /var/lib/motive/postgres -m fast -w -t 15 stop >/tmp/postgres-stop.log 2>&1 || return 1
    postgres_stopped=1
  fi
  return 0
}

code=1
diagnostic=""

if ! /sbin/runuser -u postgres -- /usr/lib/postgresql/17/bin/initdb \
    -D /var/lib/motive/postgres --no-locale --encoding=UTF8 \
    --auth-local=peer --auth-host=scram-sha-256 >/tmp/initdb.log 2>&1; then
  diagnostic="initdb-failed"
else
  cat >> /var/lib/motive/postgres/postgresql.conf <<'EOF'
listen_addresses = ''
unix_socket_directories = '/run/motive/postgres'
unix_socket_permissions = 0770
max_connections = 24
shared_buffers = 32MB
fsync = on
synchronous_commit = on
EOF
  if ! /sbin/runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl \
      -D /var/lib/motive/postgres -l /tmp/postgres.log -w -t 15 start >/tmp/postgres-start.log 2>&1; then
    diagnostic="postgres-start-failed"
  else
    postgres_started=1
    if [ -r /proc/net/tcp ] && [ -r /proc/net/tcp6 ]; then
      set +e
      /bin/busybox grep -qi ':1538 ' /proc/net/tcp /proc/net/tcp6 2>/dev/null
      tcp_probe_status=$?
      set -e
      case "$tcp_probe_status" in
        0) postgres_tcp_listening=true; postgres_tcp_probe_succeeded=true ;;
        1) postgres_tcp_listening=false; postgres_tcp_probe_succeeded=true ;;
        *) diagnostic="postgres-tcp-probe-failed" ;;
      esac
    else
      diagnostic="postgres-tcp-proc-unreadable"
    fi
    if ! /sbin/runuser -u postgres -- /usr/bin/psql -h /run/motive/postgres -d postgres -v ON_ERROR_STOP=1 \
      -c 'CREATE ROLE motive_controller LOGIN;' \
      -c 'CREATE DATABASE motive OWNER motive_controller;' >/tmp/postgres-bootstrap.log 2>&1; then
      diagnostic="postgres-bootstrap-failed"
    elif ! /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs \
      --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
      /usr/bin/env HOME=/var/lib/motive/controller NODE_ENV=test MOTIVE_JOINED_PG_SOCKET=/run/motive/postgres \
      /bin/sh -c 'cd /opt/motive/gateway && exec /usr/bin/node --import tsx packages/runner-native/native/joined-qemu-migrate.ts' \
      >/tmp/migrate.log 2>&1; then
      diagnostic="migration-failed"
    else
      /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --no-new-privs \
        --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
        /usr/bin/env HOME=/var/lib/motive/controller NODE_ENV=test MOTIVE_JOINED_PG_SOCKET=/run/motive/postgres \
        /bin/sh -c 'cd /opt/motive/gateway && exec /usr/bin/node --import tsx packages/runner-native/native/joined-qemu-gateway-entry.ts' \
        >/tmp/gateway.log 2>&1 &
      gateway_pid=$!
      ready=0
      count=0
      while [ "$count" -lt 20 ]; do
        if [ -f /exchange/ready ]; then ready=1; break; fi
        if ! /bin/busybox kill -0 "$gateway_pid" 2>/dev/null; then break; fi
        /bin/busybox sleep 1
        count=$((count + 1))
      done
      if [ "$ready" -ne 1 ]; then
        diagnostic="gateway-not-ready"
      else
        # Complete the one-way controller handoff before reducing PID 1 to the
        # launcher's three required capabilities. The gateway can no longer
        # mutate or read the exchange after this ownership transition.
        if /bin/busybox chown -R 0:0 /exchange \
            && /bin/busybox chmod 0700 /exchange \
            && /bin/busybox chmod 0400 /exchange/capability \
            && /bin/busybox chmod 0444 /exchange/ready; then
          exchange_sealed_to_root=true
        else
          diagnostic="exchange-seal-failed"
        fi
        if [ "$exchange_sealed_to_root" = true ] \
            && /opt/motive/bin/capability-envelope /usr/bin/python3 /opt/motive/test/test_launcher.py codex-joined; then
          code=0
        elif [ "$exchange_sealed_to_root" = true ]; then
          diagnostic="protected-codex-failed"
        fi
      fi
    fi
  fi
fi

if ! stop_services; then
  diagnostic="${diagnostic:+$diagnostic,}postgres-stop-failed"
  code=1
fi

cat /tmp/migrate.log 2>/dev/null || true
cat /tmp/gateway.log 2>/dev/null || true
if [ "$code" -ne 0 ]; then
  cat /tmp/initdb.log /tmp/postgres-start.log /tmp/postgres-bootstrap.log /tmp/postgres-stop.log 2>/dev/null || true
fi
if [ "$gateway_stopped" -ne 1 ] || [ "$postgres_stopped" -ne 1 ] \
    || [ "$postgres_tcp_probe_succeeded" != true ] || [ "$postgres_tcp_listening" != false ] \
    || [ "$exchange_sealed_to_root" != true ]; then code=1; fi
printf 'MOTIVE_JOINED_LIFECYCLE {"format":"motive.protected-worker-joined-lifecycle/0.1","gatewayStopped":%s,"postgresStopped":%s,"postgresTcpProbeSucceeded":%s,"postgresTcpListening":%s,"exchangeSealedToRoot":%s,"postgresSocket":"/run/motive/postgres","postgresDataMode":"0700","postgresSocketMode":"0770","diagnostic":"%s"}\n' \
  "$([ "$gateway_stopped" -eq 1 ] && echo true || echo false)" \
  "$([ "$postgres_stopped" -eq 1 ] && echo true || echo false)" \
  "$postgres_tcp_probe_succeeded" "$postgres_tcp_listening" "$exchange_sealed_to_root" "$diagnostic"
echo "MOTIVE_GUEST_EXIT=$code"
/bin/busybox sync
/bin/busybox poweroff -f
/bin/busybox sleep 10
exit "$code"
