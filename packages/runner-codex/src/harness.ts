import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { CODEX_CATALOG_VERSION, LOCAL_MOCK_MODEL, serializeLocalMockModelCatalog } from "./catalog.ts";
import { startDeterministicMock, type MockMode } from "./mock-provider.ts";
import { hasSuccessfulFixtureRead, parseJsonLines, sha256, summarizeProtocol } from "./protocol.ts";
import { resolveAgentMcp, type AgentMcpSettings } from './mcp.ts';

export type HarnessEvidence = {
  scenario: MockMode;
  status: "passed" | "failed";
  codexVersion: string | null;
  command: string[];
  exitCode: number | null;
  stdoutEvents: Record<string, unknown>[];
  stderr: string;
  effectiveConfig: { digest: string; values: Record<string, unknown> } | null;
  requests: Awaited<ReturnType<typeof startDeterministicMock>>["requests"];
  protocol: Record<string, unknown>;
  artifacts: Array<{ path: string; digest: string; content: string | null }>;
  limitations: string[];
  toolExecution?: { requestedFileReads: number; successfulFileReads: number; status: 'passed' | 'blocked_or_failed' | 'not_requested' };
};

export function redactCapturedRequests(requests: HarnessEvidence['requests']): HarnessEvidence['requests'] {
  return requests.map((request) => ({
    ...request,
    body: {
      model: request.body.model ?? null,
      stream: request.body.stream ?? null,
      store: request.body.store ?? null,
      previous_response_id: request.body.previous_response_id ?? null,
      prompt_cache_key: request.body.prompt_cache_key ?? null,
      parallel_tool_calls: request.body.parallel_tool_calls ?? null,
      include: request.body.include ?? null,
      input: Array.isArray(request.body.input)
        ? request.body.input.map((item) => {
            if (!item || typeof item !== "object") return { type: typeof item };
            const value = item as Record<string, unknown>;
            const output = typeof value.output === "string" ? value.output : null;
            return {
              type: value.type ?? null,
              role: value.role ?? null,
              call_id: value.call_id ?? null,
              name: value.name ?? null,
              output_digest: output === null ? null : sha256(output),
            };
          })
        : [],
      tools: Array.isArray(request.body.tools)
        ? request.body.tools.map((tool) => {
            if (!tool || typeof tool !== "object") return { type: typeof tool };
            const value = tool as Record<string, unknown>;
            const parameters = value.parameters && typeof value.parameters === "object" ? value.parameters as Record<string, unknown> : null;
            return { type: value.type ?? null, name: value.name ?? null, required: parameters?.required ?? null };
          })
        : [],
    },
  }));
}

export function redactHarnessEvidence(evidence: HarnessEvidence): HarnessEvidence {
  return {
    ...evidence,
    requests: redactCapturedRequests(evidence.requests),
  };
}

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;

async function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; outputTruncated: boolean }>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    const capture = (current: string, chunk: Buffer): string => {
      if (capturedBytes >= MAX_CAPTURE_BYTES) {
        outputTruncated = true;
        return current;
      }
      const remaining = MAX_CAPTURE_BYTES - capturedBytes;
      const accepted = chunk.subarray(0, remaining);
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) outputTruncated = true;
      return current + accepted.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => (stdout = capture(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = capture(stderr, chunk)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, PROCESS_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut, outputTruncated });
    });
  });
}

function isolatedEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const allow = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "LANG"];
  const env = Object.fromEntries(allow.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]));
  return { ...env, CODEX_HOME: codexHome, MOTIVE_MOCK_TOKEN: "local-non-secret", CI: "1", NO_COLOR: "1" };
}

function codexInvocation(): { command: string; prefix: string[]; display: string } {
  if (process.platform === "win32") {
    const entry = resolve(process.execPath, "..", "node_modules", "@openai", "codex", "bin", "codex.js");
    return { command: process.execPath, prefix: [entry], display: entry };
  }
  return { command: "codex", prefix: [], display: "codex" };
}

