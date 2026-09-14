import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { validateAndFreezeProfile } from '../../packages/inference-gateway/src/profile.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { parseBuildCircleVercelRuntimeArguments } from '../build-circle-vercel-runtime.ts';
import {
  CIRCLE_DEPLOYMENT_CANDIDATE_FORMAT,
  CIRCLE_REFERENCE_INPUT_PATH,
  CIRCLE_RUNTIME_CANDIDATE_FORMAT,
  executeCircleVercelRuntimeBuild,
  planCircleVercelRuntimeBuild,
  reprofileProviderUntrustedCandidate,
  readCircleRuntimeBuildSources,
  type CircleRuntimeBuildInput,
  type RuntimeBuildProvider,
  type RuntimeBuildSandbox,
} from './circle-vercel-runtime-build.ts';

function reviewedProfile() {
  return validateAndFreezeProfile({
    format: 'motive.gateway-profile/0.1', profileId: 'circle-astra-reviewed-test', status: 'reviewed-live',
    upstream: { responsesUrl: 'https://openrouter.ai/api/v1/responses', credentialRef: 'openrouter:account-bound' },
    route: { model: 'openai/gpt-6-astra', provider: { order: ['OpenAI'], allowFallbacks: false, requireParameters: true } },
    limits: { maxRequestBytes: 262144, maxResponseBytes: 1048576, maxEventBytes: 262144, requestTimeoutMs: 240000,
      maxInputItems: 32, maxTools: 4, contextWindowTokens: 100000, maxOutputTokens: 10000 },
    requestPolicy: { allowedLocalTools: ['exec_command', 'write_stdin', 'request_user_input', 'view_image'].map(name => ({ type: 'function', name })), allowedReasoningEfforts: ['low'],
      allowParallelToolCalls: true, allowTemperature: false, allowTopP: false, codexClientMetadata: 'drop-pinned-0.153.4' },
    pricing: { currency: 'USD', highestInputUsdPerMillionTokens: '5', highestOutputUsdPerMillionTokens: '25',
      fixedRequestUsd: '0', worstCaseAdditionalUsd: '0', approvedMaximumExposureUsd: '0.75' },
    evidence: { kind: 'gate-a-reviewed', reviewedAt: '2026-09-07', reviewedBy: 'test-reviewer',
      pricingSource: 'https://openrouter.ai/api/v1/models', responsesCompatibilitySource: 'https://openrouter.ai/docs/api-reference/responses/overview' },
  });
}

async function input(): Promise<CircleRuntimeBuildInput> {
  return { projectRevision: 1, gatewayProfile: reviewedProfile(), gatewayUrl: 'https://motive.example/api/inference/v1/responses',
    artifactEgressUrl: 'https://storage.example/runtime/', runtimeTimeoutMs: 300000, commandTimeoutMs: 240000,
    buildTimeoutMs: 600000, vcpus: 2, sourceFiles: await readCircleRuntimeBuildSources() };
}

