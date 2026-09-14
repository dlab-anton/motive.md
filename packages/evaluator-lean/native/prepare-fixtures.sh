#!/bin/sh
set -eu

destination=${1:-/work/prepared}
if [ "$destination" != /work/prepared ]; then
  echo 'fixture preparation destination must be exactly /work/prepared' >&2
  exit 2
fi
test ! -e "$destination"
mkdir -m 0700 "$destination"

source_root=/opt/evaluator/fixtures/sources
(cd /opt/evaluator/fixtures && sha256sum --check --strict fixture-manifest.sha256 >/dev/null)

for case_id in valid-proof wrong-target-statement incomplete-proof unapproved-custom-axiom transitive-incomplete-dependency forged-acceptance-output; do
  workspace="$destination/$case_id"
  mkdir -m 0700 "$workspace"
  cp "$source_root/Challenge.lean" "$workspace/Challenge.lean"
  cp "$source_root/lakefile.toml" "$workspace/lakefile.toml"
  cp "$source_root/comparator.json" "$workspace/comparator.json"
  cp "$source_root/$case_id/Solution.lean" "$workspace/Solution.lean"
  if [ "$case_id" = transitive-incomplete-dependency ]; then
    cp "$source_root/$case_id/CandidateDep.lean" "$workspace/CandidateDep.lean"
  fi
  chmod 0444 "$workspace"/*.lean "$workspace/lakefile.toml" "$workspace/comparator.json"
done

# Run the repository's real trusted evaluator-profile and artifact-relative-path
# policy against the two source-ingestion attacks. The candidate replacements
# are never copied into runnable workspaces.
node --disable-warning=ExperimentalWarning --experimental-transform-types \
  /opt/evaluator/policy/packages/evaluator-lean/native/validate-fixture-ingestion.ts

cat > "$destination/cases.json" <<'EOF'
{
  "format": "motive.evaluator-prepared-cases/0.1",
  "status": "PREPARED_NOT_RUN",
  "human_acceptance": "PENDING",
  "runnable_after_preflight": [
    "valid-proof",
    "wrong-target-statement",
    "incomplete-proof",
    "unapproved-custom-axiom",
    "transitive-incomplete-dependency",
    "forged-acceptance-output"
  ],
  "policy_rejected_before_execution": [
    "altered-challenge",
    "modified-build-or-checker"
  ]
}
EOF
chmod 0444 "$destination/cases.json"
printf '%s\n' "$destination"
