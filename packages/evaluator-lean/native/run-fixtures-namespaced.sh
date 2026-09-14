#!/bin/sh
set -eu

prepared=${1:-/work/prepared}
results=${2:-/work/results}
wrapper=/opt/evaluator/bin/landrun-namespace-wrapper
if [ "$prepared" != /work/prepared ] || [ "$results" != /work/results ]; then
  echo 'fixture runner paths must be exactly /work/prepared and /work/results' >&2
  exit 2
fi
test "$(id -u)" -eq 1000
test -f "$prepared/cases.json"
test ! -e "$results"

kernel_major=$(uname -r | cut -d. -f1)
kernel_minor=$(uname -r | cut -d. -f2 | sed 's/[^0-9].*$//')
if [ "$kernel_major" -lt 6 ] || { [ "$kernel_major" -eq 6 ] && [ "$kernel_minor" -lt 7 ]; }; then
  echo 'kernel 6.7 or newer is required; refusing Landrun best-effort degradation' >&2
  exit 20
fi

/opt/evaluator/bin/af-unix-probe --require-allowed
systemd-run --user --quiet --wait --pipe --collect \
  --property=RestrictAddressFamilies=~AF_UNIX \
  --property=NoNewPrivileges=yes \
  --property=RuntimeMaxSec=10s \
  --property=MemoryMax=256M \
  --property=TasksMax=32 \
  --property=KillMode=control-group \
  /opt/evaluator/bin/af-unix-probe --require-denied

# Preflight the exact fixed supervisor inside the same AF_UNIX restriction.
systemd-run --user --quiet --wait --pipe --collect \
  --property=RestrictAddressFamilies=~AF_UNIX \
  --property=NoNewPrivileges=yes \
  --property=RuntimeMaxSec=10s \
  --property=MemoryMax=256M \
  --property=TasksMax=32 \
  --property=KillMode=control-group \
  "$wrapper" --preflight

# A separately compiled test-only variant has a nonexistent fixed unshare path.
# Its setup failure must occur before the marker workload can start.
failure_marker=/work/namespace-failure-workload-started
set +e
/opt/evaluator/bin/landrun-namespace-wrapper-failure \
  --best-effort --ro / --rw /work -ldd -add-exec -- \
  /opt/evaluator/bin/workload-marker "$failure_marker"
failure_code=$?
set -e
test "$failure_code" -ne 0
test ! -e "$failure_marker"
printf 'namespace failure control: workload not started (exit %s)\n' "$failure_code"

# Prove filesystem enforcement through the wrapper and the exact pinned Landrun.
probe=$(mktemp -d /work/landrun-probe.XXXXXX)
mkdir "$probe/allowed" "$probe/denied"
if ! "$wrapper" --best-effort --ro / --rw "$probe/allowed" -ldd -add-exec -- \
    /bin/sh -c "printf ok > '$probe/allowed/ok'; if printf bad > '$probe/denied/bad' 2>/dev/null; then exit 9; fi"; then
  echo 'wrapped Landrun restriction probe failed' >&2
  exit 21
fi
test -f "$probe/allowed/ok"
test ! -e "$probe/denied/bad"

# First prove the adversarial workload really can outlive its immediate parent
# under the same real Landrun when no namespace supervisor is present. The child
# closes all inherited standard streams, so held pipes cannot delay Landrun.
positive_dir=/work/descendant-positive-control
mkdir -m 0700 "$positive_dir"
/opt/evaluator/bin/landrun --best-effort --ro / --rw "$positive_dir" -ldd -add-exec -- \
  /opt/evaluator/bin/descendant-probe "$positive_dir"
test -f "$positive_dir/started"
# The unsupervised descendant still holds this lock after Landrun returned.
if flock -n "$positive_dir/alive.lock" true; then
  echo 'unsupervised detached descendant was not observed alive' >&2
  exit 22
fi
printf 'release\n' > "$positive_dir/release"
for ignored in $(seq 1 100); do
  if [ -f "$positive_dir/survived" ]; then break; fi
  sleep 0.01
done
test -f "$positive_dir/survived"
printf 'detached descendant positive control: survived unsupervised Landrun\n'

# Repeat through the wrapper. Namespace PID 1 must tear down the detached
# descendant before the wrapper returns.
descendant_dir=/work/descendant-probe
mkdir -m 0700 "$descendant_dir"
"$wrapper" --best-effort --ro / --rw "$descendant_dir" -ldd -add-exec -- \
  /opt/evaluator/bin/descendant-probe "$descendant_dir"
test -f "$descendant_dir/started"
# The descendant cannot voluntarily exit before release. Acquiring its lock
# immediately after wrapper return directly observes that its process-held file
# description has gone away before the next stage.
flock -n "$descendant_dir/alive.lock" true
printf 'release\n' > "$descendant_dir/release"
sleep 1
test ! -e "$descendant_dir/survived"
printf 'detached descendant control: process lock released at wrapper return; no post-return write\n'

mkdir -m 0700 "$results"
for case_id in valid-proof wrong-target-statement incomplete-proof unapproved-custom-axiom transitive-incomplete-dependency forged-acceptance-output; do
  workspace="$prepared/$case_id"
  log="$results/$case_id.log"
  status="$results/$case_id.status"
  set +e
  (
    cd "$workspace"
    COMPARATOR_LANDRUN="$wrapper" \
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
      --setenv=COMPARATOR_LANDRUN="$wrapper" \
      --setenv=COMPARATOR_LEAN4EXPORT=/opt/evaluator/bin/lean4export \
      --working-directory="$workspace" \
      lake env /opt/evaluator/bin/comparator comparator.json
  ) >"$log" 2>&1
  exit_code=$?
  set -e
  printf '%s\n' "$exit_code" > "$status"
  printf 'fixture_finished=%s exit=%s\n' "$case_id" "$exit_code"
done

# Reject unrelated startup/build failures masquerading as expected negatives.
grep -Fq 'Building Challenge' "$results/valid-proof.log"
grep -Fq 'Building Solution' "$results/valid-proof.log"
grep -Fq 'Lean default kernel accepts the solution' "$results/valid-proof.log"
grep -Fq 'Your solution is okay!' "$results/valid-proof.log"
grep -Fq "Challenge and solution theorem statement do not match: 'target'" \
  "$results/wrong-target-statement.log"
grep -Fq "Illegal axiom detected: 'sorryAx'" "$results/incomplete-proof.log"
grep -Fq "Illegal axiom detected: 'unapproved'" "$results/unapproved-custom-axiom.log"
grep -Fq "Illegal axiom detected: 'sorryAx'" \
  "$results/transitive-incomplete-dependency.log"
grep -Fq '{"outcome":"VERIFIED","human_acceptance":"ACCEPTED"}' \
  "$results/forged-acceptance-output.log"
grep -Fq "Illegal axiom detected: 'sorryAx'" "$results/forged-acceptance-output.log"

cp "$prepared/altered-challenge.status" "$results/altered-challenge.status"
cp "$prepared/modified-build-or-checker.status" "$results/modified-build-or-checker.status"
printf '%s\n' "$results"
