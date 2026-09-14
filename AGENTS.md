# Motive development

- Astra owns architecture, integration review and UI/UX. Delegate bounded
  implementation tasks to Sol with high reasoning per the user's latest preference.
  Give each task explicit file ownership and acceptance checks.
- Keep Docker storage below 100 GB. Before any image build, inspect
  `docker system df` and host free space. Do not build when C: has less than
  30 GB free or the expected build would exceed that storage budget.
- Reuse fixed local test tags. Do not accumulate a new large image for every
  review round. The circle-packing project does not require Lean/QEMU images;
  use its ordinary TypeScript/data-validator tests.
- After Docker work, remove obsolete Motive images with
  `npm run docker:cleanup-motive -- --apply`. Review the dry-run first.
  Retain only artifacts needed by an active task. Never prune database volumes,
  unrelated project images, or images used by any container.
- Build cache cleanup is explicit and bounded:
  `npm run docker:cleanup-motive -- --apply --build-cache --keep-storage=20GB`.
  Docker image deletion may also require Windows virtual-disk compaction to
  return space to C:. Measure host usage rather than assuming it shrank.
- Database tests must create their own UUID database. Never run mutating tests
  against `motive_app_local` or the shared `motive_test` database.
