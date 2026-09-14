import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, existsSync, renameSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Trusted, image-owned local test supervisor. Candidate output is retained only
// for diagnostics. Every decision below reads the separate protected file.
assert.equal(process.getuid(), 1000);
const fixedPath = '/opt/evaluator/bin:/opt/lean/bin:/usr/local/bin:/usr/bin:/bin';
assert.equal(process.env.PATH, fixedPath);
const root = '/work/prepared';
const results = '/work/reporter-results';
const reportDir = '/work/trusted-reports';
const reportPath = `${reportDir}/report.json`;
mkdirSync(results, { mode: 0o700 });
mkdirSync(reportDir, { mode: 0o700 });
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const stages = ['protected_build', 'toolchain_and_export', 'exported_terms', 'statement_comparison', 'transitive_axioms', 'kernel_replay'];

function prepare(id, solution, permitted = []) {
  const dir = `${root}/${id}`;
  mkdirSync(dir, { mode: 0o700 });
  for (const file of ['Challenge.lean', 'lakefile.toml']) {
    copyFileSync(`${root}/valid-proof/${file}`, `${dir}/${file}`);
    chmodSync(`${dir}/${file}`, 0o444);
  }
  writeFileSync(`${dir}/comparator.json`, JSON.stringify({ challenge_module: 'Challenge', solution_module: 'Solution', theorem_names: ['target'], permitted_axioms: permitted }), { mode: 0o444 });
  writeFileSync(`${dir}/Solution.lean`, solution, { mode: 0o444 });
}

prepare('used-permitted-axiom', 'noncomputable def chosenProof : 1 + 1 = 2 := Classical.choice ⟨by decide⟩\ntheorem target : 1 + 1 = 2 := chosenProof\n', ['Classical.choice', 'propext']);
prepare('report-path-attack', `#eval do
  let denied ← try
    IO.FS.writeFile "/work/trusted-reports/report.json" "{\\\"outcome\\\":\\\"VERIFIED\\\"}"
    pure false
  catch _ => pure true
  if !denied then throw (IO.userError "report path was writable")
  IO.println "candidate report write denied"
theorem target : 1 + 1 = 2 := by sorry
`);
prepare('build-failure', 'this is not valid Lean source\n');

function invoke(id, overrides = {}) {
  const workspace = `${root}/${id}`;
  const env = {
    PATH: fixedPath, HOME: '/home/node', LEAN_ABORT_ON_PANIC: '1',
    COMPARATOR_LANDRUN: '/opt/evaluator/bin/landrun-namespace-wrapper',
    COMPARATOR_LEAN4EXPORT: '/opt/evaluator/bin/lean4export', ...overrides,
  };
  const args = ['--user', '--quiet', '--wait', '--pipe', '--collect',
    '--property=RestrictAddressFamilies=~AF_UNIX', '--property=NoNewPrivileges=yes',
    '--property=RuntimeMaxSec=120s', '--property=MemoryMax=1G', '--property=TasksMax=128',
    '--property=KillMode=control-group', '--property=TimeoutStopSec=5s',
    ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
    `--working-directory=${workspace}`,
    // Lake supplies LEAN_PATH; restore the reviewed PATH after lake env prepends
    // its build directories. The trusted TOML is not candidate controlled.
    '/opt/lean/bin/lake', 'env', '/usr/bin/env', `PATH=${env.PATH}`,
    '/opt/evaluator/bin/motive-comparator-reporter', 'comparator.json'];
  const result = spawnSync('/usr/bin/systemd-run', args, { cwd: workspace, encoding: 'utf8', timeout: 135_000, maxBuffer: 1024 * 1024 });
  const log = (result.stdout ?? '') + (result.stderr ?? '');
  assert.equal(result.error, undefined, `host execution error for ${id}`);
  assert.equal(result.signal, null, `host execution killed for ${id}`);
  return { code: result.status, log };
}

