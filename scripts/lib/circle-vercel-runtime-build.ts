import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Writable } from 'node:stream';
import { Sandbox } from '@vercel/sandbox';
import { canonicalJson, digestCanonicalJson, type DecimalAmount, type Digest } from '../../packages/domain/src/contracts.ts';
import { profileDigest, validateAndFreezeProfile, type GatewayProfile } from '../../packages/inference-gateway/src/profile.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { defineProviderUntrustedDataRuntime, validateProfile, type SandboxExecutionProfile } from '../../packages/sandbox-vercel/src/index.ts';
import { createSingleAttemptFetch, type NativeVercelCredentials } from '../../packages/sandbox-vercel/src/vercel-sdk.ts';
import { CIRCLE_REFERENCE_INPUT_PATH } from '../../server/project-runs/dispatcher.ts';
import { CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST } from '../../server/project-runs/runtime.ts';

export const CIRCLE_RUNTIME_BUILD_FORMAT = 'motive.circle-vercel-runtime-build-plan/0.1' as const;
export { CIRCLE_REFERENCE_INPUT_PATH };
export const CIRCLE_RUNTIME_CANDIDATE_FORMAT = 'motive.circle-vercel-runtime-build-candidate/0.1' as const;
export const CIRCLE_PROVIDER_UNTRUSTED_PROBE_FORMAT = 'motive.circle-provider-untrusted-runtime-probe/0.1' as const;
export const CIRCLE_DEPLOYMENT_CANDIDATE_FORMAT = 'motive.circle-project-run-deployment-candidate/0.1' as const;
export const CIRCLE_RUNTIME_REGION = 'iad1' as const;
export const CIRCLE_RUNTIME_IMAGE = 'vercel/sandbox/node:24' as const;
export const CIRCLE_RUNTIME_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1_000;
export const CIRCLE_CODEX_PACKAGE = '@openai/codex@0.153.4' as const;
export const CIRCLE_CODEX_VERSION = 'codex-cli 0.153.4' as const;
export const CIRCLE_CODEX_NPM_INTEGRITY = 'sha512-wbHDmit7S/YvBGVX1DQmk13xtWblZ2cApeJ/pB7xDZ10Cna+DZc5ij7f0F4OxdsXN4FW1oLT48OpogUI1+8Y2w==' as const;
export const CIRCLE_CODEX_LINUX_PACKAGE = '@openai/codex@0.153.4-linux-x64' as const;
export const CIRCLE_CODEX_LINUX_NPM_INTEGRITY = 'sha512-x1EcwBlY3AObM1VTUHNM2AzAJQsyreGdagpF+qFiYi/Oa30VBktvvG0C6tLtCzqW6hjZNWkGZQWmeVk7MuJKWg==' as const;
export const CIRCLE_REFERENCE_SCORE = '5.29109518547430697' as const;
export const CIRCLE_REFERENCE_DIGEST = 'sha256:4ac26276b59f1978b86d100df831863a23df1d7756baba3ad542d3004afb575e' as const;
export const CIRCLE_PROJECT_CONTENT_DIGEST = 'sha256:c1fceddadef50b71b873f04bf666e2f91c6ff598dceb5dd3dc081b2e3e710246' as const;
export const CIRCLE_LAUNCHER_DIGEST = 'sha256:04db77e1095ea2c3509094e46e463bc0d532ea499df748e2bfb98526e6d45062' as const;

const CHECK_PATH = '/opt/motive/bin/worker-runtime-check';
const LAUNCHER_PATH = '/opt/motive/bin/worker-launcher';
const CONFIG_PATH = '/opt/motive/codex-config/config.toml';
const CATALOG_PATH = '/opt/motive/codex-config/model-catalog.json';
const PROVIDER_CONFIG_PATH='/vercel/sandbox/workspace/.codex/config.toml';
const PROVIDER_CATALOG_PATH='/vercel/sandbox/workspace/.codex/model-catalog.json';
const SETUP_PATH = '/tmp/motive-circle-runtime-setup.sh';
const PROBE_PATH = '/tmp/motive-circle-runtime-probe.txt';
const PROBE_OUTPUT_PATH = '/tmp/motive-circle-launcher.out';
const BUILD_STAGE_PATH = '/tmp/motive-circle-build-stage';
const MAX_PROBE_BYTES = 32 * 1024;

export type CircleUnreviewedBuildConfig = {
  format: 'motive.circle-vercel-runtime-unreviewed-config/0.1';
  model: 'openai/gpt-6-astra';
  contextWindowTokens: number;
  maxOutputTokens: number;
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
};

export type CircleRuntimeBuildInput = {
  boundary?: 'protected-runtime' | 'provider-untrusted-circle-data';
  projectRevision: number;
  gatewayProfile?: Readonly<GatewayProfile>;
  unreviewedBuildConfig?: CircleUnreviewedBuildConfig;
  gatewayUrl: string;
  artifactEgressUrl?: string;
  infrastructureAuthorizationId?: string;
  maximumCostUsd?: DecimalAmount;
  runtimeTimeoutMs: number;
  commandTimeoutMs: number;
  buildTimeoutMs: number;
  vcpus: number;
  sourceFiles: {
    launcher: Uint8Array;
    runtimeCheck: Uint8Array;
    referenceWitness: Uint8Array;
  };
};

export type CircleRuntimeBuildPlan = {
  format: typeof CIRCLE_RUNTIME_BUILD_FORMAT;
  status: 'DRY_RUN_NO_EFFECTS';
  boundary: 'protected-runtime' | 'provider-untrusted-circle-data';
  provider: { image: typeof CIRCLE_RUNTIME_IMAGE; region: typeof CIRCLE_RUNTIME_REGION; persistent: false; timeoutMs: number; vcpus: number; snapshotExpirationMs: number };
  project: { slug: 'circle-packing'; revision: number; contentDigest: typeof CIRCLE_PROJECT_CONTENT_DIGEST; referenceScore: typeof CIRCLE_REFERENCE_SCORE; referenceInputPath: typeof CIRCLE_REFERENCE_INPUT_PATH; referenceDigest: typeof CIRCLE_REFERENCE_DIGEST };
  gateway: { url: string; inferenceProfileDigest: Digest | null; bindingStatus: 'REVIEWED_PROFILE_SUPPLIED' | 'PENDING_PROFILE'; model: 'openai/gpt-6-astra' };
  packages: { codex: { specifier: typeof CIRCLE_CODEX_PACKAGE; npmIntegrity: typeof CIRCLE_CODEX_NPM_INTEGRITY };
    linuxX64: { specifier: typeof CIRCLE_CODEX_LINUX_PACKAGE; npmIntegrity: typeof CIRCLE_CODEX_LINUX_NPM_INTEGRITY } };
  collectorDigest: typeof CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST;
  sourceManifest: readonly { path: string; digest: Digest; bytes: number }[];
  sourceSnapshotDigest: Digest;
  buildRecipeDigest: Digest;
};

export type CircleRuntimeProbe = {
  format: 'motive.circle-vercel-runtime-probe/0.1';
  launcher: { output: typeof CIRCLE_CODEX_VERSION; runtimeCheck: 'MOTIVE_RUNTIME_CHECK_OK' };
  platform: { architecture: string; kernelRelease: string; osId: string; osVersion: string; packageManager: 'apt' | 'dnf'; buildPackages: readonly string[];
    nodeVersion: string; pythonVersion: string | null; numpyAvailable: boolean; scipyAvailable: boolean; landlockAbiMinimumVerified: 3 };
  files: Record<string, { path: string; digest: Digest; owner: 'root:root'; mode: string }>;
  pristine: true;
};

export type CircleProviderUntrustedRuntimeProbe = {
  format: typeof CIRCLE_PROVIDER_UNTRUSTED_PROBE_FORMAT;
  boundary: { provider: 'vercel'; purpose: 'circle-packing-data'; filesystemClaim: 'none'; outputTrust: 'untrusted' };
  codex: { version: typeof CIRCLE_CODEX_VERSION; strictConfigParsed: true; catalogContainsExactAstra: true };
  platform: { architecture: 'x86_64'; nodeVersion: string; osId: string; osVersion: string };
  files: Record<string,{path:string;digest:Digest}>;
  startingFilesMutableByWorker: true;
};

