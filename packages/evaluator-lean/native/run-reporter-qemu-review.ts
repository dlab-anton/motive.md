import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { decodeComparatorFacts } from '../src/facts.ts';

const toolImage = 'motive-evaluator-tools:reporter-review';
const guestImage = 'motive-evaluator-systemd-qemu:reporter-review';
const stockImage = 'motive-evaluator-tools:pinned-review';
const expectedStock = 'sha256:fa35e29fb21455a685a2d68b82701a48c5b8ee30c9c9c7c55348d5b4b06bfe5f';
const name = `motive-evaluator-reporter-${randomBytes(6).toString('hex')}`;
const outputPrefix = 'fixtures/compatibility/evidence/evaluator-reporter-qemu';
const sha256 = (bytes: Uint8Array | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function docker(args: string[], timeoutMs = 30_000, maximumBytes = 8 * 1024 * 1024) {
  return new Promise<{ code: number | null; output: string; timedOut: boolean; truncated: boolean }>((resolve, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let count = 0; let truncated = false; let timedOut = false;
    const collect = (chunk: Buffer) => {
      if (count + chunk.length > maximumBytes) { truncated = true; child.kill(); return; }
      chunks.push(Buffer.from(chunk)); count += chunk.length;
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output: Buffer.concat(chunks).toString('utf8'), timedOut, truncated }); });
  });
}

async function checked(args: string[], timeoutMs?: number): Promise<string> {
  const result = await docker(args, timeoutMs);
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error(`Local Docker operation failed: ${args[0]}`);
  return result.output.trim();
}

const sourceFiles = [
  'packages/evaluator-lean/native/Dockerfile.namespace-wrapper',
  'packages/evaluator-lean/native/Dockerfile.systemd-qemu',
  'packages/evaluator-lean/native/landrun-namespace-wrapper.c',
  'packages/evaluator-lean/native/descendant-probe.c',
  'packages/evaluator-lean/native/workload-marker.c',
  'packages/evaluator-lean/native/run-fixtures-namespaced.sh',
  'packages/evaluator-lean/native/evaluator-guest-run.sh',
  'packages/evaluator-lean/native/evaluator-fixtures.service',
  'packages/evaluator-lean/native/run-evaluator-qemu.sh',
  'packages/evaluator-lean/native/run-reporter-qemu-review.ts',
  'packages/evaluator-lean/native/Dockerfile.reporter',
  'packages/evaluator-lean/native/Dockerfile.reporter-qemu',
  'packages/evaluator-lean/native/motive-facts-suffix.lean',
  'packages/evaluator-lean/native/prepare-reporter-source.mjs',
  'packages/evaluator-lean/native/reporter-fixtures.mjs',
  'packages/evaluator-lean/native/reporter-guest-run.sh',
  'packages/evaluator-lean/src/facts.ts',
  'packages/evaluator-lean/src/contract.ts',
  'fixtures/evaluator/sources/forged-acceptance-output/Solution.lean',
];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, sha256(await readFile(path))])));
const observedStock = await checked(['image', 'inspect', stockImage, '--format', '{{.Id}}']);
if (observedStock !== expectedStock) throw new Error('Pinned stock evaluator image changed.');
const toolId = await checked(['image', 'inspect', toolImage, '--format', '{{.Id}}']);
const guestId = await checked(['image', 'inspect', guestImage, '--format', '{{.Id}}']);
const guestDigests = await checked(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '32',
  '--entrypoint', '/bin/cat', guestId, '/guest/guest-image-sha256.txt']);
const toolDigests = await checked(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '32',
  '--entrypoint', '/usr/bin/sha256sum', toolId,
  '/opt/evaluator/bin/motive-comparator-reporter', '/opt/evaluator/identities/MotiveReporter.lean',
  '/opt/evaluator/identities/reporter-source-identity.json', '/opt/evaluator/bin/comparator', '/opt/evaluator/bin/landrun', '/opt/evaluator/bin/lean4export',
  '/opt/lean/bin/lean', '/opt/lean/bin/lake', '/opt/evaluator/bin/landrun-namespace-wrapper',
  '/usr/bin/setpriv', '/usr/bin/unshare', '/opt/evaluator/bin/descendant-probe',
  '/opt/evaluator/bin/run-fixtures', '/opt/evaluator/identities/landrun-namespace-wrapper.c',
  '/opt/evaluator/fixtures/fixture-manifest.sha256']);
const systemPackages = await checked(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '32',
  '--entrypoint', '/usr/bin/dpkg-query', toolId, '--show', '--showformat=${Package}=${Version}\n', 'util-linux', 'systemd']);

