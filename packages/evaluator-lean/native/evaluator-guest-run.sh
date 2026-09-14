#!/bin/sh
set -eu

export PATH=/opt/evaluator/bin:/opt/lean/bin:/usr/local/bin:/usr/bin:/bin
export HOME=/home/node
export XDG_RUNTIME_DIR=/run/user/1000
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus

echo 'MOTIVE_EVALUATOR_GUEST_BEGIN'
printf 'pid1=%s\n' "$(cat /proc/1/comm)"
printf 'kernel=%s\n' "$(uname -srmo)"

test "$(cat /proc/1/comm)" = systemd
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
if [ -x /opt/evaluator/bin/landrun-namespace-wrapper ]; then
  sha256sum \
    /opt/evaluator/bin/landrun-namespace-wrapper \
    /usr/bin/setpriv \
    /usr/bin/unshare \
    /opt/evaluator/bin/descendant-probe \
    /opt/evaluator/bin/workload-marker \
    /opt/evaluator/bin/run-fixtures \
    /opt/evaluator/identities/landrun-namespace-wrapper.c
fi
as_node /opt/evaluator/bin/prepare-fixtures /work/prepared
set +e
as_node /opt/evaluator/bin/run-fixtures /work/prepared /work/results
runner_code=$?
set -e
if [ "$runner_code" -ne 0 ]; then
  printf 'MOTIVE_EVALUATOR_FIXTURE_RUNNER_FAILED exit=%s\n' "$runner_code"
  for log in /work/results/*.log; do
    if [ -f "$log" ]; then
      printf '%s\n' "--- ${log##*/} (bounded diagnostic) ---"
      sed -n '1,120p' "$log"
    fi
  done
  exit "$runner_code"
fi

failures=0
for case_id in valid-proof wrong-target-statement incomplete-proof unapproved-custom-axiom transitive-incomplete-dependency forged-acceptance-output; do
  code=$(cat "/work/results/$case_id.status")
  log_digest=$(sha256sum "/work/results/$case_id.log" | cut -d' ' -f1)
  printf 'case=%s exit=%s log_sha256=%s\n' "$case_id" "$code" "$log_digest"
  if [ "$case_id" = valid-proof ]; then
    if [ "$code" -ne 0 ] || ! grep -Fq 'Your solution is okay!' "/work/results/$case_id.log"; then
      failures=$((failures + 1))
    fi
  elif [ "$code" -eq 0 ]; then
    failures=$((failures + 1))
  fi
done

grep -Fq 'REJECTED_PRE_EXECUTION PROFILE_INVALID:' /work/results/altered-challenge.status
grep -Fq 'REJECTED_PRE_EXECUTION PROFILE_INVALID:' /work/results/modified-build-or-checker.status
grep -Fq '"human_acceptance": "PENDING"' /work/prepared/cases.json
grep -Fq '"human_acceptance":"ACCEPTED"' /work/results/forged-acceptance-output.log

if [ "$failures" -ne 0 ]; then
  printf 'MOTIVE_EVALUATOR_GUEST_RESULT={"status":"FAILED","failures":%s,"human_acceptance":"PENDING"}\n' "$failures"
  exit 1
fi
echo 'MOTIVE_EVALUATOR_GUEST_RESULT={"status":"BEHAVIORAL_CASES_PASSED","cases":8,"human_acceptance":"PENDING","deployment_approved":false}'