export type CircleRuntimeBuildCandidate = {
  format: typeof CIRCLE_RUNTIME_CANDIDATE_FORMAT;
  status: 'UNREVIEWED_CANDIDATE';
  createdAt: string;
  plan: CircleRuntimeBuildPlan;
  provider: { image: string; snapshotId: string; sourceSessionId: string; region: string; sizeBytes: number; expiresAt: string };
  probe: CircleRuntimeProbe | CircleProviderUntrustedRuntimeProbe;
  probeDigest: Digest;
  materialDigest: Digest;
  reprofiledFrom?: {
    candidateArtifactDigest: Digest;
    profileDigest: Digest;
    reason: 'ADD_ENFORCING_GATEWAY_PROXY';
    snapshotReusedWithoutMutation: true;
  };
  requiredBeforePromotion: readonly string[];
  candidateDeployment: {
    format: typeof CIRCLE_DEPLOYMENT_CANDIDATE_FORMAT;
    warning: 'NOT_ACCEPTED_RUNTIME_CONFIGURATION';
    runtime: {
      format: 'motive.circle-project-run-runtime/0.1';
      gatewayUrl: string;
      inferenceProfileDigest: Digest | null;
      sandbox: SandboxExecutionProfile;
      deploymentBindings: {
        infrastructureAuthorizationId: string | null;
        maximumCostUsd: DecimalAmount | null;
        status: 'PENDING_AUTHORITY' | 'SUPPLIED_UNREVIEWED';
      };
      capabilityTtlSeconds: 120;
      nativeCollection: {
        collectorRuntimeDigest: typeof CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST;
        approvedPaths: readonly [
          { relativePath: 'candidate.json'; mediaType: 'application/json'; availability: 'REQUIRED'; maximumBytes: 32768 },
          { relativePath: 'investigation.json'; mediaType: 'application/json'; availability: 'OPTIONAL_ON_FAILURE'; maximumBytes: 16384 },
        ];
        maximumFileBytes: 32768;
        maximumTotalBytes: 49152;
      };
    };
  };
};

export type RuntimeBuildCommand = { cmd: string; args: readonly string[]; sudo: boolean; timeoutMs: number };
export type RuntimeBuildCommandResult = { exitCode: number; diagnostic: string };
export type RuntimeBuildSnapshot = { snapshotId: string; sourceSessionId: string; region: string; sizeBytes: number; expiresAt?: Date; delete(signal: AbortSignal): Promise<void> };
export interface RuntimeBuildSandbox {
  readonly image: string | undefined;
  writeFiles(files: { path: string; content: string | Uint8Array; mode?: number }[], signal: AbortSignal): Promise<void>;
  run(command: RuntimeBuildCommand, signal: AbortSignal): Promise<RuntimeBuildCommandResult>;
  read(path: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array>;
  snapshot(expirationMs: number, signal: AbortSignal): Promise<RuntimeBuildSnapshot>;
  stop(signal?: AbortSignal): Promise<void>;
}
export interface RuntimeBuildProvider {
  create(input: { image: typeof CIRCLE_RUNTIME_IMAGE; region: typeof CIRCLE_RUNTIME_REGION; persistent: false; timeoutMs: number; vcpus: number }, signal: AbortSignal): Promise<RuntimeBuildSandbox>;
}

function sha256(bytes: Uint8Array | string): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function positiveInteger(value: number, field: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
}
function publicHttpsEndpoint(value: string, field: string, requiredSuffix?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} must be a public HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !url.hostname.includes('.')
      || url.hostname === 'localhost' || isIP(url.hostname) !== 0 || url.hostname.includes('*') || (requiredSuffix && !url.pathname.endsWith(requiredSuffix))) {
    throw new Error(`${field} must be a public HTTPS URL${requiredSuffix ? ` ending in ${requiredSuffix}` : ''}.`);
  }
  return url;
}
function isResolvedManagedNode24Image(value: string | undefined): value is string {
  return typeof value === 'string' && /^(?:vcr\.vercel\.com\/)?vercel\/sandbox\/node(?::24)?@sha256:[a-f0-9]{64}$/.test(value);
}
function exactUsd(value: string): asserts value is DecimalAmount {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value) || Number(value) <= 0) throw new Error('maximumCostUsd must be a positive decimal string.');
}
function boundary(input: CircleRuntimeBuildInput) { return input.boundary ?? 'protected-runtime'; }
function assertBuildInput(input: CircleRuntimeBuildInput): Digest | null {
  if (!['protected-runtime','provider-untrusted-circle-data'].includes(boundary(input))) throw new Error('Runtime build boundary is invalid.');
  if ((input.gatewayProfile === undefined) === (input.unreviewedBuildConfig === undefined)) {
    throw new Error('Exactly one reviewed gateway profile or explicit unreviewed build config is required.');
  }
  const frozen = input.gatewayProfile ? validateAndFreezeProfile(input.gatewayProfile) : null;
  if (frozen && (frozen.status !== 'reviewed-live' || frozen.evidence.kind !== 'gate-a-reviewed' || frozen.route.model !== 'openai/gpt-6-astra')) throw new Error('The supplied gateway profile is not the exact reviewed-live Astra route.');
  if (frozen) {
    const tools = [...frozen.requestPolicy.allowedLocalTools].map(tool => `${tool.type}:${tool.name}`).sort();
    const exactTools = ['function:exec_command', 'function:request_user_input', 'function:view_image', 'function:write_stdin'];
    if (canonicalJson(tools) !== canonicalJson(exactTools) || !frozen.requestPolicy.allowParallelToolCalls
        || frozen.requestPolicy.codexClientMetadata !== 'drop-pinned-0.153.4') {
      throw new Error('The reviewed profile does not match the pinned Codex 0.153.4 wire contract.');
    }
  }
  const build = input.unreviewedBuildConfig;
  if (build && (canonicalJson(Object.keys(build).sort()) !== canonicalJson(['contextWindowTokens', 'format', 'maxOutputTokens', 'model', 'reasoningEffort'])
      || build.format !== 'motive.circle-vercel-runtime-unreviewed-config/0.1' || build.model !== 'openai/gpt-6-astra'
      || !['minimal', 'low', 'medium', 'high'].includes(build.reasoningEffort))) throw new Error('The unreviewed Astra build config is invalid.');
  if (build) { positiveInteger(build.contextWindowTokens, 'contextWindowTokens', 1, 2_000_000); positiveInteger(build.maxOutputTokens, 'maxOutputTokens', 1, build.contextWindowTokens); }
  const gateway = publicHttpsEndpoint(input.gatewayUrl, 'gatewayUrl', '/responses');
  if (boundary(input)==='protected-runtime') {
    if (!input.artifactEgressUrl) throw new Error('artifactEgressUrl is required for the protected runtime.');
    publicHttpsEndpoint(input.artifactEgressUrl, 'artifactEgressUrl');
  } else if (input.artifactEgressUrl !== undefined) throw new Error('artifactEgressUrl is forbidden for provider-untrusted circle data.');
  if (frozen && gateway.href === frozen.upstream.responsesUrl) throw new Error('gatewayUrl must be the Motive capability gateway, not the provider endpoint.');
  if (input.infrastructureAuthorizationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.infrastructureAuthorizationId)) {
    throw new Error('infrastructureAuthorizationId must be a UUID.');
  }
  if (input.maximumCostUsd !== undefined) exactUsd(input.maximumCostUsd);
  if ((input.infrastructureAuthorizationId === undefined) !== (input.maximumCostUsd === undefined)) {
    throw new Error('Deployment authority ID and maximum cost must either both be supplied or both remain pending.');
  }
  positiveInteger(input.buildTimeoutMs, 'buildTimeoutMs', 60_000, 600_000);
  positiveInteger(input.projectRevision, 'projectRevision', 1, 2_147_483_647);
  positiveInteger(input.runtimeTimeoutMs, 'runtimeTimeoutMs', 60_000, 3_600_000);
  positiveInteger(input.commandTimeoutMs, 'commandTimeoutMs', 60_000, input.runtimeTimeoutMs);
  positiveInteger(input.vcpus, 'vcpus', 1, 4);
  if (boundary(input)==='protected-runtime' && sha256(input.sourceFiles.launcher) !== CIRCLE_LAUNCHER_DIGEST) throw new Error('The worker launcher source digest is not the frozen reviewed source.');
  if (sha256(input.sourceFiles.referenceWitness) !== CIRCLE_REFERENCE_DIGEST) throw new Error('The reference witness digest is not the frozen N=101 input.');
  if (boundary(input)==='protected-runtime' && (input.sourceFiles.runtimeCheck.byteLength === 0 || input.sourceFiles.runtimeCheck.byteLength > 64 * 1024)) throw new Error('The runtime check source is missing or too large.');
  return frozen ? profileDigest(frozen) : null;
}

