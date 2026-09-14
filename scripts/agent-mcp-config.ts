import { readFile, writeFile } from 'node:fs/promises';
import { parseAgentMcpSettings, resolveAgentMcp } from '../packages/runner-codex/src/mcp.ts';

const [agentId, ...args] = process.argv.slice(2);
if (!agentId || args.length % 2 !== 0) throw new Error('Usage: npm run agent:mcp -- AGENT [--settings FILE] [--instructions FILE] [--base-config FILE] [--output FILE]');
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
  if (!['--settings', '--instructions', '--base-config', '--output'].includes(args[i]) || flags.has(args[i])) throw new Error(`Invalid or duplicate option: ${args[i]}`);
  flags.set(args[i], args[i + 1]);
}
const settings = parseAgentMcpSettings(JSON.parse(await readFile(flags.get('--settings') ?? 'profiles/agent-mcp.json', 'utf8')));
const resolved = resolveAgentMcp(settings, agentId);
const base = flags.has('--base-config') ? await readFile(flags.get('--base-config')!, 'utf8') : '';
// Start from the runner's reviewed base, never merge unknown personal/project MCP settings.
if (/mcp_servers/.test(base)) throw new Error('Base config must not already contain MCP settings.');
const instructions = flags.has('--instructions') ? await readFile(flags.get('--instructions')!, 'utf8') : null;
if (instructions !== null && /developer_instructions/.test(base)) throw new Error('Base config already supplies developer instructions.');
// Root settings precede any tables in the base configuration.
const config = `${instructions === null ? '' : `developer_instructions = ${JSON.stringify(instructions)}\n`}${base}${base.endsWith('\n') || !base ? '' : '\n'}${resolved.toml}`;
if (flags.has('--output')) await writeFile(flags.get('--output')!, config, { encoding: 'utf8', flag: 'wx' });
else process.stdout.write(config);
process.stderr.write(`Agent ${agentId}: ${Object.keys(resolved.servers).join(', ') || 'no MCP servers'}\n`);
if (resolved.requiredEnvironment.length) process.stderr.write(`Requires separately supplied environment: ${resolved.requiredEnvironment.join(', ')}\n`);
