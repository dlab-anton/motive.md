#!/bin/sh
set -eu

test "$(id -u)" -ne 0
test "$(cat /opt/evaluator/identities/comparator.commit)" = '2312244ac716564a61cc0bf4e107d9abf1757a61'
test "$(cat /opt/evaluator/identities/lean4export.commit)" = 'cacf989bd75f608700820f6afc595f32e7a99a4d'
test "$(cat /opt/evaluator/identities/landrun.commit)" = '5ed4a3db3a4ad930d577215c6b9abaa19df7f99f'
(cd /opt/evaluator/fixtures && sha256sum --check --strict fixture-manifest.sha256 >/dev/null)

printf 'runtime_uid=%s\n' "$(id -u)"
printf 'runtime_gid=%s\n' "$(id -g)"
printf 'kernel=%s\n' "$(uname -srmo)"
printf 'lean=%s\n' "$(lean --version | head -n 1)"
printf 'lake=%s\n' "$(lake --version | head -n 1)"
printf 'systemd_run=%s\n' "$(systemd-run --version | head -n 1)"
sha256sum \
  /opt/lean/bin/lean \
  /opt/lean/bin/lake \
  /opt/evaluator/bin/landrun \
  /opt/evaluator/bin/af-unix-probe \
  /opt/evaluator/bin/lean4export \
  /opt/evaluator/bin/comparator
sha256sum /opt/evaluator/identities/debian-packages.txt
sha256sum \
  /opt/evaluator/policy/packages/evaluator-lean/src/contract.ts \
  /opt/evaluator/policy/packages/artifact-storage/src/sealer.ts \
  /opt/evaluator/policy/packages/domain/src/contracts.ts \
  /opt/evaluator/policy/packages/evaluator-lean/native/validate-fixture-ingestion.ts