function modelSettings(input: CircleRuntimeBuildInput) {
  if (input.gatewayProfile) return { allowed: [...input.gatewayProfile.requestPolicy.allowedReasoningEfforts], context: input.gatewayProfile.limits.contextWindowTokens, output: input.gatewayProfile.limits.maxOutputTokens };
  const build = input.unreviewedBuildConfig!; return { allowed: [build.reasoningEffort], context: build.contextWindowTokens, output: build.maxOutputTokens };
}
function modelCatalog(input: CircleRuntimeBuildInput): string {
  const settings = modelSettings(input); const allowed = settings.allowed;
  const reasoning = allowed.includes('low') ? 'low' : allowed[0];
  if (!reasoning) throw new Error('The reviewed gateway profile must allow one Codex reasoning effort.');
  return `${JSON.stringify({ models: [{
    slug: 'openai/gpt-6-astra', display_name: 'OpenAI GPT-6 Astra',
    description: 'Motive reviewed gateway route for the bounded circle-packing run.',
    default_reasoning_level: reasoning,
    supported_reasoning_levels: allowed.map(effort => ({ effort, description: `Reviewed ${effort} reasoning level` })),
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 1,
    availability_nux: null, upgrade: null,
    model_messages: { instructions_template: 'Follow the bounded task and runtime policy.', instructions_variables: null, approvals: null, collaboration_modes: null, auto_review: null, permissions: null, multi_agent: null },
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: true, default_reasoning_summary: 'none', support_verbosity: false,
    default_verbosity: null, apply_patch_tool_type: null, web_search_tool_type: 'text',
    truncation_policy: { mode: 'tokens', limit: Math.min(10_000, settings.output) },
    supports_image_detail_original: false, context_window: settings.context,
    max_context_window: settings.context, effective_context_window_percent: 95,
    experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false,
    use_responses_lite: false, node_repl_auto_review_required: false, node_repl_disabled: true,
  }] }, null, 2)}\n`;
}

function codexConfig(input: CircleRuntimeBuildInput): string {
  const baseUrl = input.gatewayUrl.slice(0, -'/responses'.length);
  const allowed = modelSettings(input).allowed; const reasoning = allowed.includes('low') ? 'low' : allowed[0];
  return [
    'model = "openai/gpt-6-astra"', 'model_provider = "motive"', `model_catalog_json = ${JSON.stringify(boundary(input)==='protected-runtime'?CATALOG_PATH:PROVIDER_CATALOG_PATH)}`,
    `model_reasoning_effort = ${JSON.stringify(reasoning)}`, 'model_reasoning_summary = "none"',
    'sandbox_mode = "read-only"', 'approval_policy = "never"', 'web_search = "disabled"', '', '[features]',
    'multi_agent = false', 'multi_agent_v2 = false', 'apps = false', 'plugins = false', 'memories = false',
    'goals = false', 'hooks = false', 'shell_snapshot = false', '', '[model_providers.motive]',
    'name = "Motive bounded gateway"', `base_url = ${JSON.stringify(baseUrl)}`, 'env_key = "MOTIVE_RUN_CAPABILITY"',
    'wire_api = "responses"', 'request_max_retries = 0', 'stream_max_retries = 0', 'supports_websockets = false', '',
  ].join('\n');
}

function setupScript(expectedTarballSha512: string, expectedLinuxTarballSha512: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
export HOME=/root npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false DEBIAN_FRONTEND=noninteractive
printf 'SETUP_START\n' > ${BUILD_STAGE_PATH}
mkdir -p /tmp/motive-npm /opt/motive/bin /opt/motive/codex-config /opt/motive/inputs /opt/motive/package-evidence /run/motive/channels /var/lib/motive/control /var/lib/motive/worker/tmp /vercel/sandbox/workspace
. /etc/os-release
case "$ID" in
debian|ubuntu)
  package_manager=apt
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends gcc libc6-dev >/dev/null
  { printf 'package_manager=apt\n'; dpkg-query -W -f='\${Package}=\${Version}\n' gcc libc6-dev; } > /opt/motive/package-evidence/build-packages.txt
  ;;
*)
  exit 83
  ;;