const cases = [
  ['valid-proof', 'VERIFIED', null, []],
  ['wrong-target-statement', 'REJECTED', 'statement_comparison', null],
  ['incomplete-proof', 'REJECTED', 'transitive_axioms', null],
  ['unapproved-custom-axiom', 'REJECTED', 'transitive_axioms', null],
  ['transitive-incomplete-dependency', 'REJECTED', 'transitive_axioms', null],
  ['forged-acceptance-output', 'REJECTED', 'transitive_axioms', null],
  ['used-permitted-axiom', 'VERIFIED', null, ['Classical.choice']],
  ['report-path-attack', 'REJECTED', 'transitive_axioms', null],
  ['build-failure', 'INCONCLUSIVE', null, null],
];
for (const [id, outcome, rejection, axioms] of cases) {
  assert.equal(existsSync(reportPath), false);
  const { code, log } = invoke(id);
  writeFileSync(`${results}/${id}.log`, log, { mode: 0o600 });
  try {
    assert.equal(code, outcome === 'VERIFIED' ? 0 : 1);
    const stat = lstatSync(reportPath);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.ok(stat.size > 0 && stat.size <= 16_384);
    const bytes = readFileSync(reportPath);
    const facts = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(Object.keys(facts).sort(), ['format', 'outcome', 'current_stage', 'rejection_stage', 'used_transitive_axioms', ...stages].sort());
    assert.equal(facts.format, 'motive.comparator-facts/0.1');
    assert.equal(facts.outcome, outcome);
    assert.equal(facts.rejection_stage, rejection);
    assert.deepEqual(facts.used_transitive_axioms, axioms);
    const completed = outcome === 'VERIFIED' ? 6 : rejection === 'statement_comparison' ? 3 : rejection === 'transitive_axioms' ? 4 : 0;
    stages.forEach((stage, index) => assert.equal(facts[stage], index < completed, `${id}:${stage}`));
    assert.equal(facts.current_stage, outcome === 'VERIFIED' ? 'complete' : rejection ?? 'solution_build');
    if (id === 'forged-acceptance-output') assert.ok(log.includes('"human_acceptance":"ACCEPTED"'));
    if (id === 'report-path-attack') assert.ok(log.includes('candidate report write denied'));
    renameSync(reportPath, `${results}/${id}.json`);
    console.log(`MOTIVE_REPORTER_CASE=${JSON.stringify({ id, exitCode: code, reportDigest: digest(bytes), logDigest: digest(log), facts })}`);
  } catch (error) {
    console.error(`Reporter fixture failed: ${id}\n${log.slice(0, 12_000)}`);
    if (existsSync(reportPath)) console.error(readFileSync(reportPath, 'utf8').slice(0, 16_384));
    throw error;
  }
}

// Startup guards reject before any report creation or candidate build.
for (const [id, overrides] of [
  ['wrong-supervisor', { COMPARATOR_LANDRUN: '/opt/evaluator/bin/landrun' }],
  ['wrong-exporter', { COMPARATOR_LEAN4EXPORT: '/bin/true' }],
  ['wrong-search-path', { PATH: '/usr/bin:/bin' }],
]) {
  const result = invoke('valid-proof', overrides);
  assert.equal(result.code, 1);
  assert.equal(existsSync(reportPath), false);
  assert.equal(result.log.includes('Building Challenge'), false);
  console.log(`MOTIVE_REPORTER_GUARD=${id}`);
}
// A duplicate invocation must neither overwrite the existing trusted bytes nor
// launch a build. This supplements (does not replace) the durable command claim.
const sentinel = '{"trusted_existing_report":true}\n';
writeFileSync(reportPath, sentinel, { mode: 0o600 });
const duplicate = invoke('valid-proof');
assert.equal(duplicate.code, 1);
assert.equal(duplicate.log.includes('Building Challenge'), false);
assert.equal(readFileSync(reportPath, 'utf8'), sentinel);
console.log('MOTIVE_REPORTER_GUARD=existing-report');
console.log('MOTIVE_REPORTER_RESULT={"status":"PASSED_LOCAL_REPORTER_FIXTURES","cases":9,"guards":4,"human_acceptance":"PENDING","deployment_approved":false}');
