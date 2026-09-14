#!/bin/sh
set -eu

prepared=${1:-/work/prepared}
results=${2:-/work/results}
if [ "$prepared" != /work/prepared ] || [ "$results" != /work/results ]; then
  echo 'fixture runner paths must be exactly /work/prepared and /work/results' >&2
  exit 2
fi
test "$(id -u)" -ne 0
test -f "$prepared/cases.json"
test ! -e "$results"

kernel_major=$(uname -r | cut -d. -f1)
kernel_minor=$(uname -r | cut -d. -f2 | sed 's/[^0-9].*$//')
if [ "$kernel_major" -lt 6 ] || { [ "$kernel_major" -eq 6 ] && [ "$kernel_minor" -lt 7 ]; }; then
  echo 'kernel 6.7 or newer is required; refusing Landrun best-effort degradation' >&2
  exit 20
fi

# This command succeeds only when the user manager creates a transient unit and
# the process inside it observes AF_UNIX as denied.
/opt/evaluator/bin/af-unix-probe --require-allowed
systemd-run --user --quiet --wait --pipe --collect \
  --property=RestrictAddressFamilies=~AF_UNIX \
  --property=NoNewPrivileges=yes \
  --property=RuntimeMaxSec=10s \
  --property=MemoryMax=256M \
  --property=TasksMax=32 \
  --property=KillMode=control-group \
  /opt/evaluator/bin/af-unix-probe --require-denied

# Prove that the exact Landrun binary enforces an allowed/denied write boundary.
probe=$(mktemp -d /work/landrun-probe.XXXXXX)
mkdir "$probe/allowed" "$probe/denied"
if ! landrun --best-effort --ro / --rw "$probe/allowed" -ldd -add-exec -- \
    /bin/sh -c "printf ok > '$probe/allowed/ok'; if printf bad > '$probe/denied/bad' 2>/dev/null; then exit 9; fi"; then
  echo 'Landrun restriction probe failed' >&2
  exit 21
fi
test -f "$probe/allowed/ok"
test ! -e "$probe/denied/bad"

mkdir -m 0700 "$results"
for case_id in valid-proof wrong-target-statement incomplete-proof unapproved-custom-axiom transitive-incomplete-dependency forged-acceptance-output; do
  workspace="$prepared/$case_id"
  log="$results/$case_id.log"
  status="$results/$case_id.status"
  set +e
  (
    cd "$workspace"
    COMPARATOR_LANDRUN=/opt/evaluator/bin/landrun \
    COMPARATOR_LEAN4EXPORT=/opt/evaluator/bin/lean4export \
    systemd-run --user --quiet --wait --pipe --collect \
      --property=RestrictAddressFamilies=~AF_UNIX \
      --property=NoNewPrivileges=yes \
      --property=RuntimeMaxSec=120s \
      --property=MemoryMax=1G \
      --property=TasksMax=128 \
      --property=KillMode=control-group \
      --property=TimeoutStopSec=5s \
      --setenv=PATH="$PATH" \
      --setenv=HOME="$HOME" \
      --setenv=LEAN_ABORT_ON_PANIC=1 \
      --setenv=COMPARATOR_LANDRUN=/opt/evaluator/bin/landrun \
      --setenv=COMPARATOR_LEAN4EXPORT=/opt/evaluator/bin/lean4export \
      --working-directory="$workspace" \
      lake env /opt/evaluator/bin/comparator comparator.json
  ) >"$log" 2>&1
  exit_code=$?
  set -e
  printf '%s\n' "$exit_code" > "$status"
done

cp "$prepared/altered-challenge.status" "$results/altered-challenge.status"
cp "$prepared/modified-build-or-checker.status" "$results/modified-build-or-checker.status"
printf '%s\n' "$results"