esac
printf 'TOOLCHAIN_INSTALLED\n' > ${BUILD_STAGE_PATH}
cat >/tmp/motive-kernel-header-check.c <<'EOF'
#include <linux/landlock.h>
#include <sys/syscall.h>
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#error LANDLOCK_ACCESS_FS_TRUNCATE is required
#endif
#if !defined(SYS_openat2) || !defined(SYS_close_range) || !defined(SYS_landlock_create_ruleset) || !defined(SYS_landlock_add_rule) || !defined(SYS_landlock_restrict_self)
#error required worker isolation syscall definitions are missing
#endif
int main(void) { return 0; }
EOF
gcc -std=c17 -Wall -Wextra -Werror -c -o /tmp/motive-kernel-header-check.o /tmp/motive-kernel-header-check.c
cd /tmp/motive-npm
npm pack ${CIRCLE_CODEX_PACKAGE} --ignore-scripts --pack-destination /tmp/motive-npm >/dev/null
npm pack ${CIRCLE_CODEX_LINUX_PACKAGE} --ignore-scripts --pack-destination /tmp/motive-npm >/dev/null
printf '${expectedTarballSha512}  openai-codex-0.153.4.tgz\n' | sha512sum -c - >/dev/null
printf '${expectedLinuxTarballSha512}  openai-codex-0.153.4-linux-x64.tgz\n' | sha512sum -c - >/dev/null
npm install -g --omit=optional --ignore-scripts --no-audit --no-fund /tmp/motive-npm/openai-codex-0.153.4.tgz >/dev/null
mkdir -p /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64
tar -xzf /tmp/motive-npm/openai-codex-0.153.4-linux-x64.tgz --strip-components=1 -C /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64
test "$(node -p \"require('/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/package.json').version\")" = 0.153.4-linux-x64
printf 'CODEX_INSTALLED\n' > ${BUILD_STAGE_PATH}
gcc -std=c17 -Wall -Wextra -Werror -O2 -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fPIE -static-pie -Wl,-z,relro,-z,now -o ${LAUNCHER_PATH} /tmp/worker-launcher.c
gcc -std=c17 -Wall -Wextra -Werror -O2 -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fPIE -static-pie -Wl,-z,relro,-z,now -o ${CHECK_PATH} /tmp/worker-runtime-check.c
printf 'NATIVE_COMPILED\n' > ${BUILD_STAGE_PATH}
install -o root -g root -m 0444 /tmp/config.toml ${CONFIG_PATH}
install -o root -g root -m 0444 /tmp/model-catalog.json ${CATALOG_PATH}
install -o root -g root -m 0444 /tmp/reference-witness.json ${CIRCLE_REFERENCE_INPUT_PATH}
getent group 2000 >/dev/null || groupadd --gid 2000 motive-worker
getent passwd 2000 >/dev/null || useradd --uid 2000 --gid 2000 --home-dir /var/lib/motive/worker --no-create-home --shell /usr/sbin/nologin motive-worker
ln -sfn ../lib/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
ln -sfn /var/lib/motive/worker/installation_id /opt/motive/codex-config/installation_id
printf 'trusted-controller-channel\n' > /run/motive/channels/controller
chown -R root:root /opt/motive/bin /opt/motive/codex-config /opt/motive/inputs /opt/motive/package-evidence /run/motive /var/lib/motive/control
chown root:root /vercel /vercel/sandbox
chmod go-w /vercel /vercel/sandbox
chown -R 2000:2000 /var/lib/motive/worker /vercel/sandbox/workspace
chmod 0555 /opt/motive/bin /opt/motive/codex-config /opt/motive/inputs /opt/motive/package-evidence /run/motive/channels
chmod 0755 /var/lib/motive/control /vercel/sandbox/workspace
chmod 0700 /var/lib/motive/worker /var/lib/motive/worker/tmp
chmod 0555 ${LAUNCHER_PATH} ${CHECK_PATH}
chmod 0444 ${CONFIG_PATH} ${CATALOG_PATH} ${CIRCLE_REFERENCE_INPUT_PATH} /opt/motive/package-evidence/build-packages.txt /run/motive/channels/controller
printf 'LAYOUT_PROTECTED\n' > ${BUILD_STAGE_PATH}
rm -rf /tmp/motive-npm /root/.npm /tmp/worker-launcher.c /tmp/worker-runtime-check.c /tmp/config.toml /tmp/model-catalog.json /tmp/reference-witness.json /tmp/motive-kernel-header-check.c /tmp/motive-kernel-header-check.o
apt-get purge -y gcc libc6-dev >/dev/null
apt-get autoremove -y >/dev/null
rm -rf /var/lib/apt/lists/*
printf 'SETUP_COMPLETE\n' > ${BUILD_STAGE_PATH}
`;
}

const PROVIDER_WRAPPER_PATH='/usr/local/bin/codex';
function providerSetupScript(expectedTarballSha512:string,expectedLinuxTarballSha512:string):string {
  return `#!/usr/bin/env bash
set -euo pipefail
export HOME=/root npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
printf 'SETUP_START\n' > ${BUILD_STAGE_PATH}
mkdir -p /tmp/motive-npm /opt/motive/inputs /vercel/sandbox/workspace
cd /tmp/motive-npm
npm pack ${CIRCLE_CODEX_PACKAGE} --ignore-scripts --pack-destination /tmp/motive-npm >/dev/null
npm pack ${CIRCLE_CODEX_LINUX_PACKAGE} --ignore-scripts --pack-destination /tmp/motive-npm >/dev/null
printf '${expectedTarballSha512}  openai-codex-0.153.4.tgz\n' | sha512sum -c - >/dev/null
printf '${expectedLinuxTarballSha512}  openai-codex-0.153.4-linux-x64.tgz\n' | sha512sum -c - >/dev/null
npm install -g --omit=optional --ignore-scripts --no-audit --no-fund /tmp/motive-npm/openai-codex-0.153.4.tgz >/dev/null
mkdir -p /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64
tar -xzf /tmp/motive-npm/openai-codex-0.153.4-linux-x64.tgz --strip-components=1 -C /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64
test "$(node -p "require('/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/package.json').version")" = 0.153.4-linux-x64
worker_uid="$(stat -c %u /vercel/sandbox/workspace)"; worker_gid="$(stat -c %g /vercel/sandbox/workspace)"
install -d -o "$worker_uid" -g "$worker_gid" -m 0755 /vercel/sandbox/workspace/.codex
install -o "$worker_uid" -g "$worker_gid" -m 0644 /tmp/config.toml ${PROVIDER_CONFIG_PATH}
install -o "$worker_uid" -g "$worker_gid" -m 0644 /tmp/model-catalog.json ${PROVIDER_CATALOG_PATH}
install -m 0644 /tmp/reference-witness.json ${CIRCLE_REFERENCE_INPUT_PATH}
rm -f ${PROVIDER_WRAPPER_PATH}
cat >${PROVIDER_WRAPPER_PATH} <<'EOF'
#!/usr/bin/env sh
export HOME=/vercel/sandbox/workspace
export CODEX_HOME=/vercel/sandbox/workspace/.codex
exec /usr/bin/env node /usr/local/lib/node_modules/@openai/codex/bin/codex.js "$@"
EOF
chmod 0755 ${PROVIDER_WRAPPER_PATH}
rm -rf /tmp/motive-npm /root/.npm /tmp/config.toml /tmp/model-catalog.json /tmp/reference-witness.json
printf 'SETUP_COMPLETE\n' > ${BUILD_STAGE_PATH}
`;
}

function providerProbeProgram():string {
  return `import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const run=(args)=>spawnSync('${PROVIDER_WRAPPER_PATH}',args,{stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:32768,timeout:30000});
const ok=(result,code)=>{if(result.error||result.status!==0)throw new Error(code);return String(result.stdout||'')+String(result.stderr||'');};
const version=ok(run(['--version']),'CODEX_VERSION_PROBE_FAILED').trim();if(version!=='${CIRCLE_CODEX_VERSION}')throw new Error('CODEX_VERSION_INVALID');
ok(run(['app-server','--strict-config','--stdio']),'CODEX_STRICT_CONFIG_FAILED');
const models=ok(run(['debug','models']),'CODEX_CATALOG_FAILED');if(!models.includes('openai/gpt-6-astra'))throw new Error('CODEX_ASTRA_MISSING');
for(const name of readdirSync('/vercel/sandbox/workspace'))if(name!=='.codex')rmSync(join('/vercel/sandbox/workspace',name),{recursive:true,force:true});
for(const name of readdirSync('/vercel/sandbox/workspace/.codex'))if(name!=='config.toml'&&name!=='model-catalog.json')rmSync(join('/vercel/sandbox/workspace/.codex',name),{recursive:true,force:true});
if(readdirSync('/vercel/sandbox/workspace').join(',')!=='.codex'||readdirSync('/vercel/sandbox/workspace/.codex').sort().join(',')!=='config.toml,model-catalog.json')throw new Error('PROBE_STATE_NOT_PRISTINE');
const root='/usr/local/lib/node_modules/@openai/codex',native=[],platform=[];const walk=p=>{for(const n of readdirSync(p)){const x=join(p,n),s=lstatSync(x);if(s.isDirectory())walk(x);else{if(n==='codex'&&(s.mode&0o111))native.push(x);if(n==='package.json'&&x.includes('codex-linux-x64'))platform.push(x);}}};walk(root);if(native.length!==1||platform.length!==1)throw new Error('CODEX_LAYOUT_INVALID');
const files={WRAPPER:'${PROVIDER_WRAPPER_PATH}',CODEX:native[0],CODEX_PACKAGE:root+'/package.json',CODEX_PLATFORM_PACKAGE:platform[0],CONFIG:'${PROVIDER_CONFIG_PATH}',CATALOG:'${PROVIDER_CATALOG_PATH}',REFERENCE:'${CIRCLE_REFERENCE_INPUT_PATH}'};
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const os=Object.fromEntries(readFileSync('/etc/os-release','utf8').split('\\n').filter(x=>x.includes('=')).map(x=>{const a=x.indexOf('=');return[x.slice(0,a),x.slice(a+1).replace(/^"|"$/g,'')]}));
const facts=['BOUNDARY=provider-untrusted-circle-data','FILESYSTEM_CLAIM=none','OUTPUT_TRUST=untrusted','CODEX_VERSION='+version,'STRICT_CONFIG=yes','ASTRA_CATALOG=yes','ARCH='+process.arch,'NODE='+process.version,'OS_ID='+os.ID,'OS_VERSION='+os.VERSION_ID];
for(const [key,path] of Object.entries(files))facts.push(key+'_PATH='+path,key+'_SHA256='+hash(path));
writeFileSync('${PROBE_PATH}',facts.join('\\n')+'\\n');
`;
}

function sourceManifest(input: CircleRuntimeBuildInput, config: string, catalog: string, setup: string, probe: string) {
  return [
    ...(boundary(input)==='protected-runtime' ? [
    { path: 'packages/runner-native/native/worker-launcher.c', digest: sha256(input.sourceFiles.launcher), bytes: input.sourceFiles.launcher.byteLength },
    { path: 'packages/runner-native/native/worker-runtime-check.c', digest: sha256(input.sourceFiles.runtimeCheck), bytes: input.sourceFiles.runtimeCheck.byteLength },
    ] : []),
    { path: 'public/projects/circle-packing/reference-witness.json', digest: sha256(input.sourceFiles.referenceWitness), bytes: input.sourceFiles.referenceWitness.byteLength },
    { path: 'generated/config.toml', digest: sha256(config), bytes: Buffer.byteLength(config) },
    { path: 'generated/model-catalog.json', digest: sha256(catalog), bytes: Buffer.byteLength(catalog) },
    { path: 'generated/setup.sh', digest: sha256(setup), bytes: Buffer.byteLength(setup) },
    { path: 'generated/runtime-probe.mjs', digest: sha256(probe), bytes: Buffer.byteLength(probe) },
  ] as const;
}

export function planCircleVercelRuntimeBuild(input: CircleRuntimeBuildInput): CircleRuntimeBuildPlan {
  const inferenceProfileDigest = assertBuildInput(input);
  const config = codexConfig(input); const catalog = modelCatalog(input);
  const sriBytes = Buffer.from(CIRCLE_CODEX_NPM_INTEGRITY.slice('sha512-'.length), 'base64');
  const linuxSriBytes = Buffer.from(CIRCLE_CODEX_LINUX_NPM_INTEGRITY.slice('sha512-'.length), 'base64');
  const protectedMode=boundary(input)==='protected-runtime';
  const setup = protectedMode ? setupScript(sriBytes.toString('hex'), linuxSriBytes.toString('hex'))
    : providerSetupScript(sriBytes.toString('hex'),linuxSriBytes.toString('hex'));
  const probe=protectedMode?probeProgram():providerProbeProgram();
  const manifest = sourceManifest(input, config, catalog, setup, probe);
  const recipe = { providerImage: CIRCLE_RUNTIME_IMAGE, region: CIRCLE_RUNTIME_REGION, persistent: false, buildTimeoutMs: input.buildTimeoutMs,
    vcpus: input.vcpus, snapshotExpirationMs: CIRCLE_RUNTIME_SNAPSHOT_TTL_MS, codexPackage: CIRCLE_CODEX_PACKAGE,
    codexNpmIntegrity: CIRCLE_CODEX_NPM_INTEGRITY, codexLinuxPackage: CIRCLE_CODEX_LINUX_PACKAGE,
    codexLinuxNpmIntegrity: CIRCLE_CODEX_LINUX_NPM_INTEGRITY,
    compiler: protectedMode?'gcc static-pie then removed':'none', boundary:boundary(input), sourceManifest: manifest };
  return {
    format: CIRCLE_RUNTIME_BUILD_FORMAT, status: 'DRY_RUN_NO_EFFECTS', boundary:boundary(input),
    provider: { image: CIRCLE_RUNTIME_IMAGE, region: CIRCLE_RUNTIME_REGION, persistent: false, timeoutMs: input.buildTimeoutMs, vcpus: input.vcpus, snapshotExpirationMs: CIRCLE_RUNTIME_SNAPSHOT_TTL_MS },
    project: { slug: 'circle-packing', revision: input.projectRevision, contentDigest: CIRCLE_PROJECT_CONTENT_DIGEST,
      referenceScore: CIRCLE_REFERENCE_SCORE, referenceInputPath: CIRCLE_REFERENCE_INPUT_PATH, referenceDigest: CIRCLE_REFERENCE_DIGEST },
    gateway: { url: input.gatewayUrl, inferenceProfileDigest, bindingStatus: inferenceProfileDigest ? 'REVIEWED_PROFILE_SUPPLIED' : 'PENDING_PROFILE', model: 'openai/gpt-6-astra' },
    packages: { codex: { specifier: CIRCLE_CODEX_PACKAGE, npmIntegrity: CIRCLE_CODEX_NPM_INTEGRITY },
      linuxX64: { specifier: CIRCLE_CODEX_LINUX_PACKAGE, npmIntegrity: CIRCLE_CODEX_LINUX_NPM_INTEGRITY } },
    collectorDigest: CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST, sourceManifest: manifest,
    sourceSnapshotDigest: digestCanonicalJson(manifest), buildRecipeDigest: digestCanonicalJson(recipe),
  };
}

function providerGatewayProxyUrl(gatewayUrl: string): string {
  return new URL('/api/sandbox-egress', gatewayUrl).href;
}

/** Rebinds only the provider network profile around an already measured snapshot. */
export function reprofileProviderUntrustedCandidate(
  candidate: CircleRuntimeBuildCandidate,
  latestPlan: CircleRuntimeBuildPlan,
  candidateArtifactDigest: Digest,
): CircleRuntimeBuildCandidate {
  if (!/^sha256:[a-f0-9]{64}$/.test(candidateArtifactDigest)
      || candidate.plan.boundary !== 'provider-untrusted-circle-data'
      || candidate.probe.format !== CIRCLE_PROVIDER_UNTRUSTED_PROBE_FORMAT
      || canonicalJson(candidate.plan) !== canonicalJson(latestPlan)) {
    throw new Error('RUNTIME_REPROFILE_SOURCE_MISMATCH');
  }
  const original = candidate.candidateDeployment.runtime.sandbox;
  if (original.providerUntrustedDataRuntime === undefined || original.protectedRuntime !== undefined
      || original.egress.gatewayProxy !== undefined) throw new Error('RUNTIME_REPROFILE_BOUNDARY_INVALID');
  const { profileDigest: originalProfileDigest, ...originalWithoutDigest } = original;
  if (digestCanonicalJson(originalWithoutDigest) !== originalProfileDigest) throw new Error('RUNTIME_REPROFILE_PROFILE_DIGEST_INVALID');
  const withoutDigest = { ...originalWithoutDigest, egress: { ...original.egress,
    gatewayProxy: { format: 'motive.vercel-gateway-proxy/0.1' as const,
      url: providerGatewayProxyUrl(candidate.candidateDeployment.runtime.gatewayUrl) } } };
  const sandbox: SandboxExecutionProfile = { ...withoutDigest, profileDigest: digestCanonicalJson(withoutDigest) };
  validateProfile(sandbox);
  return { ...candidate, reprofiledFrom: { candidateArtifactDigest, profileDigest: originalProfileDigest,
    reason: 'ADD_ENFORCING_GATEWAY_PROXY', snapshotReusedWithoutMutation: true },
    candidateDeployment: { ...candidate.candidateDeployment, runtime: { ...candidate.candidateDeployment.runtime, sandbox } } };
}

