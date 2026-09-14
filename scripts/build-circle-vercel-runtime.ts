import { randomUUID } from 'node:crypto';
import { open, readFile, stat, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { profileDigest, validateAndFreezeProfile, type GatewayProfile } from '../packages/inference-gateway/src/profile.ts';
import {
  createNativeRuntimeBuildProvider,
  executeCircleVercelRuntimeBuild,
  planCircleVercelRuntimeBuild,
  readCircleRuntimeBuildSources,
  serializeRuntimeBuildArtifact,
  type CircleRuntimeBuildInput,
} from './lib/circle-vercel-runtime-build.ts';

export type BuildCircleVercelRuntimeArguments = {
  execute: boolean;
  boundary: 'protected-runtime' | 'provider-untrusted-circle-data';
  projectRevision: number;
  gatewayProfileFile?: string;
  buildConfigFile?: string;
  profileId?: string;
  gatewayUrl: string;
  artifactEgressUrl?: string;
  infrastructureAuthorizationId?: string;
  maximumCostUsd?: string;
  runtimeTimeoutMs: number;
  commandTimeoutMs: number;
  buildTimeoutMs: number;
  vcpus: number;
  output?: string;
};

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key); if (!value) throw new Error(`${key} is required.`); return value;
}
function integer(value: string, key: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${key} must be a positive integer.`); return Number(value);
}

export function parseBuildCircleVercelRuntimeArguments(argv: readonly string[]): BuildCircleVercelRuntimeArguments {
  const values = new Map<string, string>(); let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]!;
    if (key === '--execute') { execute = true; continue; }
    if (!key.startsWith('--') || !argv[index + 1] || argv[index + 1]!.startsWith('--') || values.has(key)) throw new Error('Arguments must be unique --key value pairs.');
    values.set(key, argv[++index]!);
  }
  const allowed = new Set(['--boundary','--project-revision', '--gateway-profile-file', '--build-config-file', '--profile-id', '--gateway-url', '--artifact-egress-url', '--infrastructure-authorization-id', '--maximum-cost-usd', '--runtime-timeout-ms', '--command-timeout-ms', '--build-timeout-ms', '--vcpus', '--output']);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unsupported argument ${key}.`);
  const result: BuildCircleVercelRuntimeArguments = {
    execute, boundary: (values.get('--boundary') ?? 'protected-runtime') as BuildCircleVercelRuntimeArguments['boundary'],
    projectRevision: integer(required(values, '--project-revision'), '--project-revision'), gatewayUrl: required(values, '--gateway-url'),
    ...(values.get('--artifact-egress-url') ? {artifactEgressUrl:values.get('--artifact-egress-url')!}:{}), runtimeTimeoutMs: integer(required(values, '--runtime-timeout-ms'), '--runtime-timeout-ms'),
    commandTimeoutMs: integer(required(values, '--command-timeout-ms'), '--command-timeout-ms'),
    buildTimeoutMs: integer(required(values, '--build-timeout-ms'), '--build-timeout-ms'), vcpus: integer(required(values, '--vcpus'), '--vcpus'),
    ...(values.get('--profile-id') ? { profileId: values.get('--profile-id')! } : {}),
    ...(values.get('--gateway-profile-file') ? { gatewayProfileFile: values.get('--gateway-profile-file')! } : {}),
    ...(values.get('--build-config-file') ? { buildConfigFile: values.get('--build-config-file')! } : {}),
    ...(values.get('--infrastructure-authorization-id') ? { infrastructureAuthorizationId: values.get('--infrastructure-authorization-id')! } : {}),
    ...(values.get('--maximum-cost-usd') ? { maximumCostUsd: values.get('--maximum-cost-usd')! } : {}),
    ...(values.get('--output') ? { output: values.get('--output')! } : {}),
  };
  if ((result.gatewayProfileFile === undefined) === (result.buildConfigFile === undefined)) throw new Error('Exactly one of --gateway-profile-file or --build-config-file is required.');
  if (!['protected-runtime','provider-untrusted-circle-data'].includes(result.boundary)) throw new Error('--boundary is invalid.');
  if (result.boundary === 'protected-runtime' && !result.artifactEgressUrl) throw new Error('--artifact-egress-url is required for the protected runtime.');
  if (result.boundary === 'provider-untrusted-circle-data' && result.artifactEgressUrl) throw new Error('--artifact-egress-url is forbidden for provider-untrusted circle data.');
  if (result.profileId && !result.gatewayProfileFile) throw new Error('--profile-id requires --gateway-profile-file.');
  if (execute && !result.output) throw new Error('--output is required with --execute.');
  if (!execute && result.output) throw new Error('--output is accepted only with --execute.');
  return result;
}

