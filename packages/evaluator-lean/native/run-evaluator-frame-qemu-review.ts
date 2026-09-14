import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { canonicalJson, digestCanonicalJson } from '../../domain/src/contracts.ts';
import { profile } from '../src/runtime-profile.fixture.ts';

const image = 'motive-evaluator-frame-qemu:local-rehearsal';
const header = 'MOTIVE_TRUSTED_EVALUATOR_FRAME_V1\n';
const failure = 'MOTIVE_EVALUATOR_FRAME_LAUNCHER_FAILED\n';
const environmentId = '12345678-1234-4123-8123-123456789abc';
const attemptId = '22345678-1234-4123-8123-123456789abc';
const profileJson = canonicalJson(profile);
const profileDigest = digestCanonicalJson(profile);
const digest = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

type RunResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; elapsedMs: number };

async function docker(args: string[], timeoutMs = 690_000): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Docker timeout: ${args.join(' ')}`)); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 256 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 64 * 1024) child.kill('SIGKILL'); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr, elapsedMs: Date.now() - started }); });
  });
}

function binding(evaluatorProfileDigest: string, artifactManifestDigest: string) {
  return Buffer.from(`motive.trusted-evaluator-create/0.1\nenvironment_id=${environmentId}\nattempt_id=${attemptId}\nevaluator_profile_digest=${evaluatorProfileDigest}\nartifact_manifest_digest=${artifactManifestDigest}\n`).toString('base64');
}

function runArgs(source: Uint8Array, caseId: string, evaluatorProfileDigest = profileDigest) {
  const sourceDigest = digest(source);
  const manifestDigest = digestCanonicalJson({ format: 'motive.local-sealed-source/0.1', case_id: caseId, source_digest: sourceDigest });
  const pack = canonicalJson({ format: 'motive.sealed-evaluator-input/0.1', artifact_manifest_digest: manifestDigest,
    files: [{ relative_path: 'Solution.lean', bytes_base64: Buffer.from(source).toString('base64'), digest: sourceDigest }] });
  return { manifestDigest, args: [
    'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '4g', '--cpus', '2',
    '-e', `MOTIVE_EVALUATOR_CREATE_BINDING_B64=${binding(evaluatorProfileDigest, manifestDigest)}`,
    '-e', `MOTIVE_EVALUATOR_PROFILE_B64=${Buffer.from(profileJson).toString('base64')}`,
    '-e', `MOTIVE_EVALUATOR_SOLUTION_B64=${Buffer.from(pack).toString('base64')}`,
    image,
  ] };
}

function requireFrame(result: RunResult, manifestDigest: string, expectedOutcome: string) {
  assert.equal(result.signal, null); assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.ok(result.stdout.startsWith(header) && result.stdout.endsWith('\n'));
  const body = result.stdout.slice(header.length, -1);
  assert.equal(body.includes('\n'), false);
  const frame = JSON.parse(body) as Record<string, unknown>;
  assert.equal(JSON.stringify(frame), body);
  assert.equal(frame.format, 'motive.trusted-evaluator-frame/0.1');
  assert.equal(frame.environment_id, environmentId); assert.equal(frame.attempt_id, attemptId);
  assert.equal(frame.evaluator_profile_digest, profileDigest); assert.equal(frame.artifact_manifest_digest, manifestDigest);
  assert.deepEqual(frame.runtime_preflight, { af_unix_denied: false, landlock_enforced: false, namespace_identity: false,
    descendants_reaped: true, protected_report_capture: true });
  assert.deepEqual(frame.input_preflight, { trusted_challenge: false, trusted_dependencies: false, candidate_source_only: true });
  assert.equal(typeof frame.facts_base64, 'string'); assert.equal(typeof frame.facts_digest, 'string');
  const factsBytes = Buffer.from(frame.facts_base64 as string, 'base64');
  assert.equal(factsBytes.toString('base64'), frame.facts_base64); assert.equal(digest(factsBytes), frame.facts_digest);
  const facts = JSON.parse(factsBytes.toString('utf8')) as Record<string, unknown>;
  assert.equal(facts.format, 'motive.comparator-facts/0.1'); assert.equal(facts.outcome, expectedOutcome);
  return { frameDigest: digest(body), factsDigest: frame.facts_digest, outcome: facts.outcome,
    rejectionStage: facts.rejection_stage, elapsedMs: result.elapsedMs };
}

const inspect = await docker(['image', 'inspect', image, '--format', '{{.Id}}'], 30_000);
assert.equal(inspect.status, 0); assert.equal(inspect.signal, null); assert.equal(inspect.stderr, '');
const imageId = inspect.stdout.trim(); assert.match(imageId, /^sha256:[a-f0-9]{64}$/);

const validSource = await readFile('fixtures/evaluator/sources/valid-proof/Solution.lean');
const changedSource = await readFile('fixtures/evaluator/sources/wrong-target-statement/Solution.lean');
const validInput = runArgs(validSource, 'valid-supplied-source');
const changedInput = runArgs(changedSource, 'changed-supplied-source');
const validResult = await docker(validInput.args);
const valid = requireFrame(validResult, validInput.manifestDigest, 'VERIFIED');
const changed = requireFrame(await docker(changedInput.args), changedInput.manifestDigest, 'REJECTED');
assert.notEqual(valid.factsDigest, changed.factsDigest);

const badDigest = digestCanonicalJson('motive intentionally mismatched evaluator profile');
const invalidInput = runArgs(validSource, 'bad-binding', badDigest);
const invalid = await docker(invalidInput.args);
assert.equal(invalid.signal, null); assert.equal(invalid.status, 125);
assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr, failure);

console.log(JSON.stringify({ format: 'motive.evaluator-frame-qemu-review/0.1', image, imageId, profileDigest,
  valid: { manifestDigest: validInput.manifestDigest, sourceDigest: digest(validSource), ...valid },
  changed: { manifestDigest: changedInput.manifestDigest, sourceDigest: digest(changedSource), ...changed },
  badBinding: { suppliedProfileDigest: badDigest, actualProfileDigest: profileDigest, exitCode: invalid.status,
    frameEmitted: invalid.stdout.includes(header), elapsedMs: invalid.elapsedMs },
  constraints: { network: 'none', readOnlyRoot: true, capabilities: [], noNewPrivileges: true,
    pids: 128, memory: '4g', cpus: 2, providerCalls: 0, spendUsd: '0.000000000000' },
  humanAcceptance: 'PENDING', deploymentApproved: false }, null, 2));