function parseProbe(text: string): CircleRuntimeProbe {
  const values = new Map(text.trim().split('\n').map(line => { const at = line.indexOf('='); return at > 0 ? [line.slice(0, at), line.slice(at + 1)] : ['', '']; }));
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error('RUNTIME_PROBE_INVALID'); return value; };
  const file = (prefix: string) => {
    const digest = required(`${prefix}_SHA256`); const owner = required(`${prefix}_OWNER`); const mode = required(`${prefix}_MODE`);
    if (!/^[a-f0-9]{64}$/.test(digest) || owner !== 'root:root' || !/^0?[0-7]{3,4}$/.test(mode)) throw new Error('RUNTIME_PROBE_INVALID');
    const path = required(`${prefix}_PATH`); if (!path.startsWith('/')) throw new Error('RUNTIME_PROBE_INVALID');
    return { path, digest: `sha256:${digest}` as Digest, owner: 'root:root' as const, mode };
  };
  if (required('LAUNCHER_CHECK') !== 'MOTIVE_RUNTIME_CHECK_OK' || required('CODEX_VERSION') !== CIRCLE_CODEX_VERSION
      || required('ARCH') !== 'x86_64' || required('PRISTINE') !== 'yes') throw new Error('RUNTIME_PROBE_INVALID');
  const buildPackages = required('BUILD_PACKAGES').split(',');
  if (buildPackages.length !== 2 || buildPackages.some(value => !/^[A-Za-z0-9+_.:-]+=[A-Za-z0-9+_.:~\-]+$/.test(value))) throw new Error('RUNTIME_PROBE_INVALID');
  const packageManager = required('PACKAGE_MANAGER'); if (packageManager !== 'apt' && packageManager !== 'dnf') throw new Error('RUNTIME_PROBE_INVALID');
  const nodeVersion = required('NODE'); if (!/^v24\.\d+\.\d+$/.test(nodeVersion)) throw new Error('RUNTIME_PROBE_INVALID');
  return { format: 'motive.circle-vercel-runtime-probe/0.1', launcher: { output: CIRCLE_CODEX_VERSION, runtimeCheck: 'MOTIVE_RUNTIME_CHECK_OK' },
    platform: { architecture: required('ARCH'), kernelRelease: required('KERNEL'), osId: required('OS_ID'), osVersion: required('OS_VERSION'), packageManager, buildPackages,
      nodeVersion,
      pythonVersion: values.get('PYTHON') || null, numpyAvailable: values.get('NUMPY') === 'yes', scipyAvailable: values.get('SCIPY') === 'yes', landlockAbiMinimumVerified: 3 },
    files: { launcher: file('LAUNCHER'), runtimeCheck: file('RUNTIME_CHECK'), codex: file('CODEX'), config: file('CONFIG'),
      catalog: file('CATALOG'), referenceWitness: file('REFERENCE'), controllerChannel: file('CHANNEL') }, pristine: true };
}