async function readProfile(path: string, selectedId?: string): Promise<Readonly<GatewayProfile>> {
  const info = await stat(path); if (!info.isFile() || info.size > 256 * 1024) throw new Error('The gateway profile bundle is missing or too large.');
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  if (entries.length === 0 || entries.length > 20) throw new Error('The gateway profile bundle must contain between one and twenty profiles.');
  const profiles = entries.map(validateAndFreezeProfile);
  const matching = selectedId ? profiles.filter(profile => profile.profileId === selectedId) : profiles.filter(profile => profile.route.model === 'openai/gpt-6-astra');
  if (matching.length !== 1) throw new Error('Exactly one reviewed Astra profile must be selected.');
  return matching[0]!;
}

async function readBuildConfig(path: string): Promise<CircleRuntimeBuildInput['unreviewedBuildConfig']> {
  const info = await stat(path); if (!info.isFile() || info.size > 32 * 1024) throw new Error('The unreviewed build config is missing or too large.');
  return JSON.parse(await readFile(path, 'utf8')) as CircleRuntimeBuildInput['unreviewedBuildConfig'];
}

export async function buildCircleVercelRuntimeMain(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const args = parseBuildCircleVercelRuntimeArguments(argv);
  const gatewayProfile = args.gatewayProfileFile ? await readProfile(args.gatewayProfileFile, args.profileId) : undefined;
  const unreviewedBuildConfig = args.buildConfigFile ? await readBuildConfig(args.buildConfigFile) : undefined;
  const input: CircleRuntimeBuildInput = { boundary: args.boundary, projectRevision: args.projectRevision, gatewayUrl: args.gatewayUrl,
    runtimeTimeoutMs: args.runtimeTimeoutMs, commandTimeoutMs: args.commandTimeoutMs, buildTimeoutMs: args.buildTimeoutMs,
    vcpus: args.vcpus, sourceFiles: await readCircleRuntimeBuildSources(), ...(args.artifactEgressUrl ? {artifactEgressUrl:args.artifactEgressUrl}:{}),
    ...(gatewayProfile ? { gatewayProfile } : {}), ...(unreviewedBuildConfig ? { unreviewedBuildConfig } : {}),
    ...(args.infrastructureAuthorizationId ? { infrastructureAuthorizationId: args.infrastructureAuthorizationId } : {}),
    ...(args.maximumCostUsd ? { maximumCostUsd: args.maximumCostUsd } : {}),
  };
  if (!args.execute) return serializeRuntimeBuildArtifact(planCircleVercelRuntimeBuild(input));
  const token = env.MOTIVE_VERCEL_TOKEN ?? env.VERCEL_OIDC_TOKEN;
  const teamId = env.MOTIVE_VERCEL_TEAM_ID ?? env.VERCEL_TEAM_ID;
  const projectId = env.MOTIVE_VERCEL_PROJECT_ID ?? env.VERCEL_PROJECT_ID;
  if (!token || !teamId || !projectId) throw new Error('Explicit Vercel build credentials are required for --execute.');
  const target = args.output!; const handle = await open(target, 'wx', 0o600);
  try {
    const candidate = await executeCircleVercelRuntimeBuild(input, createNativeRuntimeBuildProvider({ token, teamId, projectId }),
      () => new Date(), async value => handle.writeFile(serializeRuntimeBuildArtifact(value), 'utf8'));
    return `${JSON.stringify({ status: candidate.status, buildId: randomUUID(), profileDigest: gatewayProfile ? profileDigest(gatewayProfile) : null, output: target })}\n`;
  } catch (error) {
    await handle.close(); await unlink(target); throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCircleVercelRuntimeMain(process.argv.slice(2)).then(value => process.stdout.write(value)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Circle runtime build failed.'}\n`); process.exitCode = 1;
  });
}