let created = false; let removed = false;
let run: Awaited<ReturnType<typeof docker>> | null = null;
let isolation: Record<string, unknown> | null = null;
const diagnostics: string[] = [];
try {
  await checked(['create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '4g', '--cpus', '2', guestId]);
  created = true;
  const [container] = JSON.parse(await checked(['inspect', name]));
  isolation = { network: container.HostConfig.NetworkMode, readOnlyRootfs: container.HostConfig.ReadonlyRootfs,
    mounts: container.Mounts, binds: container.HostConfig.Binds, capAdd: container.HostConfig.CapAdd,
    capDrop: container.HostConfig.CapDrop, securityOpt: container.HostConfig.SecurityOpt,
    memory: container.HostConfig.Memory, nanoCpus: container.HostConfig.NanoCpus, pidsLimit: container.HostConfig.PidsLimit };
  if (isolation.network !== 'none' || isolation.readOnlyRootfs !== true || container.Mounts.length !== 0
    || (container.HostConfig.Binds?.length ?? 0) !== 0 || (container.HostConfig.CapAdd?.length ?? 0) !== 0
    || !container.HostConfig.CapDrop.includes('ALL') || !container.HostConfig.SecurityOpt.includes('no-new-privileges')
    || isolation.memory !== 4_294_967_296 || isolation.nanoCpus !== 2_000_000_000 || isolation.pidsLimit !== 128) {
    throw new Error('Evaluator container isolation differs from reviewed limits.');
  }
  run = await docker(['start', '--attach', name], 900_000);
  if (run.timedOut || run.truncated || run.code !== 0) diagnostics.push('Container attach failed, timed out or exceeded log limit.');
} catch (error) { diagnostics.push(error instanceof Error ? error.message : String(error)); }
finally {
  if (created) {
    try { await checked(['rm', '--force', name]); removed = true; }
    catch { diagnostics.push('Temporary evaluator container cleanup failed.'); }
  }
}

const log = run?.output ?? '';
await writeFile(`${outputPrefix}.log`, log);
// systemd forwards service stdout through the guest console with this prefix.
const cleanLog = log.replace(/\r/g, '').replace(/^\[\s*\d+\.\d+\] evaluator-guest-run\[\d+\]: /gm, '');
if (cleanLog.includes('MOTIVE_EVALUATOR_FIXTURE_RUNNER_FAILED')) diagnostics.push('Guest fixture runner failed before final verification.');
const resultLines = [...cleanLog.matchAll(/^MOTIVE_REPORTER_RESULT=(\{[^\n]+\})$/gm)];
let guestResult: Record<string, unknown> | null = null;
if (resultLines.length === 1) {
  try { guestResult = JSON.parse(resultLines[0][1]); } catch { diagnostics.push('Malformed guest result.'); }
} else diagnostics.push('Expected exactly one authoritative guest result marker.');
const cases = [...cleanLog.matchAll(/^MOTIVE_REPORTER_CASE=(\{[^\n]+\})$/gm)].map(match => JSON.parse(match[1]));
const expectedCases = ['valid-proof', 'wrong-target-statement', 'incomplete-proof', 'unapproved-custom-axiom',
  'transitive-incomplete-dependency', 'forged-acceptance-output', 'used-permitted-axiom', 'report-path-attack', 'build-failure'];
if (cases.length !== 9 || !expectedCases.every(id => cases.filter(item => item.id === id).length === 1)) {
  diagnostics.push('Expected nine reporter cases were not observed.');
}
for (const item of cases) {
  try {
    const facts = decodeComparatorFacts(Buffer.from(JSON.stringify(item.facts)));
    const expectedOutcome = ['valid-proof', 'used-permitted-axiom'].includes(item.id) ? 'VERIFIED'
      : item.id === 'build-failure' ? 'INCONCLUSIVE' : 'REJECTED';
    if (facts.outcome !== expectedOutcome || item.exitCode !== (expectedOutcome === 'VERIFIED' ? 0 : 1)
      || !/^sha256:[a-f0-9]{64}$/.test(item.reportDigest) || !/^sha256:[a-f0-9]{64}$/.test(item.logDigest)) {
      diagnostics.push(`Unexpected reporter case result: ${item.id}`);
    }
  } catch { diagnostics.push(`Invalid decoded checker facts: ${item.id}`); }
}
const guards = [...cleanLog.matchAll(/^MOTIVE_REPORTER_GUARD=([a-z-]+)$/gm)].map(match => match[1]);
if (guards.length !== 4 || !['wrong-supervisor', 'wrong-exporter', 'wrong-search-path', 'existing-report'].every(id => guards.filter(item => item === id).length === 1)) {
  diagnostics.push('Expected four reporter startup guards were not observed.');
}
const probes = {
  afUnixPositiveControl: cleanLog.includes('AF_UNIX positive control: allowed'),
  afUnixRestricted: cleanLog.includes('AF_UNIX restriction probe: socket() denied errno=97'),
  namespaceIdentity: cleanLog.includes('motive-namespace-probe-ok'),
  failedSetupRunsNoWork: cleanLog.includes('namespace failure control: workload not started'),
  detachedPositiveControl: cleanLog.includes('detached descendant positive control: survived unsupervised Landrun'),
  childLockReleasedAtReturn: cleanLog.includes('detached descendant control: process lock released at wrapper return; no post-return write'),
};
if (!Object.values(probes).every(Boolean)) diagnostics.push('Required namespace/descendant probes were not all observed.');
if (guestResult?.status !== 'PASSED_LOCAL_REPORTER_FIXTURES' || guestResult?.cases !== 9 || guestResult?.guards !== 4
  || guestResult?.human_acceptance !== 'PENDING' || guestResult?.deployment_approved !== false) {
  diagnostics.push('Guest did not report the complete fixture pass with acceptance pending.');
}
const evidence = { format: 'motive.evaluator-reporter-qemu-review/0.1', capturedAt: new Date().toISOString(),
  status: diagnostics.length === 0 && removed ? 'PASSED_LOCAL_REPORTER_FIXTURES' : 'FAILED',
  stockImage: { name: stockImage, id: observedStock }, toolImage: { name: toolImage, id: toolId },
  guestImage: { name: guestImage, id: guestId }, sources, guestDigests, toolDigests, systemPackages, isolation,
  logDigest: sha256(log), logBytes: Buffer.byteLength(log), guestResult, cases, guards, probes, diagnostics,
  cleanup: { containerRemoved: removed, imagesRetained: true }, humanAcceptance: 'PENDING', deploymentApproved: false,
  realProviderCalls: 0, realSpendUsd: '0.000000000000' };
await writeFile(`${outputPrefix}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ status: evidence.status, cases, guards, probes, diagnostics, outputPrefix }, null, 2));
if (evidence.status === 'FAILED') process.exitCode = 1;
