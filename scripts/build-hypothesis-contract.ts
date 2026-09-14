import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { profile as runtimeProfile } from '../packages/evaluator-lean/src/runtime-profile.fixture.ts';
import { digestCanonicalJson } from '../packages/domain/src/contracts.ts';
import { validateVersionedComparatorReport } from '../packages/evaluator-lean/src/versioned.ts';

const root = resolve(import.meta.dirname, '..');
const destination = resolve(root, 'MOTIVE-HYPOTHESIS-CONTRACT-v0.1');
const hash = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}` as const;
const json = async (path: string, value: unknown) => {
  await mkdir(dirname(resolve(destination, path)), { recursive: true });
  await writeFile(resolve(destination, path), JSON.stringify(value, null, 2) + '\n');
};
let gitAvailable = false;
try { execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { stdio: 'pipe', windowsHide: true }); gitAvailable = true; } catch {}
if (gitAvailable) throw new Error('Source identity instructions need updating: Git metadata now exists.');
const selected = new Set<string>([
  'docs/CONTROL-API.md', 'docs/ORCHESTRATION-STORE.md', 'docs/EVALUATOR-CONTRACT.md',
  'docs/EVIDENCE-HTTP.md', 'docs/EVIDENCE-ACCEPTANCE.md',
  'server/control/auth.ts', 'server/control/evidence-routes.ts', 'server/control/index.ts',
  'packages/accounting/src/kernel.ts', 'packages/domain/src/contracts.ts',
  'packages/orchestration/src/store-types.ts', 'packages/orchestration/src/store.ts',
  'packages/evidence/src/types.ts', 'packages/evidence/src/store.ts',
  'packages/evaluator-lean/src/versioned.ts', 'packages/artifact-storage/src/types.ts',
  'migrations/001_ledger_kernel.sql', 'migrations/007_durable_orchestration_store.sql',
  'migrations/008_durable_evidence_and_acceptance.sql', 'migrations/013_runtime_bound_evaluator_evidence.sql',
]);
// Only recursively copy relative TS source dependencies. Never copy env files,
// logs, DB rows, node_modules, private runtime evidence, or repository metadata.
const pending = [...selected];
while (pending.length) {
  const path = pending.pop()!;
  if (!path.endsWith('.ts')) continue;
  const text = await readFile(resolve(root, path), 'utf8');
  for (const match of text.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
    const dependency = posix.normalize(posix.join(posix.dirname(path), match[2]));
    if (!dependency.endsWith('.ts') || dependency.startsWith('../')) throw new Error(`Unexpected source dependency: ${dependency}`);
    if (!selected.has(dependency)) { selected.add(dependency); pending.push(dependency); }
  }
}
const sourceFiles = [];
for (const path of [...selected].sort()) {
  const bytes = await readFile(resolve(root, path));
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('utf8'))) throw new Error(`Private key marker in ${path}`);
  const target = resolve(destination, 'source', path);
  await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes);
  sourceFiles.push({ path, bytes: bytes.length, digest: hash(bytes) });
}
await json('SOURCE-MANIFEST.json', {
  format: 'motive.hypothesis-source-snapshot/0.1', workspacePath: root,
  gitMetadataAvailable: false, motiveCommit: null, repositoryUrl: null,
  sourceSnapshotId: hash(JSON.stringify(sourceFiles)), digestMethod: 'sha256 of UTF-8 JSON.stringify(files), sorted by path; file digests cover exact bytes',
  hypothesisBaseline: { commit: '60eef8f', schema: 3, verification: 'USER_REPORTED_NOT_INSPECTED' },
  sanitization: 'Allow-listed source/docs and relative TS dependencies only; no env files, logs, DB data, credentials or live reports.',
  files: sourceFiles,
});
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const digest = (name: string) => digestCanonicalJson(`synthetic-hypothesis:${name}`);
for (const [index, name] of ['ordinary', 'negative', 'inconclusive'].entries()) {
  const { runtime: _runtime, ...stock } = runtimeProfile;
  const profile = name === 'negative' ? { ...stock, format: 'motive.lean-comparator-profile/0.1' as const } : runtimeProfile;
  const profileDigest = digestCanonicalJson(profile);
  const manifest = digest(`artifact:${name}`);
  const facts = Buffer.from(JSON.stringify({ format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
    protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
    transitive_axioms: true, kernel_replay: true, used_transitive_axioms: [] }));
  const bindings = { evaluator_profile_digest: profileDigest, challenge_digest: profile.challenge.challenge_digest,
    dependency_lock_digest: profile.challenge.dependency_lock_digest, trusted_build_config_digest: profile.challenge.trusted_build_config_digest,
    solution_artifact_manifest_digest: manifest };
  const report = name === 'negative' ? {
    format: 'motive.lean-comparator-report/0.1', ...bindings, toolchain: profile.toolchain, permitted_axioms: [], used_transitive_axioms: null,
    checks: { trusted_challenge: 'PASS', trusted_dependencies: 'PASS', candidate_source_only: 'PASS', protected_build: 'PASS', toolchain_and_export: 'PASS',
      exported_terms: 'PASS', statement_comparison: 'FAIL', transitive_axioms: 'UNRESOLVED', kernel_replay: 'UNRESOLVED' }, outcome: 'REJECTED',
  } : {
    format: 'motive.lean-comparator-report/0.2', ...bindings, runtime_digest: digestCanonicalJson(runtimeProfile.runtime),
    runtime_preflight: { af_unix_denied: true, landlock_enforced: true, namespace_identity: true, descendants_reaped: true, protected_report_capture: name !== 'inconclusive' },
    input_preflight: { trusted_challenge: true, trusted_dependencies: true, candidate_source_only: true },
    facts_capture: name === 'inconclusive' ? null : { bytes_base64: facts.toString('base64'), digest: hash(facts) },
  };
  const bytes = Buffer.from(JSON.stringify(report));
  const assessment = validateVersionedComparatorReport({ evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest,
    solution_artifact_manifest_digest: manifest, captured_report: { bytes, expected_raw_report_digest: hash(bytes) } });
  const payload = {
    format: 'motive.hypothesis-mcp/0.1',
    target: { engineInstanceId: 'synthetic-engine', ledgerId: 'synthetic-ledger', hypothesisId: 'synthetic-hypothesis', hypothesisRevisionId: 'synthetic-revision-3', investigationId: `synthetic-investigation-${name}`, engineClaimId: null },
    motive: { projectId: uuid(1), projectRevision: 1, workOrderId: uuid(10 + index), workOrderKey: `synthetic-${name}`, workOrderRevision: 1,
      agreementId: `synthetic-agreement-${name}`, termsDigest: digest(`terms:${name}`), attemptId: uuid(20 + index), inputCommit: 'c'.repeat(40), inputDigest: digest(`input:${name}`),
      assignmentId: `synthetic-proposed-motive-assignment-${name}`, assignmentRevision: 1 },
    artifact: { artifactEnvironmentId: uuid(30 + index), artifactManifestDigest: manifest, artifactReceiptId: `synthetic-sealed-receipt-${name}` },
    evaluator: { id: uuid(40 + index), evaluatorProfileDigest: profileDigest, rawReportDigest: assessment.raw_report_digest,
      assessmentDigest: digestCanonicalJson(assessment), outcome: assessment.outcome, reportFormat: report.format, assessmentFormat: assessment.format },
    decision: null,
    attribution: { contributorActorId: null, evaluatorActorId: null, evaluatorEnvironmentId: uuid(50 + index), reviewerActorId: null },
    interpretation: 'EVALUATOR_OBSERVATION_ONLY', hypothesisSupport: 'UNASSESSED', conclusionApproval: 'UNASSESSED',
  };
  await json(`fixtures/${name}.json`, { synthetic: true, assignmentStatus: 'PROPOSED_MAPPING_NOT_A_LIVE_ASSIGNMENT', expectedOutcome: assessment.outcome, payload, payloadDigest: digestCanonicalJson(payload), profile, report });
}
await json('fixtures/duplicate.json', { synthetic: true, base: 'ordinary.json', idempotencyKey: 'synthetic-original', expected: 'ORIGINAL_RESULT_NO_SECOND_ENGINE_IMPORT' });
await json('fixtures/changed-payload-conflict.json', { synthetic: true, base: 'ordinary.json', idempotencyKey: 'synthetic-original', changedHypothesisRevisionId: 'synthetic-revision-4', expected: 'IDEMPOTENCY_CONFLICT_BEFORE_ENGINE' });
const ordinary = JSON.parse(await readFile(resolve(destination, 'fixtures/ordinary.json'), 'utf8')).payload;
await json('fixtures/denied-review.json', { synthetic: true, authenticatedActorId: uuid(90), evaluationId: ordinary.evaluator.id,
  currentProjectPermission: 'ACTIVE_NON_MAINTAINER', expectedEnabledHttpStatus: 403, expectedDefaultHttpStatus: 503,
  body: { decision: 'ACCEPTED', expectedReview: { attemptId: ordinary.motive.attemptId, artifactManifestDigest: ordinary.artifact.artifactManifestDigest,
    termsDigest: ordinary.motive.termsDigest, evaluatorProfileDigest: ordinary.evaluator.evaluatorProfileDigest, rawReportDigest: ordinary.evaluator.rawReportDigest } } });
await json('AGREEMENT.json', { contractVersion: 'motive.hypothesis-mcp/0.1', motiveAcknowledged: false, hypothesisAcknowledged: false,
  status: 'PROPOSED_AWAITING_BOTH_TEAMS', mcpToolNames: null, note: 'Agree on PACKAGE-MANIFEST.json packageSnapshotId before integration coding; no actor or tool registration is claimed.' });
const packageFiles: { path: string; bytes: number; digest: string }[] = [];
async function walk(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', 'PACKAGE-MANIFEST.json'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Bundle may not contain symlinks');
    if (entry.isDirectory()) await walk(path);
    else { const bytes = await readFile(path); packageFiles.push({ path: relative(destination, path).replaceAll('\\', '/'), bytes: bytes.length, digest: hash(bytes) }); }
  }
}
await walk(destination); packageFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
await json('PACKAGE-MANIFEST.json', { format: 'motive.hypothesis-package-snapshot/0.1', packageSnapshotId: hash(JSON.stringify(packageFiles)), files: packageFiles });
console.log(JSON.stringify({ destination, sourceSnapshotId: hash(JSON.stringify(sourceFiles)), packageSnapshotId: hash(JSON.stringify(packageFiles)), sourceFiles: sourceFiles.length, totalFiles: packageFiles.length + 1, bytes: packageFiles.reduce((n, f) => n + f.bytes, 0) }, null, 2));
