import { describe, expect, it } from 'vitest';
import { parseAgentMcpSettings, resolveAgentMcp, type AgentMcpSettings } from './mcp.ts';

const settings = (): AgentMcpSettings => ({
  servers: {
    hypothesis: { transport: 'stdio', command: '/opt/mcp/hypothesis', args: ['--mode', 'mcp'], enabled_tools: ['evidence_get'] },
    research: { transport: 'http', url: 'https://mcp.example.com/mcp', bearer_token_env_var: 'RESEARCH_TOKEN', required: false },
  },
  agents: { worker: { mcpServers: ['hypothesis'] }, planner: { mcpServers: ['research'] }, plain: { mcpServers: [] } },
});

describe('per-agent MCP selection', () => {
  it('defaults to none and disables every unselected catalog server', () => {
    for (const agent of ['plain', 'new-agent']) {
      const value = resolveAgentMcp(settings(), agent);
      expect(value.servers).toEqual({});
      expect(value.requiredEnvironment).toEqual([]);
      expect(value.toml).not.toContain('enabled = true');
    }
    expect(resolveAgentMcp({ servers: {}, agents: {} }, 'worker').toml).not.toContain('[mcp_servers.');
  });
  it('keeps selections and required credentials separate for each agent', () => {
    const worker = resolveAgentMcp(settings(), 'worker');
    const planner = resolveAgentMcp(settings(), 'planner');
    expect(Object.keys(worker.servers)).toEqual(['hypothesis']);
    expect(worker.requiredEnvironment).toEqual([]);
    expect(Object.keys(planner.servers)).toEqual(['research']);
    expect(planner.requiredEnvironment).toEqual(['RESEARCH_TOKEN']);
    expect(worker.digest).not.toBe(planner.digest);
    expect(worker.toml).toContain('enabled_tools = ["evidence_get"]');
    expect(worker.toml).toContain('required = true');
  });
  it('rejects unknown selections and misspelled or inline-secret options', () => {
    const input = settings();
    input.agents.worker.mcpServers = ['typo'];
    expect(() => parseAgentMcpSettings(input)).toThrow(/unknown server/);
    expect(() => parseAgentMcpSettings({ ...settings(), secret: 'value' })).toThrow(/unsupported/);
    for (const extra of [{ env: { TOKEN: 'secret' } }, { url: 'https://other.example/mcp' }, { enabled_tool: [] }]) {
      const value = settings();
      Object.assign(value.servers.hypothesis, extra);
      expect(() => parseAgentMcpSettings(value)).toThrow(/unsupported/);
    }
  });
  it('rejects credential-bearing URLs and malformed names or timeouts', () => {
    for (const url of ['https://user:password@example.com/mcp', 'https://example.com/mcp?token=secret', 'http://example.com/mcp']) {
      const input = settings();
      input.servers.research = { transport: 'http', url };
      expect(() => parseAgentMcpSettings(input)).toThrow(/HTTPS/);
    }
    expect(() => resolveAgentMcp(settings(), 'worker]\n[evil')).toThrow(/Invalid name/);
    const input = settings();
    input.servers.hypothesis.tool_timeout_sec = -1;
    expect(() => parseAgentMcpSettings(input)).toThrow(/integer/);
  });
  it('escapes quotes and paths, permits repeated arguments, and rejects control characters', () => {
    const input: AgentMcpSettings = { servers: { local: { transport: 'stdio', command: 'C:\\Program Files\\mcp.exe', args: ['--arg', 'a"b', '--arg', 'c'] } }, agents: { worker: { mcpServers: ['local'] } } };
    expect(resolveAgentMcp(input, 'worker').toml).toContain('command = "C:\\\\Program Files\\\\mcp.exe"');
    expect(resolveAgentMcp(input, 'worker').toml).toContain('a\\"b');
    input.servers.local = { transport: 'stdio', command: 'bad\n[features]' };
    expect(() => parseAgentMcpSettings(input)).toThrow(/control characters/);
  });
  it('detaches parsed settings and renders catalog order deterministically', () => {
    const input = settings();
    const parsed = parseAgentMcpSettings(input);
    input.agents.worker.mcpServers.length = 0;
    expect(Object.keys(resolveAgentMcp(parsed, 'worker').servers)).toEqual(['hypothesis']);
    const reversed = { ...parsed, servers: Object.fromEntries(Object.entries(parsed.servers).reverse()) };
    expect(resolveAgentMcp(parsed, 'worker').digest).toBe(resolveAgentMcp(reversed, 'worker').digest);
    parsed.servers.hypothesis.required = undefined;
    expect(resolveAgentMcp(parsed, 'worker').toml).not.toContain('undefined');
  });
});