const probe = `LAUNCHER_CHECK=MOTIVE_RUNTIME_CHECK_OK
CODEX_VERSION=codex-cli 0.153.4
ARCH=x86_64
KERNEL=6.12.0
OS_ID=ubuntu
OS_VERSION=24.04
PACKAGE_MANAGER=apt
BUILD_PACKAGES=gcc=4:13.2.0-7ubuntu1,libc6-dev=2.39-0ubuntu8
NODE=v24.8.0
PYTHON=Python 3.12.1
NUMPY=no
SCIPY=no
PRISTINE=yes
LAUNCHER_PATH=/opt/motive/bin/worker-launcher
LAUNCHER_SHA256=${'1'.repeat(64)}
LAUNCHER_OWNER=root:root
LAUNCHER_MODE=555
RUNTIME_CHECK_PATH=/opt/motive/bin/worker-runtime-check
RUNTIME_CHECK_SHA256=${'2'.repeat(64)}
RUNTIME_CHECK_OWNER=root:root
RUNTIME_CHECK_MODE=555
CODEX_PATH=/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex
CODEX_SHA256=${'3'.repeat(64)}
CODEX_OWNER=root:root
CODEX_MODE=755
CODEX_PACKAGE_PATH=/usr/local/lib/node_modules/@openai/codex/package.json
CODEX_PACKAGE_SHA256=${'9'.repeat(64)}
CODEX_PACKAGE_OWNER=root:root
CODEX_PACKAGE_MODE=644
CODEX_PLATFORM_PACKAGE_PATH=/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/package.json
CODEX_PLATFORM_PACKAGE_SHA256=${'a'.repeat(64)}
CODEX_PLATFORM_PACKAGE_OWNER=root:root
CODEX_PLATFORM_PACKAGE_MODE=644
CONFIG_PATH=/opt/motive/codex-config/config.toml
CONFIG_SHA256=${'4'.repeat(64)}
CONFIG_OWNER=root:root
CONFIG_MODE=444
CATALOG_PATH=/opt/motive/codex-config/model-catalog.json
CATALOG_SHA256=${'5'.repeat(64)}
CATALOG_OWNER=root:root
CATALOG_MODE=444
REFERENCE_PATH=/opt/motive/inputs/reference-witness.json
REFERENCE_SHA256=${'6'.repeat(64)}
REFERENCE_OWNER=root:root
REFERENCE_MODE=444
CHANNEL_PATH=/run/motive/channels/controller
CHANNEL_SHA256=${'7'.repeat(64)}
CHANNEL_OWNER=root:root
CHANNEL_MODE=444
BUILD_PACKAGES_PATH=/opt/motive/package-evidence/build-packages.txt
BUILD_PACKAGES_SHA256=${'8'.repeat(64)}
BUILD_PACKAGES_OWNER=root:root
BUILD_PACKAGES_MODE=444
OS_RELEASE_PATH=/etc/os-release
OS_RELEASE_SHA256=${'b'.repeat(64)}
OS_RELEASE_OWNER=root:root
OS_RELEASE_MODE=644
`;

const providerProbe=`BOUNDARY=provider-untrusted-circle-data
FILESYSTEM_CLAIM=none
OUTPUT_TRUST=untrusted
CODEX_VERSION=codex-cli 0.153.4
STRICT_CONFIG=yes
ASTRA_CATALOG=yes
ARCH=x64
NODE=v24.8.0
OS_ID=ubuntu
OS_VERSION=26.04
WRAPPER_PATH=/usr/local/bin/codex
WRAPPER_SHA256=${'1'.repeat(64)}
CODEX_PATH=/usr/local/lib/node_modules/@openai/codex/vendor/codex
CODEX_SHA256=${'2'.repeat(64)}
CODEX_PACKAGE_PATH=/usr/local/lib/node_modules/@openai/codex/package.json
CODEX_PACKAGE_SHA256=${'3'.repeat(64)}
CODEX_PLATFORM_PACKAGE_PATH=/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/package.json
CODEX_PLATFORM_PACKAGE_SHA256=${'4'.repeat(64)}
CONFIG_PATH=/opt/motive/codex-config/config.toml
CONFIG_SHA256=${'5'.repeat(64)}
CATALOG_PATH=/opt/motive/codex-config/model-catalog.json
CATALOG_SHA256=${'6'.repeat(64)}
REFERENCE_PATH=/opt/motive/inputs/reference-witness.json
REFERENCE_SHA256=${'7'.repeat(64)}
`;

function provider(options: { failRun?: boolean; failRunAt?:number; stopFails?: boolean; probeText?:string } = {}) {
  const writes: { path: string; content: string | Uint8Array }[][] = []; const commands: { cmd: string; args: readonly string[] }[] = [];
  const sandbox: RuntimeBuildSandbox = {
    image: `vercel/sandbox/node:24@sha256:${'c'.repeat(64)}`,
    writeFiles: vi.fn(async files => { writes.push(files); }),
    run: vi.fn(async command => { commands.push(command); const fail=options.failRun||commands.length-1===options.failRunAt;
      return { exitCode: fail ? 1 : 0, diagnostic: fail ? 'bounded build step failed' : '' }; }),
    read: vi.fn(async () => new TextEncoder().encode(options.probeText??probe)),
    snapshot: vi.fn(async () => ({ snapshotId: 'snap_MotiveCircleCandidate01', sourceSessionId: 'session-1', region: 'iad1',
      sizeBytes: 123456, expiresAt: new Date('2026-09-08T00:00:00.000Z'), delete: vi.fn() })),
    stop: vi.fn(async () => { if (options.stopFails) throw new Error('provider stop failed'); }),
  };
  const value: RuntimeBuildProvider = { create: vi.fn(async () => sandbox) };
  return { value, sandbox, writes, commands };
}