function parseProviderProbe(text:string):CircleProviderUntrustedRuntimeProbe {
  const values=new Map(text.trim().split('\n').map(line=>{const at=line.indexOf('=');return at>0?[line.slice(0,at),line.slice(at+1)]:['',''];}));
  const required=(key:string)=>{const value=values.get(key);if(!value)throw new Error('RUNTIME_PROBE_INVALID');return value;};
  if(required('BOUNDARY')!=='provider-untrusted-circle-data'||required('FILESYSTEM_CLAIM')!=='none'||required('OUTPUT_TRUST')!=='untrusted'
    ||required('CODEX_VERSION')!==CIRCLE_CODEX_VERSION||required('STRICT_CONFIG')!=='yes'||required('ASTRA_CATALOG')!=='yes'
    ||required('ARCH')!=='x64'||!/^v24\.\d+\.\d+$/.test(required('NODE')))throw new Error('RUNTIME_PROBE_INVALID');
  const file=(prefix:string)=>{const value=required(`${prefix}_SHA256`),path=required(`${prefix}_PATH`);
    if(!/^[a-f0-9]{64}$/.test(value)||!path.startsWith('/'))throw new Error('RUNTIME_PROBE_INVALID');return{path,digest:`sha256:${value}` as Digest};};
  return{format:CIRCLE_PROVIDER_UNTRUSTED_PROBE_FORMAT,boundary:{provider:'vercel',purpose:'circle-packing-data',filesystemClaim:'none',outputTrust:'untrusted'},
    codex:{version:CIRCLE_CODEX_VERSION,strictConfigParsed:true,catalogContainsExactAstra:true},platform:{architecture:'x86_64',nodeVersion:required('NODE'),osId:required('OS_ID'),osVersion:required('OS_VERSION')},
    files:{wrapper:file('WRAPPER'),codex:file('CODEX'),codexPackage:file('CODEX_PACKAGE'),codexPlatformPackage:file('CODEX_PLATFORM_PACKAGE'),config:file('CONFIG'),catalog:file('CATALOG'),referenceWitness:file('REFERENCE')},startingFilesMutableByWorker:true};
}

function probeProgram(): string {
  return `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const run=(file,args,env={})=>spawnSync(file,args,{env:{PATH:'/usr/local/bin:/usr/bin:/bin',...env},stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:4096,timeout:30000});
const expect=(result,out)=>{if(result.error||result.status!==0||result.stdout.trim()!==out){const identity=result.error&&typeof result.error.code==='string'&&/^[A-Z0-9_]+$/.test(result.error.code)?result.error.code:'NONE';process.stderr.write('launcher_status='+(result.status??'null')+' error='+identity+'\\n'+String(result.stderr||'').slice(-4096));throw new Error('RUNTIME_LAUNCHER_PROBE_FAILED');}};
writeFileSync('${BUILD_STAGE_PATH}','LAUNCHER_RUNTIME_CHECK\\n');
expect(run('${LAUNCHER_PATH}',['--cwd-relative','.','--','${CHECK_PATH}'],{MOTIVE_RUN_CAPABILITY:'synthetic-nonfunctional-build-probe-00000001'}),'MOTIVE_RUNTIME_CHECK_OK');
rmSync('/var/lib/motive/control/worker-bootstrap.json',{force:true});
writeFileSync('${BUILD_STAGE_PATH}','LAUNCHER_CODEX_CHECK\\n');
expect(run('${LAUNCHER_PATH}',['--cwd-relative','.','--','/usr/local/bin/codex','--version'],{MOTIVE_RUN_CAPABILITY:'synthetic-nonfunctional-build-probe-00000002'}),'${CIRCLE_CODEX_VERSION}');
for(const path of ['/var/lib/motive/control/worker-bootstrap.json','/var/lib/motive/worker/installation_id','/var/lib/motive/worker/history.jsonl'])rmSync(path,{force:true});
for(const path of ['/var/lib/motive/worker/sessions','/var/lib/motive/worker/log'])rmSync(path,{recursive:true,force:true});
for(const path of ['/vercel/sandbox/workspace/candidate.json','/vercel/sandbox/workspace/investigation.json'])rmSync(path,{force:true});
const workerEntries=readdirSync('/var/lib/motive/worker').filter(name=>name!=='tmp');
if(readdirSync('/vercel/sandbox/workspace').length!==0||readdirSync('/var/lib/motive/control').length!==0||workerEntries.length!==0
  ||readdirSync('/var/lib/motive/worker/tmp').length!==0||existsSync('/var/lib/motive/control/worker-bootstrap.json')||existsSync('/var/lib/motive/worker/installation_id'))throw new Error('RUNTIME_NOT_PRISTINE');
writeFileSync('${BUILD_STAGE_PATH}','MATERIAL_PROBE\\n');
const native=[],platformPackages=[]; const codexRoot='/usr/local/lib/node_modules/@openai/codex'; const walk=path=>{for(const name of readdirSync(path)){const next=join(path,name);const s=lstatSync(next);if(s.isDirectory())walk(next);else {if(name==='codex'&&(s.mode&0o111)!==0)native.push(next);if(name==='package.json'&&next.includes('codex-linux-x64'))platformPackages.push(next);}}}; walk(codexRoot);
if(native.length!==1||platformPackages.length!==1)throw new Error('CODEX_NATIVE_BINARY_AMBIGUOUS');
const fixed={LAUNCHER:'${LAUNCHER_PATH}',RUNTIME_CHECK:'${CHECK_PATH}',CODEX:native[0],CODEX_PACKAGE:codexRoot+'/package.json',CODEX_PLATFORM_PACKAGE:platformPackages[0],CONFIG:'${CONFIG_PATH}',CATALOG:'${CATALOG_PATH}',REFERENCE:'${CIRCLE_REFERENCE_INPUT_PATH}',BUILD_PACKAGES:'/opt/motive/package-evidence/build-packages.txt',OS_RELEASE:'/etc/os-release',CHANNEL:'/run/motive/channels/controller'};
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex'); const facts=[];
const simple=(cmd,args=[])=>{const r=run(cmd,args);if(r.error||r.status!==0)throw new Error('RUNTIME_PLATFORM_PROBE_FAILED');return r.stdout.trim()||r.stderr.trim();};
let python='',numpy='no',scipy='no'; const py=run('/usr/bin/env',['python3','--version']); if(!py.error&&py.status===0){python=(py.stdout||py.stderr).trim();numpy=run('/usr/bin/env',['python3','-c','import numpy']).status===0?'yes':'no';scipy=run('/usr/bin/env',['python3','-c','import scipy']).status===0?'yes':'no';}
const os=Object.fromEntries(readFileSync('/etc/os-release','utf8').split('\\n').filter(line=>line.includes('=')).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1).replace(/^"|"$/g,'')];}));
const packageLines=readFileSync('/opt/motive/package-evidence/build-packages.txt','utf8').trim().split('\\n');const packageManager=packageLines.shift();
facts.push('LAUNCHER_CHECK=MOTIVE_RUNTIME_CHECK_OK','CODEX_VERSION=${CIRCLE_CODEX_VERSION}','ARCH='+simple('/usr/bin/uname',['-m']),'KERNEL='+simple('/usr/bin/uname',['-r']),'OS_ID='+os.ID,'OS_VERSION='+os.VERSION_ID,'PACKAGE_MANAGER='+packageManager.split('=')[1],'BUILD_PACKAGES='+packageLines.join(','),'NODE='+simple('/usr/bin/env',['node','--version']),'PYTHON='+python,'NUMPY='+numpy,'SCIPY='+scipy,'PRISTINE=yes');
for(const [key,path] of Object.entries(fixed)){const s=statSync(path);if(s.uid!==0||s.gid!==0)throw new Error('RUNTIME_FILE_OWNER_INVALID');facts.push(key+'_PATH='+path,key+'_SHA256='+hash(path),key+'_OWNER=root:root',key+'_MODE='+(s.mode&0o7777).toString(8));}
writeFileSync('${PROBE_PATH}',facts.join('\\n')+'\\n',{mode:0o444});
writeFileSync('${BUILD_STAGE_PATH}','PROBE_COMPLETE\\n');
`;
}

