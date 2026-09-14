import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveAgentMcp, type AgentMcpSettings } from '../packages/runner-codex/src/mcp.ts';

// Codex's configuration inspection commands do not start MCP servers or invoke a model.
const root = resolve('.local', `mcp-config-review-${Date.now()}`);
await mkdir(root, { recursive: true });
const settings: AgentMcpSettings = {
  servers: {
    local_fixture: { transport: 'stdio', command: process.execPath, args: ['--version'], enabled_tools: ['fixture_read'] },
    remote_fixture: { transport: 'http', url: 'https://mcp.example.com/mcp', bearer_token_env_var: 'FIXTURE_MCP_TOKEN', required: false },
  },
  agents: { worker: { mcpServers: ['local_fixture'] }, planner: { mcpServers: ['remote_fixture'] }, plain: { mcpServers: [] } },
};
const invocation = process.platform === 'win32'
  ? { command: process.execPath, prefix: [resolve(process.execPath, '..', 'node_modules/@openai/codex/bin/codex.js')] }
  : { command: 'codex', prefix: [] };
const evidence = [];
const researchInstructions = await readFile('profiles/research-agent.md', 'utf8');
for (const agentId of ['worker', 'planner', 'plain']) {
  const selection = resolveAgentMcp(settings, agentId);
  const home = resolve(root, agentId);
  await mkdir(home);
  await writeFile(resolve(home, 'config.toml'), `developer_instructions = ${JSON.stringify(researchInstructions)}\n${selection.toml}`);
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home, CI: '1', NO_COLOR: '1' };
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const result = spawnSync(invocation.command, [...invocation.prefix, 'mcp', 'list', '--json'], {
    cwd: home, env, encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const listed = JSON.parse(result.stdout) as Array<{ name: string; enabled: boolean }>;
  assert.deepEqual(listed.filter(server => server.enabled).map(server => server.name).sort(), Object.keys(selection.servers).sort());
  evidence.push({ agentId, digest: selection.digest, listed });
}
const version = spawnSync(invocation.command, [...invocation.prefix, '--version'], { encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0);
await writeFile(resolve(root, 'evidence.json'), JSON.stringify({ codexVersion: version.stdout.trim(), status: 'passed',
  scope: 'Codex MCP config parsing and per-agent selection only; no server connection or model invocation. This Codex version does not support --strict-config on mcp list.', evidence }, null, 2));
console.log(`Passed: three isolated agent selections with ${version.stdout.trim()}. Evidence: ${root}`);
