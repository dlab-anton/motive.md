import { createHash } from 'node:crypto';

type McpOptions = {
  /** A selected server must start successfully unless explicitly optional. */
  required?: boolean;
  enabled_tools?: string[];
  disabled_tools?: string[];
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
};

export type AgentMcpServer = McpOptions & (
  | { transport: 'stdio'; command: string; args?: string[]; cwd?: string; env_vars?: string[] }
  | { transport: 'http'; url: string; bearer_token_env_var?: string }
);

/** Operator configuration. Server names and agent names do not confer application permissions. */
export type AgentMcpSettings = {
  servers: Record<string, AgentMcpServer>;
  agents: Record<string, { mcpServers: string[] }>;
};

const NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,127}$/;
const OPTIONS = ['required', 'enabled_tools', 'disabled_tools', 'startup_timeout_sec', 'tool_timeout_sec'];

function fail(message: string): never { throw new Error(`Invalid agent MCP settings: ${message}`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object.`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${field}.${key} is unsupported.`);
}
function string(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${field} must be a nonempty string without control characters.`);
  }
}
function strings(value: unknown, field: string, unique = true): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 128) fail(`${field} must be an array of at most 128 strings.`);
  value.forEach(item => string(item, field));
  if (unique && new Set(value).size !== value.length) fail(`${field} contains duplicates.`);
}
function name(value: string): void { if (!NAME.test(value)) fail(`Invalid name ${JSON.stringify(value)}.`); }

/** Validate JSON at the boundary; reject typos and inline credential fields. */
export function parseAgentMcpSettings(value: unknown): AgentMcpSettings {
  const root = object(value, 'settings');
  keys(root, ['servers', 'agents'], 'settings');
  const servers = object(root.servers, 'servers');
  const agents = object(root.agents, 'agents');
  for (const [id, input] of Object.entries(servers)) {
    name(id);
    const server = object(input, id);
    if (server.transport !== 'stdio' && server.transport !== 'http') fail(`${id}.transport must be stdio or http.`);
    keys(server, ['transport', ...OPTIONS, ...(server.transport === 'stdio'
      ? ['command', 'args', 'cwd', 'env_vars'] : ['url', 'bearer_token_env_var'])], id);
    if (server.transport === 'stdio') {
      string(server.command, `${id}.command`);
      if (server.args !== undefined) strings(server.args, `${id}.args`, false);
      if (server.cwd !== undefined) string(server.cwd, `${id}.cwd`);
      if (server.env_vars !== undefined) {
        strings(server.env_vars, `${id}.env_vars`);
        if (server.env_vars.some(item => !ENV.test(item))) fail(`${id}.env_vars contains an invalid environment name.`);
      }
    } else {
      string(server.url, `${id}.url`);
      let url: URL;
      try { url = new URL(server.url); } catch { return fail(`${id}.url must be a valid HTTPS URL.`); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        fail(`${id}.url must use HTTPS without credentials, query, or fragment.`);
      }
      if (server.bearer_token_env_var !== undefined &&
        (typeof server.bearer_token_env_var !== 'string' || !ENV.test(server.bearer_token_env_var))) {
        fail(`${id}.bearer_token_env_var must be an environment name.`);
      }
    }
    if (server.required !== undefined && typeof server.required !== 'boolean') fail(`${id}.required must be boolean.`);
    for (const field of ['enabled_tools', 'disabled_tools']) if (server[field] !== undefined) strings(server[field], `${id}.${field}`);
    for (const field of ['startup_timeout_sec', 'tool_timeout_sec']) {
      const timeout = server[field];
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600)) {
        fail(`${id}.${field} must be an integer between 1 and 3600.`);
      }
    }
  }
  for (const [id, input] of Object.entries(agents)) {
    name(id);
    const agent = object(input, id);
    keys(agent, ['mcpServers'], id);
    strings(agent.mcpServers, `${id}.mcpServers`);
    for (const serverId of agent.mcpServers) {
      if (!Object.hasOwn(servers, serverId)) fail(`${id} selects unknown server ${JSON.stringify(serverId)}.`);
    }
  }
  // Detach from caller-owned objects so a parsed selection cannot change underneath a run.
  return structuredClone(root) as AgentMcpSettings;
}

// JSON string escaping is TOML-compatible after control characters have been rejected above.
function tomlValue(value: string | string[] | boolean | number): string {
  return Array.isArray(value) ? `[${value.map(item => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value);
}

export function resolveAgentMcp(input: AgentMcpSettings, agentId: string) {
  const settings = parseAgentMcpSettings(input);
  name(agentId);
  // Unknown agents receive no tools; selecting a misspelled server is an error above.
  const selected = new Set(Object.hasOwn(settings.agents, agentId) ? settings.agents[agentId].mcpServers : []);
  const lines: string[] = ['# Generated by Motive. Use in an isolated agent CODEX_HOME.'];
  const servers: Record<string, AgentMcpServer> = {};
  for (const id of Object.keys(settings.servers).sort()) {
    const { transport, ...config } = settings.servers[id];
    lines.push('', `[mcp_servers.${id}]`);
    // Explicitly disable unselected catalog entries, including in a reused reviewed base config.
    lines.push(`enabled = ${selected.has(id)}`);
    for (const key of Object.keys(config).sort()) {
      const value = config[key as keyof typeof config];
      if (value !== undefined) lines.push(`${key} = ${tomlValue(value as string | string[] | number | boolean)}`);
    }
    if (config.required === undefined) lines.push(`required = ${selected.has(id)}`);
    if (selected.has(id)) servers[id] = settings.servers[id];
  }
  const toml = `${lines.join('\n')}\n`;
  return {
    agentId,
    servers,
    toml,
    digest: `sha256:${createHash('sha256').update(toml).digest('hex')}` as const,
    requiredEnvironment: [...new Set(Object.values(servers).flatMap(server => server.transport === 'stdio'
      ? server.env_vars ?? [] : server.bearer_token_env_var ? [server.bearer_token_env_var] : []))].sort(),
  };
}