async function failedStage(sandbox: RuntimeBuildSandbox, signal: AbortSignal, fallback: string, diagnostic: string): Promise<never> {
  let stage = fallback;
  try {
    const value = new TextDecoder().decode(await sandbox.read(BUILD_STAGE_PATH, 128, signal)).trim();
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) stage = value;
  } catch { /* the fixed fallback still identifies the failed phase */ }
  const safe = diagnostic.replace(/synthetic-nonfunctional-build-probe-[A-Za-z0-9_-]+/g, '[REDACTED_CAPABILITY]')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').slice(-8 * 1024).trim();
  throw new Error(`RUNTIME_BUILD_STEP_FAILED:${stage}${safe ? `\n${safe}` : ''}`);
}

export async function executeCircleVercelRuntimeBuild(input: CircleRuntimeBuildInput, provider: RuntimeBuildProvider, now = () => new Date(),
  persistCandidate?: (candidate: CircleRuntimeBuildCandidate) => Promise<void>): Promise<CircleRuntimeBuildCandidate> {
  const plan = planCircleVercelRuntimeBuild(input); const abort = AbortSignal.timeout(input.buildTimeoutMs);
  let sandbox: RuntimeBuildSandbox | null = null; let providerTerminal = false; let snapshotHandle: RuntimeBuildSnapshot | null = null;
  try {
    sandbox = await provider.create(plan.provider, abort);
    if (!isResolvedManagedNode24Image(sandbox.image)) throw new Error('RUNTIME_IMAGE_IDENTITY_INVALID');
    const config = codexConfig(input); const catalog = modelCatalog(input);
    const expectedHex = Buffer.from(CIRCLE_CODEX_NPM_INTEGRITY.slice(7), 'base64').toString('hex');
    const expectedLinuxHex = Buffer.from(CIRCLE_CODEX_LINUX_NPM_INTEGRITY.slice(7), 'base64').toString('hex');
    const protectedMode=boundary(input)==='protected-runtime';
    const setup=protectedMode?setupScript(expectedHex,expectedLinuxHex):providerSetupScript(expectedHex,expectedLinuxHex);
    const probeSource=protectedMode?probeProgram():providerProbeProgram();
    await sandbox.writeFiles([
      ...(protectedMode?[{ path: '/tmp/worker-launcher.c', content: input.sourceFiles.launcher, mode: 0o444 },
        { path: '/tmp/worker-runtime-check.c', content: input.sourceFiles.runtimeCheck, mode: 0o444 }]:[]),
      { path: '/tmp/config.toml', content: config, mode: 0o444 }, { path: '/tmp/model-catalog.json', content: catalog, mode: 0o444 },
      { path: '/tmp/reference-witness.json', content: input.sourceFiles.referenceWitness, mode: 0o444 },
      { path: SETUP_PATH, content: setup, mode: 0o500 },
      { path: '/tmp/motive-circle-runtime-probe.mjs', content: probeSource, mode: 0o400 },
    ], abort);
    const commands: [string,RuntimeBuildCommand][]=[
      ['ARCH_PREFLIGHT', { cmd: '/usr/bin/env', args: ['node', '-e', "if(process.platform!=='linux'||process.arch!=='x64')process.exit(86)"], sudo: false, timeoutMs: 10_000 }],
    ];
    if(!protectedMode)commands.push(['WORKSPACE_USER_PREFLIGHT',{cmd:'/usr/bin/env',args:['node','-e',
      "const f=require('node:fs'),p='/vercel/sandbox/workspace',q=p+'/.motive-owner-probe';f.mkdirSync(p,{recursive:true});const s=f.statSync(p);if(s.uid!==process.getuid()||s.gid!==process.getgid())process.exit(87);f.accessSync(p,f.constants.W_OK);f.writeFileSync(q,'',{flag:'wx'});f.unlinkSync(q);"],sudo:false,timeoutMs:10_000}]);
    commands.push(
      ['SETUP_START', { cmd: '/bin/bash', args: [SETUP_PATH], sudo: true, timeoutMs: input.buildTimeoutMs }],
      ['PROBE_START', { cmd: '/usr/bin/env', args: ['node', '/tmp/motive-circle-runtime-probe.mjs'], sudo: protectedMode, timeoutMs: Math.min(120_000, input.buildTimeoutMs) }],
    );
    for (const [fallback, command] of commands) {
      const result = await sandbox.run(command, abort);
      if (result.exitCode !== 0) await failedStage(sandbox, abort, fallback, result.diagnostic);
    }
    const probeText=new TextDecoder().decode(await sandbox.read(PROBE_PATH,MAX_PROBE_BYTES,abort));
    const probe = protectedMode?parseProbe(probeText):parseProviderProbe(probeText);
    if ((await sandbox.run({ cmd: '/bin/rm', args: ['-f', PROBE_PATH, BUILD_STAGE_PATH, '/tmp/motive-circle-runtime-probe.mjs', SETUP_PATH], sudo: true, timeoutMs: 10_000 }, abort)).exitCode !== 0) {
      throw new Error('RUNTIME_PROBE_SCRUB_FAILED');
    }
    const snapshot = await sandbox.snapshot(CIRCLE_RUNTIME_SNAPSHOT_TTL_MS, abort); snapshotHandle = snapshot; providerTerminal = true;
    const createdAt = now();
    if (!/^snap_[A-Za-z0-9][A-Za-z0-9_-]{5,255}$/.test(snapshot.snapshotId) || !snapshot.sourceSessionId || snapshot.sourceSessionId.length > 256
        || snapshot.region !== CIRCLE_RUNTIME_REGION || !Number.isSafeInteger(snapshot.sizeBytes) || snapshot.sizeBytes <= 0 || snapshot.sizeBytes > 8 * 1024 ** 3
        || !snapshot.expiresAt || snapshot.expiresAt <= createdAt || snapshot.expiresAt.getTime() > createdAt.getTime() + CIRCLE_RUNTIME_SNAPSHOT_TTL_MS + 5 * 60_000) throw new Error('RUNTIME_SNAPSHOT_INVALID');
    const materialDigest = digestCanonicalJson({ sourceSnapshotDigest: plan.sourceSnapshotDigest, probe });
    const sandboxProfileWithoutDigest = {
      format: 'motive.sandbox-profile/0.1' as const,
      ...(protectedMode?{protectedRuntime:defineProtectedRuntime((probe as CircleRuntimeProbe).files.launcher.digest)}
        :{providerUntrustedDataRuntime:defineProviderUntrustedDataRuntime()}),
      trustedSource: { kind: 'snapshot' as const, snapshotId: snapshot.snapshotId, materialDigest,
        buildRecipeDigest: plan.buildRecipeDigest, sourceSnapshotDigest: plan.sourceSnapshotDigest },
      timeoutMs: input.runtimeTimeoutMs, commandTimeoutMs: input.commandTimeoutMs, vcpus: input.vcpus,
      allowedExecutables: ['/usr/local/bin/codex'],
      egress: { gateway: [{ url: input.gatewayUrl, methods: ['POST'] as const, pathMatch: 'exact' as const }],
        artifacts: protectedMode ? [{ url: input.artifactEgressUrl!, methods: ['GET'] as const, pathMatch: 'prefix' as const }] : [],
        ...(!protectedMode ? { gatewayProxy: { format: 'motive.vercel-gateway-proxy/0.1' as const,
          url: providerGatewayProxyUrl(input.gatewayUrl) } } : {}) },
      artifacts: { maxFiles: 2, maxFileBytes: 32768, maxTotalBytes: 49152 },
    };
    const sandboxProfile: SandboxExecutionProfile = { ...sandboxProfileWithoutDigest, profileDigest: digestCanonicalJson(sandboxProfileWithoutDigest) };
    validateProfile(sandboxProfile);
    const nativeCollection = { collectorRuntimeDigest: CIRCLE_PROVIDER_LEARNING_DATA_COLLECTOR_DIGEST,
      approvedPaths: [
        { relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32768 },
        { relativePath: 'investigation.json', mediaType: 'application/json', availability: 'OPTIONAL_ON_FAILURE', maximumBytes: 16384 },
      ], maximumFileBytes: 32768, maximumTotalBytes: 49152 } as const;
    const candidate: CircleRuntimeBuildCandidate = { format: CIRCLE_RUNTIME_CANDIDATE_FORMAT, status: 'UNREVIEWED_CANDIDATE', createdAt: createdAt.toISOString(), plan,
      provider: { image: sandbox.image, snapshotId: snapshot.snapshotId, sourceSessionId: snapshot.sourceSessionId, region: snapshot.region,
        sizeBytes: snapshot.sizeBytes, expiresAt: snapshot.expiresAt.toISOString() }, probe, probeDigest: digestCanonicalJson(probe), materialDigest,
      requiredBeforePromotion: [protectedMode?'INDEPENDENT_RESTORE_AND_LAUNCHER_PROBE':'INDEPENDENT_RESTORE_AND_DIRECT_COMMAND_PROBE',
        'RESTORED_STRICT_CONFIG_AND_CATALOG_PARSE','PIN_CODEX_LINUX_PACKAGE_AND_NATIVE_DIGEST', 'VERIFY_SNAPSHOT_SOURCE_AND_ALL_MEASURED_DIGESTS',
        ...(protectedMode?[]:['VERIFY_BACKGROUND_WRITER_CAPTURE_AND_WHOLE_VM_STOP','ACKNOWLEDGE_MUTABLE_STARTING_FILES_AND_UNTRUSTED_OUTPUT']),
        'VERIFY_SNAPSHOT_UNEXPIRED_AT_ACTIVATION', 'BIND_REVIEWED_GATEWAY_PROFILE_AND_FINITE_AUTHORITIES',
        'EMIT_SEPARATE_ACCEPTED_DEPLOYMENT_ENVELOPE'],
      candidateDeployment: { format: CIRCLE_DEPLOYMENT_CANDIDATE_FORMAT, warning: 'NOT_ACCEPTED_RUNTIME_CONFIGURATION',
        runtime: { format: 'motive.circle-project-run-runtime/0.1', gatewayUrl: input.gatewayUrl,
          inferenceProfileDigest: plan.gateway.inferenceProfileDigest, sandbox: sandboxProfile,
          deploymentBindings: {
            infrastructureAuthorizationId: input.infrastructureAuthorizationId ?? null,
            maximumCostUsd: input.maximumCostUsd ?? null,
            status: input.infrastructureAuthorizationId ? 'SUPPLIED_UNREVIEWED' : 'PENDING_AUTHORITY',
          },
          capabilityTtlSeconds: 120, nativeCollection } } };
    await persistCandidate?.(candidate);
    return candidate;
  } catch (error) {
    if (sandbox) {
      try {
        if (snapshotHandle) await snapshotHandle.delete(AbortSignal.timeout(15_000));
        else if (!providerTerminal) await sandbox.stop(AbortSignal.timeout(15_000));
      }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'RUNTIME_BUILD_CLEANUP_UNRESOLVED'); }
    }
    throw error;
  }
}