export async function detectCodexVersion(): Promise<string | null> {
  try {
    const invocation = codexInvocation();
    const result = await run(invocation.command, [...invocation.prefix, "--version"]);
    return result.code === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function runLocalCompatibilityHarness(scenario: MockMode = "happy", options: {
  syntheticCost?: string;
  connectGateway?: (providerBaseUrl: string) => Promise<{ baseUrl: string; capability: string; close(): Promise<void> }>;
  /** A pre-issued synthetic capability reachable only through an isolated joined-harness network. */
  externalGateway?: { baseUrl: string; capability: string };
  mcp?: { settings: AgentMcpSettings; agentId: string };
} = {}): Promise<HarnessEvidence> {
  const mcp = resolveAgentMcp(options.mcp?.settings ?? { servers: {}, agents: {} }, options.mcp?.agentId ?? 'worker');
  if (mcp.requiredEnvironment.length) throw new Error('The isolated compatibility harness does not supply MCP credentials or environment variables.');
  const codexVersion = await detectCodexVersion();
  if (!codexVersion) {
    return {
      scenario,
      status: "failed",
      codexVersion: null,
      command: [],
      exitCode: null,
      stdoutEvents: [],
      stderr: "Codex executable was not found on PATH.",
      effectiveConfig: null,
      requests: [],
      protocol: {},
      artifacts: [],
      limitations: ["Installed Codex CLI is required for actual compatibility evidence."],
    };
  }

  if (options.connectGateway && options.externalGateway) throw new Error('Only one gateway connection mode may be selected.');
  const mock = options.externalGateway ? null : await startDeterministicMock(scenario, options.syntheticCost);
  let gateway: Awaited<ReturnType<NonNullable<typeof options.connectGateway>>> | undefined;
  try {
    if (mock) gateway = await options.connectGateway?.(mock.baseUrl);
  } catch (error) {
    await mock?.close();
    throw error;
  }
  const activeGateway = options.externalGateway ?? gateway;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "motive-compat-"));
  const codexHome = join(temporaryRoot, "codex-home");
  const runWorkspace = join(temporaryRoot, "workspace");
  await mkdir(codexHome);
  await mkdir(runWorkspace);
  await Promise.all([
    writeFile(join(runWorkspace, "motive-turn-1.input.txt"), "turn-one\n", "utf8"),
    writeFile(join(runWorkspace, "motive-turn-2.input.txt"), "turn-two\n", "utf8"),
    writeFile(join(codexHome, "model-catalog.json"), serializeLocalMockModelCatalog(), "utf8"),
  ]);
  const catalogPath = join(codexHome, "model-catalog.json").replaceAll("\\", "/");
  const config = [
    `model = "${LOCAL_MOCK_MODEL}"`,
    'model_provider = "motive_mock"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    'model_reasoning_effort = "low"',
    'model_reasoning_summary = "none"',
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    'web_search = "disabled"',
    '',
    '[features]',
    'multi_agent = false',
    'multi_agent_v2 = false',
    'apps = false',
    'plugins = false',
    'memories = false',
    'goals = false',
    'hooks = false',
    'shell_snapshot = false',
    '',
    '[model_providers.motive_mock]',
    'name = "Motive deterministic local mock"',
    `base_url = "${activeGateway?.baseUrl ?? mock!.baseUrl}"`,
    'env_key = "MOTIVE_MOCK_TOKEN"',
    'wire_api = "responses"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'supports_websockets = false',
    '',
  ].join("\n") + mcp.toml;
  await writeFile(join(codexHome, "config.toml"), config, "utf8");

  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--strict-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "Use the provided local shell tool exactly when requested. Complete the deterministic compatibility exercise.",
  ];
  const invocation = codexInvocation();
  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run(invocation.command, [...invocation.prefix, ...args], {
      cwd: runWorkspace,
      env: { ...isolatedEnvironment(codexHome), MOTIVE_MOCK_TOKEN: activeGateway?.capability ?? 'local-non-secret' },
    });
  } finally {
    await gateway?.close();
    await mock?.close();
  }

  const artifacts = await Promise.all(
    ["motive-turn-1.input.txt", "motive-turn-2.input.txt"].map(async (name) => {
      try {
        const content = await readFile(join(runWorkspace, name), "utf8");
        return { path: name, digest: sha256(content), content };
      } catch {
        return { path: name, digest: "missing", content: null };
      }
    }),
  );
  let stdoutEvents: Record<string, unknown>[] = [];
  let parseFailure: string | null = null;
  try {
    stdoutEvents = parseJsonLines(result.stdout);
  } catch (error) {
    parseFailure = String(error);
  }
  const requests = mock?.requests ?? [];
  const toolRoundTrips = requests.filter((request) =>
    ["call_motive_1", "call_motive_2"].some((callId) => request.body && JSON.stringify(request.body).includes(callId)),
  ).length;
  const upstreamSuccessfulFileReads = ['turn-one', 'turn-two'].filter((expected, index) => requests.some(request =>
    hasSuccessfulFixtureRead(request.body, `call_motive_${index + 1}`, expected),
  )).length;
  const stdoutSuccessfulFileReads = ['turn-one', 'turn-two'].filter(expected => stdoutEvents.some(event => {
    const item = event.item;
    return event.type === 'item.completed' && item !== null && typeof item === 'object'
      && (item as Record<string, unknown>).type === 'command_execution'
      && (item as Record<string, unknown>).exit_code === 0
      && String((item as Record<string, unknown>).aggregated_output ?? '').trim() === expected;
  })).length;
  const successfulFileReads = options.externalGateway ? stdoutSuccessfulFileReads : upstreamSuccessfulFileReads;
  const happyPassed = result.code === 0 && artifacts.every((artifact) => artifact.content !== null)
    && (options.externalGateway ? successfulFileReads === 2 : requests.length === 3 && toolRoundTrips >= 2 && successfulFileReads === 2);
  const faultPassed = !options.externalGateway && result.code !== 0 && requests.length === 1 && artifacts.every((artifact) => artifact.content !== null);
  const passed = !result.timedOut && !result.outputTruncated && parseFailure === null && (scenario === "happy" ? happyPassed : faultPassed);
  const effectiveValues = {
    model: LOCAL_MOCK_MODEL,
    model_catalog: {
      codex_version: CODEX_CATALOG_VERSION,
      digest: sha256(serializeLocalMockModelCatalog()),
      use_responses_lite: false,
      effective_parallel_tool_calls: true,
    },
    model_provider: "motive_mock",
    model_reasoning_effort: "low",
    model_reasoning_summary: "none",
    sandbox_mode: "read-only",
    approval_policy: "never",
    provider_base_url: options.externalGateway ? 'isolated-gateway-network' : 'loopback-ephemeral',
    provider_env_key: "MOTIVE_MOCK_TOKEN",
    wire_api: "responses",
    request_max_retries: 0,
    stream_max_retries: 0,
    supports_websockets: false,
    web_search: 'disabled',
    disabled_features: ['multi_agent', 'multi_agent_v2', 'apps', 'plugins', 'memories', 'goals', 'hooks', 'shell_snapshot'],
    accounting_gateway: activeGateway !== undefined,
  };
  const evidence: HarnessEvidence = {
    scenario,
    status: passed ? "passed" : "failed",
    toolExecution: { requestedFileReads: scenario === 'happy' ? 2 : 0, successfulFileReads,
      status: scenario === 'happy' ? successfulFileReads === 2 ? 'passed' : 'blocked_or_failed' : 'not_requested' },
    codexVersion,
    command: [invocation.display, ...args],
    exitCode: result.code,
    stdoutEvents,
    stderr: [activeGateway ? result.stderr.replaceAll(activeGateway.capability, '[REDACTED]') : result.stderr, result.timedOut ? `Codex exceeded ${PROCESS_TIMEOUT_MS}ms timeout.` : null, result.outputTruncated ? `Output exceeded ${MAX_CAPTURE_BYTES} bytes.` : null, parseFailure].filter(Boolean).join("\n"),
    effectiveConfig: {
      digest: sha256(JSON.stringify(effectiveValues)),
      values: effectiveValues,
    },
    requests,
    protocol: summarizeProtocol(requests),
    artifacts,
    limitations: [
      "This deterministic mock performs no real provider, billing, sandbox-host, or cloud validation. Optional gateway accounting uses synthetic local charges only.",
      ...(scenario === 'happy' && successfulFileReads !== 2 ? ['Requested tool-call round trips occurred without proving two successful file reads; inspect toolExecution and host policy denials.'] : []),
      "Live model identity, route, usage, pricing, context limits, compaction, and provider continuation behavior remain unresolved.",
    ],
  };
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  const resolvedSystemTemp = `${resolve(tmpdir())}${sep}`;
  if (!resolvedTemporaryRoot.startsWith(resolvedSystemTemp) || !basename(resolvedTemporaryRoot).startsWith("motive-compat-")) {
    throw new Error(`Refusing to remove unexpected temporary root: ${resolvedTemporaryRoot}`);
  }
  await rm(resolvedTemporaryRoot, { recursive: true, force: true });
  return evidence;
}

export async function writeHarnessEvidence(outputPath: string): Promise<HarnessEvidence> {
  const evidence = await runLocalCompatibilityHarness();
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(redactHarnessEvidence(evidence), null, 2)}\n`, "utf8");
  return evidence;
}