describe('circle Vercel runtime build candidate', () => {
  it('defaults the operator entry point to dry-run and requires explicit finite resources and one config source', () => {
    const parsed = parseBuildCircleVercelRuntimeArguments(['--project-revision', '1', '--build-config-file', '.local/build.json',
      '--gateway-url', 'https://motive.example/api/inference/v1/responses', '--artifact-egress-url', 'https://storage.example/runtime/',
      '--runtime-timeout-ms', '300000', '--command-timeout-ms', '240000', '--build-timeout-ms', '600000', '--vcpus', '2']);
    expect(parsed).toMatchObject({ execute: false, projectRevision: 1, buildTimeoutMs: 600000, vcpus: 2 });
    expect(parseBuildCircleVercelRuntimeArguments(['--boundary','provider-untrusted-circle-data','--project-revision','1',
      '--build-config-file','.local/build.json','--gateway-url','https://motive.example/api/inference/v1/responses',
      '--runtime-timeout-ms','300000','--command-timeout-ms','240000','--build-timeout-ms','600000','--vcpus','2']))
      .toMatchObject({boundary:'provider-untrusted-circle-data'});
    expect(() => parseBuildCircleVercelRuntimeArguments(['--project-revision', '1', '--build-config-file', 'a', '--gateway-profile-file', 'b',
      '--gateway-url', 'https://motive.example/responses', '--artifact-egress-url', 'https://storage.example/runtime/',
      '--runtime-timeout-ms', '1', '--command-timeout-ms', '1', '--build-timeout-ms', '1', '--vcpus', '1']))
      .toThrow('Exactly one');
  });
  it('constructs a no-effects dry run with frozen source, reference, region, resources and learning-v2 collector', async () => {
    const p = planCircleVercelRuntimeBuild(await input());
    expect(p).toMatchObject({ status: 'DRY_RUN_NO_EFFECTS', provider: { image: 'vercel/sandbox/node:24', region: 'iad1', persistent: false,
      timeoutMs: 600000, vcpus: 2, snapshotExpirationMs: 86400000 },
    project: { revision: 1, referenceScore: '5.29109518547430697', referenceInputPath: CIRCLE_REFERENCE_INPUT_PATH },
    packages: { codex: { specifier: '@openai/codex@0.153.4', npmIntegrity: 'sha512-wbHDmit7S/YvBGVX1DQmk13xtWblZ2cApeJ/pB7xDZ10Cna+DZc5ij7f0F4OxdsXN4FW1oLT48OpogUI1+8Y2w==' },
      linuxX64: { specifier: '@openai/codex@0.153.4-linux-x64', npmIntegrity: 'sha512-x1EcwBlY3AObM1VTUHNM2AzAJQsyreGdagpF+qFiYi/Oa30VBktvvG0C6tLtCzqW6hjZNWkGZQWmeVk7MuJKWg==' } },
    collectorDigest: 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415' });
    expect(p.sourceManifest.map(item => item.path)).toContain('generated/runtime-probe.mjs');
  });

  it('builds an explicitly unreviewed Astra config without inventing a profile digest or authority', async () => {
    const value = await input(); delete value.gatewayProfile;
    value.unreviewedBuildConfig = { format: 'motive.circle-vercel-runtime-unreviewed-config/0.1', model: 'openai/gpt-6-astra',
      contextWindowTokens: 128000, maxOutputTokens: 8192, reasoningEffort: 'high' };
    const p = planCircleVercelRuntimeBuild(value);
    expect(p.gateway).toEqual({ url: value.gatewayUrl, inferenceProfileDigest: null, bindingStatus: 'PENDING_PROFILE', model: 'openai/gpt-6-astra' });
  });

  it('plans and builds the explicit provider-untrusted circle boundary without native or egress claims', async()=>{
    const value=await input();value.boundary='provider-untrusted-circle-data';delete value.artifactEgressUrl;
    const plan=planCircleVercelRuntimeBuild(value);
    expect(plan).toMatchObject({status:'DRY_RUN_NO_EFFECTS',boundary:'provider-untrusted-circle-data'});
    expect(plan.sourceManifest.map(item=>item.path)).not.toContain('packages/runner-native/native/worker-launcher.c');
    const fake=provider({probeText:providerProbe});
    const result=await executeCircleVercelRuntimeBuild(value,fake.value,()=>new Date('2026-09-07T00:00:00.000Z'));
    const setup=String(fake.writes[0]!.find(file=>file.path.endsWith('setup.sh'))!.content);
    expect(setup).toContain('export CODEX_HOME=/vercel/sandbox/workspace/.codex');
    expect(setup).toContain('worker_uid="$(stat -c %u /vercel/sandbox/workspace)"');
    expect(setup).not.toContain('worker-launcher');expect(setup).not.toContain('gcc ');expect(setup).not.toContain('LANDLOCK');
    expect(fake.commands[1]).toMatchObject({cmd:'/usr/bin/env',sudo:false,args:expect.arrayContaining(['node','-e'])});
    expect(fake.commands[1]!.args.join(' ')).toContain('.motive-owner-probe');
    expect(fake.commands[1]!.args.join(' ')).toContain('s.uid!==process.getuid()');
    expect(fake.commands[2]).toMatchObject({cmd:'/bin/bash',sudo:true});
    expect(fake.commands[3]).toMatchObject({cmd:'/usr/bin/env',sudo:false});
    const generated=String(fake.writes[0]!.find(file=>file.path.endsWith('runtime-probe.mjs'))!.content);
    const syntax=spawnSync(process.execPath,['--input-type=module','--check','-'],{input:generated,encoding:'utf8'});
    expect(syntax.stderr).toBe(''); expect(syntax.status).toBe(0);
    expect(generated).toContain('PROBE_STATE_NOT_PRISTINE');
    expect(result.probe).toMatchObject({format:'motive.circle-provider-untrusted-runtime-probe/0.1',
      boundary:{filesystemClaim:'none',outputTrust:'untrusted'},startingFilesMutableByWorker:true,
      codex:{strictConfigParsed:true,catalogContainsExactAstra:true}});
    expect(result.candidateDeployment.runtime.sandbox).toMatchObject({providerUntrustedDataRuntime:{
      format:'motive.circle-provider-untrusted-runtime/0.1',filesystemClaim:'none',outputTrust:'untrusted'},
      egress:{gateway:[{methods:['POST'],pathMatch:'exact'}],artifacts:[],gatewayProxy:{
        format:'motive.vercel-gateway-proxy/0.1',url:'https://motive.example/api/sandbox-egress'}},
      allowedExecutables:['/usr/local/bin/codex']});
    expect(result.candidateDeployment.runtime.sandbox).not.toHaveProperty('protectedRuntime');
    expect(result.requiredBeforePromotion).toContain('VERIFY_BACKGROUND_WRITER_CAPTURE_AND_WHOLE_VM_STOP');
    expect(result.requiredBeforePromotion).not.toContain('VERIFY_PROVIDER_PROCESS_QUIESCENCE_BEFORE_CONTROLLER_READ');
  });

  it('reprofiles only a byte-identical provider candidate and preserves its snapshot measurements', async()=>{
    const value=await input();value.boundary='provider-untrusted-circle-data';delete value.artifactEgressUrl;
    const plan=planCircleVercelRuntimeBuild(value);const built=await executeCircleVercelRuntimeBuild(value,provider({probeText:providerProbe}).value,()=>new Date('2026-09-07T00:00:00.000Z'));
    const original=structuredClone(built);const current=original.candidateDeployment.runtime.sandbox;
    delete current.egress.gatewayProxy;const {profileDigest:_discarded,...withoutDigest}=current;
    current.profileDigest=digestCanonicalJson(withoutDigest);
    const sourceDigest=`sha256:${'a'.repeat(64)}` as const;
    const reprofiled=reprofileProviderUntrustedCandidate(original,plan,sourceDigest);
    expect(reprofiled.provider).toEqual(original.provider);expect(reprofiled.probe).toEqual(original.probe);
    expect(reprofiled.materialDigest).toBe(original.materialDigest);
    expect(reprofiled.reprofiledFrom).toEqual({candidateArtifactDigest:sourceDigest,profileDigest:current.profileDigest,
      reason:'ADD_ENFORCING_GATEWAY_PROXY',snapshotReusedWithoutMutation:true});
    expect(reprofiled.candidateDeployment.runtime.sandbox.egress.gatewayProxy).toEqual({
      format:'motive.vercel-gateway-proxy/0.1',url:'https://motive.example/api/sandbox-egress'});
    expect(reprofiled.candidateDeployment.runtime.sandbox.profileDigest).not.toBe(current.profileDigest);
    expect(()=>reprofileProviderUntrustedCandidate(original,{...plan,buildRecipeDigest:`sha256:${'b'.repeat(64)}`},sourceDigest))
      .toThrow('RUNTIME_REPROFILE_SOURCE_MISMATCH');
  });

  it('fails and cleans up before privileged setup when the unprivileged workspace owner check fails',async()=>{
    const value=await input();value.boundary='provider-untrusted-circle-data';delete value.artifactEgressUrl;
    const fake=provider({failRunAt:1,probeText:providerProbe});
    await expect(executeCircleVercelRuntimeBuild(value,fake.value)).rejects.toThrow('RUNTIME_BUILD_STEP_FAILED:WORKSPACE_USER_PREFLIGHT');
    expect(fake.commands).toHaveLength(2);expect(fake.commands.some(command=>command.cmd==='/bin/bash')).toBe(false);
    expect(fake.sandbox.stop).toHaveBeenCalledOnce();expect(fake.sandbox.snapshot).not.toHaveBeenCalled();
  });

  it('stages only in tmp, uses the actual launcher through bounded Node pipes, scrubs probe state, and emits an unreviewed non-runnable candidate', async () => {
    const fake = provider(); const result = await executeCircleVercelRuntimeBuild(await input(), fake.value, () => new Date('2026-09-07T00:00:00.000Z'));
    expect(fake.value.create).toHaveBeenCalledWith(expect.objectContaining({ image: 'vercel/sandbox/node:24', region: 'iad1', persistent: false }), expect.any(AbortSignal));
    expect(fake.writes[0]!.every(file => file.path.startsWith('/tmp/'))).toBe(true);
    const setup = String(fake.writes[0]!.find(file => file.path.endsWith('setup.sh'))!.content);
    expect(setup).toContain(`install -o root -g root -m 0444 /tmp/reference-witness.json ${CIRCLE_REFERENCE_INPUT_PATH}`);
    expect(setup).toContain('chown root:root /vercel /vercel/sandbox');
    expect(setup).toContain('apt-get install -y --no-install-recommends gcc libc6-dev');
    expect(setup).not.toContain('dnf install');
    expect(setup).toContain('LANDLOCK_ACCESS_FS_TRUNCATE');
    expect(setup).toContain('openai-codex-0.153.4-linux-x64.tgz');
    const launcherProbe = String(fake.writes[0]!.find(file => file.path.endsWith('runtime-probe.mjs'))!.content);
    expect(launcherProbe).toContain("stdio:['ignore','pipe','pipe']");
    expect(launcherProbe).toContain("maxBuffer:4096");
    expect(launcherProbe).toContain("launcher_status=");
    expect(launcherProbe).toContain("/opt/motive/bin/worker-launcher");
    expect(launcherProbe).toContain("rmSync('/var/lib/motive/control/worker-bootstrap.json'");
    expect(fake.commands[0]).toMatchObject({ cmd: '/usr/bin/env', args: expect.arrayContaining(['node']), sudo: false });
    expect(fake.commands.at(-1)).toMatchObject({ cmd: '/bin/rm', args: expect.arrayContaining(['/tmp/motive-circle-runtime-probe.mjs']) });
    expect(result).toMatchObject({ format: CIRCLE_RUNTIME_CANDIDATE_FORMAT, status: 'UNREVIEWED_CANDIDATE',
      probe: { launcher: { runtimeCheck: 'MOTIVE_RUNTIME_CHECK_OK', output: 'codex-cli 0.153.4' },
        platform: { architecture: 'x86_64', numpyAvailable: false, scipyAvailable: false, landlockAbiMinimumVerified: 3 }, pristine: true },
      candidateDeployment: { format: CIRCLE_DEPLOYMENT_CANDIDATE_FORMAT, warning: 'NOT_ACCEPTED_RUNTIME_CONFIGURATION',
        runtime: { deploymentBindings: { infrastructureAuthorizationId: null, maximumCostUsd: null, status: 'PENDING_AUTHORITY' } } } });
    expect(result.candidateDeployment.format).not.toBe('motive.circle-project-run-deployment/0.1');
    expect(result.candidateDeployment.runtime.sandbox.trustedSource).toHaveProperty('sourceSnapshotDigest', result.plan.sourceSnapshotDigest);
    expect(result.candidateDeployment.runtime.sandbox.trustedSource).not.toHaveProperty('sourceCommit');
    expect(fake.sandbox.snapshot).toHaveBeenCalledOnce(); expect(fake.sandbox.stop).not.toHaveBeenCalled();
  });

  it('stops a sandbox after a failed build step and exposes a failed cleanup as unresolved', async () => {
    const first = provider({ failRun: true }); await expect(executeCircleVercelRuntimeBuild(await input(), first.value)).rejects.toThrow('RUNTIME_BUILD_STEP_FAILED');
    expect(first.sandbox.stop).toHaveBeenCalledOnce();
    const second = provider({ failRun: true, stopFails: true });
    await expect(executeCircleVercelRuntimeBuild(await input(), second.value)).rejects.toThrow('RUNTIME_BUILD_CLEANUP_UNRESOLVED');
  });

  it('deletes a created snapshot if durable candidate persistence fails', async () => {
    const fake = provider();
    await expect(executeCircleVercelRuntimeBuild(await input(), fake.value, () => new Date('2026-09-07T00:00:00.000Z'),
      async () => { throw new Error('output failed'); })).rejects.toThrow('output failed');
    const snapshot = await vi.mocked(fake.sandbox.snapshot).mock.results[0]!.value;
    expect(snapshot.delete).toHaveBeenCalledOnce();
    expect(fake.sandbox.stop).not.toHaveBeenCalled();
  });

  it('rejects drifted source and incomplete authority pairs before a provider effect', async () => {
    const source = await input(); const fake = provider();
    source.sourceFiles = { ...source.sourceFiles, referenceWitness: new TextEncoder().encode('{}') };
    await expect(executeCircleVercelRuntimeBuild(source, fake.value)).rejects.toThrow('reference witness digest');
    expect(fake.value.create).not.toHaveBeenCalled();
    const authority = await input(); authority.infrastructureAuthorizationId = '11111111-1111-4111-8111-111111111111';
    expect(() => planCircleVercelRuntimeBuild(authority)).toThrow('both be supplied or both remain pending');
  });

  it('accepts the documented digest-resolved managed node repository with its tag dropped', async () => {
    const fake = provider(); Object.defineProperty(fake.sandbox, 'image', { value: `vercel/sandbox/node@sha256:${'d'.repeat(64)}` });
    await expect(executeCircleVercelRuntimeBuild(await input(), fake.value, () => new Date('2026-09-07T00:00:00.000Z')))
      .resolves.toMatchObject({ provider: { image: `vercel/sandbox/node@sha256:${'d'.repeat(64)}` } });
  });

  it('accepts the VCR-qualified exact managed node repository and rejects a different repository', async () => {
    const qualified = provider(); Object.defineProperty(qualified.sandbox, 'image', { value: `vcr.vercel.com/vercel/sandbox/node:24@sha256:${'e'.repeat(64)}` });
    await expect(executeCircleVercelRuntimeBuild(await input(), qualified.value, () => new Date('2026-09-07T00:00:00.000Z'))).resolves.toBeDefined();
    const wrong = provider(); Object.defineProperty(wrong.sandbox, 'image', { value: `vcr.vercel.com/other/node:24@sha256:${'e'.repeat(64)}` });
    await expect(executeCircleVercelRuntimeBuild(await input(), wrong.value)).rejects.toThrow('RUNTIME_IMAGE_IDENTITY_INVALID');
    expect(wrong.sandbox.stop).toHaveBeenCalledOnce();
  });
});