async function readBounded(stream: NodeJS.ReadableStream | null, maximumBytes: number): Promise<Uint8Array> {
  if (!stream) throw new Error('RUNTIME_PROBE_MISSING');
  const chunks: Buffer[] = []; let total = 0;
  for await (const value of stream) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); total += chunk.length;
    if (total > maximumBytes) { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.(); throw new Error('RUNTIME_PROBE_TOO_LARGE'); } chunks.push(chunk); }
  return Buffer.concat(chunks, total);
}

export function createNativeRuntimeBuildProvider(credentials: NativeVercelCredentials, rawFetch: typeof fetch = globalThis.fetch): RuntimeBuildProvider {
  const fetch = createSingleAttemptFetch(rawFetch);
  return { async create(input, signal) {
    const sandbox = await Sandbox.create({ image: input.image, region: input.region, persistent: input.persistent,
      timeout: input.timeoutMs, resources: { vcpus: input.vcpus }, snapshotExpiration: CIRCLE_RUNTIME_SNAPSHOT_TTL_MS,
      ...credentials, fetch, signal });
    const session = sandbox.currentSession();
    return {
      image: sandbox.image,
      async writeFiles(files, childSignal) { await session.writeFiles(files, { signal: childSignal }); },
      async run(command, childSignal) {
        let tail = Buffer.alloc(0);
        const bounded = () => new Writable({ write(chunk, _encoding, callback) {
          const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); tail = Buffer.concat([tail, next]).subarray(-8 * 1024); callback();
        } });
        const result = await session.runCommand({ ...command, args: [...command.args], stdout: bounded(), stderr: bounded(), signal: childSignal });
        return { exitCode: result.exitCode, diagnostic: tail.toString('utf8') };
      },
      async read(path, maximumBytes, childSignal) { return readBounded(await session.readFile({ path }, { signal: childSignal }), maximumBytes); },
      async snapshot(expirationMs, childSignal) { const value = await sandbox.snapshot({ expiration: expirationMs, signal: childSignal });
        return { snapshotId: value.snapshotId, sourceSessionId: value.sourceSessionId, region: value.regions[0] ?? input.region,
          sizeBytes: value.sizeBytes, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}),
          async delete(deleteSignal) { await value.delete({ signal: deleteSignal }); } }; },
      async stop(childSignal) { await sandbox.stop({ signal: childSignal }); },
    };
  } };
}

export async function readCircleRuntimeBuildSources(root = process.cwd()): Promise<CircleRuntimeBuildInput['sourceFiles']> {
  return {
    launcher: await readFile(`${root}/packages/runner-native/native/worker-launcher.c`),
    runtimeCheck: await readFile(`${root}/packages/runner-native/native/worker-runtime-check.c`),
    referenceWitness: await readFile(`${root}/public/projects/circle-packing/reference-witness.json`),
  };
}

export function serializeRuntimeBuildArtifact(value: CircleRuntimeBuildPlan | CircleRuntimeBuildCandidate): string {
  return `${canonicalJson(value)}\n`;
}
